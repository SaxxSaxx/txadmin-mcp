/**
 * A fake txAdmin that reproduces the real authentication handshake.
 *
 * Every behaviour here mirrors a specific place in citizenfx/txAdmin. A mock
 * that were more permissive than the real thing would hide exactly the bugs
 * this project exists to avoid (a missing CSRF header, a socket handshake
 * without `rooms`), so it is deliberately strict.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { Server as SocketIOServer } from 'socket.io';

export interface MockOptions {
  username?: string;
  password?: string;
  permissions?: string[];
  isMaster?: boolean;
  /** Return txAdmin's rate-limiter body from /auth/password. */
  rateLimited?: boolean;
  /** When false, /fxserver/commands refuses like a stopped FXServer does. */
  serverOnline?: boolean;
  consoleBuffer?: string;
}

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  hadCsrf: boolean;
}

export interface MockHandle {
  url: string;
  calls: RecordedCall[];
  loginCount: number;
  lastHandshakeQuery: Record<string, unknown> | undefined;
  /** Invalidate every issued cookie, forcing the client down its relogin path. */
  expireSessions(): void;
  close(): Promise<void>;
}

/** Mirrors PlayersTablePlayerType. */
export const CANNED_PLAYERS = [
  {
    license: 'license:aaaa1111',
    displayName: 'TestPlayer',
    playTime: 320,
    tsJoined: 1750000000,
    tsLastConnection: 1753000000,
    isAdmin: false,
    isOnline: true,
    isWhitelisted: true,
  },
];

/** Mirrors HistoryTableActionType. */
export const CANNED_HISTORY = [
  {
    id: 'BAN-1A2B',
    type: 'ban' as const,
    playerName: 'TestPlayer',
    author: 'admin',
    reason: 'cheating',
    timestamp: 1752000000,
    isRevoked: false,
    banExpiration: 'active' as const,
  },
];

/** Mirrors PlayerModalSuccess. */
export const CANNED_MODAL = {
  serverTime: 1753000000,
  banTemplates: [],
  player: {
    displayName: 'TestPlayer',
    pureName: 'testplayer',
    isRegistered: true,
    isConnected: true,
    idsOffline: ['license:aaaa1111', 'discord:123'],
    idsOnline: ['license:aaaa1111'],
    hwidsOffline: [],
    hwidsOnline: [],
    license: 'license:aaaa1111',
    actionHistory: [
      {
        id: 'WARN-9Z8Y',
        type: 'warn' as const,
        author: 'admin',
        reason: 'spamming chat',
        ts: 1751000000,
      },
    ],
    netid: 42,
    sessionTime: 90,
    tsJoined: 1750000000,
    playTime: 320,
    notes: 'known good player',
  },
};

/** Mirrors the shape of txManager.globalStatus. */
export const CANNED_STATUS = {
  server: { status: 'ONLINE', process: 'running', instantiated: true, name: 'Mock RP' },
  discord: 'ready',
  scheduler: { nextRelativeMs: 3600000, nextSkip: false },
};

export const CANNED_DIAGNOSTICS = {
  host: { cpu: { count: 4, speed: '3.2 GHz', usage: 22 }, memory: { usage: 41, total: '16 GB' } },
  txadmin: { uptime: '2 hours', fullCrashes: 0, txAdminVersion: '8.0.0' },
  fxserver: { fxServerVersion: '12345', uptime: '1 hour' },
  processes: [],
};

export const CANNED_PLAYER_DROPS = {
  summary: [
    { reason: 'timeout', count: 12 },
    { reason: 'crash', count: 3 },
  ],
};

const jsonHeaders = { 'content-type': 'application/json' };

export async function startMockTxAdmin(opts: MockOptions = {}): Promise<MockHandle> {
  const username = opts.username ?? 'admin';
  const password = opts.password ?? 'hunter2';
  const permissions = opts.permissions ?? ['all_permissions'];
  const isMaster = opts.isMaster ?? false;
  const serverOnline = opts.serverOnline ?? true;
  const consoleBuffer = opts.consoleBuffer ?? 'FXServer started\nresource chat started';

  const calls: RecordedCall[] = [];
  /** sessionId -> csrfToken */
  let sessions = new Map<string, string>();
  let loginCount = 0;
  let lastHandshakeQuery: Record<string, unknown> | undefined;

  // Mirrors WebServer/index.ts:60 — the cookie name embeds a hash of the base path.
  const cookieName = `txAdmin-sess:${createHash('sha1').update('/').digest('hex').slice(0, 8)}`;

  const authData = () => ({
    name: username,
    permissions: isMaster ? ['all_permissions'] : permissions,
    isMaster,
    isTempPassword: false,
    profilePicture: undefined,
  });

  const hasPerm = (perm: string) =>
    isMaster || permissions.includes('all_permissions') || permissions.includes(perm);

  /** Returns the csrf token for the request's cookie, or undefined. */
  const sessionOf = (req: IncomingMessage): string | undefined => {
    const raw = req.headers.cookie;
    if (!raw) return undefined;
    for (const part of raw.split(';')) {
      const [k, v] = part.trim().split('=');
      if (k === cookieName && v) return sessions.get(v);
    }
    return undefined;
  };

  const send = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...jsonHeaders, ...extra });
    res.end(JSON.stringify(body));
  };

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams.entries());

    let body: any = undefined;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
    }

    const hadCsrf = typeof req.headers['x-txadmin-csrftoken'] === 'string';
    calls.push({ method: req.method ?? 'GET', path, query, body, hadCsrf });

    // --- login (routes/authentication/verifyPassword.ts) ---
    if (path === '/auth/password' && req.method === 'POST') {
      if (opts.rateLimited) {
        return send(res, 429, { error: 'Too many attempts. Blocked for 15 minutes.' });
      }
      if (body?.username !== username || body?.password !== password) {
        return send(res, 200, { error: 'Wrong username or password!' });
      }
      loginCount += 1;
      const sessId = randomBytes(12).toString('hex');
      const csrfToken = randomBytes(8).toString('hex');
      sessions.set(sessId, csrfToken);
      return send(res, 200, { ...authData(), csrfToken }, {
        'set-cookie': `${cookieName}=${sessId}; Path=/; HttpOnly; SameSite=Lax`,
      });
    }

    // --- everything below requires an authenticated session (apiAuthMw) ---
    const csrf = sessionOf(req);
    if (!csrf) {
      return send(res, 200, { logout: true, reason: 'no session' });
    }
    if (req.headers['x-txadmin-csrftoken'] !== csrf) {
      const msg =
        "Error: Missing HTTP header 'x-txadmin-csrftoken'. This likely means your files are not " +
        'updated or you are using some reverse proxy that is removing this header from the HTTP request.';
      return send(res, 200, { type: 'error', msg, error: msg });
    }

    switch (path) {
      case '/auth/self':
        return send(res, 200, { ...authData(), csrfToken: csrf });

      case '/diagnostics/getDiagnostics':
        return send(res, 200, CANNED_DIAGNOSTICS);

      case '/player/search':
        return send(res, 200, { players: CANNED_PLAYERS, hasReachedEnd: true });

      case '/player':
        return send(res, 200, CANNED_MODAL);

      case '/history/search':
        return send(res, 200, { history: CANNED_HISTORY, hasReachedEnd: true });

      case '/playerDropsData':
        return send(res, 200, CANNED_PLAYER_DROPS);

      case '/serverLog/partial':
        return send(res, 200, {
          boundry: true,
          log: [{ ts: 1753000000, type: 'chatMessage', data: { author: 'TestPlayer', text: 'hello' } }],
        });

      case '/fxserver/commands': {
        if (!serverOnline) {
          return send(res, 200, { type: 'error', msg: 'The server is not running.' });
        }
        if (body?.action === 'admin_broadcast' && !hasPerm('announcement')) {
          return send(res, 200, { type: 'error', msg: "You don't have permission to execute this action." });
        }
        return send(res, 200, { type: 'success', msg: `${body?.action} sent.` });
      }

      case '/fxserver/controls':
        return send(res, 200, { type: 'success', msg: `Server ${body?.action} requested.` });

      case '/history/revokeAction':
        return send(res, 200, { type: 'success', msg: 'Action revoked.' });
    }

    if (path.startsWith('/player/')) {
      return send(res, 200, { type: 'success', msg: `${path.slice('/player/'.length)} ok` });
    }

    if (path === '/definitely-html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><body>login page</body></html>');
    }

    return send(res, 404, { error: `unknown route ${path}` });
  });

  const io = new SocketIOServer(httpServer, { serveClient: false });

  // Mirrors WebServer/webSocket.ts handleConnection.
  const ROOMS: Record<string, { permission: string | true; eventName: string; initialData: () => unknown }> = {
    status: { permission: true, eventName: 'status', initialData: () => CANNED_STATUS },
    playerlist: {
      permission: true,
      eventName: 'playerlist',
      initialData: () => [
        {
          mutex: 'abc123',
          type: 'fullPlayerlist',
          playerlist: [
            { netid: 42, displayName: 'TestPlayer', pureName: 'testplayer', license: 'license:aaaa1111' },
          ],
        },
      ],
    },
    liveconsole: { permission: 'console.view', eventName: 'consoleData', initialData: () => consoleBuffer },
    serverlog: { permission: 'server.log.view', eventName: 'logData', initialData: () => [] },
  };

  io.on('connection', (socket) => {
    lastHandshakeQuery = { ...socket.handshake.query };

    // Session check, same as the REST side.
    const raw = socket.handshake.headers.cookie ?? '';
    let ok = false;
    for (const part of raw.split(';')) {
      const [k, v] = part.trim().split('=');
      if (k === cookieName && v && sessions.has(v)) ok = true;
    }
    if (!ok) {
      socket.emit('logout', 'invalid session');
      return socket.disconnect();
    }

    const requested = String(socket.handshake.query.rooms ?? '')
      .split(',')
      .filter((r, i, arr) => r && arr.indexOf(r) === i)
      .filter((r) => r in ROOMS);
    if (!requested.length) {
      return socket.disconnect();
    }

    for (const name of requested) {
      const room = ROOMS[name];
      // The trap this whole design guards against: no permission means the
      // server silently skips the room and leaves the socket connected.
      if (room.permission !== true && !hasPerm(room.permission)) continue;

      if (name === 'liveconsole') {
        socket.on('consoleCommand', (command: string) => {
          socket.emit('consoleData', `> ${command}\ncommand executed`);
        });
      }
      socket.join(name);
      socket.emit(room.eventName, room.initialData());
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    get loginCount() {
      return loginCount;
    },
    get lastHandshakeQuery() {
      return lastHandshakeQuery;
    },
    expireSessions() {
      sessions = new Map();
    },
    async close() {
      await io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

export type { Server as MockServer };
