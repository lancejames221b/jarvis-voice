# Plan: openjarvis-dev-live-sync

**Task**: Reconcile the diverged OpenJarvis dev (gamez `master` @ `4582aac`) and live (generic `feature/discord-voice-commands` @ `cf23e03`) trees into one synced branch that preserves BOTH gamez's Pillar-3 structural refactor AND generic's 148 live voice features — then cut generic over to it.

**Scope**:
- IN: choosing a base of truth; the merge strategy for 145 differing paths (47 renames, 47 modifies, 44 deletes, 7 adds); conflict resolution at the flat↔subdir boundary; test + live-smoke verification gate; the cutover sequence onto generic.
- OUT (explicitly deferred, separate tasks): (1) **finishing the flat→subdir migration** — both boxes carry the dual layout; the merge does NOT resolve it. (2) The `jarvis-voice → openjarvis` directory rename on generic. (3) Starting the Claude RC tmux dev worktree (that is the LAST step, post-cutover).

**Executor**: Claude on gamez (NOT Qwen). Work happens in `~/Dev/openjarvis` on a throwaway merge branch.

## Research conducted

### Memory (Step 0 — source of truth, read before anything)
- `openjarvis_dispatch_topology` (verified 2026-05-27): OpenJarvis has TWO partial dispatch trees (flat `src/*.js` + subdir `src/{discord,brain,voice,state,agent}/`). **BOTH have live consumers. Deleting either side breaks the bot.** Maps every dual-live module: `command-dispatch`, `haiku-intent`, `fuzzy-dispatch`, `brain`, `focus-state`, `intent-classifier`. The canonical end-state is "decide ONE layout (probably subdir, given index.js entry-point preference), migrate all consumers, THEN delete the loser." **This is a planned migration, not part of this merge.**
- `openjarvis_unified_config` (shipped 2026-05-28): `~/.config/openjarvis/config.yaml` → `process.env` hydration via `src/config-env-bootstrap.js`. Sync status noted **"generic: fully shipped; gamez: pending piece 8; max: pending piece 8."** So generic is AHEAD on config, gamez is AHEAD on structure. Confirms neither tree dominates.
- `openjarvis_stt_port`: Faster-Whisper binds **8765** not 8766. generic's tip commit `cf23e03` is literally "fix(stt): default Faster-Whisper URL to port 8765" — a live-correctness fix that MUST survive the merge.
- `feedback_verification` / `feedback_verification_habit`: before claiming any Jarvis change done, run the deploy/restart/live-test checklist; the 2026-05-27 audit nearly deleted a dual-live side — verification caught it. Same risk class here.
- `project_openjarvis_dev_live_sync`: this project's own tracking memory; live snapshot = `c9449b7` on `live-snapshot-2026-06-07`, pushed.

### Ground-truth investigation (this session, on-box)
- gamez `src/index.js` imports a MIX of flat + subdir (`./brain/brain.js` AND `./brain.js` both exist; `./command-dispatch.js` flat live alongside `./agent/`, `./voice/` subdirs). **gamez did the structural extraction but did NOT finish the migration** — same duality as generic. Flat duplicates of all 5 dual-live modules still present on gamez.
- Divergence: 184 gamez-only commits (Pillar-3 extraction, worktree-manager, kanban skill, persistent scheduler, integration tests, PII scrub `17ab376`, nomenclature purge `edaae72`), 148 generic-only commits (GPU service toggles, Sonos routing, cross-channel handoff, verbose thread registry, haiku intent classifier, ClaudeFlare routing, voice model overrides, conversation memory).
- Diff shape gamez↔generic: **145 paths — 47 R (renames = the flat→subdir moves), 47 M (content edits), 44 D, 7 A.** `git diff --stat` = ~2799 ins / 11342 del (the deletes are gamez having removed flat originals that generic still edits).
- GitHub: `jarvis-voice.git` is a **redirect to `openjarvis.git`** — one canonical repo, not two.

### Failure modes (and mitigations)
1. **Naive `git merge` collides across the whole `src/` tree** because gamez moved files generic edited in place → rename/edit conflicts on ~47 files. *Mitigation:* rename-aware merge with `-X find-renames`, plus a curated per-subsystem replay (below), not one big merge commit.
2. **Merge silently drops a live voice feature** (e.g. the 8765 STT fix, GPU toggles) → live regression after cutover. *Mitigation:* feature-presence checklist (below) asserted on the merged tree BEFORE cutover; live smoke on a staging run.
3. **Merge "helpfully" deletes a dual-live flat or subdir file** → bot breaks per topology memory. *Mitigation:* HARD RULE in this plan — the merge preserves BOTH layouts exactly as the two trees already carry them; zero deletions of dual-live modules; migration is out of scope.
4. **`.env.bak*`/secret leak into the merged history.** *Mitigation:* already gitignored on generic; re-assert gitignore on the merge branch; secret-scan gate before any push.

## Recommended base of truth

**Base = gamez `master` (structure), REPLAY generic's 148 feature commits onto it.**

Rationale:
- gamez carries the **harder-to-recreate, cross-cutting** work: the subsystem extraction, test infrastructure, PII scrub, and nomenclature purge. Re-deriving those onto generic's flat tree would be a massive manual refactor.
- generic's 148 commits are **mostly additive, feature-scoped** (new skills, new slash commands, env toggles, routing tweaks) — far easier to replay onto a structured base than vice-versa.
- The canonical end-state (subdir layout) the topology memory points to is gamez's direction. Basing on gamez moves toward that end-state instead of away from it.
- **Caveat that must be honored:** generic has the live-correct config rollout (piece-complete) and live fixes (STT 8765). Those specific deltas are non-negotiable and are enumerated in the feature-presence checklist so the replay can't lose them.

This is NOT "gamez wins, discard generic." It's "gamez is the structural base; every generic feature is preserved by replay/cherry-pick with conflicts resolved toward keeping the feature on the structured layout."

## Strategy: curated subsystem replay (not one big merge)

Work on a throwaway branch `merge/dev-live-sync` cut from `master`. Bring generic's work over in **themed batches** ordered low-risk → high-risk, testing between batches. Use `refs/temp/generic-live` (already fetched) as the source.

### Batch order (each batch = cherry-pick range or path-scoped checkout, then `npm test`)
1. **Config rollout parity** — bring generic's finished unified-config pieces onto gamez (gamez was "pending piece 8"). Files: `src/config.js`, `src/config-env-bootstrap.js`, `src/config-writer.js`, `src/admin-api.js` config endpoints, `scripts/migrate-to-unified-config.js`, `scripts/smoke-config.js`. Verify with `scripts/smoke-config.js` (20-check harness).
2. **Standalone skills** (purely additive, low conflict): `skills/speaker-route`, `skills/sonos-announce`, `skills/dev-agent`, `skills/npr-speaker`, `haivemind/` submodule wiring.
3. **Config-data files**: `config/models.json` (voice trigger phrases, model display names), per-channel ask/mcp mode data.
4. **Voice-feature commits** (the bulk — Sonos routing, GPU toggles, verbose thread registry, haiku classifier, ClaudeFlare routing, conversation memory, cross-channel handoff). These touch the dual-live modules → highest conflict. Resolve per the conflict policy below.
5. **Live-correctness fixes** last, asserted individually: STT port 8765 (`cf23e03`), the 9-defect audit fix (`69929ad`), Sonos blast-radius/`/tmp` cleanup fix (`4da2acd`).

### Conflict resolution policy (the flat↔subdir collision)
For each conflicted module that exists in BOTH layouts:
- **Identify which copy generic's commit actually edited** (flat, per topology memory — generic runs the flat-live side for `command-dispatch`, `haiku-intent`, `brain`, `focus-state`, `intent-classifier`).
- **Apply generic's change to the SAME flat file on gamez** (which still exists — confirmed present). Do NOT port the change into the subdir copy and do NOT delete either copy.
- Where gamez has *also* edited that flat file, hand-merge hunk-by-hunk, preferring generic's runtime behavior for live-path code and gamez's structure for imports.
- **Net invariant:** after the merge, the set of files is `gamez's file set` ∪ `any new generic files`, with both flat and subdir layouts intact exactly as each box already runs them. No dual-live module is deleted. (Finishing the migration is a separate planned task — see topology memory's 3-step.)

## Verification gate (must pass before cutover)

### Test plan
- **Unit/integration**: `cd ~/Dev/openjarvis && npm test` (vitest). Gamez has the integration suite (feature-scheduler, feature-alerts, feature-worktrees, feature-session-management, feature-voice-pipeline, channel-dispatch). MUST be green on the merged branch. Record pass count before (on `master`) and after.
- **Config smoke**: `node scripts/smoke-config.js` — 20 checks green.
- **Import-resolution smoke**: `node -e "import('./src/index.js')"` style boot check (or `node --check` across `src/**/*.js`) to catch any broken import from the rename merge BEFORE it reaches generic. This is the single highest-value gate for the flat↔subdir risk.

### Feature-presence checklist (assert ON the merged tree — grep-level, no judgment)
- [ ] STT default URL is port **8765** (not 8766) — `grep -rn 8765 src/ | grep -i whisper`
- [ ] GPU per-service toggles present — `grep -rn "JARVIS_.*_ENABLED" src/`
- [ ] Sonos speaker-route + announce skills present — `ls skills/speaker-route skills/sonos-announce`
- [ ] Verbose thread registry present — `grep -rn "verbose thread registry\|verboseThreadRegistry" src/`
- [ ] ClaudeFlare spawn routing present — `grep -rn "JARVIS_CLAUDEFLARE_URL" src/`
- [ ] Cross-channel handoff (`continue in #channel`) present — `grep -rn "handoff-resolver" src/`
- [ ] Voice model override trigger table present — `grep -rn "config/models.json\|voice trigger" src/`
- [ ] Conversation-memory-across-turns present — `grep -rn "preserve conversation memory\|conversationMemory" src/`
- [ ] Unified-config bootstrap present — `test -f src/config-env-bootstrap.js`
- [ ] No `.env`/`.env.bak*` real secrets in tree — secret-scan gate (reuse the one from snapshot step)

### Live smoke (staging run on generic, BEFORE replacing the live branch)
Run the merged tree as a throwaway process pointed at the live `.env` but WITHOUT swapping the systemd units yet (e.g. `node scripts/jarvis-gateway.js` dry boot, or a `--test` gateway on an alt port). Confirm: bot logs in to Discord, STT service reachable on 8765, no import crashes in the first 60s of `journalctl`-equivalent stdout. Only then proceed to cutover.

## Cutover sequence (onto generic — deliberate, no timing pressure)

Voice keeps running on the OLD checkout until the very last step.
1. Push merged branch to GitHub `openjarvis` as `synced-2026-06-07` (or similar). Secret-scan gate first.
2. On generic, in the live repo, `git fetch origin synced-...`. Do NOT check it out into the running dir yet.
3. **Pre-stage the rename** (separate task, but cutover-adjacent): vacate `DEV/openjarvis` (the premature RC worktree → move to `openjarvis-rc`), then `mv DEV/jarvis-voice DEV/openjarvis`, `git worktree repair`, rewrite the ~10 systemd units (3 path forms: `%h/dev/jarvis-voice`, `/home/generic/dev/jarvis-voice`, full `/media/.../DEV/jarvis-voice`), `systemctl --user daemon-reload`.
4. **Cutover window** (brief voice outage, acceptable per Lance): stop Jarvis services → `git checkout synced-...` (or fast-forward the live branch to it) in the now-`openjarvis` dir → restart services → run the live-smoke + `feedback_verification` checklist (deploy, restart, live Discord test, journalctl clean).
5. Rollback if smoke fails: `git checkout feature/discord-voice-commands` (untouched), restart. Snapshot `c9449b7` and the old branch are both intact.
6. **LAST**: start the Claude RC tmux session (`oj-rc`) with a worktree in the synced `DEV/openjarvis` dir to develop from. (The current premature RC worktree is replaced by this correctly-placed one.)

## Open questions — RESOLVED (Lance, 2026-06-07)

1. **Replay mechanism → PATH-SCOPED IMPORT.** Per subsystem batch via `git checkout refs/temp/generic-live -- <paths>`. Full granular history is preserved in the snapshot branch `c9449b7` / `refs/temp/generic-snapshot`, so individual commit history on the merge branch isn't needed.
2. **Submodule `haivemind/` → YES, gamez carries it.** Bring `agent-hivemind` submodule over (`f457d50`). VERIFY its remote is reachable from gamez during Batch 2.
3. **Config rollout → RESOLVED BY INVESTIGATION.** Neither `master` nor `refs/temp/generic-live` has the unified-config files in committed history. The canonical, live-wired config (`src/config.js` 8.7KB, `src/config-env-bootstrap.js` 15KB, `src/config-writer.js`) exists ONLY in the snapshot commit `c9449b7` (fetched as `refs/temp/generic-snapshot`). It WAS live — `scripts/jarvis-gateway.js:1` = `import "../src/config-env-bootstrap.js"`. **Batch 1 sources config files from `refs/temp/generic-snapshot`, NOT from `refs/temp/generic-live`.** GAP: `scripts/migrate-to-unified-config.js` and `scripts/smoke-config.js` are NOT in the snapshot (deleted from disk pre-snapshot) — replace the `smoke-config.js` gate with a `node --check src/**/*.js` import-resolution boot check, or reconstruct a minimal config smoke.
4. **Max box → OUT OF SCOPE (down).** Max is powered off until Lance restarts it at home. Do NOT attempt max sync this run. Follow-up: after generic cutover succeeds, pull `synced-...` to max when it's back up.

## Sourcing refs (on gamez, already fetched)
- `refs/temp/generic-live` = generic `feature/discord-voice-commands` @ `cf23e03` (committed live history; 148 feature commits)
- `refs/temp/generic-snapshot` = generic `live-snapshot-2026-06-07` @ `c9449b7` (live history + the untracked unified-config + working-tree state). **Use this for config files + anything that was untracked-but-live.**
