# Лена на сервере (24/7)

Перенос **Telegram-бота «Лена»** с ноутбука на постоянно включённую машину: VPS Linux, домашний сервер или **Windows Server**.

После переноса **ноутбук больше не должен** запускать `lena-bot.mjs` с тем же `TELEGRAM_BOT_TOKEN` — иначе Telegram вернёт `Conflict` и бот будет «молчать».

---

## Windows Server (пошагово)

### 0. Что установить на сервере

| Компонент | Откуда |
|-----------|--------|
| **Node.js 20 LTS** | https://nodejs.org — галочка «Add to PATH» |
| **Git** | https://git-scm.com (или скопируйте папку репо с ноута) |
| **Python 3.10+** | https://python.org — «Add python.exe to PATH» |
| **Tesseract OCR** | [UB Mannheim](https://github.com/UB-Mannheim/tesseract/wiki) — язык **Russian** |
| **NSSM** (служба) | готовый `nssm.exe` — см. [`download-nssm.ps1`](download-nssm.ps1) или [dkxce/NSSM win64](https://github.com/dkxce/NSSM/blob/main/bin/v2.25/win64/nssm.exe) |

RDP на сервер, PowerShell **от администратора**.

### 1. Репозиторий

```powershell
mkdir C:\tender-prep -Force
cd C:\tender-prep
git clone <URL-вашего-репозитория> .
# или: скопируйте папку tender-prep с ноута по сети / RDP
```

### 2. Секреты с ноутбука

Создайте `C:\secrets\tender-prep\` и перенесите (не в Git):

| Файл на ноуте | Куда на сервер |
|---------------|----------------|
| `.env` из корня репо | `C:\tender-prep\.env` |
| JSON Google Drive | `C:\secrets\tender-prep\drive-service-account.json` |
| OAuth-токен (если был) | `C:\secrets\tender-prep\…` |
| `icetrade-storage.json` | `C:\secrets\tender-prep\icetrade-storage.json` |
| RAG-индекс (если был) | `C:\data\rag-index-2025-drive\` |

В `.env` **замените все пути** с `C:\Users\…\LAPTOP…` на пути сервера. Шаблон: [`env.lena-server.windows.example`](env.lena-server.windows.example).

Пример ключевых строк:

```bat
GOOGLE_DRIVE_CREDENTIALS=C:\secrets\tender-prep\drive-service-account.json
LENA_ICETRADE_PLAYWRIGHT_STORAGE=C:\secrets\tender-prep\icetrade-storage.json
LENA_ICETRADE_PLAYWRIGHT_DOWNLOADS_DIR=C:\data\playwright-downloads
LENA_PYTHON=C:\tender-prep\.venv\Scripts\python.exe
```

### 3. Установка зависимостей

```powershell
cd C:\tender-prep
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\lena-server\install-windows.ps1
```

Playwright скачает Chromium (~150 МБ) — нужен для IceTrade.

### 3b. Утилиты stop/restart (если нет `lena-bot-stop.ps1` на сервере)

Один раз из PowerShell (создаёт `lena-bot-stop.ps1`, `restart-lena-service.bat`, `stop-lena-service.bat`):

```powershell
cd C:\tender-prep
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\lena-server\create-lena-bot-tools.ps1
```

Перезапуск службы сразу:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\lena-server\create-lena-bot-tools.ps1 -RestartService
```

Или: `cmd /c C:\tender-prep\scripts\lena-server\restart-lena-service.bat`

### 4. Пробный запуск

```powershell
.\scripts\lena-server\start-lena-bot.ps1
```

В Telegram отправьте **`/help`**. В консоли должно быть `Лена-бот: @…`. Остановка: **Ctrl+C**.

### 5. Служба Windows (автозапуск)

**Рекомендуется NSSM** (работает без входа пользователя в систему):

```powershell
cd C:\tender-prep\scripts\lena-server
.\install-service-nssm.ps1
```

Логи: `C:\tender-prep\logs\lena-bot.log` и `lena-bot.err.log`.

```powershell
Get-Service tender-prep-lena
Get-Content C:\tender-prep\logs\lena-bot.err.log -Tail 40
Restart-Service tender-prep-lena   # если имя службы другое — см. install-service-nssm.ps1
```

**Без NSSM** — Планировщик заданий:

```powershell
.\install-scheduled-task.ps1
```

### 6. Остановить бота на ноутбуке

На ноуте:

```bat
lena-bot.bat stop
```

Или закройте окно с `node … lena-bot.mjs`. Два процесса с одним токеном = `Conflict`.

### 7. RAG / embeddings на том же Windows Server

В отдельном окне или второй службе NSSM:

```powershell
cd C:\tender-prep\scripts\remote-rag-worker
.\start-embeddings.ps1 -ListenAll -ApiKey "длинный-секрет"
```

В `.env` бота:

```bat
LENA_RAG_INDEX_DIR=C:\data\rag-index-2025-drive
LENA_EMBEDDING_BASE_URL=http://127.0.0.1:8765/v1
LENA_EMBEDDING_API_KEY=длинный-секрет
```

Подробнее: [../remote-rag-worker/README.md](../remote-rag-worker/README.md).

### 8. Обновление кода на сервере

```powershell
cd C:\tender-prep
git pull
npm install
.\scripts\lena-server\install-windows.ps1
Restart-Service tender-prep-lena
```

Или одной командой (то же, что делает CI после push в **main**):

```powershell
.\scripts\lena-server\deploy-from-main.ps1
```

Лог: `logs\deploy.log`.

---

## Автодеплой (GitHub Actions)

После каждого **push в `main`** репозиторий может сам обновить сервер: `git fetch` → `main` = `origin/main` → `npm install` → перезапуск службы **tender-prep-lena**.

Workflow: [`.github/workflows/deploy-lena-server.yml`](../../.github/workflows/deploy-lena-server.yml).

**Пошаговая инструкция (Windows Server):** [DEPLOY_SETUP_WINDOWS.md](DEPLOY_SETUP_WINDOWS.md).

### 1. Подготовка сервера (один раз)

**Windows Server**

1. **OpenSSH Server** — «Параметры → Приложения → Дополнительные компоненты → OpenSSH Server» или `Add-WindowsCapability OpenSSH.Server~~~~0.0.1.0`.
2. Пользователь для деплоя (например `deploy`) с правом **перезапуска службы** `tender-prep-lena` (администратор или делегированное право).
3. В `C:\Users\deploy\.ssh\authorized_keys` — **публичный** ключ, пара к которому ляжет в GitHub Secrets.
4. Репозиторий уже клонирован в `C:\tender-prep`, ветка **main**, `git remote` указывает на GitHub. Для **приватного** repo на сервере: [deploy key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys) или `git config credential.helper` — иначе `git fetch` из CI упадёт.

Проверка вручную по SSH с ноута:

```powershell
ssh deploy@ВАШ_СЕРВЕР "powershell -NoProfile -ExecutionPolicy Bypass -File C:/tender-prep/scripts/lena-server/deploy-from-main.ps1 -NoRestart"
```

**Linux** — аналогично: SSH, clone, `./scripts/lena-server/deploy-from-main.sh`, unit `tender-prep-lena-bot`.

### 2. Секреты в GitHub

Репозиторий → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Пример | Назначение |
|--------|--------|------------|
| `LENA_DEPLOY_HOST` | `203.0.113.10` или `lena.example.com` | IP/hostname сервера |
| `LENA_DEPLOY_USER` | `deploy` | SSH-пользователь |
| `LENA_DEPLOY_SSH_KEY` | содержимое **приватного** ключа PEM | вход по SSH |
| `LENA_DEPLOY_PATH` | `C:/tender-prep` | корень репозитория на сервере (слэши `/` даже на Windows) |
| `LENA_DEPLOY_PORT` | `22` | опционально, если SSH не на 22 |

**Variables** (Settings → Actions → Variables):

| Variable | Значение |
|----------|----------|
| `LENA_DEPLOY_OS` | `windows` (по умолчанию, если не задано) или `linux` |

### 3. Поведение

1. Push в **main** → workflow **Deploy Lena server**.
2. SSH на сервер → `deploy-from-main.ps1` / `deploy-from-main.sh`.
3. Сервер: `git fetch origin main`, `git reset --hard origin/main` (локальные правки в репо **затираются** — секреты только в `.env` вне Git).
4. `npm install`, `install-windows.ps1` (Playwright при деплое пропускается для скорости; полная установка — `install-windows.ps1` без `-SkipPlaywright`).
5. `Restart-Service tender-prep-lena` (Windows) или `systemctl restart tender-prep-lena-bot` (Linux).

Ручной запуск: **Actions → Deploy Lena server → Run workflow**.

**Важно:** пока секреты не заданы, job упадёт на SSH — это нормально; локальный деплой через `deploy-from-main.ps1` работает без CI.

---

## Что переезжает на сервер

| Компонент | На сервере | Комментарий |
|-----------|------------|-------------|
| `lena-bot.mjs` | обязательно | long polling, webhook при старте снимается автоматически |
| Google Drive (SA или OAuth) | обязательно | JSON-ключ и/или OAuth-токен только на сервере |
| LLM API | обязательно | `OPENAI_API_KEY` / `LENA_OPENAI_*` |
| Playwright + Chromium | рекомендуется | IceTrade: скачивание вложений с карточки |
| Python + Tesseract | рекомендуется | OCR PDF (`requirements-ocr.txt`, `scripts/lena_pdf_ocr.py`) |
| RAG-индекс + embeddings | опционально | на том же сервере удобнее, чем `127.0.0.1` на ноуте |

RAG отдельно описан в [../remote-rag-worker/README.md](../remote-rag-worker/README.md); ниже — **полный стек** (бот + при желании embeddings на одной машине).

## Быстрый чеклист миграции

1. **Подготовить сервер:** Node.js **20+**, Git, Python **3.10+**; на Linux — пакет Tesseract с русским языком.
2. **Склонировать репозиторий**, например `/opt/tender-prep` или `C:\tender-prep`.
3. **С ноутбука скопировать секреты** (не в Git):
   - `.env` (или собрать из `examples/env.telegram.example` + `env.lena-server.example`);
   - JSON сервисного аккаунта Google (`GOOGLE_DRIVE_CREDENTIALS`);
   - при OAuth — `GOOGLE_DRIVE_OAUTH_CLIENT` и `GOOGLE_DRIVE_OAUTH_TOKEN`;
   - при IceTrade — `icetrade-storage.json` (`LENA_ICETRADE_PLAYWRIGHT_STORAGE`);
   - при RAG — каталог индекса (`LENA_RAG_INDEX_DIR`, например `/data/rag-index-2025-drive`).
4. **Установить зависимости** (см. раздел «Установка»).
5. **Проверить вручную** один запуск бота, отправить `/help` в группу.
6. **Включить systemd / службу** (Linux) или NSSM / Планировщик (Windows).
7. **Остановить бота на ноутбуке** (`lena-bot.bat stop` или закрыть окно с `node … lena-bot.mjs`).

## Установка

### Linux (VPS, Ubuntu/Debian)

```bash
sudo apt update
sudo apt install -y git nodejs npm python3 python3-venv python3-pip \
  tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng

cd /opt
sudo git clone <URL-репозитория> tender-prep
sudo chown -R "$USER:$USER" /opt/tender-prep
cd /opt/tender-prep

chmod +x scripts/lena-server/*.sh
./scripts/lena-server/install-linux.sh
```

Скопируйте `.env` в корень репозитория и поправьте пути (Linux вместо `C:\…`):

```bash
cp scripts/lena-server/env.lena-server.example .env
# отредактируйте .env
nano .env
```

Пробный запуск:

```bash
./scripts/lena-server/start-lena-bot.sh
```

### Windows Server

См. **раздел «Windows Server (пошагово)»** в начале этого файла.

Кратко:

```powershell
cd C:\tender-prep
.\scripts\lena-server\install-windows.ps1
Copy-Item scripts\lena-server\env.lena-server.windows.example .env
# отредактируйте .env, секреты в C:\secrets\tender-prep\
.\scripts\lena-server\start-lena-bot.ps1
.\scripts\lena-server\install-service-nssm.ps1   # от администратора
```

Tesseract: [UB Mannheim](https://github.com/UB-Mannheim/tesseract/wiki), язык `rus`.

## Переменные окружения на сервере

Шаблон: [`env.lena-server.example`](env.lena-server.example). Минимум:

| Переменная | Назначение |
|------------|------------|
| `TELEGRAM_BOT_TOKEN` | токен @BotFather |
| `LENA_DRIVE_ROOT` | корневая папка на Google Drive |
| `GOOGLE_DRIVE_CREDENTIALS` | путь к JSON SA **или** OAuth-пара |
| `OPENAI_API_KEY` / `LENA_OPENAI_API_KEY` | LLM для `/ask`, КП и т.д. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | рекомендуется в проде: whitelist чатов |

**Пути на Linux** — абсолютные, например `/etc/tender-prep/secrets/drive-sa.json`, а не пути с ноутбука.

**IceTrade на headless Linux:**

```bash
LENA_ICETRADE_PLAYWRIGHT=1
LENA_ICETRADE_PLAYWRIGHT_STORAGE=/etc/tender-prep/secrets/icetrade-storage.json
LENA_ICETRADE_PLAYWRIGHT_DOWNLOADS_DIR=/data/playwright-downloads
```

Один раз с **рабочей машины** (с браузером) сохраните сессию:

```bash
npm run icetrade:playwright-auth -- /path/to/icetrade-storage.json
```

Файл перенесите на сервер. Периодически обновляйте, если площадка «выкидывает» сессию.

**RAG на том же сервере** (embeddings локально):

```bash
# в .env бота:
LENA_RAG_INDEX_DIR=/data/rag-index-2025-drive
LENA_EMBEDDING_BASE_URL=http://127.0.0.1:8765/v1
LENA_EMBEDDING_API_KEY=<длинный-секрет>
LENA_EMBEDDING_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
```

Сервис embeddings — см. [../remote-rag-worker/tender-prep-embeddings.service.example](../remote-rag-worker/tender-prep-embeddings.service.example).

## Автозапуск (Linux, systemd)

```bash
sudo useradd -r -m -d /opt/tender-prep -s /usr/sbin/nologin tender 2>/dev/null || true
sudo cp scripts/lena-server/tender-prep-lena-bot.service.example /etc/systemd/system/tender-prep-lena-bot.service
# поправьте User, WorkingDirectory, EnvironmentFile в unit-файле
sudo systemctl daemon-reload
sudo systemctl enable --now tender-prep-lena-bot
sudo systemctl status tender-prep-lena-bot
journalctl -u tender-prep-lena-bot -f
```

Если нужны и embeddings, и бот — два unit-файла; embeddings должен стартовать **раньше** (`After=tender-prep-embeddings.service` в unit бота).

## Автозапуск (Windows Server)

| Способ | Скрипт | Когда использовать |
|--------|--------|-------------------|
| **NSSM** (рекомендуется) | `install-service-nssm.ps1` | Сервер без постоянного входа пользователя |
| Планировщик заданий | `install-scheduled-task.ps1` | Если NSSM ставить не хотите |

Не запускайте одновременно `lena-bot.bat` на ноуте и службу на сервере.

## Обновление кода на сервере

**Автоматически:** push в **main** + секреты GitHub Actions — см. раздел **«Автодеплой (GitHub Actions)»** выше.

**Linux:**

```bash
cd /opt/tender-prep
git pull
npm install
./scripts/lena-server/install-linux.sh
sudo systemctl restart tender-prep-lena-bot
```

**Windows Server:**

```powershell
cd C:\tender-prep
git pull
npm install
.\scripts\lena-server\install-windows.ps1
Restart-Service tender-prep-lena
```

## Диагностика

| Симптом | Что проверить |
|---------|----------------|
| `Conflict` в логе | второй процесс с тем же токеном (ноут + сервер) |
| бот не отвечает | `TELEGRAM_ALLOWED_CHAT_IDS`, privacy mode в BotFather |
| IceTrade без файлов | На **локальной машине** Playwright в `%LOCALAPPDATA%`; **служба Windows (SYSTEM)** его не видит → **`.\scripts\lena-server\fix-playwright-server.ps1`**, перезапуск службы. Без Playwright: **PowerShell WebSession** (карточка → getFile). Опционально: `LENA_ICETRADE_COOKIE`, `LENA_ICETRADE_PLAYWRIGHT_STORAGE`. |
| `/archivesearch` недоступен | `LENA_RAG_INDEX_DIR`, работает ли embeddings на `:8765` |
| OCR не работает | `tesseract --version`, `pip install -r requirements-ocr.txt` |

Подробнее по командам бота: [docs/TELEGRAM.md](../../docs/TELEGRAM.md), правила — [docs/LENA_RULES.md](../../docs/LENA_RULES.md).

## Безопасность

- Секреты только на сервере, права на JSON `chmod 600`.
- Не открывайте порт embeddings (`8765`) в интернет без VPN и сильного API-ключа.
- Регулярно обновляйте ОС и зависимости; при утечке токена — `/revoke` в BotFather.
