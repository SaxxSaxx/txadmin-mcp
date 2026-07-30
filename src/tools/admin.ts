import { z } from 'zod';
import { wrapUntrusted } from '../format/untrusted.js';
import { truncate } from '../format/tables.js';
import type { ToolDef } from './types.js';

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

export const adminTools: ToolDef[] = [
  {
    name: 'txadmin_player_punish',
    tier: 'admin',
    permission: 'players.ban',
    readOnly: false,
    destructive: true,
    description:
      'Kick or ban a player. Banning requires an explicit duration — there is no default, so a ' +
      'permanent ban is never issued by omission. Durations use txAdmin syntax: "2 hours", ' +
      '"7 days", "permanent". Bans are recorded in txAdmin history and can be undone with ' +
      'txadmin_revoke_action.',
    inputSchema: {
      action: z.enum(['kick', 'ban']).describe('Which punishment to apply'),
      ...targetSchema,
      reason: z.string().min(1).describe('Reason shown to the player and stored in the log'),
      duration: z
        .string()
        .optional()
        .describe('Required for action=ban. e.g. "2 hours", "7 days", "permanent"'),
    },
    async run(args, ctx) {
      const target = requireTarget(args);

      if (args.action === 'kick') {
        await ctx.client.playerAction('kick', { ...target, reason: args.reason });
        return `Player kicked. Reason: "${args.reason}"`;
      }

      if (!args.duration) {
        throw new Error(
          'action=ban requires an explicit "duration" so a permanent ban is never issued by ' +
            'accident. Use "permanent" if that is genuinely intended.',
        );
      }

      await ctx.client.playerAction('ban', {
        ...target,
        reason: args.reason,
        duration: args.duration,
      });
      return `Player banned for ${args.duration}. Reason: "${args.reason}"`;
    },
  },

  {
    name: 'txadmin_revoke_action',
    tier: 'admin',
    permission: 'players.ban',
    readOnly: false,
    destructive: true,
    description:
      'Revoke a ban or warning by its action ID (the ID column from txadmin_history_search or ' +
      'txadmin_player_info, e.g. "BAN-1A2B"). Revoking a ban lets the player rejoin immediately.',
    inputSchema: {
      actionId: z.string().min(1).describe('Action ID to revoke, e.g. BAN-1A2B'),
    },
    async run(args, ctx) {
      await ctx.client.historyAction('revokeAction', { actionId: args.actionId });
      return `Action ${args.actionId} revoked.`;
    },
  },

  {
    name: 'txadmin_server_control',
    tier: 'admin',
    permission: 'control.server',
    readOnly: false,
    destructive: true,
    description:
      'Start, stop or restart the FXServer process, stop or start an individual resource, or ' +
      'kick every player at once. Every action here disconnects players: restarting or ' +
      'stopping the server drops everyone, and stopping a framework resource can break the ' +
      'server without stopping it. For reloading a resource during development prefer ' +
      'txadmin_resource_control, which is recoverable.',
    inputSchema: {
      action: z
        .enum(['start', 'stop', 'restart', 'stop_resource', 'start_resource', 'kick_all'])
        .describe('Which operation to run'),
      resource: z
        .string()
        .optional()
        .describe('Resource name; required for stop_resource and start_resource'),
      reason: z.string().optional().describe('Message shown to players for kick_all'),
    },
    async run(args, ctx) {
      switch (args.action) {
        case 'start':
        case 'stop':
        case 'restart': {
          await ctx.client.fxserverControl(args.action);
          return `FXServer ${args.action} requested. Use txadmin_status to confirm it came back.`;
        }
        case 'stop_resource':
        case 'start_resource': {
          if (!args.resource) throw new Error(`action=${args.action} requires a "resource" name.`);
          const verb = args.action === 'stop_resource' ? 'stop_res' : 'start_res';
          await ctx.client.fxserverCommand(verb, args.resource);
          return `Sent ${verb} for "${args.resource}". Check txadmin_read_console for the result.`;
        }
        case 'kick_all': {
          const reason = args.reason ?? '';
          await ctx.client.fxserverCommand('kick_all', reason);
          return `All players kicked${reason ? `. Reason: "${reason}"` : '.'}`;
        }
        default:
          throw new Error(`Unknown action "${args.action}".`);
      }
    },
  },

  {
    name: 'txadmin_console_command',
    tier: 'admin',
    permission: 'console.write',
    readOnly: false,
    destructive: true,
    description:
      'Execute an arbitrary command in the FXServer console and return its output. This is ' +
      'unrestricted server console access — equivalent to root on the game server — and can ' +
      'stop resources, change convars, or run anything a server owner could type. Prefer a ' +
      'specific tool when one exists.',
    inputSchema: {
      command: z.string().min(1).describe('Console command to execute, e.g. "status"'),
    },
    async run(args, ctx) {
      const output = await ctx.socket.sendConsoleCommand(args.command);
      if (!output.trim()) {
        return `Command "${args.command}" was sent; the console produced no output within the collection window.`;
      }
      return wrapUntrusted('console', truncate(output, 12000));
    },
  },
];
