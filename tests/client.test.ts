import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockTxAdmin, type MockHandle, type MockOptions } from './mock/mock-txadmin.js';
import { SessionManager } from '../src/txadmin/session.js';
import { TxAdminClient } from '../src/txadmin/client.js';
import { ServerOfflineError, NotTxAdminError, PermissionError } from '../src/txadmin/errors.js';
import type { Config } from '../src/config.js';

let handle: MockHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function build(opts: MockOptions = {}) {
  handle = await startMockTxAdmin(opts);
  const dir = await mkdtemp(join(tmpdir(), 'txmcp-'));
  const cfg: Config = {
    url: handle.url,
    user: 'admin',
    pass: 'hunter2',
    mode: 'admin',
    timeoutMs: 5000,
    insecureTls: false,
  };
  return new TxAdminClient(cfg, new SessionManager(cfg, dir));
}

describe('TxAdminClient', () => {
  it('sends the csrf header on every api call', async () => {
    const client = await build();
    await client.authSelf();
    expect(handle!.calls.find((c) => c.path === '/auth/self')!.hadCsrf).toBe(true);
  });

  it('serialises query params and drops undefined ones', async () => {
    const client = await build();
    await client.playerModal({ license: 'abc', netid: undefined });
    expect(handle!.calls.find((c) => c.path === '/player')!.query).toEqual({ license: 'abc' });
  });

  it('always sends a valid sortingKey for player search', async () => {
    const client = await build();
    await client.playerSearch({ searchValue: 'bob', searchType: 'playerName' });
    const query = handle!.calls.find((c) => c.path === '/player/search')!.query;
    expect(['playTime', 'tsJoined', 'tsLastConnection']).toContain(query.sortingKey);
  });

  it('always sends sortingKey=timestamp for history search', async () => {
    const client = await build();
    await client.historySearch({ filterbyType: 'ban' });
    expect(handle!.calls.find((c) => c.path === '/history/search')!.query.sortingKey).toBe('timestamp');
  });

  it('re-logs in exactly once when the session is rejected', async () => {
    const client = await build();
    await client.authSelf();
    handle!.expireSessions();
    await client.authSelf();
    expect(handle!.loginCount).toBe(2);
  });

  it('maps "server is not running" to ServerOfflineError', async () => {
    const client = await build({ serverOnline: false });
    await expect(client.fxserverCommand('restart_res', 'chat')).rejects.toThrow(ServerOfflineError);
  });

  it('maps a permission refusal to PermissionError naming the account', async () => {
    const client = await build({ permissions: ['players.warn'] });
    await expect(client.fxserverCommand('admin_broadcast', 'hi')).rejects.toThrow(PermissionError);
    await expect(client.fxserverCommand('admin_broadcast', 'hi')).rejects.toThrow(/Admin Manager/);
  });

  it('maps an html response to NotTxAdminError mentioning the proxy case', async () => {
    const client = await build();
    await expect(client.request('GET', '/definitely-html')).rejects.toThrow(NotTxAdminError);
    await expect(client.request('GET', '/definitely-html')).rejects.toThrow(/reverse proxy/i);
  });

  it('returns parsed payloads for reads', async () => {
    const client = await build();
    const { players } = await client.playerSearch({});
    expect(players[0].displayName).toBe('TestPlayer');
    const { player } = await client.playerModal({ license: 'license:aaaa1111' });
    expect(player.actionHistory).toHaveLength(1);
  });
});
