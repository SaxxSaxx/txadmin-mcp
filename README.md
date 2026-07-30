# txadmin-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant read and administer a **FiveM / RedM** game server through [txAdmin](https://txadmin.gg).

Ask "why is the server crashing?", "who's online?", "who banned Dave and why?" or "restart the chat resource" and get a real answer from the live server.

Works against **any unmodified txAdmin install**. No server-side resource, no config edits, no FXServer restart — it authenticates as an ordinary admin account, exactly like the web panel does.

```
npx -y txadmin-mcp
```

---

## Install

**Claude Code**

```bash
claude mcp add txadmin -- npx -y txadmin-mcp \
  -e TXADMIN_URL=http://127.0.0.1:40120 \
  -e TXADMIN_USER=mcp-bot \
  -e TXADMIN_PASS=your-password
```

**Any MCP client** (`claude_desktop_config.json`, `.mcp.json`, Cursor, …)

```json
{
  "mcpServers": {
    "txadmin": {
      "command": "npx",
      "args": ["-y", "txadmin-mcp"],
      "env": {
        "TXADMIN_URL": "http://127.0.0.1:40120",
        "TXADMIN_USER": "mcp-bot",
        "TXADMIN_PASS": "your-password",
        "TXADMIN_MODE": "write"
      }
    }
  }
}
```

If your panel is not on the same machine, use its public URL. txAdmin listens on port `40120` by default.

---

## Security

Read this before you configure it — it changes what you should set.

**Create a dedicated txAdmin admin account for the MCP.** In txAdmin: *Admin Manager → Add Admin*, then grant only the permissions you want an AI to have. This is the gate that actually matters: txAdmin enforces permissions server-side, so an account without `players.ban` cannot ban anyone no matter what the model is told to do, including by a malicious player.

**`TXADMIN_MODE` is a second belt, not the boundary.** It defaults to `write`, which excludes every destructive tool. Destructive tools (ban, kick, server stop, arbitrary console) require `TXADMIN_MODE=admin` **and** an account holding the permission.

**Tools are gated at registration.** On startup the server reads its own permissions from txAdmin and only registers tools that pass both gates. The model never sees a tool it cannot use, so it can't waste turns on one or try to work around it.

**Console and chat are player-authored.** Anything a player can type — chat messages, names, ban reasons — can contain text designed to read as instructions to an AI. All such content is returned inside an explicit untrusted-data block. That is mitigation, not a guarantee, which is the other reason destructive tools are opt-in.

**A locked-down account still gets almost everything.** Most read routes need no special permission, so a minimal account loses only the console and server-log tools. There is no pressure to over-grant.

---

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `TXADMIN_URL` | yes | — | Panel base URL, e.g. `http://127.0.0.1:40120` |
| `TXADMIN_USER` | yes | — | txAdmin admin username |
| `TXADMIN_PASS` | yes | — | That account's password |
| `TXADMIN_MODE` | no | `write` | `read`, `write` or `admin`. Cumulative |
| `TXADMIN_TIMEOUT_MS` | no | `15000` | Per-request timeout |
| `TXADMIN_INSECURE_TLS` | no | `false` | Skip TLS verification. Last resort for a self-signed panel — adding the CA to your trust store is the correct fix |

### Modes

| Mode | Exposes | Use when |
|---|---|---|
| `read` | 9 read tools | You want observability only, or you're trying it out |
| `write` | + 3 safe write tools | Day-to-day: announcements, warnings, resource reloads |
| `admin` | + 4 destructive tools | You explicitly want bans, kicks, restarts and console access |

---

## Tools

### Read — always available

| Tool | Permission | What it does |
|---|---|---|
| `txadmin_whoami` | — | Which account, which permissions, which tools are active. Start here when something is missing |
| `txadmin_status` | — | Server up/down, scheduled restart, txAdmin/FXServer versions, host CPU and memory |
| `txadmin_online_players` | — | Live playerlist with server IDs and licenses |
| `txadmin_find_player` | — | Search the player database by name, notes or identifier — includes offline players |
| `txadmin_player_info` | — | Full profile: identifiers, playtime, notes, and complete ban/warning history |
| `txadmin_history_search` | — | Every ban and warning, filterable by type, admin or reason |
| `txadmin_read_console` | `console.view` | Recent FXServer console with grep. The tool for diagnosing crashes and script errors |
| `txadmin_read_server_log` | `server.log.view` | In-game events: chat, joins, drops, deaths, explosions |
| `txadmin_player_drops` | — | Disconnect reasons grouped by cause — "why are players crashing" |

### Write — default tier

| Tool | Permission | What it does |
|---|---|---|
| `txadmin_announce` | `announcement` | Broadcast to all players (also posts to Discord if the panel has it configured) |
| `txadmin_player_action` | per-action | Direct message, warn, save an admin note, set whitelist |
| `txadmin_resource_control` | `commands.resources` | `ensure`, `restart`, `refresh` — the safe resource iteration verbs |

### Admin — requires `TXADMIN_MODE=admin`

| Tool | Permission | What it does |
|---|---|---|
| `txadmin_player_punish` | `players.ban` | Kick or ban. Bans require an explicit duration — never permanent by omission |
| `txadmin_revoke_action` | `players.ban` | Undo a ban or warning by its action ID |
| `txadmin_server_control` | `control.server` | Start/stop/restart FXServer, stop/start a resource, kick everyone |
| `txadmin_console_command` | `console.write` | Arbitrary FXServer console execution. Effectively root on the game server |

---

## How it works

txAdmin has **no official REST API** — the only token-authenticated endpoint is `/host/status`, which exists for hosting providers and returns status only. So this speaks the panel's own web API, the same one the React frontend uses:

1. `POST /auth/password` with your credentials returns a session cookie and a CSRF token.
2. Every subsequent call sends that cookie plus an `x-txadmin-csrftoken` header.
3. The live console and playerlist are socket.io rooms, joined via the handshake query string.

**Sessions are cached** at `~/.cache/txadmin-mcp` (mode `0600`, honouring `XDG_CACHE_HOME`). This is not an optimisation: txAdmin rate-limits logins to 10 attempts per 15 minutes per IP, and an MCP server is spawned fresh for every assistant session. Without the cache you would lock yourself out of your own panel within a day. Your password is never written to disk.

Because this consumes an unofficial API, all route knowledge lives in two files (`src/txadmin/client.ts` and `src/txadmin/socket.ts`). A txAdmin update touches those and nothing else.

---

## Compatibility

Developed against txAdmin `master` as of **July 2026** (the v8 line), tested on Node 18, 20 and 22.

If a txAdmin update breaks something, `txadmin_whoami` is the fastest check — it exercises authentication, CSRF and permission reading in one call. Please open an issue with what it prints.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Missing HTTP header 'x-txadmin-csrftoken'` | A reverse proxy in front of txAdmin is stripping the header. Configure it to pass `x-txadmin-*` through |
| `did not return JSON` | `TXADMIN_URL` isn't a txAdmin panel, or points at the game port (`30120`) instead of the panel port (`40120`) |
| `Too many attempts` | txAdmin's login limiter. Wait it out — retrying extends the block, and it locks you out of the browser panel too |
| A console tool is missing | The account lacks `console.view`. Run `txadmin_whoami` to confirm |
| `FXServer is not running` | The game server is stopped. Start it in txAdmin, or use `txadmin_server_control` in admin mode |

---

## Development

```bash
npm install
npm test        # 101 tests, no FiveM server required
npm run build
```

Tests run against a mock txAdmin that reproduces the real authentication handshake — including rejecting requests without a CSRF header and silently declining socket rooms the account lacks permission for, which is how the real server behaves.

To verify against a live panel (read-only, safe on production):

```bash
TXADMIN_URL=http://127.0.0.1:40120 TXADMIN_USER=x TXADMIN_PASS=y npm run smoke
```

## License

MIT
