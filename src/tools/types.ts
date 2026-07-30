import type { ZodTypeAny } from 'zod';
import type { Config, Mode } from '../config.js';
import type { TxAdminClient } from '../txadmin/client.js';
import type { TxAdminSocket } from '../txadmin/socket.js';
import type { AdminInfo } from '../txadmin/session.js';

export interface ToolCtx {
  cfg: Config;
  client: TxAdminClient;
  socket: TxAdminSocket;
  admin: AdminInfo;
  /** Names of every tool registered this session; used by txadmin_whoami. */
  registeredNames: string[];
}

export interface ToolDef {
  name: string;
  /** Lowest mode at which this tool is exposed. Tiers are cumulative. */
  tier: Mode;
  /** txAdmin permission required, or null when any authenticated admin may use it. */
  permission: string | null;
  description: string;
  inputSchema: Record<string, ZodTypeAny>;
  readOnly: boolean;
  destructive: boolean;
  run(args: any, ctx: ToolCtx): Promise<string>;
}
