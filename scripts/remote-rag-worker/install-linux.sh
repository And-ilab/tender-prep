#!/usr/bin/env bash
# Установка на Linux (always-on VPS/сервер). Node 18+ и Python 3.10+ в PATH.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

python3 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install -r scripts/local_openai_embeddings/requirements.txt
.venv/bin/pip install -r scripts/corpus_extract_text/requirements.txt
npm install --omit=dev 2>/dev/null || npm install
mkdir -p /data
echo "OK: $REPO_ROOT"
