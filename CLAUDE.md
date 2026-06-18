# OpenJarvis

> **No PII in commits/code — HARD RULE.** Never put personal/identifying info (names, emails, phone numbers, Telegram/Discord numeric IDs, tokens, usernamed paths) into commit messages, code, or tracked files. Keep commit messages generalized and technical. All such data lives in config files (`config.yaml`, `.env`, registries) referenced via env/config, never hardcoded. Scan the staged diff and message before every commit.

OpenJarvis is a Discord-native AI assistant that bridges voice I/O, Claude CLI agents, webhook alerts, and persistent memory. A user speaks or types in a Discord channel; Jarvis transcribes, routes to an AI agent session, and replies in text or voice.

**Repo**: `~/Dev/openjarvis` (gamez dev), `~/dev/openjarvis/` on generic (live)
**Package name**: `jarvis-voice` (rename to `openjarvis` is planned — see plan below)
**Stack**: Node.js ES modules + discord.js v14 + Claude CLI + Python haivemind submodule

---

## Subsystems

### jarvis-voice (`src/index.js`, `src/stt.js`, `src/tts.js`, `src/wakeword.js`, …)

Voice I/O layer. Handles:
- Wake-word detection (`wakeword.js`) → Whisper STT (`stt.js`) → intent classification → brain dispatch
- TTS response via Piper / Chatterbox / Qwen3 (`tts.js`, `tts-pipeline.js`)
- Discord event handling: mentions, slash commands, thread events, message routing
- Slash commands dispatched through `src/command-dispatch.js` and `src/slash-commands.js`
- `/spawn` creates a Discord thread as an isolated agent session (`src/spawn.js`)

`src/index.js` is 269 KB — the entire Discord setup, voice receiver, mention handling, slash dispatch, and bot bootstrap live here. Refactor into `src/{voice,discord,brain,agent,alerts,state}/` is planned.

Systemd unit (on generic): `jarvis-voice.service` (`systemctl --user`)

### jarvis-gateway (`scripts/jarvis-gateway.js`, port 22100)

The agentic brain adapter — an HTTP/SSE server that `jarvis-voice` calls to run Claude CLI subprocesses.

- `spawnClaudeStream(prompt, model, chatId, channelKey, effort)` — spawns `claude -p [--resume <chatId>]`
- Maintains a `chatId` (Claude conversation UUID) per `channelKey` in `~/.local/state/jarvis-voice/jarvis-sessions.json`. Persists across restarts.
- Routes per-channel: Claude profile (`channel-accounts.json`), ask-mode (`channel-ask-mode.json`), MCP mode (`channel-mcp-mode.json`)
- Session rotation: after N turns or T seconds, old chatId is summarized to haivemind, then replaced
- `JARVIS_GATEWAY_PORT` env var (default 22100)

Systemd unit: `jarvis-gateway.service`

### jarvis-alerts (`src/alert-webhook.js`, port 3335 Tailscale-bound)

Webhook receiver for external alert sources (Grafana, scripts, etc.). Queues incoming alerts (`src/alert-queue.js`), tracks task state (`src/task-ledger.js`), and surfaces alerts to voice/Discord via HUD. Scheduled jobs managed by `src/task-scheduler.js`.

Port is Tailscale-only: `app.listen(WEBHOOK_PORT, TAILSCALE_IP, …)`.

### kanban-dispatch (`src/kanban-dispatch.js`, `src/state/focus-state.js`)

Channel-bound Kanban CLI router. When a Discord channel's registry entry has `kanbanEnabled: true`, natural-language Kanban verbs ("create a task: …", "show the board", "start task <id>", "trash task <id>", "what's in progress") are intercepted before the brain via `tryKanbanDispatch()` (hooked in `src/discord/command-dispatch.js`). The dispatcher shells out to `${HOME}/.local/bin/kanban task …` with `--project-path` resolved from the registry entry's `kanbanPath` (or `path`). Result type `{ type: 'kanban', speech, discordText }` is rendered in `src/index.js` — TTS speaks the brief summary, full board posts to the focus channel.

Channel-registry helpers in `src/state/focus-state.js`: `isKanbanChannel(channelId)` (thread-aware) and `getKanbanPath(channelId)`. Schema fields on a registry entry: `kanbanEnabled: boolean`, `kanbanPath: string`.

Slash command `/new-kanban-channel name:<…> project-path:<abs-path>` (`src/discord/slash/new-kanban-channel.js`) creates a Discord channel, atomic-writes a `kanbanEnabled: true` registry entry, and bootstraps the workspace by invoking `kanban task list` once.

Skill: `skills/kanban/SKILL.md` — full operations reference. Setup: `skills/kanban/SETUP.md`.

### telegram (`src/telegram/{transport,adapter,registry,engine,format,commands}.js`)

A peer transport on the same brain as Discord/voice. A Telegram chat (or forum topic) behaves like a Discord channel: it binds to a project directory and routes messages to the shared agent.

- `transport.js` — `node-telegram-bot-api` long-polling. `normalizeUpdate(message)` reduces a raw Telegram update to a neutral `{userId,chatId,topicId,text,messageId}` shape (null for non-text); `splitSend()` shapes send options (`message_thread_id` for forum topics); `createTransport(token, onMessage)` wires the live bot.
- `adapter.js` — the bridge. `handleUpdate()` enforces the access gate, routes slash commands, and sends plain messages to the brain (`generateResponseStreaming`) with a per-chat live-history window; replies are shaped by `terseStatus` (one status line) + `detailBody` (4096-char follow-up chunks). `startTelegram()` is the bootstrap entry, lazy-imported from `src/index.js`'s `ready` handler; it no-ops without `TELEGRAM_BOT_TOKEN`.
- `registry.js` — `telegramChatKey(chatId, topicId)`, `getTelegramProjectPath(chatKey)`, `registerTelegramChat(chatKey, projectPath)`. Bindings live under a `telegram` key in the same channel-registry file Discord uses.
- `engine.js` — per-chat engine store (`claude` | `qwen`) at `~/.local/state/jarvis-voice/telegram-engine.json`. `resolveEngineEnv(engine)` returns the `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `model` overrides for the qwen path (LM Studio host from `JARVIS_LMS_BASE_URL`). The gateway applies that overlay to the SAME `claude -p` spawn (see jarvis-gateway `spawnClaudeStream` `engineEnv` argument), so switching engines is an env swap, not a separate client.
- `format.js` / `commands.js` — pure helpers (watch-formatting and the `/register /engine /model /status /cancel` parser, `@BotName`-suffix aware).

**Session-key shape:** `agent:main:telegram:chat:<chatId>[:topic:<topicId>]`. The gateway's `resolveProfile()` strips the `:topic:<id>` suffix (same path as Discord's `:thread:`), so a forum topic inherits its parent chat's Claude profile.

**Access model:** tier-1 owner (`isOwner`, `TELEGRAM_OWNER_ID`) may run all commands and coding; tier-2 allowlist (`TELEGRAM_ALLOWED_USERS`, comma-separated) gets chat/status only; everyone else is refused. Owner-only commands: `/register`, `/engine`, `/model`, `/cancel`.

**config.yaml block** (mapped to env by `src/config-env-bootstrap.js`):

```yaml
telegram:
  token: "<bot token from @BotFather>"
  owner: "<your telegram numeric user id>"
  allowedUsers: "<comma-separated tier-2 ids>"   # chat/status only
```

### haivemind (`haivemind/` submodule)

Python-based collective memory system. Provides ChromaDB vector storage + Redis caching + MCP server interface. Used by jarvis-gateway to store/retrieve per-channel conversation summaries and cross-agent knowledge. Has its own `haivemind/Claude.md`.

---

## Discord Channel → Thread → Agent Threading Model

### Session key format

Every agent conversation is keyed by a **channelKey**:

```
agent:main:discord:channel:<channelId>
agent:main:discord:channel:<channelId>:thread:<threadId>
```

A top-level channel message uses the channel form; a thread message uses the `:thread:` form.

### How a thread becomes an agent session

1. User runs `/spawn <task>` (or voice-spawn fires via `src/spawn.js:runVoiceSpawn`)
2. `spawn.js` creates a Discord thread in the parent channel
3. The thread's ID becomes part of the channelKey: `…:channel:<parentId>:thread:<threadId>`
4. Gateway calls `getOrCreateChatId(channelKey)` — returns an existing Claude `chatId` or starts a new session
5. Each subsequent message in the thread resumes: `claude -p --resume <chatId>`
6. Thread lifetime = session lifetime; the Discord thread is the visible history

### How `:thread:` suffixes are stripped — `resolveProfile()`

`scripts/jarvis-gateway.js:78-88`:

```js
function resolveProfile(channelKey) {
  let profileName = channelAccounts.channels?.[channelKey]; // exact match
  if (!profileName) {
    const parentKey = channelKey.replace(/:thread:\d+$/, ""); // strip thread suffix
    if (parentKey !== channelKey) profileName = channelAccounts.channels?.[parentKey];
  }
  profileName = profileName || "default";
  return channelAccounts.profiles?.[profileName] ?? channelAccounts.profiles?.default ?? null;
}
```

The same `:thread:` suffix stripping is applied in `_channelIsInAskMode()` (line 209) and `_channelMcpMode()` (line 233) so that per-channel ask-mode and MCP-mode settings are inherited by threads inside that channel.

**Fix landed in commit `faa16cc`**: thread sessions now correctly inherit the parent channel's haivemind memories, focus tag, and Claude profile. Before that fix, `:thread:` suffixes in session keys caused a lookup miss and threads got the default profile.

---

## Channel Registry — Per-Channel Context Routing

**File**: `~/dev/contexts/channel-registry.json` (~14 entries)

Maps a Discord channel ID to project context:

```json
{
  "<channelId>": {
    "name": "ewitness-dev",
    "path": "~/Dev/ewitness",
    "model": "claude-sonnet-4-6"
  }
}
```

`src/focus-state.js:_loadRegistry()` reads this file. When a message arrives in a channel, the registry entry provides:
- `path` — the project root Claude is run from (currently the gateway's cwd, not per-session; worktree isolation is planned)
- `model` — default model for that channel
- `name` — used in focus tags injected into Claude's context

Channel accounts (which Claude `--config-path` to use per channel) are separate: `channel-accounts.json` loaded by the gateway. MCP mode overrides: `channel-mcp-mode.json`. Both support the same `:thread:` suffix-stripping fallback.

---

## State Files (live, on generic)

Access via SSHFS at `~/Dev/generic/` (gamez) or directly at `~/.local/state/jarvis-voice/` on generic.
Note: `~/mnt/generic/` is empty — the real SSHFS mount is `~/Dev/generic/`.

| File | Purpose |
|---|---|
| `.local/state/jarvis-voice/jarvis-sessions.json` | channelKey → Claude chatId UUID |
| `.local/state/jarvis-voice/channel-models.json` | Per-channel model overrides |
| `.local/state/jarvis-voice/channel-accounts.json` | Per-channel Claude config-path (profile) |
| `.local/state/jarvis-voice/channel-ask-mode.json` | Per-channel ask-mode flag |
| `.local/state/jarvis-voice/channel-mcp-mode.json` | Per-channel MCP mode (`full`/`off`/subset) |
| `.local/state/jarvis-voice/handoff-pins.json` | Handoff thread pin registry |

---

## Deploy Workflow

**Model: GitHub is the single source of truth.**
- gamez authors code, commits, pushes to GitHub
- generic pulls from GitHub and restarts services
- No rsync, no SSHFS required for deploys

```
gamez  →  git push  →  GitHub  →  git pull --ff-only (generic)  →  systemctl restart
```

### Deploy with `scripts/deploy.sh`

```bash
# Full deploy: push branch to GitHub, pull on generic, restart services
scripts/deploy.sh

# Push to GitHub only (no restart)
scripts/deploy.sh --push-only

# Pull + restart on generic only (already pushed)
scripts/deploy.sh --pull-only

# Dry-run — shows what would happen, makes no changes
scripts/deploy.sh --dry-run
```

The script:
1. Pushes current branch to `origin` (GitHub)
2. Checks live tree on generic for dirty tracked files (would block `--ff-only`)
3. `git pull --ff-only origin <branch>` on generic
4. Restarts both services, waits 3s, checks `is-active`, tails startup logs

### Systemd services (on generic, `--user`)

| Unit | Purpose |
|---|---|
| `jarvis-voice.service` | Voice I/O + Discord event handling + bot bootstrap |
| `jarvis-gateway.service` | Claude CLI HTTP/SSE adapter (port 22100) |

Both run as `--user` units under the `generic` user account.

```bash
# Check status
ssh generic "systemctl --user status jarvis-voice jarvis-gateway"

# Restart individually
ssh generic "systemctl --user restart jarvis-gateway"
ssh generic "systemctl --user restart jarvis-voice"

# Follow live logs for one service
ssh generic "journalctl --user -u jarvis-voice -f"
ssh generic "journalctl --user -u jarvis-gateway -f"

# Tail both together (recent 100 lines)
ssh generic "journalctl --user -u jarvis-voice -u jarvis-gateway --since '5 minutes ago' --no-pager -n 100"

# Since last boot
ssh generic "journalctl --user -u jarvis-voice -u jarvis-gateway -b --no-pager | tail -80"
```

### Rolling back a bad deploy

Since the live tree is a git checkout, rollback is a `git reset`:

```bash
# Roll back one commit on generic
ssh generic "cd /home/generic/dev/openjarvis && git reset --hard HEAD^"
ssh generic "systemctl --user restart jarvis-gateway jarvis-voice"

# Confirm
ssh generic "systemctl --user is-active jarvis-voice jarvis-gateway"
ssh generic "journalctl --user -u jarvis-voice -u jarvis-gateway --since '20 seconds ago' --no-pager -n 40"
```

To roll back to a specific commit: `git reset --hard <sha>` on generic.

---

## Key Source Files

| File | Role |
|---|---|
| `src/index.js` (269 KB) | Bot bootstrap, Discord events, voice receiver, slash dispatch — monolith, refactor planned |
| `scripts/jarvis-gateway.js` (1096 lines) | Claude CLI adapter, session management, per-channel routing |
| `src/spawn.js` | `/spawn` and voice-spawn: creates threads, streams agent output |
| `src/brain.js` | Intent dispatch, response handling |
| `src/focus-state.js` | Channel registry loader, focus tag management |
| `src/alert-webhook.js` (61 KB) | Webhook receiver + alert queue |
| `src/session-manager.js` | Session lifecycle helpers |
| `src/thread-router.js` + `src/thread-orchestrator.js` | Thread-level routing and multi-step orchestration |
| `src/channel-mcp-mode.js` | MCP mode state per channel/thread |
| `haivemind/` | Python memory submodule — see `haivemind/Claude.md` |

---

## Planned Work

See plan: `~/.claude/plans/voice-can-you-figure-noble-patterson.md`

Key open items:
- Rename `package.json` `name` from `jarvis-voice` → `openjarvis`; bump to v2.0.0
- Add `projectPath` / `worktreeMode` to channel-registry and build `src/worktree-manager.js` so each Discord thread gets an isolated git worktree (currently all sessions share the gateway's cwd)
- Refactor `src/index.js` into `src/{voice,discord,brain,agent,alerts,state}/`
