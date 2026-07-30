#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type Config } from './config.js';
import { SessionManager } from './txadmin/session.js';
import { TxAdminClient } from './txadmin/client.js';
import { TxAdminSocket } from './txadmin/socket.js';
import { registerTools } from './tools/registry.js';
import { readTools } from './tools/read.js';
import { writeTools } from './tools/write.js';
import { adminTools } from './tools/admin.js';
import { TxAdminError } from './txadmin/errors.js';
import type { ToolCtx, ToolDef } from './tools/types.js';

export const VERSION = '0.1.0';

export const ALL_TOOLS: ToolDef[] = [...readTools, ...writeTools, ...adminTools];

export interface BuiltServer {
  server: McpServer;
  registered: ToolDef[];
  ctx: ToolCtx;
}

/**
 * Authenticate, discover what this txAdmin account may actually do, and expose
 * only the tools that pass both that check and the configured mode.
 */
export async function buildServer(cfg: Config): Promise<BuiltServer> {
  const session = new SessionManager(cfg);
  const { admin } = await session.get();

  const ctx: ToolCtx = {
    cfg,
    client: new TxAdminClient(cfg, session),
    socket: new TxAdminSocket(cfg, session),
    admin,
    registeredNames: [],
  };

  const server = new McpServer({ name: 'txadmin-mcp', version: VERSION });
  const registered = registerTools(server, ALL_TOOLS, ctx);

  return { server, registered, ctx };
}

/** Diagnostics go to stderr — stdout carries the MCP protocol itself. */
function log(message: string): void {
  process.stderr.write(`[txadmin-mcp] ${message}\n`);
}

async function main(): Promise<void> {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    log('See https://github.com/SaxxSaxx/txadmin-mcp#configuration for the full variable list.');
    process.exit(1);
  }

  let built: BuiltServer;
  try {
    built = await buildServer(cfg);
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    if (err instanceof TxAdminError && err.kind === 'auth') {
      log('Verify TXADMIN_USER and TXADMIN_PASS by logging into the panel in a browser.');
    }
    process.exit(1);
  }

  const { server, registered, ctx } = built;
  const skipped = ALL_TOOLS.length - registered.length;

  await server.connect(new StdioServerTransport());

  log(
    `Connected to ${cfg.url} as "${ctx.admin.name}" — ` +
      `${registered.length} tools registered in ${cfg.mode} mode` +
      (skipped ? `, ${skipped} withheld by mode or account permissions` : ''),
  );
}

/** True only when this file is the process entry point, not an import. */
function isMainModule(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return realpathSync(argv) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

// Guarded so tests can import buildServer without starting a stdio server.
if (isMainModule()) {
  main().catch((err) => {
    log(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
