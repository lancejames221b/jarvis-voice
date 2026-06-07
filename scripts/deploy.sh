#!/usr/bin/env bash
# Deploy OpenJarvis from dev (gamez) to live (generic).
# Usage: scripts/deploy.sh [generic|dev]
#   generic — full deploy + service restart (default)
#   dev     — dry-run only, no changes
#
# Deploys DIRECTLY over ssh to the live SSD path where systemd runs the
# services (NOT via SSHFS — that mount maps to ~/dev/jarvis-voice which is a
# DIFFERENT directory from the live WorkingDirectory and silently no-ops).

set -euo pipefail

TARGET="${1:-generic}"
SRC="${JARVIS_DEV_PATH:-$HOME/Dev/openjarvis}"
REMOTE="${JARVIS_REMOTE:-generic}"
# Live SSD path = systemd WorkingDirectory for jarvis-voice/jarvis-gateway on generic.
LIVE="${JARVIS_LIVE_PATH:-/media/generic/8f6026e4-4fcd-4f37-8815-807fdcb8a4043/DEV/jarvis-voice}"

log() { echo "[deploy] $*"; }
die() { echo "[deploy] ERROR: $*" >&2; exit 1; }

# Runtime state that lives under src/ but must NEVER be overwritten from dev.
# src/data/ holds box-state.json, memory.md, task-ledger.json — all live state.
SRC_EXCLUDES=(--exclude 'data/' --exclude '__tests__/')

if [[ "$TARGET" == "dev" ]]; then
  log "Dry run (no changes will be made) → $REMOTE:$LIVE"
  rsync -avz --dry-run "${SRC_EXCLUDES[@]}" "$SRC/src/" "$REMOTE:$LIVE/src/"
  rsync -avz --dry-run "$SRC/scripts/"     "$REMOTE:$LIVE/scripts/"
  rsync -avz --dry-run "$SRC/package.json" "$REMOTE:$LIVE/package.json"
  exit 0
fi

[[ "$TARGET" == "generic" ]] || die "Unknown target '$TARGET' — use 'generic' or 'dev'"

# Confirm the live path exists on the remote before touching anything.
ssh "$REMOTE" "[ -d '$LIVE/src' ]" || die "Live path not found on $REMOTE: $LIVE/src"

# Backup current live for rollback (one generation, on the remote box).
BAK="${LIVE}.bak"
log "Backing up current live → $REMOTE:$BAK"
ssh "$REMOTE" "mkdir -p '$BAK' && rsync -a --delete '$LIVE/src/' '$BAK/src/' && rsync -a --delete '$LIVE/scripts/' '$BAK/scripts/' && cp '$LIVE/package.json' '$BAK/package.json' 2>/dev/null || true"

# Sync source over ssh directly to the live SSD path.
# NOTE: NO --delete. Dev is a full mirror of code, but live may hold runtime
# data/state files not tracked in dev; deleting them once crashed startup
# (thread-router.js). Renames/removals must be cleaned up manually if needed.
log "Syncing src/ → $REMOTE:$LIVE/src/ ..."
rsync -avz "${SRC_EXCLUDES[@]}" "$SRC/src/" "$REMOTE:$LIVE/src/"
log "Syncing scripts/ ..."
rsync -avz "$SRC/scripts/" "$REMOTE:$LIVE/scripts/"
log "Syncing package.json ..."
rsync -avz "$SRC/package.json" "$REMOTE:$LIVE/package.json"

# Restart services.
log "Restarting jarvis-gateway and jarvis-voice on $REMOTE ..."
ssh "$REMOTE" "systemctl --user restart jarvis-gateway jarvis-voice"

# Brief pause for startup.
sleep 3

# Verify.
log "Checking service status ..."
ssh "$REMOTE" "systemctl --user is-active jarvis-voice jarvis-gateway" || {
  log "!!! A service is not active — recent logs:"
  ssh "$REMOTE" "journalctl --user -u jarvis-voice -u jarvis-gateway --since '30 seconds ago' --no-pager -n 80"
  die "Deploy completed but a service failed to start. Roll back with the .bak directory on $REMOTE."
}

# Tail logs.
log "--- recent logs ---"
ssh "$REMOTE" "journalctl --user -u jarvis-voice -u jarvis-gateway --since '15 seconds ago' --no-pager -n 60"
log "Deploy complete."
