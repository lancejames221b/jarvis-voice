# Plan: openjarvis-dev-live-reconciliation

> Reconcile the OpenJarvis codebase between **gamez (dev)** and **generic (live)**, which
> diverged with no merge-base. Complete the in-flight structural merge so the synced tree
> preserves BOTH the Pillar-3 subdir architecture AND the 148 live voice features, gated by
> the vitest suite + a live smoke, then cut generic over during a deliberate window.

**Executor:** Claude on gamez (NOT Qwen). This is a judgement-heavy reconciliation, not a mechanical port.

---

## Research conducted

### Memory (per /plan Step 0)
- `[[project_openjarvis_dev_live_sync]]` (local) — the originating decision: make gamez+generic
  consistent, ORDER = sync code -> rename generic jarvis-voice->openjarvis -> THEN RC worktree last.
  Live snapshotted to `live-snapshot-2026-06-07` (c9449b7). Use `/plan` for the merge. **This plan is that deliverable.**
- `[[openjarvis_dispatch_topology]]` (local) — BOTH flat `src/*.js` AND subdir `src/{voice,brain,...}/`
  currently have live consumers. Deleting either side breaks the bot. Migration is incomplete; grep before any cleanup.
- `[[openjarvis_unified_config]]` (local) — `~/.config/openjarvis/config.yaml` hydrates `process.env`
  at boot via `config-env-bootstrap.js`. This was batch1 of the in-flight merge.
- `[[openjarvis_stt_port]]` (local) — Faster-Whisper binds 8765 not 8766; the fix is batch5 (HEAD).
- hAIveMind `0d0f1c6c` — live deploy topology: `jarvis-voice.service` on generic runs from
  `/media/generic/8f6026e4-.../DEV/jarvis-voice`; gamez is authoritative source, deploy by sync+restart.
- hAIveMind `6c4aa894` — historical rule: dev work in a clone, never edit the live `/media/.../DEV/jarvis-voice` path directly. Honoured: all merge work happens on the gamez checkout.
- Memory turned up **nothing that contradicts** "gamez structure is base, port live features in" — it
  corroborates it.

### Ground-truth verification (read on gamez disk, NOT from the brief)
The brief assumed HEAD = `master @ 4582aac`, greenfield. **That is stale.** Actual state:

| Fact | Brief assumed | Verified on disk |
|---|---|---|
| Current branch / HEAD | `master @ 4582aac` | `merge/dev-live-sync @ 9207799` |
| Merge status | not started | **5 batches already committed** (snapshot, batch1, batch2, batch4a, batch5) |
| Base-of-truth decision | "recommend one" | **already made + executing**: gamez Pillar-3 subdir = base; live features port IN |
| `src/` layout | one or the other | BOTH present (`voice/ brain/ agent/ state/ discord/` populated AND flat `*.js`) |
| Remaining live commits | "merge 148" | 148 commits exist in `refs/temp/generic-live` but **most features already present in gamez tree** |
| Merge-base | none | confirmed none (`git merge-base` returns nothing) — manual port, not git merge |

**The decisive finding** (presence-grep of gamez `src/` for each live feature theme): claudeflare routing
(`scripts/jarvis-gateway.js`), cross-channel handoff (`src/state/focus-state.js`, `src/brain/briefing.js`),
haiku intent (`src/brain/haiku-intent.js`), Sonos (`src/sonos-play.js`, `src/sonos-mode.js`),
verbose live-stream/thread registry (`src/verbose-mode.js`, `src/live-stream.js`), data-driven voice
model overrides (`config/models.json` EXISTS) — **all already in the gamez tree**, carried in during the
Pillar-3 refactor. The only theme with NO match was "conversation memory across voice turns"
(live commit `78ce6b7`, +78 lines in flat `src/brain.js`).

So the real job is **NOT** "hand-port 148 commits." It is: **parity-audit the gamez tree against the
148-commit feature set, and port only the genuine deltas** (likely a handful, not 148). The 148 number
is inflated by the refactor having already absorbed most of them under different paths.

---

## Task

Finish the in-flight `merge/dev-live-sync` so the gamez tree is the single base of truth that contains
the Pillar-3 architecture **and** full live voice feature-parity, verified by `vitest run` + a live
smoke, then cut generic over (pull + rename `jarvis-voice` -> `openjarvis`), and only then start the RC
tmux/worktree session.

## Scope

**In scope**
- Finish the structural merge ON the gamez `merge/dev-live-sync` branch (low-risk to break dev).
- A per-subsystem **parity audit** of gamez-tree vs the 148 live commits; port genuine deltas only.
- Preserve the dual flat+subdir topology until BOTH sides have live consumers retired (do not delete either layer in this plan).
- Commit the currently-uncommitted **cgg integration** (already deployed live) so it survives the merge.
- Verification gate: full vitest suite green + live smoke on a throwaway test channel.
- Cutover runbook for generic (pull, rename, restart) with rollback to `live-snapshot-2026-06-07`.

**Out of scope**
- Deleting the flat `src/*.js` layer (separate future task once subdir consumers fully replace it — the topology memory forbids it here).
- The `package.json name` rename to `openjarvis` + v2.0.0 bump as a *code* change is IN scope at cutover; the broader rename-everything pass is not.
- Building the worktree-manager / RC agent (explicitly LAST, after cutover — out of this plan's body).
- haivemind submodule internal changes (batch2 already fixed the submodule URL).

## Base-of-truth recommendation (ratify, don't relitigate)

**Base = gamez Pillar-3 subdir structure. Live features port INTO it.** Justification:
1. **It's already chosen and 5 batches deep.** Reversing to a generic-features base throws away batches 1/2/4a/5 and the entire refactor.
2. **The refactor already absorbed most live features** (presence-grep above). The structural tree is the superset; live is the subset-plus-a-few-deltas.
3. **Structure is hard to redo; features are easy to re-port.** Re-deriving the Pillar-3 extraction (slimmed 389-line bootstrap, module boundaries, integration tests) from the flat layout would be enormous; porting a 78-line brain delta is trivial. Pick the base that minimises irreversible work.
4. **The test suite lives on the gamez side** (31 vitest files incl. integration). Keeping the structural base keeps the verification gate intact.

## Stack
Node.js ES modules, discord.js v14, vitest (`vitest run`), Claude CLI gateway. No framework choices to make — this is a reconciliation, not a build.

## References
- `refs/temp/generic-live` (cf23e03) — fetched live tree, the 148-commit feature source.
- `refs/temp/generic-snapshot` / branch `live-snapshot-2026-06-07` (c9449b7) — pushed rollback point.
- `/tmp/oj-remaining-commits.txt` — full 148-commit subject list (generated this session).
- `CLAUDE.md` (repo) — deploy workflow, systemd units, rollback recipe.

---

## Strategy: parity-audit, not commit-replay

Do **not** `git cherry-pick` or `git rebase` across the 148 commits — there is no merge-base and the
file paths moved (flat -> subdir), so every pick would conflict across the whole tree. Instead, work by
**subsystem feature-group**. For each group: diff the live behavior against the gamez tree, and port only
what's genuinely missing or behind. This is the same hand-authored "batch" method already in use
(batches 1/2/4a/5), continued to completion.

### The flat -> subdir path map (the core collision table)
Every live commit edits a flat path; its gamez home is the subdir module. When porting a delta, retarget:

| Live (flat) path | Gamez (subdir) home | Notes |
|---|---|---|
| `src/brain.js` | `src/brain/` (index.js, intent-classifier.js, haiku-intent.js, briefing.js, …) | brain.js was split; find the function's new module |
| `src/stt.js` | `src/voice/stt.js` | batch5 already did the port here |
| `src/tts.js`, `src/tts-pipeline.js` | `src/voice/tts.js`, `src/voice/tts-delivery.js` | |
| `src/index.js` (voice receiver / dispatch hooks) | `src/discord/command-dispatch.js`, `src/voice/voice-receiver.js` | BUT flat `src/index.js` (5932 lines) is STILL the live bootstrap on gamez too — see topology note |
| `src/service-control.js` | exists flat AND batch4a added subdir voice edits | dual: batch4a kept flat file + edited `src/voice/{stt,tts}.js` |
| `src/focus-state.js` | `src/state/focus-state.js` | |
| `src/live-stream.js`, verbose thread registry | `src/verbose-mode.js`, `src/live-stream.js` | already present, audit for behavior parity |
| `config/models.json` | `config/models.json` | already present; diff values |

**Topology caveat (from `[[openjarvis_dispatch_topology]]`):** the flat `src/index.js` (5932 lines) is
STILL a live consumer on gamez, not just a 389-line bootstrap. Do NOT assume the subdir version replaced
it. Before porting any `index.js`-level dispatch hook, grep which file the running bootstrap actually
imports, and patch THAT one (or both, if both are wired). The cgg integration already did this correctly
(hooked the flat `src/index.js`).

---

## Files / work units

Work proceeds as ordered **stages**, each ending at a green `vitest run`. Treat each as one commit.

### Stage 0 — Preserve the uncommitted cgg work — [COMMIT] ✅ DONE (91a501a)
**Why first:** the working tree was dirty with the cgg integration
(`src/cgg-dispatch.js`, `src/__tests__/feature-cgg-dispatch.test.js`, edits to `src/index.js` +
`package.json`). A merge operation could clobber it, so it MUST be captured before anything else moves.
**CORRECTION (verified 2026-06-15):** cgg is NOT yet on live. `refs/temp/generic-live` (cf23e03) has
no `cgg-dispatch.js`, no cgg references anywhere, and no `@mermaid-js/mermaid-cli` in its `package.json`.
cgg is a **gamez-only addition that is NEW to generic**, not a byte-identical re-sync. The earlier
"already deployed live" framing was stale prose; the tree is truth.
**Actions (done):**
- `git status` confirmed exactly these 4 paths dirty (all genuinely cgg wiring — package.json adds the
  mermaid-cli dep; index.js adds the `tryCggDispatch` import + pre-brain intercept).
- `git add src/cgg-dispatch.js src/__tests__/feature-cgg-dispatch.test.js src/index.js package.json`
- Committed: `merge(cgg): land cgg Discord dispatch into merge branch` (91a501a).
**Acceptance MET:** the 4 paths committed; `vitest run` green (feature-cgg-dispatch.test.js, 13 tests).

### Stage 1 — Build the parity ledger — [CREATE doc]
**Purpose:** turn the 148 commits into a deduplicated, bucketed gap list so porting is finite and auditable.
**Actions:**
- For each theme bucket (counts from this session): Sonos/audio (6), handoff/cross-channel (4),
  verbose/live-stream (17), haiku intent (7), claudeflare (1), voice-model overrides (7),
  GPU toggles (4 — mostly batch4a), ask/mcp mode (2), memory fixes (14), skills (6), plus the long tail.
- For each, `git log -p HEAD..refs/temp/generic-live -- <flat path>` to read the live behavior, then grep
  the gamez subdir home. Mark each: **PRESENT** (parity, skip), **DELTA** (port the diff), or **MISSING** (port whole).
- Write `plans/oj-parity-ledger.md`: one row per feature-group → {status, live commit(s), gamez target file, action}.
**Acceptance:** ledger covers all 148 commits (every commit maps to a bucket); the count of DELTA+MISSING rows is the real remaining workload (expected: small, single digits of feature-groups).

### Stage 2 — Port the genuine deltas, one feature-group per commit — [MODIFY]
For each DELTA/MISSING row in the ledger, in this priority order (operational impact first):
1. **conversation-memory-across-turns** (`78ce6b7`, the one confirmed MISSING). Live added +78 lines to flat
   `src/brain.js`; port the logic into the matching `src/brain/` module. **Acceptance:** a voice turn N
   sees turn N-1 context; add/extend a brain test asserting prior-turn carry.
2. **admin voice commands for live GPU control** (`61f1d5b`) — verify batch4a's `src/service-control.js`
   actually covers the voice-command surface, not just env toggles. Port any missing command handlers.
3. **Sonos routing/announce/speaker-route** — diff `src/sonos-play.js`/`src/sonos-mode.js` against live; port deltas.
4. **verbose thread registry** — confirm `src/verbose-mode.js` keys threads by source channel/thread ID
   (live commits `22b8780`/`88caa66`); port if the gamez version regressed to a global registry.
5. **haiku intent classifier** — confirm `src/brain/haiku-intent.js` has the 1500ms timeout + tool-marker
   stripping (`97a4c50`); port if behind.
6. **claudeflare spawn routing** (`eddc285`) — verify `scripts/jarvis-gateway.js` routes spawns through
   `JARVIS_CLAUDEFLARE_URL`; port if absent.
7. **data-driven voice model overrides** — diff `config/models.json` + `src/discord/channel-models.js`
   against live (`f11455d`/`9e70502`/`4cfc90a`); reconcile values.
8. Long-tail memory fixes (14) + remaining — port any that are genuine bugfixes not already in the subdir tree.

**Per-group rule:** retarget flat->subdir via the path map; patch the file the live bootstrap actually
imports (grep to confirm); one feature-group = one `merge(batchN): <feature>` commit; run `vitest run`
after each. A group that grep proves is already at parity gets NO commit — just a ledger note.

**Loading/empty/error states:** N/A (backend voice logic, not UI). **Error surface:** each ported handler
must keep the live error path (e.g. Sonos-room-not-found ack plays through Discord, not the cleared Sonos target — `0a6dafe`).

### Stage 3 — Topology consistency sweep — [VERIFY]
**Purpose:** the dual flat+subdir layout must not have one layer stale after porting.
**Actions:**
- For every file touched in Stage 2 that exists in BOTH flat and subdir form, grep the live bootstrap
  (`src/index.js`) to see which it imports; ensure the imported one carries the ported behavior.
- Do NOT delete either layer (topology memory). Document any remaining flat<->subdir drift in the ledger as
  a follow-up, not a blocker.
**Acceptance:** no ported feature is reachable only through a non-imported layer.

---

## Verification gate (the cutover blocker — must ALL pass before generic pulls)

1. **Unit/integration:** `npm test` (`vitest run`) — ALL 31+ test files green, including the new
   conversation-memory assertion and feature-cgg-dispatch. Zero skips of previously-passing tests.
2. **Boot smoke (gamez):** `node -e "import('./src/index.js')"`-style load OR start the bot against a
   throwaway Discord test guild; confirm clean boot (no `ERR_MODULE_NOT_FOUND`, no missing-export).
   Known pre-existing live boot warnings (`channel-topic.js`, old-path `thread-router.js`) must be
   resolved or explicitly logged as known-unrelated.
3. **Live smoke (functional, on a test channel — NOT the live channels):** exercise one command per ported
   feature-group: a voice turn that needs prior-turn memory; a Sonos speaker toggle; a GPU
   enable/disable; a `!cgg <path>`; a verbose-thread @mention. Each returns the expected behavior.
4. **No-secrets check:** `git log -p` of the merge branch contains no `.env`, no `.env.bak*`, no tokens
   (these are gitignored; double-check the cgg + ported commits didn't add any).

If ANY gate fails, the cutover does not proceed. Voice keeps running on generic untouched.

---

## Cutover sequence (deliberate, no time pressure — voice stays up on generic until this runs)

**Order is fixed (from `[[project_openjarvis_dev_live_sync]]`): sync code -> rename -> RC worktree last.**

1. **Push the verified merge branch** from gamez: `git push origin merge/dev-live-sync`.
2. **Snapshot live again** (defence in depth) — confirm `live-snapshot-2026-06-07` (c9449b7) is still on
   GitHub; if live drifted since, re-snapshot the current generic tree to a dated branch + push.
3. **Quiet window:** pick a low-traffic moment (no hard deadline). Announce in #hud that a cutover is starting.
4. **On generic, fetch + checkout** the merge branch into the live path
   `/media/generic/8f6026e4-.../DEV/jarvis-voice` (the running WorkingDirectory). `git fetch`,
   `git checkout merge/dev-live-sync`. Keep `.env`/state files (gitignored, untouched).
5. **`npm install`** on generic (mermaid-cli + any new deps from batches). Use `PUPPETEER_SKIP_DOWNLOAD=true`.
   - **cgg is NEW to generic** (not a re-sync — verified: live ref cf23e03 has no cgg / no mermaid-cli).
     Confirm `@mermaid-js/mermaid-cli` installs cleanly here, and that the `cgg` binary itself is on
     generic's PATH (cgg-dispatch shells out to it). If either is missing, `!cgg` will fail at runtime
     even though the bot boots fine.
   - **Sonos/LAN IPs:** gamez removed the hardcoded fallback IPs from `src/sonos-play.js` (now empty-string
     defaults sourced from `~/.config/openjarvis/config.yaml` via config-env-bootstrap). `config.yaml` is
     gitignored, so the checkout won't touch it — but confirm generic's `config.yaml` actually carries
     `sonos.bedroomIp` / `sonos.kitchenIp` / `hosts.lanHost`, or Sonos targets resolve to empty.
6. **Restart services:** `systemctl --user restart jarvis-gateway jarvis-voice`. Wait 3s, check
   `is-active` both, tail `journalctl --user -u jarvis-voice -u jarvis-gateway -b -n 80`. Confirm
   "Jarvis Voice Bot online", NRestarts=0, no module-not-found.
7. **Live functional re-smoke** on the real (but quiet) channels: one voice turn (needing prior-turn
   memory, exercises batch6), one Sonos toggle, one `!cgg` (**smoke as a FRESH feature on generic, not a
   parity confirmation** — it has never run there). Confirm expected behavior.
8. **Rename `jarvis-voice` -> `openjarvis`** (the planned rename, AFTER code sync is verified live):
   - `package.json` `name` -> `openjarvis`, bump v2.0.0.
   - Rename the systemd unit `jarvis-voice.service` -> `openjarvis.service` (and `jarvis-gateway` if Lance wants), update WorkingDirectory if the dir is also renamed, `systemctl --user daemon-reload`, disable old + enable new, restart, re-smoke.
   - Update CLAUDE.md deploy paths/unit names.
9. **THEN (last):** start the Claude RC tmux session with a fresh git worktree in the synced/renamed dir
   to develop from. This is explicitly the final step — not part of the merge.

### Rollback (if any cutover step fails)
- `git checkout live-snapshot-2026-06-07` (c9449b7) on the live path (OR the deploy.sh `../jarvis-voice.bak/`
  generation), `npm install` if deps changed, `systemctl --user restart jarvis-gateway jarvis-voice`,
  confirm `is-active`. The pre-cutover live tree is fully preserved on GitHub; rollback is a checkout + restart.

---

## Data flow
No new data flow. State files (`jarvis-sessions.json`, `channel-*.json`, registry) live on generic and are
gitignored — the merge does not touch them; they survive the cutover checkout unchanged.

## Test plan
- **Manual smoke (3 actions):** (1) voice turn needing prior-turn memory in a test channel; (2) `!cgg src/voice` returns PNG+mmd; (3) Sonos/GPU toggle command acks correctly.
- **Regression:** `vitest run` full suite after EACH stage commit, not just at the end.
- **Cutover re-smoke:** repeat the 3 actions on generic post-restart before declaring success.

## Open questions (executor must NOT decide alone)
1. **Scope of the rename at cutover:** rename only `package.json name`, or also the systemd unit
   (`jarvis-voice.service` -> `openjarvis.service`) AND the on-disk directory
   `/media/.../DEV/jarvis-voice` -> `.../openjarvis`? The directory rename changes the unit's
   WorkingDirectory and any absolute-path references — confirm with Lance how far the rename goes.
2. **Long-tail commits (the ~90 not in a named theme bucket):** after the ledger, if any are ambiguous
   (cosmetic vs behavioral), surface them to Lance rather than guessing whether they're worth porting.
3. **Flat-layer retirement:** the topology memory forbids deleting the flat `src/*.js` in this plan. Confirm
   that staged deletion of the flat layer is a SEPARATE future task, not expected here.

---

## Recommended executor

**Primary:** Claude on gamez (this session / a `/loop` continuation) — reconciliation needs per-commit
behavioral judgement, flat->subdir retargeting, and grep-verification that Qwen would not do safely.
**Backup:** none — do not hand the merge to Qwen; the topology-collision risk (deleting a still-consumed
layer) is exactly the failure mode a non-judgement executor hits.
**Reasoning:** the hard part is deciding PRESENT vs DELTA vs MISSING per feature-group and patching the
correct (imported) layer — judgement, not mechanics.
**Warm command:** N/A (Claude-driven, not a warmed local model).

---

## Phase 0 status log

### 2026-06-15 — gamez-side tidy complete (commit c80e34e, pushed)
The two approved gamez-side dirty-tree items from the live audit are done:
- `package.json`: pinned `@mermaid-js/mermaid-cli` to exact `11.15.0` (matches live).
- `.gitignore`: broadened to ignore the full `.claude/` and `.gstack/` local runtime dirs
  (replaced the two narrow `.claude/scheduled_tasks.*` lines; nothing was tracked under `.claude/`).
- Verification gate: `vitest run` 794/794 green, 31/31 files, at HEAD c80e34e.

Phase 0 merge work on gamez is now complete and verified:
batch4a..batch7 + cgg + conversation-memory port + this tidy commit, all on `merge/dev-live-sync`,
pushed to origin. Full vitest suite green. Parity audit found no gaps beyond the now-ported 78ce6b7.

### FROZEN — awaiting Lance: live cutover + live dirty-tree reconcile
Still Lance-gated, untouched:
- Generic's own uncommitted work (live cgg variant — adopt-live decision recorded; .claude/ + .gstack/
  live-only dirs; package-lock drift) must be reconciled per the audit table before the checkout.
- The cutover itself (generic pulls `merge/dev-live-sync` + rename jarvis-voice -> openjarvis).
- Stale `.claude/worktrees/agent-a926` cruft on the live host — needs Lance's word (live-host change).

Nothing here touches generic. Voice keeps running on generic untouched until the deliberate cutover.
