import { z } from 'zod';
import { wrapUntrusted } from '../format/untrusted.js';
import { minutes, stripAnsi, table, truncate, ts } from '../format/tables.js';
import type { ToolDef } from './types.js';

/** Tool results are read into a model's context; cap the worst offenders. */
const MAX_CHARS = 12000;

function lastLines(text: string, count: number): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

export const readTools: ToolDef[] = [
  {
    name: 'txadmin_whoami',
    tier: 'read',
    permission: null,
    readOnly: true,
    destructive: false,
    description:
      'Report which txAdmin account this MCP server is authenticated as, what permissions it ' +
      'holds, and which txadmin_* tools are active as a result. Use this first when another ' +
      'tool fails unexpectedly or seems to be missing — it turns a permission problem into a ' +
      'one-call diagnosis.',
    inputSchema: {},
    async run(_args, ctx) {
      const self = await ctx.client.authSelf();
      const lines = [
        `Account:     ${self.name}`,
        `Master:      ${self.isMaster ? 'yes (holds every permission)' : 'no'}`,
        `Permissions: ${self.permissions.length ? self.permissions.join(', ') : '(none)'}`,
        `Mode:        ${ctx.cfg.mode}`,
        `Panel:       ${ctx.cfg.url}`,
        '',
        `Active tools (${ctx.registeredNames.length}):`,
        ...ctx.registeredNames.map((name) => `  - ${name}`),
      ];
      return lines.join('\n');
    },
  },

  {
    name: 'txadmin_status',
    tier: 'read',
    permission: null,
    readOnly: true,
    destructive: false,
    description:
      'Current FiveM/RedM server status: whether FXServer is running, the scheduled restart, ' +
      'plus txAdmin and FXServer versions and host CPU/memory load. Start here when asked ' +
      'whether the server is up or how it is holding up.',
    inputSchema: {},
    async run(_args, ctx) {
      const [status, diagnostics] = await Promise.all([
        ctx.socket.readRoom<any>('status', 'status').catch((err: Error) => ({ error: err.message })),
        ctx.client.diagnostics().catch((err: Error) => ({ error: err.message })),
      ]);

      const out: string[] = ['# Server status'];
      if (status?.error) {
        out.push(`(live status unavailable: ${status.error})`);
      } else {
        out.push(`FXServer:  ${status?.server?.status ?? 'unknown'}`);
        if (status?.server?.name) out.push(`Name:      ${status.server.name}`);
        if (status?.discord) out.push(`Discord:   ${status.discord}`);
        const nextMs = status?.scheduler?.nextRelativeMs;
        if (typeof nextMs === 'number') {
          out.push(`Next scheduled restart: in ${Math.round(nextMs / 60000)} minutes`);
        }
      }

      if (diagnostics?.error) {
        out.push('', `(diagnostics unavailable: ${diagnostics.error})`);
      } else {
        out.push('', '# Host and versions');
        if (diagnostics?.txadmin) {
          out.push(
            `txAdmin ${diagnostics.txadmin.txAdminVersion ?? '?'} — uptime ${diagnostics.txadmin.uptime ?? '?'}`,
          );
        }
        if (diagnostics?.fxserver) {
          out.push(
            `FXServer ${diagnostics.fxserver.fxServerVersion ?? '?'} — uptime ${diagnostics.fxserver.uptime ?? '?'}`,
          );
        }
        if (diagnostics?.host?.cpu) {
          out.push(`CPU ${diagnostics.host.cpu.usage ?? '?'}% of ${diagnostics.host.cpu.count ?? '?'} cores`);
        }
        if (diagnostics?.host?.memory) {
          out.push(`Memory ${diagnostics.host.memory.usage ?? '?'}% of ${diagnostics.host.memory.total ?? '?'}`);
        }
      }

      return out.join('\n');
    },
  },

  {
    name: 'txadmin_online_players',
    tier: 'read',
    permission: null,
    readOnly: true,
    destructive: false,
    description:
      'List the players connected to the server right now, with their server IDs (netid) and ' +
      'licenses. This is the only source of the live playerlist — txadmin_find_player searches ' +
      'the historical player database instead, which includes people who are offline.',
    inputSchema: {},
    async run(_args, ctx) {
      const payload = await ctx.socket.readRoom<any>('playerlist', 'playerlist');
      const entry = Array.isArray(payload) ? payload[0] : payload;
      const players: any[] = entry?.playerlist ?? [];

      if (!players.length) {
        return 'No players are currently connected.';
      }

      const rendered = table(
        players.map((p) => ({
          netid: p.netid,
          name: p.displayName,
          license: p.license ?? '(none)',
        })),
        ['netid', 'name', 'license'],
      );

      return [
        `${players.length} player(s) online. Server mutex: ${entry?.mutex ?? 'unknown'}`,
        '',
        wrapUntrusted('playerlist', rendered),
      ].join('\n');
    },
  },

  {
    name: 'txadmin_find_player',
    tier: 'read',
    permission: null,
    readOnly: true,
    destructive: false,
    description:
      'Search the txAdmin player database by name, admin notes, or identifier (license, ' +
      'discord, steam). Covers offline players too. For the currently-connected list use ' +
      'txadmin_online_players.',
    inputSchema: {
      query: z.string().min(1).describe('Text to search for'),
      searchType: z
        .enum(['playerName', 'playerNotes', 'playerIds'])
        .default('playerName')
        .describe('Which field to match against'),
      limit: z.number().int().min(1).max(50).default(15).describe('Maximum rows to return'),
    },
    async run(args, ctx) {
      const { players } = await ctx.client.playerSearch({
        searchValue: args.query,
        searchType: args.searchType ?? 'playerName',
      });

      if (!players.length) {
        return `No players matched "${args.query}" (searched by ${args.searchType ?? 'playerName'}).`;
      }

      const rows = players.slice(0, args.limit ?? 15).map((p) => ({
        name: p.displayName,
        license: p.license,
        playTime: minutes(p.playTime),
        lastSeen: ts(p.tsLastConnection),
        online: p.isOnline ? 'yes' : 'no',
        whitelisted: p.isWhitelisted ? 'yes' : 'no',
      }));

      return [
        `${players.length} match(es)${players.length > rows.length ? `, showing ${rows.length}` : ''}.`,
        '',
        wrapUntrusted(
          'player search',
          table(rows, ['name', 'license', 'playTime', 'lastSeen', 'online', 'whitelisted']),
        ),
      ].join('\n');
    },
  },

  {
    name: 'txadmin_player_info',
    tier: 'read',
    permission: null,
    readOnly: true,
    destructive: false,
    description:
      'Full profile for one player: identifiers, playtime, whitelist state, admin notes, and ' +
      'their complete ban and warning history. Identify the player by license (works offline) ' +
      'or by netid plus mutex (online only — get both from txadmin_online_players).',
    inputSchema: {
      license: z.string().optional().describe('Player license, e.g. license:abc123'),
      netid: z.number().int().optional().describe('Server ID of a connected player'),
      mutex: z.string().optional().describe('Server mutex, required alongside netid'),
    },
    async run(args, ctx) {
      if (!args.license && args.netid === undefined) {
        throw new Error('Provide either license, or netid together with mutex.');
      }
      if (args.netid !== undefined && !args.mutex) {
        throw new Error(
          'netid identifies a player only within one server session, so mutex is required too. ' +
            'txadmin_online_players returns both.',
        );
      }

      const { player } = await ctx.client.playerModal({
        license: args.license,
        netid: args.netid,
        mutex: args.mutex,
      });

      const facts = [
        `Name:        ${player.displayName}`,
        `License:     ${player.license ?? '(none)'}`,
        `Registered:  ${player.isRegistered ? 'yes' : 'no'}`,
        `Connected:   ${player.isConnected ? `yes (netid ${player.netid ?? '?'})` : 'no'}`,
        `Play time:   ${minutes(player.playTime)}`,
        `First seen:  ${ts(player.tsJoined)}`,
        `Whitelisted: ${player.tsWhitelisted ? `yes, ${ts(player.tsWhitelisted)}` : 'no'}`,
        `Identifiers: ${(player.idsOnline?.length ? player.idsOnline : player.idsOffline)?.join(', ') || '(none)'}`,
      ];

      if (player.notes) facts.push(`Notes:       ${player.notes}`);

      const history = player.actionHistory ?? [];
      const historyBlock = history.length
        ? table(
            history.map((item) => ({
              id: item.id,
              type: item.type,
              by: item.author,
              when: ts(item.ts),
              expires: item.exp ? ts(item.exp) : item.type === 'ban' ? 'permanent' : '',
              revoked: item.revokedBy ? `by ${item.revokedBy}` : 'no',
              reason: item.reason,
            })),
            ['id', 'type', 'by', 'when', 'expires', 'revoked', 'reason'],
          )
        : '(no bans or warnings on record)';

      return wrapUntrusted(
        'player profile',
        [...facts, '', `# Ban and warning history (${history.length})`, historyBlock].join('\n'),
      );
    },
  },

  {
    name: 'txadmin_history_search',
    tier: 'read',
    permission: null,
    readOnly: true,
    destructive: false,
    description:
      'Search the moderation log — every ban and warning issued on this server, newest first. ' +
      'Filter by type, by the admin who issued it, or by free text over the reason. Use this ' +
      'for questions like "who banned whom last night" or "how many bans did X issue".',
    inputSchema: {
      query: z.string().optional().describe('Free text matched against the reason'),
      filterbyType: z.enum(['ban', 'warn']).optional().describe('Restrict to bans or warnings'),
      filterbyAdmin: z.string().optional().describe('Only actions issued by this admin name'),
      limit: z.number().int().min(1).max(50).default(15).describe('Maximum rows to return'),
    },
    async run(args, ctx) {
      const { history } = await ctx.client.historySearch({
        searchValue: args.query,
        searchType: args.query ? 'reason' : undefined,
        filterbyType: args.filterbyType,
        filterbyAdmin: args.filterbyAdmin,
      });

      if (!history.length) return 'No matching bans or warnings were found.';

      const rows = history.slice(0, args.limit ?? 15).map((action) => ({
        id: action.id,
        type: action.type,
        player: action.playerName === false ? '(unknown)' : action.playerName,
        by: action.author,
        when: ts(action.timestamp),
        state: action.isRevoked ? 'revoked' : (action.banExpiration ?? 'active'),
        reason: action.reason,
      }));

      return [
        `${history.length} action(s)${history.length > rows.length ? `, showing ${rows.length}` : ''}.`,
        '',
        wrapUntrusted(
          'moderation history',
          table(rows, ['id', 'type', 'player', 'by', 'when', 'state', 'reason']),
        ),
      ].join('\n');
    },
  },

  {
    name: 'txadmin_read_console',
    tier: 'read',
    permission: 'console.view',
    readOnly: true,
    destructive: false,
    description:
      'Read the recent FXServer console output — startup messages, script errors, Lua ' +
      'stack traces, resource load failures. This is the primary tool for diagnosing why the ' +
      'server is crashing, why a resource will not start, or what an error actually says.',
    inputSchema: {
      lines: z.number().int().min(1).max(500).default(80).describe('How many trailing lines'),
      grep: z.string().optional().describe('Only keep lines containing this text (case-insensitive)'),
    },
    async run(args, ctx) {
      const raw = await ctx.socket.readRoom<string>('liveconsole', 'consoleData');
      let text = stripAnsi(typeof raw === 'string' ? raw : JSON.stringify(raw));

      if (args.grep) {
        const needle = String(args.grep).toLowerCase();
        const matched = text.split('\n').filter((line) => line.toLowerCase().includes(needle));
        if (!matched.length) {
          return `No console lines matched "${args.grep}".`;
        }
        text = matched.join('\n');
      }

      text = lastLines(text, args.lines ?? 80);
      if (!text.trim()) return 'The console buffer is empty.';

      return wrapUntrusted('console', truncate(text, MAX_CHARS));
    },
  },

  {
    name: 'txadmin_read_server_log',
    tier: 'read',
    permission: 'server.log.view',
    readOnly: true,
    destructive: false,
    description:
      'Read the in-game event log: chat messages, player joins and drops, deaths, explosions. ' +
      'This is gameplay activity, distinct from txadmin_read_console which shows the server ' +
      'process output. Use it to reconstruct what happened in-game at a given time.',
    inputSchema: {
      lines: z.number().int().min(1).max(500).default(80).describe('How many trailing entries'),
      dir: z
        .enum(['older', 'newer'])
        .optional()
        .describe('Page through the log relative to ref'),
      ref: z.string().optional().describe('13-digit millisecond timestamp to page from'),
    },
    async run(args, ctx) {
      const { log } = await ctx.client.serverLogPartial({ dir: args.dir, ref: args.ref });
      if (!log?.length) return 'The server log is empty for that range.';

      const slice = log.slice(Math.max(0, log.length - (args.lines ?? 80)));
      const rendered = slice
        .map((entry: any) => {
          const when = entry.ts ? ts(Math.floor(entry.ts / (entry.ts > 1e12 ? 1000 : 1))) : 'unknown';
          const data =
            typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data ?? {});
          return `${when} [${entry.type ?? 'event'}] ${data}`;
        })
        .join('\n');

      return wrapUntrusted('server log', truncate(rendered, MAX_CHARS));
    },
  },

  {
    name: 'txadmin_player_drops',
    tier: 'read',
    permission: null,
    readOnly: true,
    destructive: false,
    description:
      'Why players have been disconnecting: counts grouped by drop reason (timeout, crash, ' +
      'resource error, kick). Use this to answer "why are players crashing" or to spot a ' +
      'resource that started ejecting people after a deploy.',
    inputSchema: {},
    async run(_args, ctx) {
      const data = await ctx.client.playerDrops();

      const summary = data?.summary ?? data?.dropTypes ?? data;
      if (Array.isArray(summary) && summary.length) {
        const rows = summary.map((item: any) => ({
          reason: item.reason ?? item.type ?? item.label ?? 'unknown',
          count: item.count ?? item.value ?? 0,
        }));
        return ['# Player drops by reason', '', table(rows, ['reason', 'count'])].join('\n');
      }

      return [
        '# Player drops',
        '',
        'txAdmin returned drop data in an unrecognised shape; raw payload follows.',
        truncate(JSON.stringify(data, null, 2), MAX_CHARS),
      ].join('\n');
    },
  },
];
