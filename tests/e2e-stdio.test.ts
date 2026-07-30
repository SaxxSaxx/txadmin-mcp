/**
 * End-to-end test through the real MCP stdio transport.
 *
 * The unit tests all call tool functions directly, so none of them would catch
 * a stray console.log writing to stdout — which silently corrupts the JSON-RPC
 * stream and breaks the server for every client. This spawns the built binary
 * and talks to it exactly as Claude Code would.
 *
 * Requires `npm run build` first; CI builds before testing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startMockTxAdmin, type MockHandle } from './mock/mock-txadmin.js';

const DIST = resolve(__dirname, '..', 'dist', 'index.js');

let handle: MockHandle | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close().catch(() => {});
  client = undefined;
  await handle?.close();
  handle = undefined;
});

async function connect(mode: string) {
  handle = await startMockTxAdmin({ isMaster: true });
  const cache = await mkdtemp(join(tmpdir(), 'txmcp-e2e-'));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST],
    env: {
      PATH: process.env.PATH ?? '',
      XDG_CACHE_HOME: cache,
      TXADMIN_URL: handle.url,
      TXADMIN_USER: 'admin',
      TXADMIN_PASS: 'hunter2',
      TXADMIN_MODE: mode,
    },
    stderr: 'pipe',
  });

  client = new Client({ name: 'e2e-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

describe.skipIf(!existsSync(DIST))('stdio end-to-end', () => {
  it('completes the MCP handshake and lists its tools', async () => {
    const c = await connect('write');
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('txadmin_whoami');
    expect(names).toContain('txadmin_announce');
    // write mode must not leak destructive tools onto the wire
    expect(names).not.toContain('txadmin_player_punish');
  });

  it('advertises correct tool annotations and input schemas', async () => {
    const c = await connect('admin');
    const { tools } = await c.listTools();

    const whoami = tools.find((t) => t.name === 'txadmin_whoami')!;
    expect(whoami.annotations?.readOnlyHint).toBe(true);
    expect(whoami.description?.length).toBeGreaterThan(60);

    const punish = tools.find((t) => t.name === 'txadmin_player_punish')!;
    expect(punish.annotations?.destructiveHint).toBe(true);
    expect(punish.inputSchema.properties).toHaveProperty('duration');
  });

  it('executes a tool call over the wire', async () => {
    const c = await connect('read');
    const result: any = await c.callTool({ name: 'txadmin_whoami', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Account:\s+admin/);
  });

  it('returns tool errors as results rather than killing the transport', async () => {
    const c = await connect('read');
    const result: any = await c.callTool({
      name: 'txadmin_player_info',
      arguments: { netid: 42 },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/mutex/i);

    // The connection must still be usable after a failed call.
    const after: any = await c.callTool({ name: 'txadmin_whoami', arguments: {} });
    expect(after.isError).toBeFalsy();
  });
});
