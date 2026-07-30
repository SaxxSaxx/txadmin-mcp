import { describe, it, expect, afterEach } from 'vitest';
import { startMockTxAdmin, type MockHandle } from './mock-txadmin.js';

let handle: MockHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function login(url: string, password = 'hunter2') {
  return fetch(`${url}/auth/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
}

describe('MockTxAdmin', () => {
  it('issues a hashed session cookie and a csrf token on login', async () => {
    handle = await startMockTxAdmin();
    const res = await login(handle.url);
    const body = await res.json();
    expect(body.csrfToken).toMatch(/.+/);
    expect(res.headers.get('set-cookie')).toMatch(/^txAdmin-sess:[a-f0-9]+=/);
  });

  it('rejects an api call missing the csrf header', async () => {
    handle = await startMockTxAdmin();
    const res = await login(handle.url);
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    const body = await (await fetch(`${handle.url}/auth/self`, { headers: { cookie } })).json();
    expect(body.error).toMatch(/csrftoken/i);
  });

  it('reports a missing session when no cookie is sent', async () => {
    handle = await startMockTxAdmin();
    const body = await (await fetch(`${handle.url}/auth/self`)).json();
    expect(body.logout).toBe(true);
  });

  it('reports wrong credentials without counting a login', async () => {
    handle = await startMockTxAdmin();
    const body = await (await login(handle.url, 'wrong')).json();
    expect(body.error).toMatch(/Wrong username or password/);
    expect(handle.loginCount).toBe(0);
  });

  it('returns the rate limit body when configured', async () => {
    handle = await startMockTxAdmin({ rateLimited: true });
    const body = await (await login(handle.url)).json();
    expect(body.error).toMatch(/Too many attempts/);
  });

  it('refuses fxserver commands while the server is offline', async () => {
    handle = await startMockTxAdmin({ serverOnline: false });
    const res = await login(handle.url);
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    const { csrfToken } = await res.json();
    const body = await (
      await fetch(`${handle.url}/fxserver/commands`, {
        method: 'POST',
        headers: { cookie, 'x-txadmin-csrftoken': csrfToken, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'restart_res', parameter: 'chat' }),
      })
    ).json();
    expect(body.msg).toMatch(/not running/i);
  });

  it('expireSessions forces the next call to look logged out', async () => {
    handle = await startMockTxAdmin();
    const res = await login(handle.url);
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    const { csrfToken } = await res.json();
    handle.expireSessions();
    const body = await (
      await fetch(`${handle.url}/auth/self`, { headers: { cookie, 'x-txadmin-csrftoken': csrfToken } })
    ).json();
    expect(body.logout).toBe(true);
  });
});
