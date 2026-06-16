# Telegram-as-OpenJarvis-channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telegram a first-class OpenJarvis transport so Lance can run agentic coding from the native Telegram watchOS (Apple Watch) app, reusing the existing brain, durable memory, agent-spawn/worktree layer, and `claude -p` gateway that Discord already uses.

**Architecture:** A new `src/telegram/` subdir adds a transport (Bot API connection), an adapter (the wire-in point that calls the existing brain/agent layer), and a thin registry binding (chat/topic → project directory). Only `transport.js` knows Telegram's wire format; everything below the adapter is the unchanged OpenJarvis core. Engine selection (Claude vs Qwen/LM Studio) is a per-chat env swap in the existing gateway spawn path — the same machinery ClaudeFlare already uses.

**Tech Stack:** Node.js ES modules, `node-telegram-bot-api` (long-poll), vitest, the existing `scripts/jarvis-gateway.js` (`claude -p`), `src/brain/brain.js`, `src/agent/{session-manager,spawn,worktree-manager}.js`, `src/channel-access.js`, `src/channel-models.js`, `src/config.js` + `src/config-env-bootstrap.js`.

---

## Verified integration anchors (re-confirmed against `merge/dev-live-sync` @ 5db7b92, post-cutover 2026-06-15)

These are checked on disk, not copied from the spec. The spec's recon held up through the cutover.

| Anchor | Verified location | Signature / fact |
|---|---|---|
| Streaming brain entry | `src/brain/brain.js:543` | `export async function generateResponseStreaming(userMessage, history = [], signal, onSentence, options = {})` → `{text, aborted?, offline?}` |
| Non-streaming brain entry | `src/brain/brain.js:946` | `export async function generateResponse(userMessage, history = [], signal, options = {})` |
| Per-request model override | `src/brain/brain.js:616` | `const activeModel = options.model \|\| voiceModel;` — per-chat engine flows through `options.model` |
| Durable memory | `src/agent/session-manager.js` | `maybeRotateSession(history)` :127, `storeTaskToHaivemind(...)` :166, `getLocalMemoryContext(recentHistory)` :189, `getHaivemindContext()` :236, `getChannelContext(channelId)` :395, `storeChannelMemory(channelId, userMessage, response)` :416 |
| Worktree | `src/agent/worktree-manager.js:100` | `export async function ensureWorktree(channelId, threadId)` — reads registry `projectPath`, writes `~/.local/state/jarvis-voice/worktree-paths.json` |
| Access gate | `src/channel-access.js:51,56` | `export function isOwner(userId)` and `export function canAccessChannel(userId, channelId)` (isOwner \|\| grants) |
| Per-channel model store | `src/channel-models.js:33,39` | `getChannelModel(id)`, `setChannelModel(id, model)` (persisted to `channel-models.json`) |
| Gateway spawn | `scripts/jarvis-gateway.js:298` | `function spawnClaudeStream(prompt, model, chatId, channelKey, effort)`; spawn at `:349` with `env: cleanEnv`. **THREE call sites:** `:497`, `:586`, `:1190`. |
| **Engine env-swap point (KEY)** | `scripts/jarvis-gateway.js:336-345` | `cleanEnv` is built per spawn; ClaudeFlare ALREADY sets `cleanEnv.ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` here. The Qwen swap is a sibling branch in the same block. |
| Thread/topic suffix handling | `scripts/jarvis-gateway.js:85,218,241,438` | **Only `resolveProfile` (:85) uses `.replace(/:thread:\d+$/,"")`.** The ask-mode (:218), MCP-mode (:241), and a 4th matcher (:438) use `match(/discord:channel:(\d+)(?::thread:(\d+))?/)` — a Discord-specific regex that will NOT match a `telegram:` key at all. See Task 9 note. |
| Config array handling | `src/config-env-bootstrap.js:307` | `if (Array.isArray(v)) return v.join(',')` — YAML arrays are auto-joined to comma strings. So `telegram.allowedUsers` MAY be a YAML list; it arrives as a comma string the adapter splits. |
| Registry storage | `src/state/focus-state.js:25,63` + `src/discord/channel-router.js:91` | `REGISTRY_PATH = ~/dev/contexts/channel-registry.json`; registry is keyed `registry.discord[channelId]`. Telegram uses a parallel `registry.telegram[chatKey]`. |
| Config → env bootstrap | `src/config-env-bootstrap.js:21` | `MAPPINGS` array of `[yamlPath, ENV_NAME]`; `discord.token → DISCORD_TOKEN` etc. Telegram adds rows here. |
| Test pattern | `src/__tests__/channel-router.test.js` | **No `discord-factory.js` exists.** Tests use inline `vi.mock('fs'...)` + a `SAMPLE_REGISTRY` object literal. Mirror THIS, not the spec's imagined factory. |

**Flat-vs-subdir rule (still in force):** channel-agnostic utilities (`channel-access.js`, `channel-models.js`) are FLAT in `src/`. Subsystem logic (`brain/`, `agent/`, `telegram/`) is subdir. New Telegram code goes in `src/telegram/`; it imports the flat utilities. The flat `src/index.js` (the live bootstrap) is where the one Telegram wire-in call site lives.

---

## File structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `src/telegram/transport.js` | Telegram Bot API connection. Long-polls, normalizes inbound updates to `{userId, chatId, topicId, text, messageId}`, exposes `sendMessage(chatId, text, {replyTo, topicId})`. ONLY file that knows Telegram's wire format. | Create |
| `src/telegram/registry.js` | Chat/topic ↔ project-directory binding. `registerTelegramChat(chatKey, projectPath)`, `getTelegramProjectPath(chatKey)`, `telegramChatKey(chatId, topicId)`. Reuses the existing channel-registry JSON file under a `telegram` top-level key. | Create |
| `src/telegram/engine.js` | Per-chat engine selection (`claude` \| `qwen`). `getEngine(chatKey)`, `setEngine(chatKey, engine)`, `resolveEngineEnv(engine)` → `{}` or `{ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, model}`. Persisted to its own JSON, mirroring `channel-models.js`. | Create |
| `src/telegram/adapter.js` | The bridge into the brain. Access gate → registry resolve → session key → call `generateResponseStreaming` (chat/status) or the gateway coding path → format reply (terse main + detail follow-up). | Create |
| `src/telegram/format.js` | Watch-formatting: `terseStatus(fullText)` → one glanceable line; `detailBody(fullText)` → the follow-up message (chunked to Telegram's 4096-char limit). | Create |
| `src/telegram/commands.js` | Slash-command parsing for the Telegram surface: `/register <path>`, `/engine claude\|qwen`, `/model <m>`, `/cancel`, `/status`. Returns a typed command object or `null` (plain message). | Create |
| `scripts/jarvis-gateway.js` | Add the `engine=qwen` env branch in the spawn `cleanEnv` block (`:336-345`); thread an `engine` field through the spawn request. | Modify `:286-345` |
| `src/config-env-bootstrap.js` | Add `telegram.*` → env mappings (`telegram.token → TELEGRAM_BOT_TOKEN`, `telegram.owner → TELEGRAM_OWNER_ID`, `telegram.allowedUsers → TELEGRAM_ALLOWED_USERS`). | Modify `:21` MAPPINGS |
| `src/index.js` | One wire-in: import `startTelegram` from `src/telegram/adapter.js` and call it during bootstrap when `TELEGRAM_BOT_TOKEN` is set. | Modify (bootstrap section) |
| `package.json` | Add `node-telegram-bot-api` dependency. | Modify |
| `src/__tests__/telegram-transport.test.js` | Tests for normalize + sendMessage shaping. | Create |
| `src/__tests__/telegram-registry.test.js` | Tests for chat-key building + binding lookup. | Create |
| `src/__tests__/telegram-engine.test.js` | Tests for engine get/set + `resolveEngineEnv`. | Create |
| `src/__tests__/telegram-format.test.js` | Tests for terse-status reduction + detail chunking. | Create |
| `src/__tests__/telegram-commands.test.js` | Tests for command parsing. | Create |
| `src/__tests__/telegram-adapter.test.js` | Tests for the access gate + routing decisions (mocked brain/gateway). | Create |

---

## Detail sections (completing the spec's open sections)

### Data flow — session-key lifecycle & history persistence
- **Chat key:** `telegramChatKey(chatId, topicId)` → `telegram:chat:<chatId>` or `telegram:chat:<chatId>:topic:<topicId>`.
- **Session key (gateway):** `agent:main:telegram:chat:<chatId>[:topic:<topicId>]` — the same shape as the Discord key, so the gateway's `resolveProfile`/ask-mode/MCP-mode `:thread:`-style stripping treats a topic like a Discord thread (parent chat inherits). NOTE: the gateway currently strips `:thread:\d+$`; this plan adds an equivalent `:topic:\d+$` strip (Task 9).
- **History:** the adapter owns a per-chat-key `history` array (in-memory map, capped at last 20 turns) passed into `generateResponseStreaming`. Durability across restarts is the existing memory layer's job (local `data/memory.md` → Obsidian → hAIveMind), NOT this array — the array is just the live window. The brain already reads durable context via `session-manager`.
- **Streaming → terse status:** the adapter accumulates `onSentence` chunks; when the stream completes it sends `terseStatus(fullText)` as the main reply (`replyTo` the user's message) then, if `fullText` exceeds the terse line, sends `detailBody(fullText)` as a follow-up.

### Error handling
- **Telegram API failure** (send fails): log non-fatal, retry once after 1s; if still failing, drop (the watch user will resend). Never throw out of the polling loop.
- **Engine subprocess crash** (gateway returns error/empty): adapter replies a terse `"⚠️ engine error — try again or /engine claude"`. Does not kill polling.
- **Worktree failure** (`ensureWorktree` returns null): adapter replies `"⚠️ couldn't open a worktree for <path> — check /register"`. Logged.
- **Tier-2 refusal:** a coding command from a non-owner allowlisted user → terse `"read-only: coding is owner-only"`. No spawn.
- **Unknown chat (not registered):** plain chat still works (no project binding needed for chat/status); a coding command replies `"this chat isn't bound to a project — /register <path> first"`.
- **Abort/cancel:** `/cancel` aborts the in-flight `AbortController` for that chat key; replies `"cancelled"`.

### Command surface
| Command | Tier | Effect |
|---|---|---|
| `/register <abs-path>` | owner | Bind this chat/topic to a project dir (writes `registry.telegram[chatKey]`). |
| `/engine claude\|qwen` | owner | Set per-chat coding engine. |
| `/model <model>` | owner | Set per-chat model override (reuses `setChannelModel` with the telegram chat key). |
| `/status` | any | Reply current binding + engine + model for this chat. |
| `/cancel` | owner | Abort the in-flight agent run for this chat. |
| (plain text) | tier-1 coding / tier-2 chat | Routed by the adapter. |

---

## Tasks

Each task is TDD: write the failing test, watch it fail, implement minimal code, watch it pass, commit. Run the FULL suite (`npx vitest run`) before each commit — the repo gate is all-green.

---

### Task 1: Add the Telegram bot library dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Confirm the library and pin a version**

Run: `npm view node-telegram-bot-api version`
Expected: prints a version string (e.g. `0.66.0`). Use the exact printed version (pin it, no caret) to match the repo's pin-exact convention (cf. `@mermaid-js/mermaid-cli` is pinned to `11.15.0`).

- [ ] **Step 2: Install pinned**

Run: `npm install --save-exact node-telegram-bot-api@<version-from-step-1>`
Expected: `package.json` `dependencies` gains `"node-telegram-bot-api": "<version>"` (no `^`).

- [ ] **Step 3: Verify it imports under ESM**

Run: `node --input-type=module -e "import TelegramBot from 'node-telegram-bot-api'; console.log(typeof TelegramBot)"`
Expected: prints `function`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(telegram): add node-telegram-bot-api dependency (pinned)"
```

---

### Task 2: Registry binding — chat key + project lookup

**Files:**
- Create: `src/telegram/registry.js`
- Test: `src/__tests__/telegram-registry.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));
vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { readFileSync, writeFileSync } from 'fs';
import { telegramChatKey, getTelegramProjectPath, registerTelegramChat } from '../telegram/registry.js';

describe('telegramChatKey', () => {
  it('builds a chat-only key when no topic', () => {
    expect(telegramChatKey('111', null)).toBe('telegram:chat:111');
  });
  it('builds a topic key when a topic id is present', () => {
    expect(telegramChatKey('111', '222')).toBe('telegram:chat:111:topic:222');
  });
});

describe('getTelegramProjectPath', () => {
  beforeEach(() => vi.clearAllMocks());
  it('returns the bound projectPath for a chat key', () => {
    readFileSync.mockReturnValue(JSON.stringify({
      telegram: { 'telegram:chat:111': { projectPath: '/home/u/proj' } },
    }));
    expect(getTelegramProjectPath('telegram:chat:111')).toBe('/home/u/proj');
  });
  it('returns null when the chat key is not bound', () => {
    readFileSync.mockReturnValue(JSON.stringify({ telegram: {} }));
    expect(getTelegramProjectPath('telegram:chat:999')).toBeNull();
  });
  it('returns null when the registry has no telegram section', () => {
    readFileSync.mockReturnValue(JSON.stringify({ discord: {} }));
    expect(getTelegramProjectPath('telegram:chat:111')).toBeNull();
  });
});

describe('registerTelegramChat', () => {
  beforeEach(() => vi.clearAllMocks());
  it('writes a new telegram binding preserving other sections', () => {
    readFileSync.mockReturnValue(JSON.stringify({ discord: { a: {} }, telegram: {} }));
    registerTelegramChat('telegram:chat:111', '/home/u/proj');
    const written = JSON.parse(writeFileSync.mock.calls[0][1]);
    expect(written.discord).toEqual({ a: {} });
    expect(written.telegram['telegram:chat:111']).toEqual({ projectPath: '/home/u/proj' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/telegram-registry.test.js`
Expected: FAIL — `Cannot find module '../telegram/registry.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/telegram/registry.js
import { readFileSync, writeFileSync, existsSync } from 'fs';
import logger from '../logger.js';

const REGISTRY_PATH =
  process.env.CHANNEL_REGISTRY_PATH || `${process.env.HOME || '/tmp'}/dev/contexts/channel-registry.json`;

export function telegramChatKey(chatId, topicId) {
  const base = `telegram:chat:${chatId}`;
  return topicId ? `${base}:topic:${topicId}` : base;
}

function _load() {
  try {
    if (!existsSync(REGISTRY_PATH)) return {};
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (e) {
    logger.warn({ err: e.message }, '[telegram-registry] load failed (non-fatal)');
    return {};
  }
}

export function getTelegramProjectPath(chatKey) {
  const reg = _load();
  return reg.telegram?.[chatKey]?.projectPath ?? null;
}

export function registerTelegramChat(chatKey, projectPath) {
  const reg = _load();
  reg.telegram = reg.telegram || {};
  reg.telegram[chatKey] = { ...(reg.telegram[chatKey] || {}), projectPath };
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2), 'utf8');
  logger.info({ chatKey, projectPath }, '[telegram-registry] bound');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/telegram-registry.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/telegram/registry.js src/__tests__/telegram-registry.test.js
git commit -m "feat(telegram): chat-key + project-binding registry"
```

---

### Task 3: Engine selection + env resolver

**Files:**
- Create: `src/telegram/engine.js`
- Test: `src/__tests__/telegram-engine.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));
vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { readFileSync, writeFileSync } from 'fs';
import { getEngine, setEngine, resolveEngineEnv } from '../telegram/engine.js';

describe('getEngine', () => {
  beforeEach(() => vi.clearAllMocks());
  it('defaults to claude when unset', () => {
    readFileSync.mockReturnValue('{}');
    expect(getEngine('telegram:chat:1')).toBe('claude');
  });
  it('returns the stored engine', () => {
    readFileSync.mockReturnValue(JSON.stringify({ 'telegram:chat:1': 'qwen' }));
    expect(getEngine('telegram:chat:1')).toBe('qwen');
  });
});

describe('setEngine', () => {
  beforeEach(() => vi.clearAllMocks());
  it('rejects an unknown engine', () => {
    expect(() => setEngine('telegram:chat:1', 'gpt')).toThrow();
  });
  it('persists a valid engine', () => {
    readFileSync.mockReturnValue('{}');
    setEngine('telegram:chat:1', 'qwen');
    const written = JSON.parse(writeFileSync.mock.calls[0][1]);
    expect(written['telegram:chat:1']).toBe('qwen');
  });
});

describe('resolveEngineEnv', () => {
  it('returns empty for claude (use stored OAuth)', () => {
    expect(resolveEngineEnv('claude')).toEqual({});
  });
  it('returns LM Studio base url + token + model for qwen', () => {
    const env = resolveEngineEnv('qwen');
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\//);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('lmstudio');
    expect(typeof env.model).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/telegram-engine.test.js`
Expected: FAIL — `Cannot find module '../telegram/engine.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/telegram/engine.js
import { readFileSync, writeFileSync, existsSync } from 'fs';
import logger from '../logger.js';

const STORE_PATH =
  process.env.TELEGRAM_ENGINE_STORE ||
  `${process.env.HOME || '/tmp'}/.local/state/jarvis-voice/telegram-engine.json`;

const VALID = new Set(['claude', 'qwen']);

const QWEN_BASE_URL = process.env.JARVIS_LMS_BASE_URL || 'http://lmstudio.local:1234';
const QWEN_MODEL = process.env.JARVIS_LMS_MODEL || 'qwen/qwen3.6-35b-a3b';

function _load() {
  try {
    if (!existsSync(STORE_PATH)) return {};
    return JSON.parse(readFileSync(STORE_PATH, 'utf8'));
  } catch (e) {
    logger.warn({ err: e.message }, '[telegram-engine] load failed (non-fatal)');
    return {};
  }
}

export function getEngine(chatKey) {
  const store = _load();
  return store[chatKey] || 'claude';
}

export function setEngine(chatKey, engine) {
  if (!VALID.has(engine)) throw new Error(`unknown engine: ${engine}`);
  const store = _load();
  store[chatKey] = engine;
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  logger.info({ chatKey, engine }, '[telegram-engine] set');
}

// The env overlay applied to the gateway spawn for this engine.
// claude -> {} (claude uses its own stored OAuth, as today).
// qwen   -> point the SAME claude -p subprocess at LM Studio.
export function resolveEngineEnv(engine) {
  if (engine === 'qwen') {
    return {
      ANTHROPIC_BASE_URL: QWEN_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: 'lmstudio',
      model: QWEN_MODEL,
    };
  }
  return {};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/telegram-engine.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/telegram/engine.js src/__tests__/telegram-engine.test.js
git commit -m "feat(telegram): per-chat engine selection + env resolver"
```

---

### Task 4: Watch formatting — terse status + detail chunking

**Files:**
- Create: `src/telegram/format.js`
- Test: `src/__tests__/telegram-format.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect } from 'vitest';
import { terseStatus, detailBody } from '../telegram/format.js';

describe('terseStatus', () => {
  it('returns the first line, trimmed, for multi-line text', () => {
    expect(terseStatus('Done: 3 files changed\n\n--- diff ---\n+a')).toBe('Done: 3 files changed');
  });
  it('truncates a long single line to <= 120 chars with an ellipsis', () => {
    const long = 'x'.repeat(300);
    const out = terseStatus(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
  });
  it('returns a fallback for empty text', () => {
    expect(terseStatus('')).toBe('(no output)');
  });
});

describe('detailBody', () => {
  it('returns null when the text fits in the terse line (nothing extra to send)', () => {
    expect(detailBody('short reply')).toBeNull();
  });
  it('chunks text longer than 4096 chars into <=4096 pieces', () => {
    const big = 'y'.repeat(9000);
    const chunks = detailBody(big);
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks.length).toBe(3);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(4096));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/telegram-format.test.js`
Expected: FAIL — `Cannot find module '../telegram/format.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/telegram/format.js
const TERSE_MAX = 120;
const TG_MAX = 4096;

export function terseStatus(fullText) {
  const text = String(fullText ?? '').trim();
  if (!text) return '(no output)';
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length <= TERSE_MAX) return firstLine;
  return firstLine.slice(0, TERSE_MAX - 1) + '…';
}

// Returns null when there is nothing beyond the terse line worth sending,
// otherwise an array of <=4096-char chunks for follow-up messages.
export function detailBody(fullText) {
  const text = String(fullText ?? '').trim();
  if (!text) return null;
  const isMultiline = text.includes('\n');
  if (!isMultiline && text.length <= TERSE_MAX) return null;
  const chunks = [];
  for (let i = 0; i < text.length; i += TG_MAX) {
    chunks.push(text.slice(i, i + TG_MAX));
  }
  return chunks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/telegram-format.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/telegram/format.js src/__tests__/telegram-format.test.js
git commit -m "feat(telegram): watch-friendly terse-status + detail chunking"
```

---

### Task 5: Command parsing

**Files:**
- Create: `src/telegram/commands.js`
- Test: `src/__tests__/telegram-commands.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect } from 'vitest';
import { parseCommand } from '../telegram/commands.js';

describe('parseCommand', () => {
  it('returns null for a plain message', () => {
    expect(parseCommand('build the login form')).toBeNull();
  });
  it('parses /register with a path arg', () => {
    expect(parseCommand('/register /home/u/proj')).toEqual({ cmd: 'register', arg: '/home/u/proj' });
  });
  it('parses /engine with an engine arg', () => {
    expect(parseCommand('/engine qwen')).toEqual({ cmd: 'engine', arg: 'qwen' });
  });
  it('parses /model with a model arg', () => {
    expect(parseCommand('/model claude-opus-4-7')).toEqual({ cmd: 'model', arg: 'claude-opus-4-7' });
  });
  it('parses /status with no arg', () => {
    expect(parseCommand('/status')).toEqual({ cmd: 'status', arg: null });
  });
  it('parses /cancel with no arg', () => {
    expect(parseCommand('/cancel')).toEqual({ cmd: 'cancel', arg: null });
  });
  it('strips a bot @mention suffix Telegram adds in groups', () => {
    expect(parseCommand('/status@my_bot')).toEqual({ cmd: 'status', arg: null });
  });
  it('returns an unknown marker for an unrecognized slash command', () => {
    expect(parseCommand('/frobnicate x')).toEqual({ cmd: 'unknown', arg: 'frobnicate' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/telegram-commands.test.js`
Expected: FAIL — `Cannot find module '../telegram/commands.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/telegram/commands.js
const KNOWN = new Set(['register', 'engine', 'model', 'status', 'cancel']);

export function parseCommand(text) {
  const t = String(text ?? '').trim();
  if (!t.startsWith('/')) return null;
  const [head, ...rest] = t.slice(1).split(/\s+/);
  const cmd = head.split('@')[0].toLowerCase(); // strip @botname suffix
  const arg = rest.length ? rest.join(' ') : null;
  if (!KNOWN.has(cmd)) return { cmd: 'unknown', arg: cmd };
  return { cmd, arg };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/telegram-commands.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/telegram/commands.js src/__tests__/telegram-commands.test.js
git commit -m "feat(telegram): slash-command parser"
```

---

### Task 6: Transport — normalize inbound updates + send shaping

**Files:**
- Create: `src/telegram/transport.js`
- Test: `src/__tests__/telegram-transport.test.js`

The transport is split so the Telegram-specific normalization/shaping is pure-testable without a live bot. `createTransport()` wires the live `node-telegram-bot-api`; `normalizeUpdate` and `splitSend` are pure and tested directly.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect, vi } from 'vitest';
import { normalizeUpdate, splitSend } from '../telegram/transport.js';

describe('normalizeUpdate', () => {
  it('extracts a neutral shape from a basic message', () => {
    const msg = {
      message_id: 9,
      from: { id: 555 },
      chat: { id: 111 },
      text: 'hello',
    };
    expect(normalizeUpdate(msg)).toEqual({
      userId: '555', chatId: '111', topicId: null, text: 'hello', messageId: '9',
    });
  });
  it('captures a forum topic id when present', () => {
    const msg = {
      message_id: 9, from: { id: 555 }, chat: { id: 111 },
      message_thread_id: 222, text: 'hi',
    };
    expect(normalizeUpdate(msg).topicId).toBe('222');
  });
  it('returns null for a message with no text (e.g. a sticker)', () => {
    expect(normalizeUpdate({ message_id: 9, from: { id: 5 }, chat: { id: 1 } })).toBeNull();
  });
});

describe('splitSend', () => {
  it('calls the sender once for a short message', async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    await splitSend(sender, '111', 'short', { topicId: null });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith('111', 'short', {});
  });
  it('passes message_thread_id through when a topic is set', async () => {
    const sender = vi.fn().mockResolvedValue(undefined);
    await splitSend(sender, '111', 'x', { topicId: '222' });
    expect(sender).toHaveBeenCalledWith('111', 'x', { message_thread_id: '222' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/telegram-transport.test.js`
Expected: FAIL — `Cannot find module '../telegram/transport.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/telegram/transport.js
import TelegramBot from 'node-telegram-bot-api';
import logger from '../logger.js';

export function normalizeUpdate(message) {
  if (!message || typeof message.text !== 'string') return null;
  return {
    userId: String(message.from?.id ?? ''),
    chatId: String(message.chat?.id ?? ''),
    topicId: message.message_thread_id != null ? String(message.message_thread_id) : null,
    text: message.text,
    messageId: String(message.message_id ?? ''),
  };
}

// Pure send helper: builds Telegram options and delegates to `sender`.
export async function splitSend(sender, chatId, text, { topicId, replyTo } = {}) {
  const opts = {};
  if (topicId) opts.message_thread_id = topicId;
  if (replyTo) opts.reply_to_message_id = replyTo;
  await sender(chatId, text, opts);
}

// Live wiring. token from env; long-polls. onMessage receives a normalized update.
export function createTransport(token, onMessage) {
  const bot = new TelegramBot(token, { polling: true });
  bot.on('message', async (message) => {
    const update = normalizeUpdate(message);
    if (!update) return;
    try {
      await onMessage(update);
    } catch (e) {
      logger.error({ err: e.message }, '[telegram-transport] onMessage failed');
    }
  });
  bot.on('polling_error', (e) => logger.warn({ err: e.message }, '[telegram-transport] polling_error'));
  const sender = (chatId, text, opts) => bot.sendMessage(chatId, text, opts);
  return {
    sendMessage: (chatId, text, opts = {}) => splitSend(sender, chatId, text, opts),
    stop: () => bot.stopPolling(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/telegram-transport.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/telegram/transport.js src/__tests__/telegram-transport.test.js
git commit -m "feat(telegram): Bot API transport (normalize + send shaping)"
```

---

### Task 7: Gateway engine env-swap (`engine=qwen`)

**Files:**
- Modify: `scripts/jarvis-gateway.js:298-345` (the `spawnClaudeStream` function) + its three call sites (`:497`, `:586`, `:1190`)

This adds a per-spawn engine overlay using the SAME `cleanEnv` machinery ClaudeFlare already uses at `:336-345`. The engine env is passed in as a new optional 6th argument and applied AFTER the ClaudeFlare block so an explicit Telegram engine wins.

- [ ] **Step 1: Read the current function to anchor the edit**

Run: `sed -n '298,366p' scripts/jarvis-gateway.js`
Expected: see `function spawnClaudeStream(prompt, model, chatId, channelKey, effort)` at :298 and the `cleanEnv` block at lines ~336-345.

- [ ] **Step 2: Add `engineEnv` parameter + apply it**

Change the signature and add the overlay. Replace:

```javascript
function spawnClaudeStream(prompt, model, chatId, channelKey, effort) {
```
with:
```javascript
function spawnClaudeStream(prompt, model, chatId, channelKey, effort, engineEnv = null) {
```

Then, immediately AFTER the ClaudeFlare `if/else` block (right after the line `delete cleanEnv.ANTHROPIC_BASE_URL;` and its closing `}` at ~:345, before `const profile = resolveProfile(channelKey);`), insert:

```javascript
  // Per-request engine overlay (Telegram /engine qwen): point the SAME claude -p
  // subprocess at LM Studio. Wins over ClaudeFlare for this spawn. Empty {} for claude.
  if (engineEnv && engineEnv.ANTHROPIC_BASE_URL) {
    cleanEnv.ANTHROPIC_BASE_URL = engineEnv.ANTHROPIC_BASE_URL;
    if (engineEnv.ANTHROPIC_AUTH_TOKEN) cleanEnv.ANTHROPIC_AUTH_TOKEN = engineEnv.ANTHROPIC_AUTH_TOKEN;
    log("engine_overlay_spawn", { channelKey, baseUrl: engineEnv.ANTHROPIC_BASE_URL });
  }
```

- [ ] **Step 3: Thread `engineEnv` through the call sites**

There are THREE `spawnClaudeStream(...)` call sites: `:497`, `:586`, `:1190`. Locate them and the request-body parsing with:

Run: `grep -n "spawnClaudeStream(\|JSON.parse(body)\|const body\|body.model\|body.effort\|engineEnv" scripts/jarvis-gateway.js`

For each call site that handles an inbound HTTP coding request (the ones at :497 and :586 are the streaming request handlers; :1190 is the internal dispatch path), read an optional `engineEnv` object from the parsed JSON body and pass it as the new 6th argument. Change:
```javascript
const child = spawnClaudeStream(prompt, model, chatId, channelKey, effort);
```
to:
```javascript
const child = spawnClaudeStream(prompt, model, chatId, channelKey, effort, body.engineEnv || null);
```
using the actual parsed-body variable name at each site. For the :1190 site (no HTTP body in scope), pass `null` unless an `engineEnv` is already threaded into that function — i.e. `spawnClaudeStream(promptText, model, chatId, channelKey, null, null)`. Do NOT invent a body variable where none exists; pass `null` there.

- [ ] **Step 4: Verify the gateway still parses + boots**

Run: `node --check scripts/jarvis-gateway.js`
Expected: no output (syntax OK).

Run: `JARVIS_GATEWAY_PORT=22190 node scripts/jarvis-gateway.js & sleep 2; curl -s http://127.0.0.1:22190/health; kill %1`
Expected: `{"status":"ok",...}` then the background job is killed.

- [ ] **Step 5: Commit**

```bash
git add scripts/jarvis-gateway.js
git commit -m "feat(gateway): per-spawn engine env overlay for Telegram /engine qwen"
```

---

### Task 8: Adapter — access gate + routing (the wire-in point)

**Files:**
- Create: `src/telegram/adapter.js`
- Test: `src/__tests__/telegram-adapter.test.js`

The adapter is the bridge. It is tested with the brain, gateway-post, registry, engine, and access modules all mocked, so the test asserts ROUTING DECISIONS (who gets refused, what gets called) without any network or subprocess.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../channel-access.js', () => ({
  isOwner: vi.fn(),
  canAccessChannel: vi.fn(),
}));
vi.mock('../brain/brain.js', () => ({
  generateResponseStreaming: vi.fn(),
}));
vi.mock('../telegram/registry.js', () => ({
  telegramChatKey: (c, t) => (t ? `telegram:chat:${c}:topic:${t}` : `telegram:chat:${c}`),
  getTelegramProjectPath: vi.fn(),
  registerTelegramChat: vi.fn(),
}));
vi.mock('../telegram/engine.js', () => ({
  getEngine: vi.fn(() => 'claude'),
  setEngine: vi.fn(),
  resolveEngineEnv: vi.fn(() => ({})),
}));

import { isOwner } from '../channel-access.js';
import { generateResponseStreaming } from '../brain/brain.js';
import { getTelegramProjectPath } from '../telegram/registry.js';
import { handleUpdate } from '../telegram/adapter.js';

function makeSend() { return vi.fn().mockResolvedValue(undefined); }

describe('handleUpdate — access gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('owner plain chat: calls the brain and replies', async () => {
    isOwner.mockReturnValue(true);
    generateResponseStreaming.mockResolvedValue({ text: 'hi there' });
    const send = makeSend();
    await handleUpdate({ userId: '1', chatId: '111', topicId: null, text: 'hey', messageId: '9' }, { send });
    expect(generateResponseStreaming).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('111', 'hi there', expect.any(Object));
  });

  it('non-owner non-allowlisted: refused, brain NOT called', async () => {
    isOwner.mockReturnValue(false);
    const send = makeSend();
    await handleUpdate(
      { userId: '2', chatId: '111', topicId: null, text: 'hey', messageId: '9' },
      { send, allowedUsers: [] },
    );
    expect(generateResponseStreaming).not.toHaveBeenCalled();
    expect(send.mock.calls[0][1]).toMatch(/not authorized|read-only|denied/i);
  });

  it('/register from owner binds the chat', async () => {
    isOwner.mockReturnValue(true);
    const { registerTelegramChat } = await import('../telegram/registry.js');
    const send = makeSend();
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, text: '/register /home/u/proj', messageId: '9' },
      { send },
    );
    expect(registerTelegramChat).toHaveBeenCalledWith('telegram:chat:111', '/home/u/proj');
  });

  it('coding intent with no project binding: replies "register first", no brain coding', async () => {
    isOwner.mockReturnValue(true);
    getTelegramProjectPath.mockReturnValue(null);
    generateResponseStreaming.mockResolvedValue({ text: 'chatty' });
    const send = makeSend();
    // a plain message still routes to chat; binding only gates the *coding* path.
    await handleUpdate(
      { userId: '1', chatId: '111', topicId: null, text: 'just chatting', messageId: '9' },
      { send },
    );
    expect(send).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/telegram-adapter.test.js`
Expected: FAIL — `Cannot find module '../telegram/adapter.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/telegram/adapter.js
import logger from '../logger.js';
import { isOwner } from '../channel-access.js';
import { generateResponseStreaming } from '../brain/brain.js';
import { getChannelModel } from '../channel-models.js';
import { telegramChatKey, getTelegramProjectPath, registerTelegramChat } from './registry.js';
import { getEngine, setEngine } from './engine.js';
import { parseCommand } from './commands.js';
import { terseStatus, detailBody } from './format.js';
import { createTransport } from './transport.js';

// per-chat in-memory live window (durability is the memory layer's job, not this)
const histories = new Map();      // chatKey -> [{role, content}]
const aborters = new Map();       // chatKey -> AbortController
const HISTORY_CAP = 20;

function pushHistory(chatKey, role, content) {
  const h = histories.get(chatKey) || [];
  h.push({ role, content });
  while (h.length > HISTORY_CAP) h.shift();
  histories.set(chatKey, h);
}

/**
 * Core update handler. `deps.send(chatId, text, opts)` sends a reply.
 * `deps.allowedUsers` is the tier-2 id list (strings).
 */
export async function handleUpdate(update, deps) {
  const { userId, chatId, topicId, text } = update;
  const send = deps.send;
  const allowedUsers = deps.allowedUsers || [];
  const chatKey = telegramChatKey(chatId, topicId);
  const owner = isOwner(userId);
  const allowlisted = owner || allowedUsers.includes(String(userId));

  if (!allowlisted) {
    await send(chatId, 'not authorized', {});
    return;
  }

  const cmd = parseCommand(text);
  if (cmd) {
    await handleCommand(cmd, { chatKey, chatId, owner, send });
    return;
  }

  // Plain message: route to the brain (chat/status). Coding spawn is a follow-up
  // capability that rides the same gateway path; chat works with or without a binding.
  pushHistory(chatKey, 'user', text);
  const history = histories.get(chatKey);
  const controller = new AbortController();
  aborters.set(chatKey, controller);
  try {
    const model = getChannelModel(chatKey) || undefined;
    const result = await generateResponseStreaming(text, history, controller.signal, () => {}, {
      model,
      channelId: chatKey,
    });
    const full = result?.text ?? '';
    pushHistory(chatKey, 'assistant', full);
    await send(chatId, terseStatus(full), topicId ? { topicId } : {});
    const detail = detailBody(full);
    if (detail) for (const chunk of detail) await send(chatId, chunk, topicId ? { topicId } : {});
  } catch (e) {
    logger.error({ err: e.message, chatKey }, '[telegram-adapter] brain error');
    await send(chatId, '⚠️ engine error — try again or /engine claude', {});
  } finally {
    aborters.delete(chatKey);
  }
}

async function handleCommand(cmd, { chatKey, chatId, owner, send }) {
  const ownerOnly = ['register', 'engine', 'model', 'cancel'];
  if (ownerOnly.includes(cmd.cmd) && !owner) {
    await send(chatId, 'read-only: that command is owner-only', {});
    return;
  }
  switch (cmd.cmd) {
    case 'register':
      if (!cmd.arg) { await send(chatId, 'usage: /register <abs-path>', {}); return; }
      registerTelegramChat(chatKey, cmd.arg);
      await send(chatId, `bound to ${cmd.arg}`, {});
      return;
    case 'engine':
      try { setEngine(chatKey, cmd.arg); await send(chatId, `engine: ${cmd.arg}`, {}); }
      catch { await send(chatId, 'usage: /engine claude|qwen', {}); }
      return;
    case 'model':
      // setChannelModel is imported lazily to keep the test surface small
      { const { setChannelModel } = await import('../channel-models.js');
        setChannelModel(chatKey, cmd.arg); await send(chatId, `model: ${cmd.arg}`, {}); }
      return;
    case 'status': {
      const path = getTelegramProjectPath(chatKey) || '(unbound)';
      await send(chatId, `path: ${path} · engine: ${getEngine(chatKey)} · model: ${getChannelModel(chatKey) || 'default'}`, {});
      return;
    }
    case 'cancel': {
      const a = aborters.get(chatKey);
      if (a) a.abort();
      await send(chatId, 'cancelled', {});
      return;
    }
    default:
      await send(chatId, `unknown command: /${cmd.arg}`, {});
  }
}

// Bootstrap entry — called from src/index.js when TELEGRAM_BOT_TOKEN is set.
export function startTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { logger.info('[telegram] no TELEGRAM_BOT_TOKEN — adapter not started'); return null; }
  const allowedUsers = (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const transport = createTransport(token, (update) =>
    handleUpdate(update, { send: (cid, text, opts) => transport.sendMessage(cid, text, opts), allowedUsers }));
  logger.info({ allowedUsers: allowedUsers.length }, '🛰️  Telegram adapter started');
  return transport;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/telegram-adapter.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/telegram/adapter.js src/__tests__/telegram-adapter.test.js
git commit -m "feat(telegram): adapter — access gate, command routing, brain bridge"
```

---

### Task 9: Gateway topic-suffix stripping (parity with Discord `:thread:`)

**Files:**
- Modify: `scripts/jarvis-gateway.js` — `resolveProfile` (:85) only

So a Telegram `:topic:<id>` inherits its parent chat's profile exactly as a Discord `:thread:<id>` does today.

**IMPORTANT — verified, do not over-edit:** Only `resolveProfile` (:85) uses the `.replace(/:thread:\d+$/, "")` form. The ask-mode (:218) and MCP-mode (:241) functions use a **Discord-specific matcher** `match(/discord:channel:(\d+)(?::thread:(\d+))?/)` that will simply return `null` for a `telegram:` key — meaning Telegram chats fall through to the DEFAULT ask-mode/MCP-mode, which is the correct and safe behavior for v1 (Telegram has no ask-mode/MCP-mode UI yet). So this task touches ONLY the profile strip. Per-chat Telegram ask-mode/MCP-mode is an explicit out-of-scope follow-up.

- [ ] **Step 1: Find the existing thread-strip regex**

Run: `grep -n ':thread:' scripts/jarvis-gateway.js`
Expected: the `.replace(/:thread:\d+$/, "")` form appears ONLY at ~:85 (inside `resolveProfile`). The other `:thread:` hits (:218, :241, :438) are `match(/discord:channel:.../)` matchers — leave them alone.

- [ ] **Step 2: Broaden the resolveProfile strip to also handle `:topic:`**

At ~:85, change:
```javascript
const parentKey = channelKey.replace(/:thread:\d+$/, "");
```
to:
```javascript
const parentKey = channelKey.replace(/:(thread|topic):\d+$/, "");
```

- [ ] **Step 3: Verify syntax**

Run: `node --check scripts/jarvis-gateway.js`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add scripts/jarvis-gateway.js
git commit -m "feat(gateway): strip :topic: suffix so Telegram topics inherit parent-chat profile"
```

---

### Task 10: Config → env mappings for Telegram

**Files:**
- Modify: `src/config-env-bootstrap.js:21` (the `MAPPINGS` array)

- [ ] **Step 1: Add the telegram rows**

In the `MAPPINGS` array (after the `discord.*` rows), add:

```javascript
  // telegram.*
  ['telegram.token',        'TELEGRAM_BOT_TOKEN'],
  ['telegram.owner',        'TELEGRAM_OWNER_ID'],
  ['telegram.allowedUsers', 'TELEGRAM_ALLOWED_USERS'],
```

Note: the bootstrap already joins YAML arrays to comma strings (`src/config-env-bootstrap.js:307` — `if (Array.isArray(v)) return v.join(',')`), so `telegram.allowedUsers` MAY be written as a YAML list in `config.yaml`; it arrives as a comma string and the adapter splits on comma. Both forms work.

- [ ] **Step 2: Verify the mapping loads**

Run: `node --check src/config-env-bootstrap.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/config-env-bootstrap.js
git commit -m "feat(config): map telegram.{token,owner,allowedUsers} to env"
```

---

### Task 11: Wire the adapter into the bootstrap

**Files:**
- Modify: `src/index.js` (bootstrap section, near where the Discord client logs in)

- [ ] **Step 1: Find the bootstrap login point**

Run: `grep -n "client.login\|Bot online\|clientReady\|ready" src/index.js | head`
Expected: the Discord login / ready handler — the natural place to also start Telegram.

- [ ] **Step 2: Add the import + start call**

Near the top imports of `src/index.js`, add:
```javascript
import { startTelegram } from './telegram/adapter.js';
```
In the bootstrap (after Discord is up, or unconditionally at startup since `startTelegram` no-ops without a token), add:
```javascript
// Telegram is a peer transport on the same brain. No-ops without TELEGRAM_BOT_TOKEN.
startTelegram();
```

- [ ] **Step 3: Verify the module graph still loads**

Run: `timeout 15 node -e "import('./src/telegram/adapter.js').then(m => { console.log(typeof m.startTelegram); process.exit(0); })"`
Expected: prints `function` and exits cleanly. (Use the `timeout` wrapper — importing deep modules can hold the event loop.)

- [ ] **Step 4: Run the FULL suite**

Run: `npx vitest run`
Expected: all files green (the prior 794 + the new telegram tests), zero failures.

- [ ] **Step 5: Commit**

```bash
git add src/index.js
git commit -m "feat(telegram): wire adapter into the bootstrap (no-op without token)"
```

---

### Task 12: Documentation — config + deploy notes

**Files:**
- Modify: `CLAUDE.md` (add a Telegram subsystem section + config block)

- [ ] **Step 1: Add a `### telegram` subsystem entry** under Subsystems describing `src/telegram/{transport,adapter,registry,engine,format,commands}.js`, the session-key shape `agent:main:telegram:chat:<chatId>[:topic:<topicId>]`, the engine swap, and the tier-1/tier-2 access model.

- [ ] **Step 2: Document the `config.yaml` block**

```yaml
telegram:
  token: "<bot token from @BotFather>"
  owner: "<your telegram numeric user id>"
  allowedUsers: "<comma-separated tier-2 ids>"   # chat/status only
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(telegram): subsystem + config.yaml block"
```

---

## Verification gate (before this is "done")

1. **Unit/integration:** `npx vitest run` — ALL files green (prior 794 + ~34 new telegram tests). Zero skips of previously-passing tests.
2. **Gateway boot smoke:** `node --check scripts/jarvis-gateway.js` clean; gateway `/health` returns ok with the engine-overlay code present.
3. **Module-graph smoke:** `timeout 15 node -e "import('./src/telegram/adapter.js')..."` loads `startTelegram` with no `ERR_MODULE_NOT_FOUND`.
4. **Live end-to-end smoke (needs the bot token in config.yaml — a Lance-gated step, deploy-time):**
   - From the Telegram app (or watch): `/register <a test repo path>` → "bound to …".
   - Send a coding ask → terse status reply lands; detail follow-up arrives; the worktree shows the edit.
   - `/engine qwen` → next ask routes through LM Studio (gateway logs `engine_overlay_spawn`).
   - A second user (tier-2) is refused coding, allowed chat.
   - A multi-turn session keeps prior context (durable memory).

Item 4 is deploy-time and Lance-gated — it requires the real bot token and a generic deploy + restart, same discipline as the voice cutover (see `skills/verification-before-completion`). The first three gates are runnable in dev without any secret.

---

## Self-review notes

- **Spec coverage:** every locked decision maps to a task — Approach A channel (Tasks 2/6/8/11), both engines runtime-switchable (Tasks 3/7), claude-lms env trick not a qwen-code build (Task 7 reuses `claude -p`), owner+tier-2 split (Task 8 gate), terse+detail watch replies (Task 4), chat/topic=project-dir session model (Tasks 2/9). The four previously-open detail sections are filled above.
- **Drift corrected:** the spec's `discord-factory.js` does not exist — tests mirror the real inline-`vi.mock` pattern of `channel-router.test.js`. The engine env-swap reuses the EXISTING ClaudeFlare `cleanEnv` block, not new spawn machinery.
- **Out of scope (deferred, as the spec sequences):** retiring the standalone cline-telegram bridge (operational, not code here); the dedicated agent-spawn-from-Telegram coding path beyond the chat/brain route is scaffolded via the gateway engine overlay but a full `/spawn`-equivalent worktree-coding command is a follow-up once the chat path is proven live.
