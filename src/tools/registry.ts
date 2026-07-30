import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Mode } from '../config.js';
import { hasPermission, type AdminInfo } from '../txadmin/session.js';
import type { ToolCtx, ToolDef } from './types.js';

const TIER_RANK: Record<Mode, number> = { read: 0, write: 1, admin: 2 };

/**
 * Decide which tools this session may expose.
 *
 * Two independent gates, both applied at registration rather than at call time:
 *
 * 1. TXADMIN_MODE, set by the operator. Tiers are cumulative.
 * 2. The txAdmin account's real permissions, read from /auth/self at startup.
 *
 * Gating at registration means the model never sees a tool that would fail with
 * a permission error, so it never burns a turn on one or tries to route around
 * it. The authoritative gate remains txAdmin's own server-side permission check
 * — this is a convenience layer on top of it, not the security boundary.
 */
export function selectTools(defs: ToolDef[], mode: Mode, admin: AdminInfo): ToolDef[] {
  return defs.filter(
    (def) =>
      TIER_RANK[def.tier] <= TIER_RANK[mode] &&
      (def.permission === null || hasPermission(admin, def.permission)),
  );
}

export function registerTools(server: McpServer, defs: ToolDef[], ctx: ToolCtx): ToolDef[] {
  const selected = selectTools(defs, ctx.cfg.mode, ctx.admin);
  ctx.registeredNames = selected.map((def) => def.name);

  for (const def of selected) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: {
          readOnlyHint: def.readOnly,
          destructiveHint: def.destructive,
        },
      },
      async (args: any) => {
        try {
          return { content: [{ type: 'text' as const, text: await def.run(args ?? {}, ctx) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );
  }

  return selected;
}
