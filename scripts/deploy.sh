#!/usr/bin/env bash
# Deploy OpenJarvis from dev (gamez) to live (generic) via git pull.
#
# Usage:
#   scripts/deploy.sh                  — full deploy: push local branch, pull on generic, restart
#   scripts/deploy.sh --push-only      — push to GitHub only, no restart (CI/test use)
#   scripts/deploy.sh --pull-only      — pull + restart on generic, no push (already pushed)
#   scripts/deploy.sh --dry-run        — show what would happen, make no changes
#
# Model: GitHub is the single source of truth.
#   gamez  → git push → GitHub → generic git pull --ff-only → systemctl restart
#
# Requirements:
#   - Current branch is pushed to GitHub (or will be pushed by this script)
#   - Live tree on generic is a clean git checkout (no local edits to tracked files)
#   - .env and config files on generic are gitignored — they survive the pull untouched

set -euo pipefail

REMOTE="${JARVIS_REMOTE:-generic}"
LIVE_PATH="${JARVIS_LIVE_PATH:-/home/generic/dev/openjarvis}"
BRANCH="$(git -C "$(dirname "$0")/.." rev-parse --abbrev-ref HEAD)"

log()  { echo "[deploy] $*"; }
die()  { echo "[deploy] ERROR: $*" >&2; exit 1; }
info() { echo "[deploy] $*"; }

DRY=0
PUSH=1
PULL=1

for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY=1 ;;
    --push-only)  PULL=0 ;;
    --pull-only)  PUSH=0 ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

# ── 1. Push to GitHub ─────────────────────────────────────────────────────────
if [[ $PUSH -eq 1 ]]; then
  log "Pushing branch '$BRANCH' to origin ..."
  if [[ $DRY -eq 1 ]]; then
    info "(dry-run) git push origin $BRANCH"
  else
    git -C "$(dirname "$0")/.." push origin "$BRANCH"
  fi
fi

# ── 2. Pull + restart on generic ──────────────────────────────────────────────
if [[ $PULL -eq 1 ]]; then
  log "Pulling on $REMOTE:$LIVE_PATH ..."

  # Confirm live path exists.
  ssh "$REMOTE" "[ -d '$LIVE_PATH/.git' ]" || \
    die "Live path not a git repo on $REMOTE: $LIVE_PATH"

  # Check for dirty TRACKED files on live (untracked files are fine; --ff-only only cares about tracked).
  DIRTY=$(ssh "$REMOTE" "git -C '$LIVE_PATH' status --porcelain" 2>/dev/null | grep -v '^??' || true)
  if [[ -n "$DIRTY" ]]; then
    log "WARNING: live tree has uncommitted changes to tracked files:"
    echo "$DIRTY"
    die "Aborting. Commit or stash on generic first, or use --push-only to inspect."
  fi

  if [[ $DRY -eq 1 ]]; then
    info "(dry-run) ssh $REMOTE 'git -C $LIVE_PATH pull --ff-only origin $BRANCH'"
    info "(dry-run) ssh $REMOTE 'systemctl --user restart jarvis-gateway jarvis-voice'"
  else
    ssh "$REMOTE" "git -C '$LIVE_PATH' pull --ff-only origin '$BRANCH'"

    log "Restarting jarvis-gateway and jarvis-voice on $REMOTE ..."
    ssh "$REMOTE" "systemctl --user restart jarvis-gateway jarvis-voice"

    sleep 3

    log "Checking service status ..."
    if ! ssh "$REMOTE" "systemctl --user is-active jarvis-voice jarvis-gateway"; then
      log "!!! A service failed to start — recent logs:"
      ssh "$REMOTE" "journalctl --user -u jarvis-voice -u jarvis-gateway --since '30 seconds ago' --no-pager -n 80"
      die "Services failed. Check logs above. Last git pull succeeded — rollback with: ssh $REMOTE 'cd $LIVE_PATH && git reset --hard HEAD^'"
    fi

    log "--- startup logs ---"
    ssh "$REMOTE" "journalctl --user -u jarvis-voice -u jarvis-gateway --since '15 seconds ago' --no-pager -n 60"
  fi
fi

log "Done. Branch: $BRANCH → $REMOTE:$LIVE_PATH"
