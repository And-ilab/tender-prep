# RAG на постоянно включённой машине

Перенос **тяжёлой части** (сервер эмбеддингов + при желании весь `rag index`) с ноутбука на сервер, который не перезагрувают.

## Два режима

| Режим | На сервере | На ноутбуке |
|--------|------------|-------------|
| **A. Только эмбеддинги** | `server.py` (порт 8765) | `rag index` / `query` с `LENA_EMBEDDING_BASE_URL=http://IP_СЕРВЕРА:8765/v1` |
| **B. Всё на сервере** | репозиторий, `C:\data`, embeddings + `rag index` | только RDP/SSH, копирование при обновлении |

Рекомендация: **B** — ноутбук не держит часы индексации и не зависит от перезагрузок.

## 1. Подготовка удалённой Windows-машины

1. Установите **Node.js LTS** и **Python 3.10+** (или только Python — скрипт создаст `.venv`).
2. Склонируйте репозиторий, например `C:\tender-prep`.
3. Установка зависимостей:

```powershell
cd C:\tender-prep\scripts\remote-rag-worker
.\install-windows.ps1
Copy-Item env.remote-worker.example env.remote-worker.local
# отредактируйте env.remote-worker.local: LOCAL_EMBEDDINGS_API_KEY, пути
```

4. **Данные** с ноутбука (уже есть `corpus-2025-drive-txt`):

```powershell
# на ноутбуке (подставьте IP/имя сервера и учётку с доступом к C$):
.\copy-data-from-laptop.ps1 -RemoteHost 192.168.1.50 -RemoteUser ВАШ_ЛОГИН
```

Или вручную: `robocopy C:\data\corpus-2025-drive-txt \\SERVER\C$\data\corpus-2025-drive-txt /E`

5. **Сервер эмбеддингов** (отдельное окно или Планировщик заданий при входе):

```powershell
.\start-embeddings.ps1 -ListenAll -ApiKey "длинный-секрет"
```

В брандмауэре Windows откройте **TCP 8765** только для вашей сети/VPN.

6. **Индекс** (один раз, долго):

```powershell
.\run-rag-index.ps1
```

Готово: `C:\data\rag-index-2025-drive\manifest.json`.

### Автозапуск embeddings (Windows)

- **Планировщик заданий**: триггер «При входе в систему», действие — `powershell.exe -File C:\tender-prep\scripts\remote-rag-worker\start-embeddings.ps1`, рабочая папка `C:\tender-prep\scripts\remote-rag-worker`.
- Или [NSSM](https://nssm.cc/) как служба Windows.

## 2. Ноутбук после переноса

Только запросы к уже готовому индексу **по сети** (если шарите `C:\data\rag-index-2025-drive`) или копируете индекс обратно.

Эмбеддинги с ноутбука **без** локального `server.py`:

```cmd
set LENA_EMBEDDING_BASE_URL=http://192.168.1.50:8765/v1
set LENA_EMBEDDING_API_KEY=тот-же-секрет-что-на-сервере
set LENA_EMBEDDING_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
node src/cli.js rag query \\SERVER\share\rag-index-2025-drive "вопрос" 5
```

Либо RDP на сервер и `rag query` локально на `C:\data\rag-index-2025-drive`.

## 3. Linux-сервер

```bash
cd /opt/tender-prep/scripts/remote-rag-worker
chmod +x install-linux.sh start-embeddings.sh
./install-linux.sh
cp env.remote-worker.example env.remote-worker.local
# LOCAL_EMBEDDINGS_HOST=0.0.0.0 + API key
./start-embeddings.sh
# systemd: tender-prep-embeddings.service.example
```

## 4. Обновление архива 2025 с Drive (на сервере)

```cmd
set GOOGLE_DRIVE_CREDENTIALS=C:\secrets\service-account.json
set NODE_TLS_REJECT_UNAUTHORIZED=0
node src/cli.js drive corpus-pull "https://drive.google.com/drive/folders/1VGgxftxNdwdF1vDvz45vSy4EzpWwqnK_" "C:\data\corpus-2025-drive-pull" 40 200000
.venv\Scripts\python.exe scripts\corpus_extract_text\corpus_extract_text.py -i C:\data\corpus-2025-drive-pull -o C:\data\corpus-2025-drive-txt --lenient-exit
.\run-rag-index.ps1
```

## 5. Безопасность

- При `-ListenAll` / `0.0.0.0` обязательно **`LOCAL_EMBEDDINGS_API_KEY`** и тот же **`LENA_EMBEDDING_API_KEY`** у клиентов.
- Не выставляйте 8765 в интернет без VPN.
- JSON ключ Google — только на сервере, не в git.

## Папка 2025 на Drive

`1VGgxftxNdwdF1vDvz45vSy4EzpWwqnK_` — корень архива «2025».
