/**
 * Read-only smoke test against a real txAdmin panel.
 *
 * Unit tests prove the client speaks the protocol our mock implements; this
 * proves the mock matches reality. It calls only read-tier tools, so it is safe
 * to point at a live production server.
 *
 *   TXADMIN_URL=http://127.0.0.1:40120 TXADMIN_USER=x TXADMIN_PASS=y npm run smoke
 */
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/txadmin/session.js';
import { TxAdminClient } from '../src/txadmin/client.js';
import { TxAdminSocket } from '../src/txadmin/socket.js';
import { readTools } from '../src/tools/read.js';
import type { ToolCtx } from '../src/tools/types.js';
import { hasPermission } from '../src/txadmin/session.js';

const PREVIEW_CHARS = 220;

async function main(): Promise<void> {
  if (!process.env.TXADMIN_URL) {
    console.log('SKIP: set TXADMIN_URL, TXADMIN_USER and TXADMIN_PASS to run the smoke test.');
    return;
  }

  const cfg = loadConfig();
  console.log(`Panel: ${cfg.url}`);

  const session = new SessionManager(cfg);
  const { admin } = await session.get();
  console.log(`Authenticated as "${admin.name}" (master: ${admin.isMaster})`);
  console.log(`Permissions: ${admin.permissions.join(', ') || '(none)'}\n`);

  const ctx: ToolCtx = {
    cfg,
    client: new TxAdminClient(cfg, session),
    socket: new TxAdminSocket(cfg, session),
    admin,
    registeredNames: readTools.map((t) => t.name),
  };

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const tool of readTools) {
    if (tool.permission && !hasPermission(admin, tool.permission)) {
      console.log(`SKIP ${tool.name} — account lacks "${tool.permission}"`);
      skipped += 1;
      continue;
    }

    const started = Date.now();
    try {
      const output = await tool.run({}, ctx);
      const preview = output.replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS);
      console.log(`PASS ${tool.name} (${Date.now() - started}ms)`);
      console.log(`     ${preview}${output.length > PREVIEW_CHARS ? '…' : ''}\n`);
      passed += 1;
    } catch (err) {
      console.log(`FAIL ${tool.name} (${Date.now() - started}ms)`);
      console.log(`     ${err instanceof Error ? err.message : String(err)}\n`);
      failed += 1;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
