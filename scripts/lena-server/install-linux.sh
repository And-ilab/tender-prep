#!/usr/bin/env bash
# Установка зависимостей Лены на Linux-сервере (Node + Python venv + опционально Playwright).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Нужен Node 20+ (https://nodejs.org или пакет дистрибутива)."
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  echo "Предупреждение: Node ${NODE_MAJOR} — в package.json указано engines >=20."
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 не найден. Установите Python 3.10+."
  exit 1
fi

echo "Repo: $REPO_ROOT"

python3 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install -r scripts/local_openai_embeddings/requirements.txt
.venv/bin/pip install -r scripts/corpus_extract_text/requirements.txt
.venv/bin/pip install -r requirements-ocr.txt

echo "npm install…"
npm install --omit=dev 2>/dev/null || npm install

if [[ "${INSTALL_PLAYWRIGHT:-1}" == "1" ]]; then
  echo "Playwright Chromium (IceTrade)…"
  if npx playwright install chromium --with-deps 2>/dev/null; then
    :
  else
    npx playwright install chromium
  fi
fi

mkdir -p /data/playwright-downloads /data/rag-index
echo "OK. Дальше: скопируйте .env и секреты, затем ./scripts/lena-server/start-lena-bot.sh"
