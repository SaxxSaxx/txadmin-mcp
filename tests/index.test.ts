import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockTxAdmin, type MockHandle, type MockOptions } from './mock/mock-txadmin.js';
import { buildServer, ALL_TOOLS } from '../src/index.js';
import type { Config } from '../src/config.js';

let handle: MockHandle | undefined;
let cacheDir: string;

beforeEach(async () => {
  // buildServer uses the default cache location; point it somewhere disposable
  // so a developer's real session is never read or overwritten by the suite.
  cacheDir = await mkdtemp(join(tmpdir(), 'txmcp-xdg-'));
  process.env.XDG_CACHE_HOME = cacheDir;
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  delete process.env.XDG_CACHE_HOME;
});

const cfg = (url: string, over: Partial<Config> = {}): Config => ({
  url,
  user: 'admin',
  pass: 'hunter2',
  mode: 'write',
  timeoutMs: 5000,
  insecureTls: false,
  ...over,
});

async function mock(opts: MockOptions = {}) {
  handle = await startMockTxAdmin(opts);
  return handle;
}

describe('buildServer', () => {
  it('registers read and write tools for a master account in write mode', async () => {
    const m = await mock({ isMaster: true });
    const { registered } = await buildServer(cfg(m.url));
    const names = registered.map((t) => t.name);
    expect(names).toContain('txadmin_announce');
    expect(names).toContain('txadmin_read_console');
    expect(names).not.toContain('txadmin_player_punish');
  });

  it('exposes all 16 tools to a master account in admin mode', async () => {
    const m = await mock({ isMaster: true });
    const { registered } = await buildServer(cfg(m.url, { mode: 'admin' }));
    expect(registered).toHaveLength(16);
    expect(ALL_TOOLS).toHaveLength(16);
  });

  it('exposes only read tools in read mode', async () => {
    const m = await mock({ isMaster: true });
    const { registered } = await buildServer(cfg(m.url, { mode: 'read' }));
    expect(registered.every((t) => t.tier === 'read')).toBe(true);
    expect(registered).toHaveLength(9);
  });

  it('hides console tools when the account lacks console.view', async () => {
    const m = await mock({ permissions: ['announcement'], isMaster: false });
    const { registered } = await buildServer(cfg(m.url, { mode: 'admin' }));
    const names = registered.map((t) => t.name);
    expect(names).not.toContain('txadmin_read_console');
    expect(names).not.toContain('txadmin_console_command');
    expect(names).toContain('txadmin_announce');
  });

  it('a permissionless account still gets the open read tools', async () => {
    const m = await mock({ permissions: [], isMaster: false });
    const { registered } = await buildServer(cfg(m.url, { mode: 'admin' }));
    const names = registered.map((t) => t.name);
    expect(names).toContain('txadmin_whoami');
    expect(names).toContain('txadmin_online_players');
    expect(names).toContain('txadmin_player_info');
    expect(names).not.toContain('txadmin_server_control');
  });

  it('reports the registered tool names through the context', async () => {
    const m = await mock({ isMaster: true });
    const { ctx, registered } = await buildServer(cfg(m.url, { mode: 'admin' }));
    expect(ctx.registeredNames).toEqual(registered.map((t) => t.name));
  });
});
