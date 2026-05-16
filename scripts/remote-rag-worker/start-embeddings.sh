#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=/dev/null
[ -f "$(dirname "$0")/env.remote-worker.local" ] && set -a && . "$(dirname "$0")/env.remote-worker.local" && set +a
export LOCAL_EMBEDDINGS_HOST="${LOCAL_EMBEDDINGS_HOST:-0.0.0.0}"
export LOCAL_EMBEDDINGS_PORT="${LOCAL_EMBEDDINGS_PORT:-8765}"
export LOCAL_EMBEDDINGS_MODEL="${LOCAL_EMBEDDINGS_MODEL:-sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2}"
exec .venv/bin/python scripts/local_openai_embeddings/server.py
