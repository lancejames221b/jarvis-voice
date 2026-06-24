---
topic: Fix the autonomous loop so it actually finishes work (verifier gate + blocked-escalation + convergence guard)
generated_by: oplan (model: claude-opus-4-8)
generated_at: 2026-06-02T16:45:00-04:00
---

# Make the loop finish real work, not just declare "done"

## The problem (from the #keyspy "Qwen" thread)
You said: *"keep it going... stay in a loop until it fucking works and gets done. I don't want to babysit."* The loop kept declaring **done**, you pushed back, it re-checked, declared **done** again — while the real keyspy task was actually failing (2.9% accuracy, basically random / 1-in-36). Three concrete failures:

1. **No success gate.** "Done" = the model *says* `LOOP_DONE`. There's no objective check. So the loop "completes" on the model's optimism, not on tests passing or a metric hit.
2. **The prompt fix didn't take on resumed sessions.** I added a "don't roll your own poller" instruction to the agent prompt, but the Qwen agent is a warm `--resume` session that still spawned a NEW bash poller (PID 2929798: `for i in seq 1 20; do sleep 60; tmux capture-pane...`) AFTER the fix deployed. Resumed sessions carry the old baked-in prompt.
3. **No "blocked → escalate" path.** When work genuinely can't progress (wrong dataset shapes, target unreachable), the loop has no way to stop and say "I'm stuck, here's why, I need you." It either fake-completes or spins.

## What OpenClaw does (the reference you pointed to)
- **Verifier-driven goal**: each iteration runs a real verify command (e.g. `pytest`); done = command actually passes.
- **Status gating** (`active`/`blocked`/`complete`): mark complete only when objective truly achieved; mark **blocked** (and escalate to user) when the **same blocking condition repeats**.
- **Convergence detection**: if consecutive iterations are >85% similar (no progress), intervene instead of spinning.
- **Hard iteration cap + escalate-to-user** rather than silent abort or infinite retry.

Our loop today has ONLY the hard cap (25). We add the other three.

## Goal
Upgrade the loop engine (`src/slash/loop.js`) so an autonomous loop stops for one of FOUR real reasons — verify-passed, genuinely-complete, blocked (escalate to you), or convergence/cap — and never silently fake-completes or spins on a detached poller.

## Approach
Extend the existing `startLoopCore()` (already has the hard cap + warm gateway session) with a verifier gate, a blocked-escalation path, and a convergence guard. Keep it all in `loop.js` — no new service, no detached process. Reuse the gateway warm-session call that already works. This is additive; `/loop` and natural-language auto-loops both flow through `startLoopCore`, so both get the upgrade.

## Phases

### Phase 1: Verifier-driven termination
- Add an optional `verifyCmd` to the loop (e.g. `pytest -q`, `npm test`, or any shell one-liner) and a `verifyContains` / exit-code check.
- Each iteration, AFTER the model's turn, run `verifyCmd` on the executor box (via the same shell path the agent uses — `tmux`/ssh to generic, or a gateway shell hook). Loop is DONE only when verify passes (exit 0 or output contains the success token).
- Natural-language: parse "until tests pass", "until pytest is green", "until `<cmd>` works" → set `verifyCmd`. If no verify command is extractable, fall back to self-judged `LOOP_DONE` (current behavior) but REQUIRE the model to include a one-line evidence statement ("verified: <what>") so it can't just assert done.
- **Verification**: a loop with `verifyCmd: "exit 1"` never terminates as complete (only via cap); `verifyCmd: "exit 0"` terminates on iteration 1 as verified.

### Phase 2: Blocked-state escalation (stop babysitting AND stop fake-completing)
- Add a structured turn contract: the model ends each iteration with one of `STATUS: WORKING` / `STATUS: BLOCKED <reason>` / `STATUS: DONE`.
- `BLOCKED` twice on the SAME reason (normalized compare) → stop the loop, post a clear "🚧 Blocked, need you: <reason>" message into the thread AND speak a TL;DR. This is the "honest 2.9% accuracy, the approach won't hit target without X" moment — surfaced instead of buried.
- `DONE` is only honored if the verifier (Phase 1) agrees, or if there's no verifier and evidence is present.
- **Verification**: a scripted model reply that says `STATUS: BLOCKED dataset shape mismatch` twice halts with an escalation message; a single blocked followed by working does not.

### Phase 3: Convergence guard (no-progress detection)
- Track a cheap fingerprint of each iteration's output (normalized text, or a hash of the tool actions). If N consecutive iterations are ~identical (>85% similar, or same fingerprint 3x), treat as stuck → escalate as BLOCKED with reason "no progress for 3 iterations".
- **Verification**: feeding the same output 3 times in a row triggers the convergence halt before the hard cap.

### Phase 4: Kill the rogue-poller path for good (resumed-session-proof)
- The prompt-only fix is insufficient for warm sessions. Add a belt-and-suspenders guard: a `before_tool_call`-style check (or a wrapper on the agent's shell dispatch) that detects a detached long-poll pattern in a shell command the agent tries to run — `while true`, `for i in $(seq`, `nohup ... &`, repeated `sleep` + `tmux capture-pane` — and BLOCKS it with a message telling the agent to use the loop engine instead.
- Also: kill the currently-running orphan (PID 2929798 + its `sleep 60` child) on generic now.
- **Verification**: the orphan is gone (`ps` shows nothing); a test shell command containing `while true; do sleep 60` is rejected by the guard.

### Phase 5: Wire params through both entry points + deploy
- `/loop` gains optional `verify:` option; `startLoopFromMessage` passes parsed `verifyCmd`.
- `detectLoopIntent` extracts verify command from "until tests pass / until `<cmd>` works".
- Deploy via `scripts/deploy.sh generic`; restart; **start a fresh agent session** (the warm one has the old prompt — must rotate it so the new behavior actually applies to the keyspy thread).
- **Verification**: full import resolve, syntax check, clean boot, `/loop` + verify round-trip tested against the live gateway.

## Files to touch
- `/home/yari/Dev/openjarvis/src/slash/loop.js` — verifier gate, blocked escalation, convergence guard, verify-command parsing; extend `startLoopCore`, `detectLoopIntent`, `handleLoopCommand`, `startLoopFromMessage`.
- `/home/yari/Dev/openjarvis/src/slash-commands.js` — add `verify:` option to LOOP_CMD.
- `/home/yari/Dev/openjarvis/src/brain.js` AND `/home/yari/Dev/openjarvis/src/brain/brain.js` — strengthen the MONITORING/LOOPING prompt; add the rogue-poll guard note (both files — index.js uses the brain/ one).
- Possibly `scripts/jarvis-gateway.js` — if the shell-command guard (Phase 4) needs to live at the gateway's tool-dispatch layer rather than in-prompt. Will confirm where the agent's shell calls flow before editing.
- `/home/yari/Dev/openjarvis/data/schedules.json` — NOT touched (excluded by deploy).

## Files NOT to touch
- `src/task-scheduler.js` — the recurring scheduler is fine and just got fixed; this work is the loop engine, separate concern.
- `src/data/` — runtime state, excluded from deploy.

## Risks
- **Verify command runs shell on the live box** → scope it: only run the user-provided verify command, with a timeout, never an arbitrary model-chosen command. Mitigation: verifyCmd is set once at loop start from the user's words, not re-derived by the model each turn.
- **Convergence false-positive** halts a legitimately-slow loop → tune threshold (3 identical iterations, not 2) and always escalate rather than silently kill, so you can say "keep going."
- **Phase 4 shell guard over-blocks** a legitimate `sleep` → match only the detached-poll *combination* (loop keyword + sleep + capture/log), not bare `sleep`.

## Open questions (resolved with sensible defaults unless you object)
- Where to run verifyCmd: default = the executor box (generic) over the same channel the agent uses, since that's where the work happens.
- Convergence threshold: default 3 identical iterations.

## Next action
Kill the live orphan poller (PID 2929798 + child) on generic, then implement Phase 1 (verifier gate) in `src/slash/loop.js`.

## Sources
- OpenClaw agent loop & goal tasks: https://docs.openclaw.ai/concepts/agent-loop , https://docs.openclaw.ai/tools/goal
- Production goal-loop impl: https://github.com/goldmar/openclaw-code-agent
- Loop control / max_iterations / convergence: https://www.roborhythms.com/openclaw-agent-keeps-looping-fix/ , https://github.com/openclaw/openclaw/issues/9912
