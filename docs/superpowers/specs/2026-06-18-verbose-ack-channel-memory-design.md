# Design: `/verbose` ack mode + Telegram channel memory

**Date:** 2026-06-18
**Status:** Approved design (pre-implementation)
**Author:** Lance + Claude

## Problem

The Discord and Telegram chat interfaces give no signal that a task has started.
A request to the brain runs to full completion (often minutes; long tasks hit the
gateway's 600s timeout) before the user sees a single character back. Quote from
Lance in `#hud`:

> "It's responding now but is there a way to maybe have it ack on tasks and such.
> Feels like a black hole until telegram gets back to me."

Separately, the Telegram interface loses conversational memory. In `#hud`,
"Yeah" → "Hey — what do you need?" and "This" → another blank — the bot had no
prior turns to resolve the referent against. This was aggravated by a gateway
restart (the stuck-op abort) wiping the in-memory window mid-conversation.

## Root causes (confirmed in code)

| Symptom | Cause | File |
|---|---|---|
| Telegram black hole until done | `handleUpdate` `await`s `generateResponseStreaming` to full completion before sending anything; the streaming callback is `() => {}` and discards every partial. | `src/telegram/adapter.js:55` |
| Telegram amnesia ("Yeah"/"This") | History is a bare in-memory `Map` (`HISTORY_CAP=20`), wiped on every process restart and never backfilled from the chat. | `src/telegram/adapter.js:12-21` |
| Progress only in threading mode | Only the Discord live-stream/thread path renders `⏳ *responding...*`. Non-thread Discord gets a `🎯` react + a `sendTyping()` pulse that expires in ~10s. | `src/index.js:5320`, `src/brain/task-processor.js:330` |

**Important asymmetry:** Discord non-thread **already** backfills and remembers
channel history via `ensureDiscordHistoryLoaded` → `ch.messages.fetch({ limit, before })`
(`src/discord/message-handlers.js:67`). **Telegram has neither.** So the memory
fix is primarily a Telegram fix; Discord needs only the ack/progress fix.

## What we borrow from OpenClaw (studied from GitHub/docs only — nothing local)

- **`typingMode`** (`never` / `instant` / `thinking` / `message`) — *when* the working
  signal starts, refreshed every `typingIntervalSeconds` (default 6s) so it never
  expires mid-run. <https://docs.openclaw.ai/concepts/typing-indicators>
- **`streaming: progress`** — an *editable progress draft*: status updates during
  generation, then the final answer replaces it. This is exactly the `/verbose`
  behavior we want. <https://docs.openclaw.ai/concepts/streaming>
- **On-disk session store keyed by source, reloaded after restart** — the durability
  our Telegram `Map` lacks. <https://docs.openclaw.ai/concepts/session>
- **Gotcha to avoid:** a cluster of OpenClaw issues are *stuck* typing/progress
  indicators that never clear after a run ends
  ([#26733](https://github.com/openclaw/openclaw/issues/26733),
  [#27106](https://github.com/openclaw/openclaw/issues/27106),
  [#27926](https://github.com/openclaw/openclaw/issues/27926)).
  Our indicator MUST be cleared in a `finally` on every exit path (success, error,
  abort, timeout).

## Decisions (locked)

- **Telegram memory:** backfill on cold start **and** persist per-chat history to disk.
- **`/verbose`:** simple per-chat `on|off` toggle (not OpenClaw's 4-mode parity).

## Design

### Piece 1 — `/verbose on|off` (per-chat progress draft)

A new per-chat flag, stored exactly like the existing `engine`/`model` per-chat state
(`src/telegram/engine.js` is the pattern). Default **off**.

- **off (default):** today's behavior, plus the instant ack from Piece 2.
- **on:** a single "progress draft" message is sent immediately and **edited in place**
  as the run proceeds:
  `🔄 starting…` → `🔧 working…` (+ coarse tool/elapsed hints) → finally **replaced**
  by the real answer (`terseStatus` + `detailBody` chunks as today).

Mechanism: the adapter currently passes `() => {}` as the streaming callback to
`generateResponseStreaming` and throws away every partial. In verbose mode we pass a
real callback that throttles edits (respect Telegram's edit rate limits — coalesce to
~1 edit / 2–3s) to the draft message via `editMessageText`.

- **Commands:** Telegram `/verbose on|off` (owner-only, same gate as `/engine`).
  Discord gets an equivalent `/verbose` toggle for non-thread channels.
- **Status:** surface current verbose state in the existing `/status` output.

### Piece 2 — Instant ack + self-refreshing working indicator

Independent of verbose mode, so even `/verbose off` is never a black hole.

- **Telegram:** on message receipt, call `sendChatAction(chatId, 'typing')` and refresh
  it on a ~6s interval (Telegram's typing action lasts ~5s) until the run ends.
- **Discord non-thread:** the `🎯` react already fires; add a `sendTyping()` refresh
  loop on the same ~6s cadence so it doesn't expire on long tasks.
- **Clear-on-every-exit:** the refresh interval is created before the run and cleared in
  a `finally`, covering success, error, abort (`/cancel`), and the 600s timeout. This is
  the explicit guard against OpenClaw's stuck-indicator bug.

### Piece 3 — Telegram channel memory: backfill + persist

Bring Telegram up to Discord's level (and past it, with durable persistence).

- **Persist:** replace the in-memory `histories` `Map` with a small disk-backed store at
  `~/.local/state/jarvis-voice/telegram-history.json`, keyed by the existing
  `telegramChatKey(chatId, topicId)`. Same write-discipline as the other state files in
  that dir (atomic write). Cap retained turns (keep `HISTORY_CAP=20` window for what's
  sent to the brain; the disk file may hold a slightly larger ring for safety).
- **Backfill on cold start:** the first time a chat is seen after start with an empty
  persisted history, pull recent messages from the Telegram API (mirroring Discord's
  `messages.fetch` backfill) and seed the window so "yeah"/"this" resolve. Telegram's
  bot API cannot fetch arbitrary history the way Discord can, so backfill is
  best-effort: seed from whatever is available (the persisted file is the primary
  durability mechanism; live backfill is the secondary, cold-start nicety).
- **Restart safety:** because the window is now on disk, a gateway/voice restart (the
  exact event that wiped context in `#hud`) no longer erases the conversation.

## Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/telegram/verbose.js` (new) | per-chat verbose flag get/set + disk persistence | state dir |
| `src/telegram/history-store.js` (new) | disk-backed per-chat history: load, push, trim, persist, backfill seed | transport, state dir |
| `src/telegram/progress.js` (new) | progress-draft lifecycle: open draft, throttled edit, finalize/replace, clear | transport |
| `src/telegram/typing.js` (new) | self-refreshing typing action with guaranteed clear | transport |
| `src/telegram/adapter.js` (edit) | wire the above into `handleUpdate`; pass real streaming callback when verbose | all of the above |
| `src/telegram/commands.js` (edit) | parse `/verbose on|off` | — |
| Discord side (edit) | `/verbose` toggle + `sendTyping()` refresh loop on non-thread path | existing handlers |

Each new unit is small, single-purpose, independently testable, and talks to the
transport through a narrow interface (send / edit / chatAction).

## Error handling

- Every typing/progress lifecycle is wrapped so the indicator is **cleared in `finally`**
  regardless of how the run ends. This is a hard requirement (OpenClaw stuck-indicator
  bug class).
- Progress-draft edits that fail (deleted message, rate limit) are swallowed and do not
  abort the run; on repeated edit failure, fall back to a single final send.
- History-store disk writes are atomic; a corrupt/missing file degrades gracefully to an
  empty in-memory window (never crashes the adapter).

## Testing

- **Unit:** verbose flag persistence; history-store push/trim/persist/reload round-trip;
  progress throttle (N rapid partials → ≤1 edit per window); typing-clear on each exit
  path (success / throw / abort).
- **Integration (live Telegram):** send a long task with `/verbose off` → see instant
  typing within ~1s, answer at the end, no stuck typing. With `/verbose on` → see the
  draft mutate then get replaced. Restart the gateway mid-conversation → next "yeah"
  still resolves (persistence proven).
- Per `verification-before-completion`: deploy to generic, restart services, run the live
  Telegram test, and confirm via `journalctl` before claiming done.

## Out of scope (YAGNI)

- OpenClaw's `partial`/`block` token-streaming modes (we chose simple on/off).
- Cross-channel identity linking (`identityLinks`) and `dmScope` tiers.
- Discord memory changes beyond the typing-refresh (it already backfills + remembers).
- Summarization/compaction of the Telegram window (the 20-turn cap is enough for now).
