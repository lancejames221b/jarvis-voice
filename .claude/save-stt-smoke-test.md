# Jarvis STT Smoke-Test Investigation — /test/stt Fix

**Goal:** Trace the live Jarvis voice pipeline from STT transcript → command dispatch → brain task, and fix `/test/stt` so it actually executes tasks (not just classifies).

## Verified Findings

1. **Live generic state** — jarvis-voice and jarvis-gateway running (commit 78ce6b7), gateway healthy with 70 sessions, TAILSCALE_IP-based webhook on port 3335.

2. **`/test/stt` returns 404** — confirmed on live. No `DEV_MODE=true` set in `.env`. Endpoint only exists when `NODE_ENV=development || DEV_MODE==='true'` (alert-webhook.js:1649).

3. **`/test-voice` works** — returns JSON with TTS delivered on kitchen speaker at volume 20. Full voice pipeline (alert-webhook → gateway → TTS) is functional.

4. **Gateway-only smoke test** — responds correctly, but Claude can't answer "check the news" without web search (knowledge cut-off: Aug 2025).

## Root Cause — /test/stt is Dispatch-Only, Not Execution

**Fake STT callback** (`src/index.js:1441-1449`):
```js
setHandleFakeSttCallback(async (text, userId) => {
  const dispatch = await dispatchCommand(text, cleaned, ...);
  return { type: dispatch.type, wakeWord, transcript, dispatch }; // ← returns JSON only
});
```

**Real STT pipeline** (`src/index.js:4739-4816`):
```js
// dispatchResult.type === 'brain' → fall through to background brain call
conv.history.push({ role: 'user', content: transcript });
trimHistory(conv.history);
queueUtterance(userId, transcript, conv, speakerName, sentiment); // ← creates task → gateway → response
```

`/test/stt` never calls `queueUtterance()`, so no brain task is created, no gateway call, no HUD output — dead end.

## Fix Applied (src/index.js:1440-1495)

Fake STT callback now replicates the real brain path:
- For non-brain dispatches (mode toggles, shortcuts): pass-through unchanged
- For `type: 'brain'`: adds to conversation history with cold-start seed, calls `trimHistory()`, then calls `queueUtterance()` — same debounce path as real STT

## Tests Remaining

- **Test C** (TODO): Run `/test/stt` with news query after deploying fix
- **Test D** (TODO): Real Discord voice path end-to-end
- Must enable `DEV_MODE=true` on live generic before `/test/stt` works
