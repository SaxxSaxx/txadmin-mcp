import { ConfigError } from './txadmin/errors.js';

/**
 * Tool exposure tier. Cumulative: `write` includes read, `admin` includes both.
 */
export type Mode = 'read' | 'write' | 'admin';

const MODES: readonly Mode[] = ['read', 'write', 'admin'];

export interface Config {
  readonly url: string;
  readonly user: string;
  readonly pass: string;
  readonly mode: Mode;
  readonly timeoutMs: number;
  readonly insecureTls: boolean;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new ConfigError(
      `Missing required environment variable ${key}. ` +
        `txadmin-mcp needs TXADMIN_URL, TXADMIN_USER and TXADMIN_PASS.`,
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = required(env, 'TXADMIN_URL');
  if (!/^https?:\/\//i.test(rawUrl)) {
    throw new ConfigError(
      `TXADMIN_URL must start with http:// or https:// (got "${rawUrl}"). ` +
        `A typical value is http://127.0.0.1:40120`,
    );
  }
  const url = rawUrl.replace(/\/+$/, '');

  const mode = (env.TXADMIN_MODE?.trim() || 'write') as Mode;
  if (!MODES.includes(mode)) {
    throw new ConfigError(
      `TXADMIN_MODE must be one of read, write, admin (got "${mode}").`,
    );
  }

  const rawTimeout = env.TXADMIN_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? Number(rawTimeout) : 15000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    throw new ConfigError(
      `TXADMIN_TIMEOUT_MS must be a number >= 1000 (got "${rawTimeout}").`,
    );
  }

  return Object.freeze({
    url,
    user: required(env, 'TXADMIN_USER'),
    pass: required(env, 'TXADMIN_PASS'),
    mode,
    timeoutMs,
    insecureTls: env.TXADMIN_INSECURE_TLS?.trim() === 'true',
  });
}
