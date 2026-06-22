# Jarvis v2.0.0 Architecture Spec

> **Status:** design / buildable. **Spine:** migration-risk-first strangler-fig.
> **Scope:** Discord + Telegram + voice (the three live surfaces). Slack is a deferred stub that proves the abstraction.
> **No-PII hard rule:** every example below uses placeholder IDs (`<channelId>`, `<chatId>`). Real channel IDs, owner IDs, Telegram numeric IDs, and tokens live ONLY in `config.yaml` / `channel-registry.json` / `channel-accounts.json` (config tier, gitignored / out of tree). Capability lists, surface names, and config keys are generic technical flags — safe to commit. The runtime prompt block and any log line template **surface/model LABELS, never raw IDs**.
> **Deploy model:** GitHub is the single source of truth. gamez authors → `git push` → GitHub → generic `git pull --ff-only` → `systemctl --user restart`. Every step below is independently shippable through `scripts/deploy.sh` and reversible with `git reset --hard HEAD^` on generic.

---

## 0. Why this design, and the one bug that drives it

The originating bug is structural, not cosmetic: **the model is blind to its own surface and capabilities.** `brain.js` builds the system prompt knowing only `surfaceHint` (`'telegram'`), while the gateway (`scripts/jarvis-gateway.js spawnClaudeStream`) is the *only* place where `model`, `askMode`, `mcpMode`, and `engineEnv` all converge at spawn time — and it pours those signals into CLI flags only, never into the prompt the model reads. So when `/engine qwen` is set, Qwen sees Claude-centric instructions (`sessions_spawn`, MCP chrome tools) it cannot use, and `@/path/to/file` attachment refs with no instruction on how to read them.

This document fixes that by resolving a **single typed `Capabilities` descriptor at the gateway spawn boundary** and injecting a compact `## Runtime` block into the prompt. The same descriptor instance also drives reply rendering in a new neutral comms layer, so "what the model is told it can do" and "what the renderer enforces" cannot drift.

Three angles were considered. This spec uses **the migration-risk-first strangler-fig as the backbone** (it is the only framing honest about the half-finished current state — duplicate inline senders shadowing `src/discord/posting.js`), grafts in the **flat typed `Capabilities` descriptor** (single instance feeds both prompt and renderer), and adopts the **`AgnosticFile` attachment shape** (contains the verified `AttachmentBuilder` leak).

### Verified ground truth (read before building)

| Claim | Verified location |
|---|---|
| Telegram ask/mcp inputs are **structurally dead**, not a cosmetic ID issue | `jarvis-gateway.js:247` `_channelIsInAskMode` and `:270` `_channelMcpMode` both `channelKey.match(/discord:channel:(\d+)(?::thread:(\d+))?/)` then bail. A `telegram:chat:` key never matches → askMode always `false`, mcpMode always `off` for Telegram. |
| The fix shape already exists | `memoryCategory` at `:417` uses `/telegram:chat:([\w-]+)/` and handles negative IDs. |
| Resumed-chat prompt can have **empty `_sysText`** | `jarvis-gateway.js:975-977`: resumed path is `_sysText ? \`${_sysText}\n\n${userMsg}\` : userMsg`. On the empty-sys branch there is nothing to splice after — preamble MUST prepend the final `prompt` variable. |
| `src/index.js` holds **duplicate inline senders** shadowing `posting.js` | `index.js`: `postActivity@848`, `sendDM@3302`, `postToCC@3316`, `postToTextChannel@3329`, `postToChannel@3404`. `posting.js` exports the same names. 5994 lines total. |
| Voice output is a **stateful FSM**, not "enqueue TTS" | `index.js:525` `_ttsDeliveryActive`, `:529` `setTTSDeliveryActive`, `:537` `getIsSpeaking()`-equivalent, `:560` `_deliverSpeak`, `:870` `AudioQueue` class, plus `speech-output.js` drain machinery. |
| Alert callbacks are **12 setters, only 4 are send paths** | `alert-webhook.js:311/319/323/329` (send) vs `:315/333/337/341/424/428/431/1647` (control/state). |
| `_surfaceInstruction` is the ONLY formatting hint, called twice | `brain.js:1234` def, `:1246` + `:1462` call sites. |
| Correct file paths | spawn is `src/agent/spawn.js` + `src/slash/spawn.js` (NOT `src/spawn.js`); cgg is `src/cgg-dispatch.js` (NOT `src/discord/`). |
| Test runner + worktree are **not greenfield** | `package.json` `"test": "vitest run"`; `src/__tests__/worktree-manager.test.js` + `feature-worktrees.test.js` already exist. |

---

## 1. Comms / transport layer

A single transport-neutral comms layer becomes the spine. Every producer (brain, alerts, cgg, HUD, voice, spawn-thread streaming, kanban) emits one neutral `OutMessage` to a `Recipient`; every surface implements one small `Provider`. Providers own ALL surface-specific serialization (chunking, `AttachmentBuilder`/`InputFile` wrapping, action mapping, markdown variant). No producer imports `discord.js` or `node-telegram-bot-api` directly.

The key strangler move: **`src/discord/posting.js` keeps its exported function names and becomes a thin shim that builds a `Recipient`+`OutMessage` and calls `comms.send()`.** Its six importers (`voice/tts-delivery.js`, `voice/utterance-queue.js`, `discord/startup.js`, `discord/message-handlers.js`, `discord/voice-state-handler.js`, `brain/task-processor.js`) never change. The duplicate inline copies in `index.js` are deleted **last**, after local callers are repointed, so the old path stays live as a safety net.

### 1.1 Neutral shapes (`src/comms/types.js`, JSDoc typedefs — repo is plain ESM, no TS)

```js
/**
 * @typedef {Object} Recipient
 * @property {'discord'|'telegram'|'voice'} surface
 * @property {'channel'|'thread'|'user'|'chat'} kind
 * @property {string} id                       // namespaced by surface; raw id within surface
 * @property {string} [topicId]                // telegram forum topic / discord thread parent
 */

/**
 * @typedef {Object} AgnosticFile               // NEVER a discord.js AttachmentBuilder
 * @property {'image'|'audio'|'doc'|'video'} kind
 * @property {string} [path]                    // on-disk path (allowlist-validated)
 * @property {Buffer} [buffer]                  // in-memory (cgg PNG/mmd buffers)
 * @property {string} name
 * @property {string} [mime]
 */

/**
 * @typedef {Object} NeutralEmbed
 * @property {string} [title]
 * @property {{name:string,value:string}[]} [fields]
 */

/**
 * @typedef {Object} ReplyContext
 * @property {string} [messageId]               // discord allowedMentions+reply / telegram reply_to_message_id
 * @property {string} [threadId]                // discord thread / telegram message_thread_id
 * @property {boolean} [suppressMention]
 */

/**
 * @typedef {Object} OutMessage                 // the ONLY shape that crosses the comms boundary
 * @property {string} [text]
 * @property {AgnosticFile[]} [attachments]
 * @property {NeutralEmbed} [embed]
 * @property {{audioPath:string}} [voice]       // voice surface only
 * @property {ReplyContext} [replyTo]
 * @property {Object} [meta]                     // {parseMode?, silent?}
 */

/** @typedef {{messageId: (string|null), channelId: string}} SendResult */
```

`messageId` is `string | null` — voice has no message id. Reaction / follow-up actions are gated on `caps.canReact`, so a `null` id never breaks a caller.

### 1.2 Provider interface (`src/comms/provider.js`)

```js
/**
 * @typedef {Object} CommsProvider
 * @property {'discord'|'telegram'|'voice'} surface
 * @property {(recipient: Recipient) => import('../capabilities/schema.js').Capabilities} capabilities
 * @property {(recipient: Recipient, msg: OutMessage, caps: Capabilities) => Promise<SendResult>} send
 * @property {(recipient: Recipient) => Promise<void>} [sendTyping]   // optional affordance, no-op if unsupported
 */
```

`send()` receives the **same `Capabilities` instance** the gateway used to build the prompt (see §2). It reads `caps.maxLen` (chunking), `caps.supportsMarkdown` (downgrade headers/tables to plain when false), `caps.supportsEmbeds` (Telegram renders an embed as a text summary), `caps.canAttachFiles` (if false, drop attachments and inline a `[file: <name> @<path>]` text ref — the same shape Telegram already uses for inbound). This is the symmetric twin of the prompt layer.

### 1.3 Errors (`src/comms/errors.js`)

One shared class, `kind` discriminator (ported lighter from openclaw's per-surface `DiscordSendError`):

```js
export class SendError extends Error {
  constructor(kind, surface, channelId, cause) { super(`${surface}:${kind}`); ... }
  // kind: 'missing-permissions' | 'dm-blocked' | 'not-found' | 'rate-limited'
}
```

Permission *probing* (openclaw probes channel perms on failure) is deferred until a real `dm-blocked` failure shows up.

### 1.4 Directory layout

```
src/comms/
  index.js              barrel + registry: registerProvider(surface, p), getProvider(surface), send(recipient, msg)
  types.js              JSDoc typedefs above
  provider.js           CommsProvider contract typedef
  recipient.js          parse/normalize; Recipient <-> channelKey bridge; the SHARED suffix-strip util
  chunk.js              flat per-surface limits: DISCORD=2000 char-split, TELEGRAM=4096 char-split
  errors.js             SendError{kind,surface,channelId}
  attachments.js        NEUTRAL: extractAttachmentsNeutral(text) -> {cleanedText, files:AgnosticFile[], dropped}
                        + buildAttachmentContext(att, caps) (model-aware, see §2.6)
  render.js             pure: renderReply(msg, caps) -> surface-ready chunks (markdown downgrade + chunking)
  providers/
    discord.js          DiscordProvider — the ONLY file that imports AttachmentBuilder / EmbedBuilder
    telegram.js         TelegramProvider — wraps existing createTransport() injected sender + splitSend()
    voice.js            VoiceProvider — models the real audioQueue / _ttsDeliveryActive FSM (see §1.6)
    slack.js            (deferred stub — proves the abstraction, no live wiring)
```

### 1.5 Where `extractAttachments` and media live — containing the leak

The verified leak: `src/discord/attachments.js extractAttachments()` returns `discord.js` `AttachmentBuilder[]`, and `posting.js:76` consumes it; `cgg-dispatch.js` builds `AttachmentBuilder[pngBuffer, mmdText]` from binary buffers.

Fix:
- The **path-allowlist / `realpath` / containment validation** (the genuinely valuable, security-relevant part) moves **verbatim** into `src/comms/attachments.js extractAttachmentsNeutral()`, which returns `AgnosticFile[]` (`{kind, path, name, mime}`) — **no `AttachmentBuilder`**.
- `src/discord/attachments.js extractAttachments()` becomes a thin re-export shim that calls `extractAttachmentsNeutral()`.
- `DiscordProvider.send()` does `new AttachmentBuilder(f.path, {name:f.name})` (path) or `new AttachmentBuilder(f.buffer, {name:f.name})` (buffer) **at the boundary**, the only place that imports it.
- `cgg-dispatch.js` stops importing `discord.js` entirely and instead returns `OutMessage{attachments:[{kind:'image',buffer:pngBuffer,name:'graph.png'},{kind:'doc',buffer:mmdText,name:'graph.mmd'}]}` → `comms.send()`.
- After the migration, `grep AttachmentBuilder|EmbedBuilder src/` must hit **only** `providers/discord.js` and `providers/voice.js` (HUD embeds). Any other hit is a bug.

openclaw's `media/parse.ts` MEDIA-token extraction is **deferred** — openjarvis does not emit agent-side outbound media yet. Add only when that lands.

### 1.6 VoiceProvider — modeled against the real FSM (gap filled)

A naive `VoiceProvider.send() = audioQueue.add(path)` would bypass speaking-state gating and double-speak over active task TTS / barge-in. The real path is stateful (`index.js:525-583`, `speech-output.js`):

```js
// src/comms/providers/voice.js
export function makeVoiceProvider({ audioQueue, ttsState, speechOutput }) {
  return {
    surface: 'voice',
    capabilities: () => VOICE_CAPS,  // {isVoice:true, maxLen:0, canAttachFiles:false, supportsMarkdown:false}
    async send(recipient, msg, caps) {
      // 1. If task delivery is active, DEFER via the existing pending-speak drain, do NOT add directly.
      if (ttsState.isTTSDeliveryActive()) {
        speechOutput.queuePendingSpeak(msg);          // flushed by flushPendingSpeaks scheduler
        return { messageId: null, channelId: 'voice' };
      }
      // 2. Pre-synthesized audio path
      if (msg.voice?.audioPath) { audioQueue.add(msg.voice.audioPath); return {messageId:null,channelId:'voice'}; }
      // 3. Text -> respect getIsSpeaking() gate + enforceOutputLength, then speakAndWait
      const text = speechOutput.enforceOutputLength(msg.text || '');
      await speechOutput.speakAndWait(text);          // owns synthesizeSpeech + audioQueue.add + setIsSpeaking
      return { messageId: null, channelId: 'voice' };
    },
  };
}
```

`VoiceProvider` is injected the real `audioQueue`, the `_ttsDeliveryActive` accessors (`isTTSDeliveryActive`/`setTTSDeliveryActive`), and the `speech-output.js` exports (`speakAndWait`, `enforceOutputLength`, `getRandomCachedAck`, drain scheduler). It does **not** re-implement the FSM — it routes through it.

### 1.7 Producers that must become comms consumers (gaps filled)

Every send consumer is enumerated so none is missed:

| Producer | Today | v2 |
|---|---|---|
| `posting.js` 5 senders | direct `channel.send()` | shim → `comms.send()` |
| `index.js` 5 inline dup senders | direct, 51 local call sites | repointed to imported `posting.js`, then deleted |
| `src/cgg-dispatch.js` | `message.reply({files: AttachmentBuilder[]})` | returns `OutMessage{attachments:[{buffer}]}` → `comms.send()` |
| **spawn-thread streaming** (`src/agent/spawn.js`, `src/slash/spawn.js`) | streamed agent tokens written to a Discord thread via `thread.send()` | `comms.send()` with `Recipient{kind:'thread'}`, chunked per `caps.maxLen`; preserves token ordering |
| **kanban-dispatch** (`src/kanban-dispatch.js`) | returns `{type:'kanban', speech, discordText}` rendered in `index.js` (TTS speech + Discord post) | emits **two** `OutMessage`s: one to the voice `Recipient` (`{text:speech}`) and one to the channel `Recipient` (`{text:discordText}`). Stays a pre-brain dispatch; the renderer just absorbs both outputs. |
| HUD (`src/discord/hud.js`) | `EmbedBuilder` | `OutMessage{embed:NeutralEmbed}`; `DiscordProvider` wraps to `EmbedBuilder` (first chunk only) |
| Alert send paths (4 of 12 callbacks) | `setPostToTextCallback`/`setSpeakCallback`/`setPostActivityCallback`/`setPostToThreadCallback` | direct `comms.send(recipient, msg)`. **The other 8 callbacks stay** (control/state inversions, §3.5) |

---

## 2. Env-aware capability + system-prompt layer

One flat typed descriptor, resolved at the single gateway spawn boundary where every signal converges, injected as a compact `## Runtime` block into the final prompt string, and re-used by the comms renderer.

### 2.1 Schema (`src/capabilities/schema.js`)

```js
/**
 * @typedef {Object} Capabilities
 * @property {'discord'|'telegram'|'voice'} surface
 * @property {string} model                  // resolved model id (LABEL only in prompt, never raw channel id)
 * @property {'claude'|'qwen'} engine
 * @property {number}  maxLen                 // 2000 discord / 4096 telegram / 0 voice
 * @property {boolean} supportsMarkdown
 * @property {boolean} supportsEmbeds
 * @property {boolean} canAttachFiles
 * @property {boolean} canThread
 * @property {boolean} canReact
 * @property {boolean} isVoice
 * @property {boolean} canReadFilePaths       // claude: true; qwen: false (files inlined as text)
 * @property {boolean} hasTools               // claude && mcp!=off && !askMode-write-block
 * @property {'off'|'subset'|'full'} mcpMode
 * @property {boolean} askMode                // plan/read-only
 */
```

Flat booleans beat openclaw's `string[]` + `Set.has('inlinebuttons')` membership tests scattered across ~6 `buildXSection()` functions: one struct, direct field reads, one builder. The **same instance** feeds the prompt block AND the comms renderer, so they cannot diverge.

### 2.2 Resolution (`src/capabilities/resolve.js`)

```js
export function resolveCapabilities({ surface, model, engine, mcpMode, askMode }) -> Capabilities
```

Composition order (surface default ← model overlay ← mcp overlay ← ask overlay):

```
SURFACE_DEFAULTS[surface]                      // from config.yaml capabilities.<surface>, hardcoded fallback
  ← engine==='qwen'  : canReadFilePaths=false, hasTools=false, (text-only, files inlined)
  ← mcpMode==='off'  : hasTools=false
  ← askMode===true   : hasTools stays but writes refused; preamble says plan-only
```

Surface defaults:

```yaml
# config.yaml -> mapped to env by src/config-env-bootstrap.js (no PII; generic flags)
capabilities:
  discord:  { maxLen: 2000, supportsMarkdown: true,  supportsEmbeds: true,  canAttachFiles: true,  canThread: true, canReact: true }
  telegram: { maxLen: 4096, supportsMarkdown: false, supportsEmbeds: false, canAttachFiles: true,  canThread: true, canReact: false }
  voice:    { maxLen: 0,    supportsMarkdown: false, supportsEmbeds: false, canAttachFiles: false, isVoice: true }
```

Code-side `SURFACE_DEFAULTS` fallbacks **must match these exactly**, so a missing `config.yaml` on generic does not silently change behavior. Verify the resolved-caps log line on generic after `pull --ff-only + restart`.

Two-tier override (lighter than openclaw's 3-tier account>channel>default): `channel-registry.json` per-channel override > `config.yaml` surface default. No multi-account-per-surface model, so no third tier.

### 2.3 ⚠️ STEP -1 PREREQUISITE — fix the Telegram-blind ask/mcp regexes FIRST

**This must land before any capability descriptor reads `askMode`/`mcpMode`, or the descriptor silently encodes wrong values for the exact surface the originating bug lives on.**

`jarvis-gateway.js:247` and `:270` currently:

```js
const m = channelKey.match(/discord:channel:(\d+)(?::thread:(\d+))?/);
if (!m) return false;   // <-- telegram ALWAYS hits this
```

Replace the lookup so it is surface-aware, mirroring `memoryCategory` at `:417`. Extract the shared parser into `src/comms/recipient.js` (the single home for the `/(thread|topic):\d+$/` suffix-strip the recon flagged as duplicated):

```js
// src/comms/recipient.js
export function parseChannelKey(channelKey) {
  // discord:  agent:main:discord:channel:<id>[:thread:<tid>]
  // telegram: agent:main:telegram:chat:<id>[:topic:<tid>]   (<id> may be negative: -100...)
  let m = channelKey.match(/discord:channel:(\d+)(?::thread:(\d+))?/);
  if (m) return { surface:'discord', channelId:m[1], threadId:m[2] || null };
  m = channelKey.match(/telegram:chat:([\w-]+)(?::topic:(\d+))?/);
  if (m) return { surface:'telegram', channelId:m[1], threadId:m[2] || null };
  return null;
}
export const stripThreadSuffix = (k) => k.replace(/:(thread|topic):\d+$/, '');
```

`_channelIsInAskMode` / `_channelMcpMode` call `parseChannelKey()`, then index the **raw-id-keyed** state files by `channelId`/`threadId` (see §2.7). Test with a real **negative** Telegram chat id fixture.

### 2.4 Resolution point + injection (`src/capabilities/runtime-block.js`)

Resolve at `jarvis-gateway.js spawnClaudeStream` — the only place `askMode` (`:328`), `mcpMode` (`:336`), `model`, and `engineEnv` (`:377`) co-exist:

```js
// in spawnClaudeStream, downstream of both prompt branches
const caps = resolveCapabilities({ surface, model, engine, mcpMode, askMode });
const preamble = buildRuntimeBlock(caps);   // compact, label-only, no raw ids
prompt = `${preamble}\n\n${prompt}`;        // PREPEND the FINAL prompt var unconditionally
```

**Critical (fatal-flaw avoidance):** prepend the **final `prompt` variable** (or do it inside `spawnClaudeStream` at `:327`), downstream of the resumed (`:976`) vs new-chat (`:977`) branches. On the resumed branch `_sysText` can be empty; splicing "after `_sysText`" loses the preamble on every turn after the first. Prepending the final `prompt` covers both branches.

`buildRuntimeBlock(caps)` — one function, conditional lines gated on non-default values (omit lines that match the surface default, to control prompt-length growth):

```
## Runtime
surface=<surface> model=<modelLabel> engine=<engine>
<if !supportsMarkdown>  Reply target: <surface> — light formatting only, no headers/tables, max ~<maxLen> chars.
<if !canReadFilePaths>  Files: this model CANNOT open @path references; attachments are inlined as text below.
<if !hasTools>          Tools: none in this mode. Do not call sessions_spawn or MCP tools.
<if askMode>            Mode: plan/ask — read and discuss only, do not Edit/Write/Bash.
<if isVoice>            Voice reply — concise spoken sentences, no markdown, no code blocks.
```

This is openclaw's `buildRuntimeLine` + conditional `buildMessagingSection` idea collapsed to ONE builder appending a compact block — no per-section builder fan-out, no `promptMode full/minimal/none` gating.

### 2.5 What this kills, and what stays in brain.js

Kills every verified contradiction: Qwen no longer sees `@/path` with Claude instructions; ask-mode no longer says "Use tools via sessions_spawn"; `mcp=off` no longer claims MCP tools.

**Stays in brain (fatal-flaw avoidance):** `_surfaceInstruction(surfaceHint)` (`brain.js:1234`, called `:1246` + `:1462`) is **kept as formatting-only**. It is the ONLY surface formatting hint in the codebase, it is known at brain time, and it is surface-stable. Do **not** delete it and move its job to the gateway block (Design 2's flaw): a preamble-flag-off or gateway hiccup would then leave Telegram with no formatting instruction at all. Clean split: **formatting → brain (`_surfaceInstruction`); model/capability awareness → gateway (`buildRuntimeBlock`).** `text-channel.txt` / `mobile-mode.txt` Claude-centric tool lines are NOT stripped — the gateway block authoritatively overrides them per-turn, and leaving the templates intact means the system degrades gracefully if the block is flag-disabled.

`brain.js` passes `surface` through the request body to the gateway (alongside the existing `surfaceHint`), so the gateway can resolve caps. `surfaceHint` is **not** removed.

### 2.6 Attachment capability declaration (closes the attachment seam)

`src/comms/attachments.js buildAttachmentContext(att, caps)` and `telegram/attachments.js` become model-aware in ONE place:

```js
if (caps.canReadFilePaths) return `[The user sent an attachment. Read it with @${att.path}]`;
return `[The user sent an attachment. Its contents are inlined below:]\n${inlineText(att)}`;
```

The adapter does not decide — it passes the attachment neutrally; the gateway's `caps` resolves the branch. This is the symmetric twin of `caps.canAttachFiles` in the renderer (§1.2).

### 2.7 Per-channel state files stay RAW-ID-keyed (gap filled)

`channel-ask-mode.json`, `channel-mcp-mode.json`, `channel-models.json` are keyed by **raw numeric `channelId`/`threadId`** (the gateway extracts the id via `parseChannelKey`, then indexes `state[threadId] ?? state[channelId]`). **Do not re-key these by `Target` or full `channelKey`** during the comms refactor — that would silently break every existing per-channel override. `recipient.js` extracts the raw id; the state modules keep their current key shape.

### 2.8 The `memoryCategory` ↔ `getChannelContext` contract (gap filled)

`memoryCategory()` (gateway `:417`) and `getChannelContext()` (brain) **must agree on category names**. Discord strips `:thread:`, Telegram strips `:topic:`. Both now route through `recipient.js`. **Step 0 ships a contract test** asserting both produce identical categories for the same `channelKey` (Discord + Telegram + negative-id fixtures). If one side changes, both change in the same PR.

---

## 3. `src/index.js` decomposition (5994 → ~300 lines)

Reality check: `index.js` is **not** a pure monolith. Commit `a1ef878` ("slim to 389-line bootstrap, Pillar 3") and the existing `src/{discord,brain,voice,agent,state}/` trees show decomposition already landed. `index.js` already *imports* the extracted modules. Three things still need to leave it, in priority order. **The client-bootstrap extraction (C) goes LAST — it is pure risk with no capability payoff.**

| Concern remaining in `index.js` | Destination | Priority |
|---|---|---|
| **(A)** duplicate senders `postActivity@848`/`sendDM@3302`/`postToCC@3316`/`postToTextChannel@3329`/`postToChannel@3404` + 51 local call sites | DELETE; repoint local callers to `src/discord/posting.js` (now comms-backed) | with comms work |
| **(B)** `AudioQueue@870` class + `_deliverSpeak@560` + `_ttsDeliveryActive` accessors | `src/voice/audio-queue.js` + `src/voice/speak-delivery.js` (slots beside existing `speech-output.js`, `tts-delivery.js`, `utterance-queue.js`) | after comms+caps live |
| **(C)** Discord `Client` construction + `GatewayIntentBits` + all `client.on()` wiring | `src/discord/client.js` (construct) + `src/discord/events.js` (handlers, mostly already delegate to `message-handlers.js`) | LAST |

### Target tree

```
src/
  comms/        NEW — neutral transport spine (§1)
  capabilities/ NEW — schema.js, resolve.js, runtime-block.js (§2). Imported by gateway (prompt) + comms (render)
  discord/      EXISTS — gains client.js + events.js; posting.js becomes comms shim
  voice/        EXISTS — gains audio-queue.js + speak-delivery.js
  brain/        EXISTS — keeps brain.js; _surfaceInstruction stays formatting-only; adds surface passthrough
  agent/        EXISTS — spawn.js (thread streaming → comms), session-manager, handoff-resolver
  alerts/       NEW (RENAME target, LOW priority) — alert-webhook.js, alert-queue.js, alert-context.js, task-ledger.js
  state/        EXISTS — bot-state, focus-state, runtime; discordRef client handle
scripts/jarvis-gateway.js   SEPARATE systemd unit, stays put; gains resolveCapabilities + buildRuntimeBlock import
```

`index.js` end state (~300 lines): load env/config, construct client via `discord/client.js`, register providers into `comms`, register events, start alert-webhook, login, graceful shutdown.

**Ordering rule:** `index.js` shrinks as a **byproduct** of the comms work (A is forced by it), not as its own big-bang. Never bulk-move; one concern per PR; re-export shims keep external requires working; run the live-Discord + journalctl verification after each.

### 3.5 Alerts: keep the 8 non-send callbacks (gap filled)

`alert-webhook.js` has 12 setters. Only **4 are send paths** and migrate to `comms.send()`:
`setSpeakCallback`, `setPostActivityCallback`, `setPostToTextCallback`, `setPostToThreadCallback`.

The other **8 are control/state inversions** that comms does NOT subsume and **must keep existing**:
`setMarkBotResponseCallback`, `setCurrentVoiceChannelId`, `setPersonaSwitchCallback`, `setPersonaCreateCallback`, `setDedupCallback`, `setCancelAllTasksCallback`, `setDidTaskSpeakInlineCallback`, `setHandleFakeSttCallback`.

Treating "alert callbacks" as one thing comms replaces would delete load-bearing non-send wiring. The alerts migration (§6 STEP 8) touches the voice→text→DM→gateway escalation chain (load-bearing for on-call) — it is the **highest-risk** migration, done LAST, behind a flag, with the full escalation ladder smoked on generic before the old send callbacks are removed.

---

## 4. Per-thread git worktree isolation

**Not greenfield.** `src/__tests__/worktree-manager.test.js` and `feature-worktrees.test.js` already exist, and `channel-registry.json` already carries `projectPath` / `baseRef` / `worktreeMode` / `worktreeRoot` (per `registry-schema.js`). v2 reconciles with these tests, it does not assume a clean slate.

Worktree isolation is **orthogonal to and downstream of** the comms/capability work and must be sequenced **after** it. The comms layer never touches git — it only routes messages. The clean seam: a worktree is a property of the SESSION/`channelKey`, resolved at the **same** `spawnClaudeStream` chokepoint where capabilities and `engineEnv`/profile already resolve.

```js
// scripts/jarvis-gateway.js spawnClaudeStream, alongside engineEnv overlay
const parentKey = stripThreadSuffix(channelKey);                 // shared util from recipient.js
const worktreePath = resolveWorktree(parentKey);                 // null when worktreeMode=off (default)
const spawnOpts = { cwd: worktreePath ?? GATEWAY_CWD, env: { ...engineEnv } };
```

`resolveCapabilities` and `resolveWorktree` are **siblings** keyed off `channelKey`: the worktree sets the spawn `cwd` (today `claude -p` inherits the gateway cwd); the descriptor sets the prompt+render contract. Both inherit the parent channel via the SAME `:thread:`/`:topic:` suffix-strip (`recipient.js stripThreadSuffix`), so a thread reuses its parent channel's worktree, falling back to the parent when the thread has none.

`worktreeMode` default `off` = current shared-cwd behavior → the feature is a **no-op until a channel opts in**, which makes it safe to land after the live-traffic comms work. The runtime block can also surface `workdir=<branch>` as a Runtime line so the model knows its isolated tree (label only, never a path that leaks PII).

---

## 5. The `openjarvis` → v2.0.0 rename

Mechanical, isolated to its own PR (no behavior change), landed **after** the comms+capability work is stable:

1. `package.json`: `"name": "jarvis-voice"` → `"openjarvis"`; `"version"` → `"2.0.0"`.
2. Keep the **systemd unit names** (`jarvis-voice.service`, `jarvis-gateway.service`) — renaming units is a separate generic-side op with its own rollback; do NOT couple it to the package rename. Document the unit names as legacy-stable in `CLAUDE.md`.
3. Grep for hardcoded `jarvis-voice` package references in scripts (`deploy.sh`, state-dir paths `~/.local/state/jarvis-voice/`). **State-dir paths stay `jarvis-voice`** — renaming the state dir would orphan live session/registry files on generic. The package name and the state-dir name are decoupled on purpose.
4. No PII touched; commit message generic: `chore: rename package jarvis-voice -> openjarvis, bump 2.0.0`.

---

## 6. Incremental migration plan (strangler-fig)

Every step is independently shippable via `scripts/deploy.sh` (gamez push → GitHub → generic `git pull --ff-only` → `systemctl --user restart`), reversible with `git reset --hard HEAD^` on generic, and current traffic is never broken. Work lands on a fresh branch off the merged state; confirm the generic tree is clean (deploy.sh checks dirty tracked files) before each pull. New modules ship with **vitest** specs (`vitest run`), not `node --test`.

**Verify gate (run after EVERY step):** `ssh generic "systemctl --user is-active jarvis-voice jarvis-gateway"` both `active`; `journalctl --user -u jarvis-voice -u jarvis-gateway --since '60s ago' --no-pager` clean; plus the per-step live check below. Use the `verification-before-completion` skill discipline (deploy → restart → live-Discord test → journalctl).

---

### STEP -1 — Fix Telegram-blind ask/mcp regexes (PREREQUISITE, ships alone)
Add `src/comms/recipient.js` (`parseChannelKey`, `stripThreadSuffix`) with vitest specs incl. a **negative Telegram chat-id** fixture. Repoint `_channelIsInAskMode` (`:247`) and `_channelMcpMode` (`:270`) to `parseChannelKey()`, preserving raw-id state-file indexing (§2.7). **Verify:** set ask-mode on a real Telegram chat, confirm the gateway now reads it (journalctl shows plan-mode args); Discord ask/mcp behavior identical. Without this, every later capability descriptor is wrong for Telegram.

### STEP 0 — Comms skeleton + contracts (no behavior change, additive)
Add `src/comms/{types.js, provider.js, chunk.js, errors.js}` and `src/capabilities/schema.js` as pure modules. Add the **`memoryCategory` ↔ `getChannelContext` contract test** (§2.8) and the `recipient.js` round-trip test. Nothing imports the new code yet. **Verify:** `vitest run` green; both units `is-active` after deploy. Pure-additive, zero risk.

### STEP 1 — DiscordProvider + neutral attachments (additive, dormant)
Add `src/comms/providers/discord.js` (the ONLY new importer of `AttachmentBuilder`/`EmbedBuilder`) and `src/comms/attachments.js extractAttachmentsNeutral` (moves the allowlist/realpath validation verbatim, returns `AgnosticFile[]`). Add `src/comms/index.js` registry + `render.js`. Unit-test in `src/__tests__/`. No live caller. **Verify:** vitest green; units up.

### STEP 2 — First real cut: posting.js becomes a comms shim (ONE surface)
Rewrite `posting.js postToTextChannel` + `postActivity` as thin shims building `Recipient`+`OutMessage` → `comms.send()` via DiscordProvider. **Diff inline-vs-posting.js bodies line-by-line first** and preserve every guard (e.g. `ACTIVITY_FEED_ENABLED && client.isReady()`). The 6 importers are unchanged. **Verify (live):** post a Discord message **with an attachment** (exercises `extractAttachments`), check `#activity`, journalctl. The inline `index.js` copies still exist as the safety net for the 51 local callers. Rollback = `git reset --hard HEAD^` + restart.

### STEP 3 — Repoint 51 local call sites, then delete dup senders
Repoint `index.js`'s 51 local call sites from inline senders to the imported (comms-backed) `posting.js`, **one logical group per commit** (activity-feed posts → task posts → DM escalations). After each group: deploy, live-test that surface, journalctl. When all 51 are repointed, DELETE the inline duplicates (`index.js` drops ~150 lines) in a final commit. Each sub-commit independently shippable/rollback-able.

### STEP 4 — cgg-dispatch off discord.js
Convert `src/cgg-dispatch.js` to return `OutMessage{attachments:[{kind:'image',buffer},{kind:'doc',buffer}]}` → `comms.send()`; remove its `discord.js` import. **Verify:** `/cgg` in a channel still renders PNG + mermaid; `grep AttachmentBuilder src/` hits only `providers/discord.js`.

### STEP 5 — Capability layer (gateway-side, behind flag)
Add `src/capabilities/{resolve.js, runtime-block.js}` (pure, vitest). Wire into `spawnClaudeStream`: compute `caps`, **prepend `buildRuntimeBlock()` to the FINAL `prompt` var** (covers resumed `:976` + new `:977`), **behind `JARVIS_CAP_PREAMBLE=1` (default OFF)**. Pass `surface` through the request body from `brain.js` (keep `surfaceHint`). Add `config.yaml capabilities:` block + map in `config-env-bootstrap.js` (code fallbacks match exactly). Deploy; flip flag on **one** Telegram test chat. **Verify (live):** `/engine qwen` + send an `@file` → confirm the spawned prompt now contains "text-only, files inlined", NOT `@path` (journalctl shows the prompt). **Then verify a known-good Claude+MCP channel replies identically** (same tool use, tone, length) before trusting — the preamble must be a no-op for `caps={canReadFilePaths,hasTools}`. Flip global only after that.

### STEP 6 — Attachment capability declaration
`src/comms/attachments.js` + `telegram/attachments.js buildAttachmentContext(att, caps)` gain the caps-aware branch (§2.6). **Verify:** image to a qwen-engine Telegram chat → contents inlined; image to a Claude chat → `@path` native. Independent of prior steps.

### STEP 7 — TelegramProvider parity
Add `src/comms/providers/telegram.js` wrapping the existing `createTransport()` injected sender + `splitSend()` (already ~90% shaped); route `telegram/adapter.js` replies through `comms.send()`. **Verify:** Telegram chat + forum topic + voice-note echo unchanged with a real message + image. Until this lands, Telegram keeps its own transport untouched (it already works).

### STEP 8 — VoiceProvider + spawn-thread + kanban consumers (FSM-aware)
Add `src/comms/providers/voice.js` modeled against the real `audioQueue`/`_ttsDeliveryActive` FSM (§1.6). Route `_deliverSpeak`, spawn-thread streaming (`agent/spawn.js`, `slash/spawn.js`), and kanban-dispatch dual-output through `comms.send()`. **Verify (generic, GPU up):** wake-word → spoken reply with no double-speak over active task TTS; `/spawn` thread streams in order; a kanban verb both speaks and posts the board.

### STEP 9 — Alerts migration (HIGHEST risk, LAST, flagged)
Move `alert-webhook/queue/context/ledger` to `src/alerts/`. Replace the **4 send callbacks** with `comms.send()`; **keep the 8 control/state callbacks** (§3.5). Behind a flag. **Verify:** smoke the full voice→text→DM→gateway escalation ladder on generic **before** removing the old send callbacks.

### STEP 10 — index.js final slim (pure-risk, no payoff, LAST)
Extract `AudioQueue` + `_deliverSpeak` → `voice/audio-queue.js` + `voice/speak-delivery.js`; then Discord client bootstrap + events → `discord/client.js` + `discord/events.js`. Move-then-import-then-verify, one commit each. `index.js` ends ~300 lines.

### STEP 11 — Worktree isolation (orthogonal, opt-in, no-op default)
Add `cwd: resolveWorktree(parentKey)` to `spawnClaudeStream` spawn opts; reconcile with existing `worktree-manager.test.js`. `worktreeMode=off` default = no-op. **Verify:** a channel with `worktreeMode=worktree` spawns in its isolated tree (`git -C <worktree> rev-parse`); default channels unchanged.

### STEP 12 — Rename to v2.0.0 (mechanical, isolated)
Per §5. **Verify:** `npm test` green; units up; state-dir + unit names untouched.

### STEP 13 (optional) — SlackProvider stub
Implement `provider.js` for Slack with **zero** changes to brain/alerts/voice — proves the spine.

---

## 7. What we ported from openclaw, made lighter/better

| Idea | openclaw | openjarvis v2 |
|---|---|---|
| Provider send signature | per-surface `send.ts` × 9 surfaces × 4 files, `(to, text, opts) -> {messageId, channelId}` | ONE `CommsProvider` JSDoc contract + a Map registry; `(recipient, msg, caps) -> SendResult`; 3 providers + 1 stub |
| Recipient abstraction | `Recipient {kind, id}` + string-prefix namespace | `{surface, kind, id, topicId}`; adapted to openjarvis's existing `channelKey` so the gateway `user`-field contract is preserved exactly; `recipient.js` bridges both directions |
| Attachment-is-data | `media/input-files.ts InputFileSource` + `parse.ts` + `loadWebMedia` | ONE `src/comms/attachments.js`; `AgnosticFile{kind,path?,buffer?,name,mime}`; preserves the path-allowlist validation verbatim; MEDIA-token parse deferred until outbound media exists |
| Capability → prompt | `channel-capabilities.ts string[]` + `system-prompt.ts buildRuntimeLine` + ~6 scattered `buildXSection` + `promptMode` gating | ONE flat typed `Capabilities` struct + ONE `buildRuntimeBlock()`; no stringly-typed `Set.has`, no section fan-out, no promptMode gating |
| Capability resolution point | inside embedded-runner `compact.ts` with per-surface augmentation hooks (`resolveTelegramInlineButtonsScope`…) before model fully known | resolved ONCE at the gateway `spawnClaudeStream` boundary — the single convergence point of surface+model+mcp+ask+engine; no augmentation hooks to keep in sync |
| Anti-drift | prompt and send read capabilities independently | the SAME `Capabilities` instance feeds prompt injection AND reply rendering — they cannot diverge |
| Capability override tiers | account > channel > undefined (3-tier) | channel-registry override > config.yaml surface default (2-tier); no multi-account-per-surface model |
| Error model | per-surface `DiscordSendError` + permission probing | ONE `SendError{kind, surface, channelId}`; probing deferred to first real failure |
| Chunk limits | `config/chunk.ts` load-config layer | flat constants in `chunk.js` (discord 2000, telegram 4096) |
| Retry | `retry-policy.ts createXRetryRunner` per surface | **reused openjarvis-native** `resilientFetch` + dual circuit breakers (`brain.js`/`session-manager.js`) — not duplicated |
| Telegram send | `WebClient`-bound sends | **reused openjarvis-native** injected-sender + `splitSend()` pure helper (already cleaner) as the Provider template |
| Alert routing | n/a | **replaced** the 4 hand-rolled send callbacks with the real neutral comms seam; **kept** the 8 control/state callbacks |

**Deliberately dropped** (openclaw sprawl unjustified for a 2-surface voice-first bot): `plugin-sdk`, `acp`, `canvas-host`, `node-host`, `browser`, `auto-reply` templates (openjarvis uses the LLM directly), `media-understanding` (image/video analysis), the 8 extra surfaces (imessage/whatsapp/line/signal/slack[live]/web/terminal), per-surface `accounts.ts` multi-account token resolution (openjarvis's `channel-accounts.json` profiles are a different, sufficient model).

---

## 8. Risk register (the load-bearing ones)

1. **Telegram-blind ask/mcp (STEP -1)** — hard correctness break, not cosmetic. Fix the `:247`/`:270` regexes before any capability descriptor reads those values, or the qwen prompt stays wrong for the exact surface the bug lives on. Test a negative chat id.
2. **Resumed-chat preamble loss** — prepend the FINAL `prompt` var unconditionally (covers empty-`_sysText` resumed branch), never splice after `_sysText`.
3. **Preamble must no-op for Claude+MCP** — gate behind `JARVIS_CAP_PREAMBLE` for one deploy cycle; verify a known-good Claude channel replies identically before global flip.
4. **Duplicate-send confusion (#1 migration risk)** — diff inline vs `posting.js` bodies line-by-line before repointing each function; preserve every guard; live-verify `#activity` after each group.
5. **AttachmentBuilder leak containment** — after STEP 4, `grep AttachmentBuilder|EmbedBuilder src/` must hit only `providers/discord.js` (+ voice/HUD embeds). Any other hit is a bug.
6. **VoiceProvider must route through the FSM** — model `_ttsDeliveryActive` + pending-speak drain, never raw `audioQueue.add`, or it double-speaks over task TTS / barge-in.
7. **Keep the 8 non-send alert callbacks** — only 4 of 12 are send paths; the rest are control/state and must survive.
8. **`memoryCategory` ↔ `getChannelContext` lockstep** — contract test in STEP 0; migrate both sides in one PR.
9. **Per-channel state files stay raw-id-keyed** — do not re-key by Target/channelKey.
10. **Worktree is not greenfield** — reconcile with existing `worktree-manager.test.js` / `feature-worktrees.test.js`; opt-in, no-op default; land last.
11. **Branch hygiene** — current work is on `merge/dev-live-sync` with `src/slash-commands.js` modified + untracked `src/daily-briefing.js`. Land v2 as discrete commits on a fresh branch off the merged state; confirm generic tree clean before each `pull --ff-only`.
12. **PII** — surface/model LABELS only in the runtime block and log templates, never raw IDs; channel IDs/tokens stay in config tier; scan staged diff + message before every commit.
