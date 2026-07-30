import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockTxAdmin, type MockHandle, type MockOptions } from './mock/mock-txadmin.js';
import { SessionManager } from '../src/txadmin/session.js';
import { TxAdminSocket } from '../src/txadmin/socket.js';
import { PermissionError } from '../src/txadmin/errors.js';
import type { Config } from '../src/config.js';

let handle: MockHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function build(opts: MockOptions = {}, timeoutMs = 3000) {
  handle = await startMockTxAdmin(opts);
  const dir = await mkdtemp(join(tmpdir(), 'txmcp-'));
  const cfg: Config = {
    url: handle.url,
    user: 'admin',
    pass: 'hunter2',
    mode: 'admin',
    timeoutMs,
    insecureTls: false,
  };
  return new TxAdminSocket(cfg, new SessionManager(cfg, dir));
}

describe('TxAdminSocket', () => {
  it('reads the console buffer from the liveconsole room', async () => {
    const socket = await build({ consoleBuffer: 'hello from fxserver' });
    expect(await socket.readRoom<string>('liveconsole', 'consoleData')).toContain(
      'hello from fxserver',
    );
  });

  it('reads the playerlist room', async () => {
    const socket = await build();
    const data = await socket.readRoom<any[]>('playerlist', 'playerlist');
    expect(data[0].playerlist[0].displayName).toBe('TestPlayer');
  });

  it('reads the status room', async () => {
    const socket = await build();
    const data = await socket.readRoom<any>('status', 'status');
    expect(data.server.status).toBe('ONLINE');
  });

  it('reports a silent room as a permission problem, not an empty console', async () => {
    const socket = await build({ permissions: ['players.warn'] }, 1500);
    await expect(socket.readRoom('liveconsole', 'consoleData')).rejects.toThrow(PermissionError);
    await expect(socket.readRoom('liveconsole', 'consoleData')).rejects.toThrow(/console\.view/);
  });

  it('sends a console command and returns the resulting output', async () => {
    const socket = await build();
    expect(await socket.sendConsoleCommand('status')).toContain('status');
  });

  it('does not send uiVersion in the handshake', async () => {
    const socket = await build();
    await socket.readRoom('status', 'status');
    expect(handle!.lastHandshakeQuery).toBeDefined();
    expect(handle!.lastHandshakeQuery).not.toHaveProperty('uiVersion');
    expect(handle!.lastHandshakeQuery!.rooms).toBe('status');
  });
});
