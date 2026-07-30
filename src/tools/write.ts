import { z } from 'zod';
import type { ToolDef } from './types.js';

/** Shared identity fields — txAdmin accepts license, or netid plus mutex. */
const targetSchema = {
  license: z.string().optional().describe('Player license, e.g. license:abc123'),
  netid: z.number().int().optional().describe('Server ID of a connected player'),
  mutex: z.string().optional().describe('Server mutex, required alongside netid'),
};

function requireTarget(args: any): Record<string, unknown> {
  if (!args.license && args.netid === undefined) {
    throw new Error('Provide either license, or netid together with mutex.');
  }
  if (args.netid !== undefined && !args.mutex) {
    throw new Error(
      'netid identifies a player only within one server session, so mutex is required too. ' +
        'txadmin_online_players returns both.',
    );
  }
  return { license: args.license, netid: args.netid, mutex: args.mutex };
}

export const writeTools: ToolDef[] = [
  {
    name: 'txadmin_announce',
    tier: 'write',
    permission: 'announcement',
    readOnly: false,
    destructive: false,
    description:
      'Broadcast an announcement to every player currently on the server. Note this reaches ' +
      'beyond the game: if the panel has a Discord bot configured, txAdmin also posts the ' +
      'announcement to the configured Discord channel.',
    inputSchema: {
      message: z.string().min(1).max(1000).describe('Text shown to all players'),
    },
    async run(args, ctx) {
      await ctx.client.fxserverCommand('admin_broadcast', args.message);
      return `Announcement sent to all players: "${args.message}"`;
    },
  },

  {
    name: 'txadmin_player_action',
    tier: 'write',
    permission: null,
    readOnly: false,
    destructive: false,
    description:
      'Reversible moderation actions on one player: send them a direct message, issue a ' +
      'warning, save an admin note, or set their whitelist state. Kicking and banning are ' +
      'deliberately not here — they live in txadmin_player_punish, which requires admin mode.',
    inputSchema: {
      action: z
        .enum(['message', 'warn', 'save_note', 'whitelist'])
        .describe('Which action to perform'),
      ...targetSchema,
      message: z.string().optional().describe('Required for action=message'),
      reason: z.string().optional().describe('Required for action=warn'),
      note: z.string().optional().describe('Required for action=save_note; replaces existing notes'),
      status: z.boolean().optional().describe('Required for action=whitelist'),
    },
    async run(args, ctx) {
      const target = requireTarget(args);

      switch (args.action) {
        case 'message': {
          if (!args.message) throw new Error('action=message requires a "message" field.');
          await ctx.client.playerAction('message', { ...target, message: args.message });
          return `Direct message sent to the player.`;
        }
        case 'warn': {
          if (!args.reason) throw new Error('action=warn requires a "reason" field.');
          await ctx.client.playerAction('warn', { ...target, reason: args.reason });
          return `Warning issued: "${args.reason}"`;
        }
        case 'save_note': {
          if (args.note === undefined) throw new Error('action=save_note requires a "note" field.');
          await ctx.client.playerAction('save_note', { ...target, note: args.note });
          return `Admin note saved.`;
        }
        case 'whitelist': {
          if (args.status === undefined) {
            throw new Error('action=whitelist requires a boolean "status" field.');
          }
          await ctx.client.playerAction('whitelist', { ...target, status: args.status });
          return `Whitelist ${args.status ? 'granted' : 'revoked'}.`;
        }
        default:
          throw new Error(`Unknown action "${args.action}".`);
      }
    },
  },

  {
    name: 'txadmin_resource_control',
    tier: 'write',
    permission: 'commands.resources',
    readOnly: false,
    destructive: false,
    description:
      'Reload a server resource: ensure (start if stopped), restart, or refresh (rescan the ' +
      'resources folder so newly added ones are discovered). These are the safe iteration ' +
      'verbs for developing a resource. Stopping or starting a resource outright is in ' +
      'txadmin_server_control, because stopping a framework core takes the server down.',
    inputSchema: {
      action: z.enum(['ensure', 'restart', 'refresh']).describe('Which operation to run'),
      resource: z
        .string()
        .optional()
        .describe('Resource name; required for ensure and restart, ignored by refresh'),
    },
    async run(args, ctx) {
      if (args.action === 'refresh') {
        await ctx.client.fxserverCommand('refresh_res', '');
        return 'Resource list refreshed. Newly added resources are now known to the server.';
      }

      if (!args.resource) {
        throw new Error(`action=${args.action} requires a "resource" name.`);
      }

      const map = { ensure: 'ensure_res', restart: 'restart_res' } as const;
      await ctx.client.fxserverCommand(map[args.action as 'ensure' | 'restart'], args.resource);
      return `Sent ${args.action} for resource "${args.resource}". Check txadmin_read_console for the result.`;
    },
  },
];
