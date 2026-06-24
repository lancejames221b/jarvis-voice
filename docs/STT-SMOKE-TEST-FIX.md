# Jarvis STT Smoke-Test Fix — Deployed 2026-05-24

## What was found
`/test/stt` endpoint only existed when `DEV_MODE=true`. The fake STT callback (`src/index.js`) only called `dispatchCommand()` and returned JSON — never actually executed brain tasks.

## Fix applied
Fake STT callback replicates real brain path: dispatchCommand → check dispatch.type === 'brain' → add to conversations Map → trimHistory → queueUtterance.

## Deploy issues
Deploy.sh sync wiped 120+ committed src/ files from git HEAD. Had to:
1. Pull ALL committed src/ files from `git show HEAD` on generic (not deploy.sh — it syncs --delete)
2. Fix hud.js importing task-ledger from wrong path (`./task-ledger.js` → `./agent/task-ledger.js`)
3. Apply fix to git HEAD index.js (different API: `conversations` Map, `CONVERSATION_HISTORY_MAX`)

## Test results
- A (gateway-only): PASS
- B (/test-voice): PASS  
- C (/test/stt + news dispatch): **PASS** — returns type: brain, 1 active task in ledger
- D (real Discord voice): NOT TESTED
