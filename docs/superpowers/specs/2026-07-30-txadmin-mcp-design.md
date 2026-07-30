# txadmin-mcp — Design

**Date:** 2026-07-30
**Status:** Approved, ready for implementation planning

## Summary

An MCP server that gives an AI assistant read and controlled write access to a
FiveM/RedM server through **txAdmin**, the panel that supervises ~29k FXServer
instances. Published to npm as `txadmin-mcp`, installed with
`npx -y txadmin-mcp`, and usable against **any unmodified txAdmin install** —
no server-side resource, no config file edits, no FXServer restart.

## Goals

1. Answer operational questions without the user opening the panel: who is
   online, why did the server crash, who was banned and by whom, what is the
   console saying.
2. Perform routine moderation and the resource dev-loop (restart a resource,
   announce, warn a player) from the assistant.
3. Be safe by default. Destructive actions exist but require explicit opt-in
   **and** a txAdmin account that actually holds the permission.
4. Be publishable — a stranger with a txAdmin login can install it in one
   command.

## Non-goals

- Framework-aware in-game data (qbx/ESX money, jobs, inventory). That needs a
  companion FiveM resource, which would destroy the zero-install property. v2
  at the earliest.
- Multi-server support. txAdmin itself is single-server per instance
  (`webSocket.ts` has a `//NOTE: when adding multiserver` comment); one MCP
  process targets one panel. Users needing several add several MCP entries.
- Anything requiring `all_permissions` (`/advanced/run`, master actions,
  database backup). Too much blast radius for the value.

---

## Background: how txAdmin actually authenticates

All facts below were read from `citizenfx/txAdmin@master` (pushed 2026-07-23),
not from documentation. They are the load-bearing assumptions of this design
and each cites its source file.

### There is no official REST API

The only token-authenticated endpoint is `GET /host/status`, gated by the
`TXHOST_API_TOKEN` environment variable (`middlewares/authMws.ts`,
`hostAuthMw`). It exists for hosting providers and returns status only. Issue
#179 asking for a general REST API was closed without one being built.

Therefore this MCP is a **client of the panel's own web API**, the same API the
React frontend uses. This is an unofficial surface and can change between
txAdmin releases. See "Version brittleness" below for the mitigation.

### The handshake

1. `POST {base}/auth/password` with JSON `{username, password}`
   (`routes/authentication/verifyPassword.ts`, zod schema
   `{username: string, password: string}`, both trimmed).
   - **Do not append `?uiVersion=`.** If present and not exactly equal to the
     panel's version, the route short-circuits with `{error: 'refreshToUpdate'}`.
   - On success the response body is `getAuthData()`:
     `{name, permissions, isMaster, isTempPassword, profilePicture, csrfToken}`
     (`WebServer/authLogic.ts`, `AuthedAdmin.getAuthData`).
   - On failure: `{error: 'Wrong username or password!'}` or
     `{error: 'no_admins_setup'}`.
2. The response sets a session cookie. **The cookie name is dynamic:**
   `` `${consts.cookies.session}:${pathHash}` `` where `pathHash` derives from
   the panel's base path (`WebServer/index.ts:60`). It must be read from the
   `set-cookie` response header and echoed back verbatim. Never hardcode it.
3. Every subsequent API call sends that cookie **and** the header
   `x-txadmin-csrftoken` set to the `csrfToken` from step 1
   (`middlewares/authMws.ts:163`, `apiAuthMw`).

### The CSRF check cannot be skipped

`apiAuthMw` only enforces CSRF when `ctx.txVars.isWebInterface` is true, and
that is defined as `typeof ctx.headers['x-txadmin-token'] !== 'string'`
(`middlewares/ctxVarsMw.ts:24`). Sending an `x-txadmin-token` header to dodge
the CSRF check does not work: it routes authentication to `nuiAuthLogic`
instead, which requires the header to equal the server's private `luaComToken`
*and* requires the request to originate from a local address
(`WebServer/authLogic.ts`, `nuiAuthLogic`). Password auth + CSRF is the only
viable path for an external client.

### Login is rate limited — this drives a real design decision

`limiterAttempts` defaults to **10**, `limiterMinutes` to **15**
(`ConfigStore/schema/webServer.ts`). Exceeding it blocks the source IP from
`/auth/password` for 15 minutes, which locks the human out of their own panel
too.

An MCP server over stdio is spawned fresh on every assistant session and on
every config reload. Naive login-per-process would burn the budget within a
day of normal use. **Sessions are therefore cached to disk** (see Session
cache) and a fresh login only happens when there is no valid cached session or
the server explicitly reports `{logout: true}`.

### Live console is socket.io, and rooms are joined at handshake time

`WebServer/index.ts:156` constructs `new SocketIO(..., {serveClient: false})`
with no `path` override, so the default `/socket.io` endpoint applies.
Authentication reuses the session cookie from the handshake headers
(`socketioSessMw`).

Rooms are **not** joined by emitting an event. The client passes them in the
handshake query string: `?rooms=liveconsole,playerlist`. The server splits on
comma, dedupes, and validates against
`VALID_ROOMS = ['status','dashboard','liveconsole','serverlog','playerlist']`;
if none are valid the socket is terminated (`WebServer/webSocket.ts`,
`handleConnection`).

Also in `handleConnection`: if `socket.handshake.query.uiVersion` is present
and mismatched, the server emits `refreshToUpdate` and disconnects. **Omit
`uiVersion` from the socket handshake too.**

On join, the server immediately emits the room's `eventName` with
`initialData()`. For `liveconsole` that is `eventName: 'consoleData'` and
`initialData: () => txCore.logger.fxserver.getRecentBuffer()`
(`wsRooms/liveconsole.ts`) — i.e. **a one-shot connect yields the recent
console buffer without needing to stream**.

Sending a console command means emitting `consoleCommand` with a string while
joined to `liveconsole`; it requires the `console.write` permission and the
handler strips newlines before passing to `fxRunner.sendRawCommand`.

### Route inventory

From `WebServer/router.ts`. `apiAuthMw` = session + CSRF; `webAuthMw` = session
only, returns HTML.

**Reads (JSON, `apiAuthMw`)**

| Route | Notes |
|---|---|
| `GET /auth/self` | Returns `getAuthData()` — name, permissions, isMaster |
| `GET /player/search` | Query: `searchValue, searchType, filters, sortingKey, sortingDesc, offsetParam, offsetLicense`. Searches the **player database**, not the online list |
| `GET /player` | Query: `mutex, netid` (online) or `license` (any known player) |
| `GET /player/stats` | Aggregate player counts |
| `GET /history/search` | Query: `searchValue, searchType, filterbyType, filterbyAdmin, sortingKey, sortingDesc, offsetParam, offsetActionId` |
| `GET /history/stats` | Aggregate ban/warn counts |
| `GET /history/action` | Single action detail |
| `GET /serverLog/partial` | In-game event log (chat, deaths, joins). Query `dir=older\|newer` + `ref` (13-digit ms timestamp), 500 per slice. No params = recent buffer. Needs `server.log.view` |
| `GET /systemLog/:scope` | txAdmin's own logs |
| `GET /playerDropsData` | Crash/drop analytics |
| `GET /perfChartData/:thread` | Tick performance |
| `GET /diagnostics/getDiagnostics` | Host, txAdmin and FXServer process info |
| `GET /whitelist/:table` | Whitelist requests / approvals |
| `GET /settings/configs` | Panel config |

**Writes (`apiAuthMw`)**

| Route | Actions | Permission |
|---|---|---|
| `POST /player/:action` | `save_note`, `warn`, `ban`, `whitelist`, `removeIds`, `message`, `kick` | per-action |
| `POST /history/:action` | `revokeAction`, `addLegacyBan` | `players.ban` etc |
| `POST /fxserver/commands` | `admin_broadcast`, `kick_all`, `start_res`, `stop_res`, `restart_res`, `ensure_res`, `refresh_res`. Body `{action, parameter}` | `announcement`, `control.server`, `commands.resources` |
| `POST /fxserver/controls` | `restart`, `stop`, `start` (the FXServer process itself) | `control.server` |
| `POST /fxserver/schedule` | Scheduled restarts | |
| `POST /whitelist/:table/:action` | Approve/deny whitelist requests | |
| `POST /cfgEditor/save` | Writes server.cfg | not used in v1 |

Two guards worth knowing: `/fxserver/commands` rejects every action while the
server is offline, and refuses `start_res`/`restart_res`/`ensure_res` when the
parameter contains `runcode` (`routes/fxserver/commands.ts`).

### Known gap: no JSON resource list

`/legacy/resources` calls `ctx.utils.render('main/resources', ...)` — it
returns a rendered HTML page, not JSON (`routes/resources.js`). Listing
resources by name would require scraping that HTML, which is exactly the kind
of thing that breaks silently on a txAdmin update.

**v1 does not include a resource-listing tool.** `resource_control` takes a
resource name the user or the console output supplies. Revisit in v2 if the
HTML shape proves stable or a JSON route appears.

---

## Architecture

Four layers, each independently testable. The dependency arrow points one way
only: tools depend on the client, the client depends on session, nothing
depends on tools.

```
src/
  index.ts            # entry: parse env, build server, register tools, stdio
  config.ts           # env parsing + validation, one exported Config type
  txadmin/
    session.ts        # login, cookie extraction, csrf, disk cache, relogin
    client.ts         # request(); one typed method per route used
    socket.ts         # one-shot socket.io: read console, send command
    errors.ts         # TxAdminError taxonomy (auth, permission, offline, http)
  tools/
    registry.ts       # tier + permission gating, dynamic registration
    read.ts           # 9 read tools
    write.ts          # 3 safe-write tools
    admin.ts          # 4 destructive tools
  format/
    untrusted.ts      # wrap player-authored text
    tables.ts         # compact table rendering for model consumption
```

### `session.ts` — the only thing that knows about auth

Public surface: `getSession(): Promise<Session>` and
`invalidate(): Promise<void>`. `Session` is
`{cookieHeader: string, csrfToken: string, admin: {name, permissions, isMaster}}`.

- On first call: read the disk cache; if a session exists, validate it with
  `GET /auth/self`. If that succeeds, use it — **zero logins in the common
  case**.
- If there is no cache or validation fails, `POST /auth/password`, extract the
  `set-cookie` name and value, persist, return.
- `invalidate()` deletes the cache. Called when a request returns
  `{logout: true}`.
- **Relogin is attempted at most once per request and at most once per 60s
  process-wide.** If txAdmin returns the rate-limit body (`{error: 'Too many
  attempts. Blocked for N minutes.'}`), that message is surfaced verbatim to
  the user and no further login is attempted for N minutes. Silently retrying
  into a 15-minute lockout is the single worst failure mode available here.

### Session cache

Path: `~/.cache/txadmin-mcp/<sha256(url + username)>.json`, file mode `0600`,
directory mode `0700`. Contents: cookie header, csrf token, admin name,
`createdAt`. **Refuses to write if the mode cannot be set** — this file is a
live credential-equivalent and a world-readable one is worse than no cache.

The user's password is never written to disk; it lives only in the env var the
user already controls.

### `client.ts`

One `request(method, path, {query, body})` that attaches cookie + CSRF +
`Accept: application/json`, applies `TXADMIN_TIMEOUT_MS`, and normalises
errors. Above it, one thin typed method per route in the inventory. Nothing
in this file knows what an MCP tool is.

Two response shapes need explicit handling because they are easy to
misdiagnose:
- A **`text/html` response** to an API path means the request was
  unauthenticated or the base URL points somewhere that is not txAdmin. Raise
  a distinct error saying which, rather than a JSON parse failure.
- `{logout: true, reason}` means the session died → `invalidate()`, retry once.

### `socket.ts`

`readConsole()` and `sendConsoleCommand(cmd)`. Both open a socket.io v4
connection to `{base}` with the session cookie in `extraHeaders`, query
`rooms=liveconsole`, **no `uiVersion`**, wait for the first `consoleData`
event, then disconnect. Hard timeout, and explicit handling for the server's
`logout` / `refreshToUpdate` / `txAdminShuttingDown` emits so a disconnect is
never reported as an empty console.

`sendConsoleCommand` emits `consoleCommand`, waits briefly for the resulting
`consoleData` delta, and returns it so the model sees the command's output
rather than firing blind.

**A trap worth naming:** when an account lacks a room's permission,
`handleConnection` simply `continue`s past that room — it does not join, does
not error, and does not disconnect. The socket connects successfully and then
sits silent forever. So a missing `console.view` looks identical to an idle
server. `socket.ts` must treat "connected but no `consoleData` before timeout"
as a probable permission failure and say so, and gate 2 should keep it from
happening at all by not registering the tool.

### `registry.ts` — the safety model

Two independent gates, both applied at **registration** time, not call time:

1. **`TXADMIN_MODE`** — `read` | `write` (default) | `admin`. Set by the human
   in their MCP config. **Tiers are cumulative**: `write` exposes read + write,
   `admin` exposes all three. There is no way to get admin tools without the
   read ones.
2. **The account's real permissions**, read from `/auth/self` at startup. Each
   tool declares the txAdmin permission it needs (`control.server`,
   `players.ban`, `console.write`, `announcement`, `commands.resources`,
   `server.log.view`, …). A tool whose permission the account lacks is not
   registered.

A tool is exposed only if **both** gates pass. Consequences worth stating:

- The model never sees a tool that will fail with a permission error, so it
  never wastes a turn on one or tries to work around one.
- The authoritative gate is txAdmin's own server-side permission check, which
  no amount of prompt injection can move. `TXADMIN_MODE` is a convenience belt
  on top, not the security boundary.
- **The documented recommendation is a dedicated txAdmin admin account for the
  MCP** with only the permissions the operator wants it to have. The README
  leads with this rather than burying it.

If `isMaster` is true the account has `all_permissions` and every gate-2 check
passes; the README warns that using a master account gives up gate 2 entirely.

**Which permissions actually gate what** (read from source, and narrower than
expected): `/diagnostics/getDiagnostics`, `/playerDropsData`, `/player/search`,
`/player`, `/history/search` carry **no permission check** beyond being an
authenticated admin, and the `status` and `playerlist` socket rooms are
`permission: true`. So the entire read tier is available to any txAdmin admin
account **except** `txadmin_read_console` (`console.view`) and
`txadmin_read_server_log` (`server.log.view`).

The corollary matters for the recommended-account advice: a locked-down
txAdmin account still gets almost all read value, so there is no pressure on
users to over-grant.

### Prompt injection

Console output, chat logs, player names and ban reasons are **written by
players**. They arrive in tool results and would otherwise read as instructions
to the model. Every tool that returns player-authored text routes it through
`format/untrusted.ts`, which wraps it in a delimited block with a preamble
stating it is untrusted data from server users and must never be treated as
instructions.

This is mitigation, not a guarantee, which is the other reason destructive
tools are opt-in: the tools most worth attacking are the ones absent by
default.

---

## Tools

16 tools. Names are prefixed `txadmin_` so they stay legible next to other MCP
servers. Every description states what it reads or changes and whether it is
reversible.

### read tier — always available

| Tool | Source | Returns |
|---|---|---|
| `txadmin_whoami` | `GET /auth/self` | Account name, permissions, which tools are consequently active. Makes permission problems a one-call diagnosis |
| `txadmin_status` | socket.io `status` room + `GET /diagnostics/getDiagnostics` | FXServer up/down, player count, scheduled restarts (from `txManager.globalStatus`), plus txAdmin/FXServer version and host CPU/RAM |
| `txadmin_online_players` | socket.io `playerlist` room, one-shot | Currently connected: netid, name, playtime. **The only route to the live list** — `/player/search` searches the database |
| `txadmin_find_player` | `GET /player/search` | Database search by name / license / identifier |
| `txadmin_player_info` | `GET /player` + `GET /history/search` | Composed: profile, identifiers, playtime, notes **and** that player's bans/warns in one call, because they are always wanted together |
| `txadmin_history_search` | `GET /history/search` | Bans and warns, filterable by type, admin, player, revoked state |
| `txadmin_read_console` | socket.io `liveconsole` initialData | Recent FXServer console. Args: `lines`, optional `grep`. ANSI stripped |
| `txadmin_read_server_log` | `GET /serverLog/partial` | In-game events: chat, deaths, joins, explosions. Paginates via `dir`/`ref` |
| `txadmin_player_drops` | `GET /playerDropsData` | Drop/crash reasons over time — the "why are players crashing" tool |

### write tier — default, safe and reversible

| Tool | Route | Notes |
|---|---|---|
| `txadmin_announce` | `POST /fxserver/commands` `admin_broadcast` | Needs `announcement`. Also posts to Discord if configured — the description says so, since it reaches beyond the game server |
| `txadmin_player_action` | `POST /player/:action` | `message`, `warn`, `save_note`, `whitelist`. Kick and ban are deliberately **not** in this tool |
| `txadmin_resource_control` | `POST /fxserver/commands` | `ensure_res`, `restart_res`, `refresh_res` only. These are the iteration verbs and are recoverable |

### admin tier — only with `TXADMIN_MODE=admin`

| Tool | Route | Notes |
|---|---|---|
| `txadmin_player_punish` | `POST /player/:action` | `kick`, `ban`. Ban requires an explicit duration and reason — no defaulted permanent bans |
| `txadmin_revoke_action` | `POST /history/revokeAction` | Undo a ban or warn |
| `txadmin_server_control` | `POST /fxserver/controls`, plus `stop_res`/`start_res`/`kick_all` via `/fxserver/commands` | Start/stop/restart FXServer, stop/start a resource, kick every player. Everything here can take the server down or empty it |
| `txadmin_console_command` | socket.io `consoleCommand` | Arbitrary console execution. Needs `console.write`. Effectively root on the server — documented as such |

---

## Configuration

Environment variables, since that is how MCP clients pass config.

| Var | Required | Default | Meaning |
|---|---|---|---|
| `TXADMIN_URL` | yes | — | Panel base URL, e.g. `http://127.0.0.1:40120` |
| `TXADMIN_USER` | yes | — | txAdmin admin username |
| `TXADMIN_PASS` | yes | — | that account's password |
| `TXADMIN_MODE` | no | `write` | `read` \| `write` \| `admin` |
| `TXADMIN_TIMEOUT_MS` | no | `15000` | Per-request timeout |
| `TXADMIN_INSECURE_TLS` | no | `false` | Accept self-signed panel certs |

Startup validates all of these and **fails loudly with an actionable message**
rather than surfacing the problem later as a confusing tool error: a
`TXADMIN_URL` with no scheme, an unreachable panel, and bad credentials each
get their own message.

---

## Error handling

`errors.ts` defines a small taxonomy, and every one maps to a message that
tells the user what to actually do:

| Error | Cause | Message says |
|---|---|---|
| `ConfigError` | Missing/malformed env | Which var, what shape it needs |
| `AuthError` | Bad credentials | Check user/pass; **does not retry** |
| `RateLimitError` | 10 logins / 15 min exceeded | How long remains; that retrying makes it worse |
| `PermissionError` | Account lacks the permission | Which permission, and to grant it in txAdmin's admin manager |
| `ServerOfflineError` | `/fxserver/commands` while FXServer is down | Server is stopped; `txadmin_server_control` can start it if in admin mode |
| `NotTxAdminError` | HTML where JSON expected | The URL is not a txAdmin panel, or a reverse proxy is stripping `x-txadmin-csrftoken` |
| `VersionError` | `refreshToUpdate` | The panel updated; this is the brittleness case, link to issues |

The reverse-proxy case is called out explicitly because txAdmin's own error
text names it as a common cause of a stripped CSRF header, and it produces a
baffling failure otherwise.

## Version brittleness

This consumes an unofficial API. The mitigations:

1. **All route knowledge lives in `client.ts` and `socket.ts`.** A txAdmin
   change touches those two files, never the 16 tools.
2. `README` records the txAdmin version range tested against.
3. `txadmin_whoami` doubles as a health check, so "did txAdmin break this" is
   one call to answer.
4. Contract tests run against a mock implementing the handshake exactly as
   read from source, so a regression in our own code is never mistaken for a
   txAdmin change.

## Testing

- **Unit** (vitest): config parsing, cookie extraction from `set-cookie`,
  session cache read/write/permissions, untrusted-text wrapping, table
  formatting, tier × permission gating matrix.
- **Contract**: `MockTxAdmin`, a plain-node http + socket.io server that
  implements the real handshake — issues a `txAdmin-sess:<hash>` cookie,
  returns a `csrfToken`, **rejects any API request missing
  `x-txadmin-csrftoken`**, serves canned route payloads, and terminates
  socket connections with no valid `rooms` query. The full client and every
  tool are tested against it. No FiveM server required, runs in CI.
- **Rate-limit behaviour** is tested explicitly: the mock returns the block
  body and the test asserts no second login attempt is made.
- **Smoke** (`npm run smoke`): runs the read-tier tools against a real panel,
  skipped unless `TXADMIN_URL`/`USER`/`PASS` are set. Read-only, so it is safe
  to point at a live server. First target is Fire Roleplay
  (`92.42.45.97:40120`).

## Distribution

Publishing is the step these projects historically die at, so it is part of
the spec, with named acts rather than "publish it":

1. GitHub repo `SaxxSaxx/txadmin-mcp`, MIT.
2. `npm publish` as `txadmin-mcp`.
3. README leading with the one-line install, the dedicated-account
   recommendation, and a table of the 16 tools.
4. A post in the cfx.re forum's Server Development / txAdmin section — that is
   where 29k server owners actually are.
5. Submit to the MCP server registry / awesome-mcp-servers list.

## Open questions for implementation

Deliberately not guessed here; each is one call against a live panel to
resolve, and the plan should schedule them early:

- Exact field names in `/diagnostics/getDiagnostics`, `/playerDropsData` and
  the `playerlist` room payload. Read from a real panel and pin with fixtures.
- Whether `/player/search` requires `sortingKey` (`/history/search` rejects a
  missing or non-allowlisted one, so probably yes).
- Exact body shape for `/player/ban` duration — txAdmin uses a string form
  like `2 hours` / `permanent`; confirm before writing the tool schema.
