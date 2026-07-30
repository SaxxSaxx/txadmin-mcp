import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockTxAdmin, type MockHandle, type MockOptions } from './mock/mock-txadmin.js';
import { SessionManager } from '../src/txadmin/session.js';
import { TxAdminClient } from '../src/txadmin/client.js';
import { TxAdminSocket } from '../src/txadmin/socket.js';
import { readTools } from '../src/tools/read.js';
import { writeTools } from '../src/tools/write.js';
import { adminTools } from '../src/tools/admin.js';
import { selectTools } from '../src/tools/registry.js';
import type { Config } from '../src/config.js';
import type { ToolCtx, ToolDef } from '../src/tools/types.js';

let handle: MockHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function ctx(opts: MockOptions = {}): Promise<ToolCtx> {
  handle = await startMockTxAdmin(opts);
  const dir = await mkdtemp(join(tmpdir(), 'txmcp-'));
  const cfg: Config = {
    url: handle.url,
    user: 'admin',
    pass: 'hunter2',
    mode: 'admin',
    timeoutMs: 4000,
    insecureTls: false,
  };
  const session = new SessionManager(cfg, dir);
  const { admin } = await session.get();
  return {
    cfg,
    client: new TxAdminClient(cfg, session),
    socket: new TxAdminSocket(cfg, session),
    admin,
    registeredNames: ['txadmin_whoami'],
  };
}

const all: ToolDef[] = [...readTools, ...writeTools, ...adminTools];
const tool = (name: string) => all.find((t) => t.name === name)!;

describe('tool inventory', () => {
  it('exposes 16 tools across three tiers', () => {
    expect(readTools).toHaveLength(9);
    expect(writeTools).toHaveLength(3);
    expect(adminTools).toHaveLength(4);
    expect(all).toHaveLength(16);
  });

  it('every tool name is unique and prefixed', () => {
    const names = all.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith('txadmin_'))).toBe(true);
  });

  it('read tools are read-only, admin tools are destructive', () => {
    expect(readTools.every((t) => t.readOnly && !t.destructive)).toBe(true);
    expect(writeTools.every((t) => !t.readOnly && !t.destructive)).toBe(true);
    expect(adminTools.every((t) => !t.readOnly && t.destructive)).toBe(true);
  });

  it('every tool has a description of substance', () => {
    expect(all.every((t) => t.description.length > 60)).toBe(true);
  });

  it('console tools declare the permissions txAdmin actually enforces', () => {
    expect(tool('txadmin_read_console').permission).toBe('console.view');
    expect(tool('txadmin_console_command').permission).toBe('console.write');
    expect(tool('txadmin_read_server_log').permission).toBe('server.log.view');
  });

  it('no admin tool is exposed in write mode', () => {
    const master = { name: 'x', permissions: ['all_permissions'], isMaster: true };
    expect(selectTools(all, 'write', master).filter((t) => t.tier === 'admin')).toHaveLength(0);
  });
});

describe('read tools', () => {
  it('whoami reports the account and active tools', async () => {
    const out = await tool('txadmin_whoami').run({}, await ctx());
    expect(out).toMatch(/Account:\s+admin/);
    expect(out).toContain('txadmin_whoami');
  });

  it('status combines live status with diagnostics', async () => {
    const out = await tool('txadmin_status').run({}, await ctx());
    expect(out).toContain('ONLINE');
    expect(out).toMatch(/txAdmin 8\.0\.0/);
  });

  it('online_players renders a table of connected players', async () => {
    const out = await tool('txadmin_online_players').run({}, await ctx());
    expect(out).toMatch(/netid/);
    expect(out).toContain('TestPlayer');
    expect(out).toMatch(/untrusted/i);
  });

  it('find_player reports matches with playtime', async () => {
    const out = await tool('txadmin_find_player').run({ query: 'Test' }, await ctx());
    expect(out).toContain('TestPlayer');
    expect(out).toContain('5h 20m');
  });

  it('player_info includes the ban and warning history', async () => {
    const out = await tool('txadmin_player_info').run(
      { license: 'license:aaaa1111' },
      await ctx(),
    );
    expect(out).toContain('spamming chat');
    expect(out).toMatch(/Ban and warning history \(1\)/);
  });

  it('player_info refuses netid without mutex', async () => {
    await expect(tool('txadmin_player_info').run({ netid: 42 }, await ctx())).rejects.toThrow(
      /mutex/i,
    );
  });

  it('history_search lists moderation actions', async () => {
    const out = await tool('txadmin_history_search').run({ filterbyType: 'ban' }, await ctx());
    expect(out).toContain('BAN-1A2B');
    expect(out).toContain('cheating');
  });

  it('read_console strips ansi and marks output untrusted', async () => {
    const out = await tool('txadmin_read_console').run(
      { lines: 10 },
      await ctx({ consoleBuffer: '\x1b[31mboom\x1b[0m' }),
    );
    expect(out).toContain('boom');
    expect(out).not.toContain('[31m');
    expect(out).toMatch(/untrusted/i);
  });

  it('read_console applies grep', async () => {
    const c = await ctx({ consoleBuffer: 'alpha\nbravo\ncharlie' });
    const out = await tool('txadmin_read_console').run({ lines: 50, grep: 'brav' }, c);
    expect(out).toContain('bravo');
    expect(out).not.toContain('alpha');
  });

  it('read_console says so when grep matches nothing', async () => {
    const c = await ctx({ consoleBuffer: 'alpha' });
    const out = await tool('txadmin_read_console').run({ lines: 50, grep: 'zzz' }, c);
    expect(out).toMatch(/no console lines matched/i);
  });

  it('player_drops summarises drop reasons', async () => {
    const out = await tool('txadmin_player_drops').run({}, await ctx());
    expect(out).toContain('timeout');
    expect(out).toContain('12');
  });
});

describe('write tools', () => {
  it('announce posts admin_broadcast', async () => {
    await tool('txadmin_announce').run({ message: 'restart in 5' }, await ctx());
    const call = handle!.calls.find((c) => c.path === '/fxserver/commands')!;
    expect(call.body).toMatchObject({ action: 'admin_broadcast', parameter: 'restart in 5' });
  });

  it('resource_control maps restart to restart_res', async () => {
    await tool('txadmin_resource_control').run({ action: 'restart', resource: 'chat' }, await ctx());
    const call = handle!.calls.find((c) => c.path === '/fxserver/commands')!;
    expect(call.body).toMatchObject({ action: 'restart_res', parameter: 'chat' });
  });

  it('resource_control refuses restart with no resource name', async () => {
    await expect(
      tool('txadmin_resource_control').run({ action: 'restart' }, await ctx()),
    ).rejects.toThrow(/resource/i);
  });

  it('resource_control refresh needs no resource', async () => {
    const out = await tool('txadmin_resource_control').run({ action: 'refresh' }, await ctx());
    expect(out).toMatch(/refreshed/i);
  });

  it('player_action refuses warn with no reason', async () => {
    await expect(
      tool('txadmin_player_action').run({ action: 'warn', license: 'abc' }, await ctx()),
    ).rejects.toThrow(/reason/i);
  });

  it('player_action sends a warning when given one', async () => {
    await tool('txadmin_player_action').run(
      { action: 'warn', license: 'abc', reason: 'spam' },
      await ctx(),
    );
    expect(handle!.calls.some((c) => c.path === '/player/warn')).toBe(true);
  });

  it('announce surfaces the offline server clearly', async () => {
    await expect(
      tool('txadmin_announce').run({ message: 'hi' }, await ctx({ serverOnline: false })),
    ).rejects.toThrow(/not running/i);
  });
});

describe('admin tools', () => {
  it('ban refuses to default to permanent', async () => {
    await expect(
      tool('txadmin_player_punish').run(
        { action: 'ban', license: 'abc', reason: 'cheating' },
        await ctx(),
      ),
    ).rejects.toThrow(/duration/i);
  });

  it('ban proceeds with an explicit duration', async () => {
    const out = await tool('txadmin_player_punish').run(
      { action: 'ban', license: 'abc', reason: 'cheating', duration: '7 days' },
      await ctx(),
    );
    expect(out).toContain('7 days');
    expect(handle!.calls.some((c) => c.path === '/player/ban')).toBe(true);
  });

  it('kick does not require a duration', async () => {
    await tool('txadmin_player_punish').run(
      { action: 'kick', license: 'abc', reason: 'afk' },
      await ctx(),
    );
    expect(handle!.calls.some((c) => c.path === '/player/kick')).toBe(true);
  });

  it('server_control restart hits fxserver/controls', async () => {
    await tool('txadmin_server_control').run({ action: 'restart' }, await ctx());
    const call = handle!.calls.find((c) => c.path === '/fxserver/controls')!;
    expect(call.body).toMatchObject({ action: 'restart' });
  });

  it('server_control stop_resource requires a resource name', async () => {
    await expect(
      tool('txadmin_server_control').run({ action: 'stop_resource' }, await ctx()),
    ).rejects.toThrow(/resource/i);
  });

  it('revoke_action posts the action id', async () => {
    await tool('txadmin_revoke_action').run({ actionId: 'BAN-1A2B' }, await ctx());
    const call = handle!.calls.find((c) => c.path === '/history/revokeAction')!;
    expect(call.body).toMatchObject({ actionId: 'BAN-1A2B' });
  });

  it('console_command marks its output untrusted', async () => {
    const out = await tool('txadmin_console_command').run({ command: 'status' }, await ctx());
    expect(out).toMatch(/untrusted/i);
    expect(out).toContain('status');
  });
});
