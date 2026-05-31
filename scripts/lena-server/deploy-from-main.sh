#!/usr/bin/env bash
# Синхронизация сервера с origin/main и перезапуск systemd-службы Лены.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BRANCH="${1:-main}"
SKIP_PLAYWRIGHT="${SKIP_PLAYWRIGHT:-1}"
NO_RESTART="${NO_RESTART:-0}"
SERVICE_NAME="${LENA_SYSTEMD_SERVICE:-tender-prep-lena-bot}"
LOG="$REPO_ROOT/logs/deploy.log"

mkdir -p "$REPO_ROOT/logs"
log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"
}

cd "$REPO_ROOT"
log "=== deploy-from-main start (branch=$BRANCH) ==="

if [[ ! -d .git ]]; then
  echo "Not a git repo: $REPO_ROOT" >&2
  exit 1
fi

log "git fetch origin $BRANCH"
git fetch origin "$BRANCH"

REMOTE_SHA="$(git rev-parse "origin/$BRANCH")"
LOCAL_SHA="$(git rev-parse HEAD)"
log "local=$LOCAL_SHA remote=$REMOTE_SHA"

if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  log "git checkout -B $BRANCH origin/$BRANCH"
  git checkout -B "$BRANCH" "origin/$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  log "Already on $REMOTE_SHA — continuing (npm/service refresh)"
fi

log "npm install"
npm install --omit=dev 2>/dev/null || npm install

if [[ "$SKIP_PLAYWRIGHT" == "1" ]]; then
  export INSTALL_PLAYWRIGHT=0
fi
log "install-linux.sh"
./scripts/lena-server/install-linux.sh

if [[ "$NO_RESTART" == "0" ]]; then
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    log "systemctl restart $SERVICE_NAME"
    sudo systemctl restart "$SERVICE_NAME"
  else
    log "WARN: service $SERVICE_NAME not active — skip restart"
  fi
else
  log "Skip service restart (NO_RESTART=1)"
fi

log "=== deploy-from-main OK ==="
