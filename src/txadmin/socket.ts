import { io, type Socket } from 'socket.io-client';
import type { Config } from '../config.js';
import type { SessionManager } from './session.js';
import { AuthError, PermissionError, TimeoutError, TxAdminError, VersionError } from './errors.js';

export type RoomName = 'status' | 'playerlist' | 'liveconsole' | 'serverlog';

/** The permission txAdmin requires to join each room (wsRooms/*.ts). */
const ROOM_PERMISSION: Record<RoomName, string | null> = {
  status: null,
  playerlist: null,
  liveconsole: 'console.view',
  serverlog: 'server.log.view',
};

/** How long to keep collecting console output after issuing a command. */
const COMMAND_COLLECT_MS = 1500;

/**
 * Reads txAdmin's socket.io rooms.
 *
 * Two things about txAdmin's websocket drive this design:
 *
 * 1. Rooms are requested in the handshake query (`?rooms=liveconsole`), not by
 *    emitting a join event, and the server sends the room's initial data
 *    immediately on join. So a one-shot connect is enough to read the console
 *    buffer or the playerlist — no streaming subscription required.
 * 2. If the account lacks a room's permission the server neither errors nor
 *    disconnects; it just skips the room and leaves the socket connected and
 *    silent forever. That makes a permissions problem look exactly like an idle
 *    server, so a timeout while connected is reported as a permission problem.
 */
export class TxAdminSocket {
  constructor(
    private readonly cfg: Config,
    private readonly session: SessionManager,
  ) {}

  private async connect(room: RoomName): Promise<Socket> {
    const session = await this.session.get();
    return io(this.cfg.url, {
      transports: ['websocket'],
      extraHeaders: { Cookie: session.cookieHeader },
      // `rooms` only. Sending `uiVersion` makes txAdmin force a reload and
      // disconnect us whenever its version differs from whatever we claim.
      query: { rooms: room },
      reconnection: false,
      timeout: this.cfg.timeoutMs,
      rejectUnauthorized: !this.cfg.insecureTls,
    });
  }

  private permissionHint(room: RoomName): string {
    const perm = ROOM_PERMISSION[room];
    return perm
      ? `The txAdmin account is most likely missing the "${perm}" permission — txAdmin silently ` +
          `declines to join a room the account cannot see, instead of returning an error. ` +
          `Grant it in txAdmin's Admin Manager, then restart txadmin-mcp.`
      : `The server accepted the connection but sent no data for the "${room}" room.`;
  }

  /** Connect, take the room's initial payload, disconnect. */
  async readRoom<T = unknown>(room: RoomName, eventName: string): Promise<T> {
    const socket = await this.connect(room);
    let connected = false;

    try {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            connected
              ? new PermissionError(this.permissionHint(room))
              : new TimeoutError(
                  `Timed out connecting to the txAdmin websocket at ${this.cfg.url} ` +
                    `after ${this.cfg.timeoutMs}ms.`,
                ),
          );
        }, this.cfg.timeoutMs);

        const settle = (fn: () => void) => {
          clearTimeout(timer);
          fn();
        };

        socket.on('connect', () => {
          connected = true;
        });
        socket.on(eventName, (data: T) => settle(() => resolve(data)));
        socket.on('logout', (reason: string) =>
          settle(() => reject(new AuthError(`txAdmin closed the websocket session: ${reason}`))),
        );
        socket.on('refreshToUpdate', () =>
          settle(() =>
            reject(new VersionError(`txAdmin reported a version mismatch on the websocket.`)),
          ),
        );
        socket.on('txAdminShuttingDown', () =>
          settle(() => reject(new TxAdminError('shutdown', `txAdmin is shutting down.`))),
        );
        socket.on('connect_error', (err: Error) =>
          settle(() =>
            reject(
              new TxAdminError(
                'network',
                `Websocket connection to ${this.cfg.url} failed: ${err.message}`,
              ),
            ),
          ),
        );
      });
    } finally {
      // A leaked socket keeps the event loop alive and hangs the MCP server.
      socket.close();
    }
  }

  /** Join the live console, run a command, and return what it printed. */
  async sendConsoleCommand(command: string): Promise<string> {
    const socket = await this.connect('liveconsole');
    let connected = false;

    try {
      return await new Promise<string>((resolve, reject) => {
        const output: string[] = [];
        let joined = false;
        let collectTimer: NodeJS.Timeout | undefined;

        const connectTimer = setTimeout(() => {
          if (joined) return;
          reject(
            connected
              ? new PermissionError(this.permissionHint('liveconsole'))
              : new TimeoutError(`Timed out connecting to the txAdmin websocket.`),
          );
        }, this.cfg.timeoutMs);

        socket.on('connect', () => {
          connected = true;
        });

        socket.on('consoleData', (data: unknown) => {
          if (!joined) {
            // First payload is the pre-existing buffer, not our command's output.
            joined = true;
            clearTimeout(connectTimer);
            socket.emit('consoleCommand', command);
            collectTimer = setTimeout(() => resolve(output.join('')), COMMAND_COLLECT_MS);
            return;
          }
          output.push(typeof data === 'string' ? data : JSON.stringify(data));
        });

        socket.on('logout', (reason: string) => {
          clearTimeout(connectTimer);
          if (collectTimer) clearTimeout(collectTimer);
          reject(new AuthError(`txAdmin closed the websocket session: ${reason}`));
        });

        socket.on('connect_error', (err: Error) => {
          clearTimeout(connectTimer);
          reject(
            new TxAdminError('network', `Websocket connection failed: ${err.message}`),
          );
        });
      });
    } finally {
      socket.close();
    }
  }
}
