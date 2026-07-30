import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ConfigError } from '../src/txadmin/errors.js';

const base = {
  TXADMIN_URL: 'http://127.0.0.1:40120',
  TXADMIN_USER: 'admin',
  TXADMIN_PASS: 'hunter2',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(cfg.mode).toBe('write');
    expect(cfg.timeoutMs).toBe(15000);
    expect(cfg.insecureTls).toBe(false);
  });

  it('strips a trailing slash from the url', () => {
    const cfg = loadConfig({ ...base, TXADMIN_URL: 'http://x:40120/' } as NodeJS.ProcessEnv);
    expect(cfg.url).toBe('http://x:40120');
  });

  it('rejects a url with no scheme', () => {
    expect(() =>
      loadConfig({ ...base, TXADMIN_URL: '127.0.0.1:40120' } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  it('rejects an unknown mode', () => {
    expect(() =>
      loadConfig({ ...base, TXADMIN_MODE: 'god' } as NodeJS.ProcessEnv),
    ).toThrow(/read.*write.*admin/);
  });

  it('names the missing variable', () => {
    expect(() =>
      loadConfig({ TXADMIN_URL: base.TXADMIN_URL } as NodeJS.ProcessEnv),
    ).toThrow(/TXADMIN_USER/);
  });

  it('rejects a timeout below one second', () => {
    expect(() =>
      loadConfig({ ...base, TXADMIN_TIMEOUT_MS: '10' } as NodeJS.ProcessEnv),
    ).toThrow(/TXADMIN_TIMEOUT_MS/);
  });
});
