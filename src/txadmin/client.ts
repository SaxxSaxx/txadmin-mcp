import { Agent } from 'undici';
import type { Config } from '../config.js';
import type { AdminInfo, SessionManager } from './session.js';
import {
  AuthError,
  NotTxAdminError,
  PermissionError,
  ServerOfflineError,
  TimeoutError,
  TxAdminError,
} from './errors.js';

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
}

/** Valid `sortingKey` values for /player/search (ALLOWED_SORTINGS in txAdmin). */
export type PlayerSortKey = 'playTime' | 'tsJoined' | 'tsLastConnection';
export type PlayerSearchType = 'playerName' | 'playerNotes' | 'playerIds';
export type HistorySearchType = 'actionId' | 'reason' | 'identifiers';

export interface PlayersTablePlayer {
  license: string;
  displayName: string;
  playTime: number;
  tsJoined: number;
  tsLastConnection: number;
  notes?: string;
  isAdmin: boolean;
  isOnline: boolean;
  isWhitelisted: boolean;
}

export interface HistoryTableAction {
  id: string;
  type: 'ban' | 'warn';
  playerName: string | false;
  author: string;
  reason: string;
  timestamp: number;
  isRevoked: boolean;
  banExpiration?: 'expired' | 'active' | 'permanent';
  warnAcked?: boolean;
}

export interface PlayerHistoryItem {
  id: string;
  type: 'ban' | 'warn';
  author: string;
  reason: string;
  ts: number;
  exp?: number;
  revokedBy?: string;
  revokedAt?: number;
}

export interface PlayerModalPlayer {
  displayName: string;
  pureName: string;
  isRegistered: boolean;
  isConnected: boolean;
  idsOffline: string[];
  idsOnline: string[];
  hwidsOffline: string[];
  hwidsOnline: string[];
  license: string | null;
  actionHistory: PlayerHistoryItem[];
  netid?: number;
  sessionTime?: number;
  tsJoined?: number;
  tsWhitelisted?: number;
  playTime?: number;
  notes?: string;
  tsLastConnection?: number;
}

/**
 * The only place that knows txAdmin's HTTP routes.
 *
 * txAdmin exposes no official REST API — this speaks the panel's own web API,
 * which means session cookie plus `x-txadmin-csrftoken` on every call. When a
 * txAdmin release changes a route, it changes here and nowhere else.
 */
export class TxAdminClient {
  private readonly dispatcher: Agent | undefined;

  constructor(
    private readonly cfg: Config,
    private readonly session: SessionManager,
  ) {
    if (cfg.insecureTls) {
      // Scoped to this client's requests only. Setting
      // NODE_TLS_REJECT_UNAUTHORIZED=0 would disable verification for every
      // request the process ever makes, which is a far bigger hole.
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
      process.stderr.write(
        '[txadmin-mcp] WARNING: TLS certificate verification is disabled for the txAdmin ' +
          'connection (TXADMIN_INSECURE_TLS=true). Prefer adding the panel CA to your trust store.\n',
      );
    }
  }

  async request<T = any>(
    method: 'GET' | 'POST',
    path: string,
    opts: RequestOptions = {},
    isRetry = false,
  ): Promise<T> {
    const session = await this.session.get();

    const url = new URL(path, this.cfg.url);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      cookie: session.cookieHeader,
      'x-txadmin-csrftoken': session.csrfToken,
      accept: 'application/json',
    };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      } as RequestInit);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/abort|timeout/i.test(message)) {
        throw new TimeoutError(
          `Request to ${url.pathname} timed out after ${this.cfg.timeoutMs}ms. ` +
            `Is the txAdmin panel reachable at ${this.cfg.url}?`,
        );
      }
      throw new TxAdminError('network', `Could not reach ${this.cfg.url}: ${message}`);
    }

    if (!res.headers.get('content-type')?.includes('json')) {
      throw new NotTxAdminError(
        `${url.pathname} returned ${res.headers.get('content-type') ?? 'no content type'} ` +
          `instead of JSON. Either TXADMIN_URL is not a txAdmin panel, or a reverse proxy is ` +
          `stripping the x-txadmin-csrftoken header from the request.`,
      );
    }

    const body: any = await res.json();

    if (body?.logout === true) {
      if (isRetry) {
        throw new AuthError(
          `txAdmin rejected the session twice in a row (${body.reason ?? 'no reason given'}). ` +
            `Check that TXADMIN_USER still exists and its password is unchanged.`,
        );
      }
      await this.session.invalidate();
      return this.request<T>(method, path, opts, true);
    }

    const errorText: string | undefined =
      typeof body?.error === 'string'
        ? body.error
        : body?.type === 'error' && typeof body?.msg === 'string'
          ? body.msg
          : undefined;

    if (errorText) {
      if (/not running/i.test(errorText)) {
        throw new ServerOfflineError(
          `FXServer is not running, so txAdmin refused the command. ` +
            `Start it from txAdmin, or use txadmin_server_control if admin mode is enabled.`,
        );
      }
      if (/permission/i.test(errorText)) {
        throw new PermissionError(
          `${errorText} Grant the permission to "${session.admin.name}" in txAdmin's ` +
            `Admin Manager, then restart txadmin-mcp.`,
        );
      }
      if (/csrftoken/i.test(errorText)) {
        throw new NotTxAdminError(errorText);
      }
      throw new TxAdminError('txadmin', errorText);
    }

    return body as T;
  }

  authSelf(): Promise<AdminInfo & { csrfToken: string }> {
    return this.request('GET', '/auth/self');
  }

  diagnostics(): Promise<any> {
    return this.request('GET', '/diagnostics/getDiagnostics');
  }

  playerSearch(query: {
    searchValue?: string;
    searchType?: PlayerSearchType;
    sortingKey?: PlayerSortKey;
    sortingDesc?: boolean;
    offsetParam?: number;
    offsetLicense?: string;
  }): Promise<{ players: PlayersTablePlayer[]; hasReachedEnd: boolean }> {
    // sortingKey is mandatory: txAdmin rejects anything outside ALLOWED_SORTINGS.
    return this.request('GET', '/player/search', {
      query: { sortingKey: 'tsLastConnection', sortingDesc: true, ...query },
    });
  }

  playerModal(query: { mutex?: string; netid?: number; license?: string }): Promise<{
    serverTime: number;
    player: PlayerModalPlayer;
  }> {
    return this.request('GET', '/player', { query });
  }

  historySearch(query: {
    searchValue?: string;
    searchType?: HistorySearchType;
    filterbyType?: 'ban' | 'warn';
    filterbyAdmin?: string;
    sortingDesc?: boolean;
    offsetParam?: number;
    offsetActionId?: string;
  }): Promise<{ history: HistoryTableAction[]; hasReachedEnd: boolean }> {
    // 'timestamp' is the only value ALLOWED_SORTINGS accepts for history.
    return this.request('GET', '/history/search', {
      query: { sortingKey: 'timestamp', sortingDesc: true, ...query },
    });
  }

  serverLogPartial(query: { dir?: 'older' | 'newer'; ref?: string } = {}): Promise<{
    boundry: boolean;
    log: any[];
  }> {
    return this.request('GET', '/serverLog/partial', { query });
  }

  playerDrops(): Promise<any> {
    return this.request('GET', '/playerDropsData');
  }

  playerAction(action: string, body: Record<string, unknown>): Promise<any> {
    return this.request('POST', `/player/${action}`, { body });
  }

  historyAction(action: string, body: Record<string, unknown>): Promise<any> {
    return this.request('POST', `/history/${action}`, { body });
  }

  fxserverCommand(action: string, parameter: string): Promise<any> {
    return this.request('POST', '/fxserver/commands', { body: { action, parameter } });
  }

  fxserverControl(action: 'start' | 'stop' | 'restart'): Promise<any> {
    return this.request('POST', '/fxserver/controls', { body: { action } });
  }
}
