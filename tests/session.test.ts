import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockTxAdmin, type MockHandle } from './mock/mock-txadmin.js';
import { SessionManager, hasPermission } from '../src/txadmin/session.js';
import { AuthError, RateLimitError } from '../src/txadmin/errors.js';
import type { Config } from '../src/config.js';

let handle: MockHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
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

const tmp = () => mkdtemp(join(tmpdir(), 'txmcp-'));

describe('SessionManager', () => {
  it('logs in once and reuses the session in-process', async () => {
    handle = await startMockTxAdmin();
    const sm = new SessionManager(cfg(handle.url), await tmp());
    const a = await sm.get();
    const b = await sm.get();
    expect(a.csrfToken).toBe(b.csrfToken);
    expect(a.cookieHeader).toMatch(/^txAdmin-sess:/);
    expect(handle.loginCount).toBe(1);
  });

  it('reuses a cached session across manager instances', async () => {
    handle = await startMockTxAdmin();
    const dir = await tmp();
    await new SessionManager(cfg(handle.url), dir).get();
    await new SessionManager(cfg(handle.url), dir).get();
    expect(handle.loginCount).toBe(1);
  });

  it('collapses concurrent callers onto a single login', async () => {
    handle = await startMockTxAdmin();
    const sm = new SessionManager(cfg(handle.url), await tmp());
    await Promise.all([sm.get(), sm.get(), sm.get()]);
    expect(handle.loginCount).toBe(1);
  });

  it('writes the cache file 0600 and never stores the password', async () => {
    handle = await startMockTxAdmin();
    const dir = await tmp();
    await new SessionManager(cfg(handle.url), dir).get();
    const file = join(dir, (await readdir(dir))[0]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).not.toContain('hunter2');
  });

  it('reads the admin permissions from the login response', async () => {
    handle = await startMockTxAdmin({ permissions: ['players.ban', 'console.view'] });
    const session = await new SessionManager(cfg(handle.url), await tmp()).get();
    expect(session.admin.permissions).toEqual(['players.ban', 'console.view']);
    expect(session.admin.isMaster).toBe(false);
  });

  it('throws AuthError on bad credentials without counting a login', async () => {
    handle = await startMockTxAdmin();
    const sm = new SessionManager(cfg(handle.url, { pass: 'wrong' }), await tmp());
    await expect(sm.get()).rejects.toThrow(AuthError);
    expect(handle.loginCount).toBe(0);
  });

  it('throws RateLimitError and makes no second network attempt', async () => {
    handle = await startMockTxAdmin({ rateLimited: true });
    const sm = new SessionManager(cfg(handle.url), await tmp());
    await expect(sm.get()).rejects.toThrow(RateLimitError);
    await expect(sm.get()).rejects.toThrow(RateLimitError);
    expect(handle.calls.filter((c) => c.path === '/auth/password')).toHaveLength(1);
  });

  it('invalidate clears the cache so the next get logs in again', async () => {
    handle = await startMockTxAdmin();
    const sm = new SessionManager(cfg(handle.url), await tmp());
    await sm.get();
    await sm.invalidate();
    await sm.get();
    expect(handle.loginCount).toBe(2);
  });
});

describe('hasPermission', () => {
  const admin = (permissions: string[], isMaster = false) => ({ name: 'x', permissions, isMaster });

  it('honours the exact permission', () => {
    expect(hasPermission(admin(['players.ban']), 'players.ban')).toBe(true);
  });

  it('honours all_permissions', () => {
    expect(hasPermission(admin(['all_permissions']), 'control.server')).toBe(true);
  });

  it('honours isMaster', () => {
    expect(hasPermission(admin([], true), 'console.write')).toBe(true);
  });

  it('denies otherwise', () => {
    expect(hasPermission(admin(['players.warn']), 'players.ban')).toBe(false);
  });
});
