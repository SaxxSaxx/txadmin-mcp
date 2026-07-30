import { mkdir, readFile, writeFile, unlink, chmod, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { AuthError, RateLimitError, VersionError, NotTxAdminError } from './errors.js';

export interface AdminInfo {
  name: string;
  permissions: string[];
  isMaster: boolean;
}

export interface Session {
  cookieHeader: string;
  csrfToken: string;
  admin: AdminInfo;
}

interface CachedSession extends Session {
  createdAt: number;
}

/**
 * Mirrors AuthedAdmin.hasPermission in txAdmin's WebServer/authLogic.ts.
 */
export function hasPermission(admin: AdminInfo, perm: string): boolean {
  if (admin.isMaster) return true;
  if (admin.permissions.includes('all_permissions')) return true;
  return admin.permissions.includes(perm);
}

function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  return xdg ? join(xdg, 'txadmin-mcp') : join(homedir(), '.cache', 'txadmin-mcp');
}

/**
 * Owns authentication against txAdmin.
 *
 * txAdmin rate-limits /auth/password to 10 attempts per 15 minutes per source
 * IP, and an MCP server over stdio is spawned fresh for every client session.
 * Logging in per process would burn that budget in a day and lock the operator
 * out of their own panel, so sessions are cached to disk and validated with a
 * cheap GET rather than re-established.
 */
export class SessionManager {
  private readonly cacheDir: string;
  private readonly cacheFile: string;
  private memo: Session | undefined;
  private blockedUntil = 0;
  private inFlight: Promise<Session> | undefined;

  constructor(private readonly cfg: Config, cacheDir?: string) {
    this.cacheDir = cacheDir ?? defaultCacheDir();
    const key = createHash('sha256').update(`${cfg.url} ${cfg.user}`).digest('hex').slice(0, 32);
    this.cacheFile = join(this.cacheDir, `${key}.json`);
  }

  async get(): Promise<Session> {
    if (this.memo) return this.memo;
    // Collapse concurrent callers onto one login rather than racing several.
    this.inFlight ??= this.resolve().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async resolve(): Promise<Session> {
    if (Date.now() < this.blockedUntil) {
      const secs = Math.ceil((this.blockedUntil - Date.now()) / 1000);
      throw new RateLimitError(
        `txAdmin has rate-limited logins from this machine. Waiting ~${secs}s. ` +
          `Retrying sooner only extends the block.`,
      );
    }

    const cached = await this.readCache();
    if (cached && (await this.validate(cached))) {
      this.memo = cached;
      return cached;
    }

    const fresh = await this.login();
    this.memo = fresh;
    await this.writeCache(fresh);
    return fresh;
  }

  /** Cheap check that a cached cookie is still good. Avoids spending a login. */
  private async validate(session: Session): Promise<boolean> {
    try {
      const res = await fetch(new URL('/auth/self', this.cfg.url), {
        headers: {
          cookie: session.cookieHeader,
          'x-txadmin-csrftoken': session.csrfToken,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      if (!res.headers.get('content-type')?.includes('json')) return false;
      const body: any = await res.json();
      if (body?.logout || body?.error) return false;
      if (typeof body?.name !== 'string') return false;
      session.admin = {
        name: body.name,
        permissions: Array.isArray(body.permissions) ? body.permissions : [],
        isMaster: Boolean(body.isMaster),
      };
      return true;
    } catch {
      return false;
    }
  }

  private async login(): Promise<Session> {
    // No `uiVersion` query: a mismatch makes txAdmin answer `refreshToUpdate`.
    const res = await fetch(new URL('/auth/password', this.cfg.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username: this.cfg.user, password: this.cfg.pass }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });

    if (!res.headers.get('content-type')?.includes('json')) {
      throw new NotTxAdminError(
        `${this.cfg.url} did not return JSON from /auth/password. ` +
          `Check that TXADMIN_URL points at a txAdmin panel (usually port 40120).`,
      );
    }

    const body: any = await res.json();

    if (typeof body?.error === 'string') {
      if (/too many attempts/i.test(body.error)) {
        const minutes = Number(body.error.match(/(\d+)\s*minutes?/i)?.[1] ?? 15);
        this.blockedUntil = Date.now() + minutes * 60_000;
        throw new RateLimitError(
          `txAdmin rejected the login: ${body.error} ` +
            `This limit is per source IP and also blocks you from the web panel. Wait it out.`,
        );
      }
      if (body.error === 'refreshToUpdate') {
        throw new VersionError(
          `txAdmin reported a version mismatch during login. Update txadmin-mcp, ` +
            `or open an issue if this persists.`,
        );
      }
      if (body.error === 'no_admins_setup') {
        throw new AuthError(`This txAdmin instance has no admin accounts configured yet.`);
      }
      throw new AuthError(
        `txAdmin rejected the login for "${this.cfg.user}": ${body.error}`,
      );
    }

    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) {
      throw new AuthError(
        `txAdmin accepted the credentials but set no session cookie. ` +
          `A reverse proxy may be stripping Set-Cookie.`,
      );
    }
    if (typeof body?.csrfToken !== 'string' || body.csrfToken === 'not_set') {
      throw new AuthError(`txAdmin returned no CSRF token for this session.`);
    }

    return {
      // The cookie name embeds a hash of the panel's base path, so it is read
      // from the response rather than assumed.
      cookieHeader: setCookie.split(';')[0],
      csrfToken: body.csrfToken,
      admin: {
        name: body.name,
        permissions: Array.isArray(body.permissions) ? body.permissions : [],
        isMaster: Boolean(body.isMaster),
      },
    };
  }

  async invalidate(): Promise<void> {
    this.memo = undefined;
    try {
      await unlink(this.cacheFile);
    } catch {
      // Nothing cached; nothing to do.
    }
  }

  private async readCache(): Promise<Session | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.cacheFile, 'utf8')) as CachedSession;
      if (!parsed?.cookieHeader || !parsed?.csrfToken) return undefined;
      return { cookieHeader: parsed.cookieHeader, csrfToken: parsed.csrfToken, admin: parsed.admin };
    } catch {
      return undefined;
    }
  }

  /**
   * The cache holds a live session cookie, which is credential-equivalent. If
   * the file cannot be made owner-only it is removed rather than left readable.
   */
  private async writeCache(session: Session): Promise<void> {
    const payload: CachedSession = { ...session, createdAt: Date.now() };
    try {
      await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
      await writeFile(this.cacheFile, JSON.stringify(payload), { mode: 0o600 });
      await chmod(this.cacheFile, 0o600);
      const mode = (await stat(this.cacheFile)).mode & 0o777;
      if (mode !== 0o600) {
        await unlink(this.cacheFile);
      }
    } catch {
      try {
        await unlink(this.cacheFile);
      } catch {
        // Best effort: running without a cache is correct, just slower.
      }
    }
  }
}
