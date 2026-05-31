# Тестовая группа в Telegram

Удобный способ **вручную** проверить сценарий «Лена + Диск»: ссылки на папки, вывод `agent-bundle`, скриншоты, обсуждение. Опционально — **бот** для автоматических смоук-тестов (ответ в группе).

## 1. Группа и люди

1. Создайте группу в Telegram (например «Lena tender-prep test»).
2. Добавьте участников, которым нужен доступ к тесту.
3. Закрепите в описании или закреплённом сообщении: **id корневой папки Google Drive**, правила именования `tender_id`, кто кладёт файлы в `_lena/context` и `_lena/templates`, и при параллельных закупках в одном чате — **правило «Ответить»** на якорное сообщение по тендеру (см. раздел 4 в этом файле).

## 2. Бот (опционально, для API)

1. В Telegram откройте [@BotFather](https://t.me/BotFather) → `/newbot` → сохраните **токен**.
2. Добавьте бота в группу (через «Добавить участников»).
3. В группе выдайте боту право **писать** (в настройках группы → администраторы → можно только «отправка сообщений», без лишних прав).
4. Чтобы бот **видел обычные сообщения** в группе (не только команды), в BotFather: `/setprivacy` → выберите бота → **Disable** (для тестовой группы это нормально; в проде обычно включают privacy и используют только `/command` или ответы на сообщения бота).

Токен **никогда** не кладите в Git. Используйте переменную окружения `TELEGRAM_BOT_TOKEN` (см. `examples/env.telegram.example`).

## 3. Смоук-тест бота из репозитория

После `TELEGRAM_BOT_TOKEN=...` (и при необходимости настроенном `GOOGLE_DRIVE_CREDENTIALS` для других команд):

```bash
node src/telegram/smoke-poll.mjs
```

Бот в режиме long polling: на любое текстовое сообщение в **группе** отвечает коротким эхо + подсказкой. Остановка: `Ctrl+C`.

Это проверяет только связку **Telegram Bot API ↔ ваш процесс**, без Google.

**Зависимости Node:** один раз из корня репозитория выполните `npm install`. Пакеты **`mammoth`**, **`pdf-parse`**, **`word-extractor`** нужны для **`/tenderextract`** и сценариев с парсингом PDF/DOC/DOCX; для **OCR сканов** (после `pdf-parse`) — **`tesseract.js`**, **`pdfjs-dist`**, **`@napi-rs/canvas`**. Они **подгружаются при работе** extract, так что бот и IceTrade bootstrap стартуют и без установленного `node_modules` (но тогда extract вернёт ошибку до успешного `npm install`). Если установка срывается с **`UNABLE_TO_VERIFY_LEAF_SIGNATURE`** (в т.ч. при скачивании `@napi-rs/canvas`), задайте в той же консоли **`NODE_OPTIONS=--use-openssl-ca`** и повторите `npm install`; на новых версиях Node попробуйте **`NODE_OPTIONS=--use-system-ca`**. При необходимости задайте **`NODE_EXTRA_CA_CERTS`** на путь к `.pem` корпоративного CA, либо подключите корневой сертификат в системе/Node.

## 4. Бот «Лена» (Drive из чата)

Скрипт `src/telegram/lena-bot.mjs` отвечает в группе на команды и читает ту же структуру `_lena/`, что и CLI (`workspace.js`).

**Переменные окружения** (см. `examples/env.telegram.example`):

| Переменная | Назначение |
|------------|------------|
| `TELEGRAM_BOT_TOKEN` | обязательно |
| `LENA_DRIVE_ROOT` | id или URL корневой папки Drive (как для `drive workspace-ensure`) |
| `GOOGLE_DRIVE_CREDENTIALS` | путь к JSON **сервисного аккаунта** с доступом к папке (**или** см. OAuth ниже) |
| `GOOGLE_DRIVE_OAUTH_CLIENT` | для **личного** Gmail: путь к JSON OAuth-клиента (Desktop) из Google Cloud |
| `GOOGLE_DRIVE_OAUTH_TOKEN` | для **личного** Gmail: путь к JSON с `refresh_token` после `node src/cli.js drive oauth-login` (см. [GOOGLE_DRIVE_OAUTH.md](GOOGLE_DRIVE_OAUTH.md)) |
| `TELEGRAM_ALLOWED_CHAT_IDS` | опционально: список `chat_id` через запятую; **если не задано** — бот отвечает во всех чатах; **если задано** — все остальные чаты игнорируются без ответа (обновляйте список при смене чата); при старте бот пишет в консоль активный whitelist |
| `LENA_DEFAULT_TENDER_YEAR` | опционально: год для `/bundle` (иначе текущий календарный) |
| `LENA_EXTRA_CONTEXT_FOLDERS` | опционально: URL или id папок на Drive (через запятую) — подмешиваются в `/context` и в бандл; каждая папка расшарена на тот же SA |
| `OPENAI_API_KEY` или `LENA_OPENAI_API_KEY` | опционально: для `/ask`, `/tenderask` и **`/archiveask`** (Chat Completions) |
| `LENA_OPENAI_BASE_URL` | опционально: API совместимый с OpenAI (по умолчанию `https://api.openai.com/v1`) |
| `LENA_OPENAI_MODEL` | опционально (по умолчанию `gpt-4o-mini`) |
| `LENA_LLM_SYSTEM_PROMPT` | опционально: свой системный промпт вместо встроенного (содержательно см. [LENA_RULES.md](LENA_RULES.md), раздел «Краткий системный блок») |
| `LENA_RAG_INDEX_DIR` | путь к папке индекса (`manifest.json` + `chunks.jsonl`) — для **`/archivesearch`** и **`/archiveask`** |
| `LENA_EMBEDDING_BASE_URL` | как у `rag query`: **`POST …/embeddings`** (локально `http://127.0.0.1:8765/v1`) |
| `LENA_EMBEDDING_API_KEY` | непустой Bearer; для локального CPU-сервера — например `sk-local` |
| `LENA_EMBEDDING_MODEL` | та же модель, что при **`rag index`** (например `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`) |
| `LENA_RAG_TOP_K` | опционально: число фрагментов по умолчанию (иначе 8), макс. 24 |
| `LENA_ICETRADE_BOOT_MAX_FILES` | опционально: макс. число файлов за один bootstrap IceTrade→inputs (по умолчанию 30) |
| `LENA_ICETRADE_FETCH_TIMEOUT_MS` | опционально: таймаут HTTP к карточке IceTrade и скачивания файла в мс (по умолчанию 25000) |
| `LENA_ICETRADE_PLAYWRIGHT` | `1` / `true` — карточка IceTrade в Chromium (нужны `playwright` + `npx playwright install chromium`) |
| `LENA_ICETRADE_PLAYWRIGHT_STORAGE` | путь к **существующему** JSON после `npm run icetrade:playwright-auth` (куки Chromium с карточки); неверный путь = предупреждение |
| `LENA_ICETRADE_COOKIE` | опционально: заголовок Cookie из DevTools — если `getFile` отдаёт HTML автоматике, хотя в браузере тот же файл открывается |
| `LENA_ICETRADE_PLAYWRIGHT_DOWNLOAD_PRIME_MS` | пауза мс после открытия карточки в том же Chromium, что качает вложения (по умолчанию 2000; при сбоях попробуйте 3500–4000) |
| `LENA_ICETRADE_PLAYWRIGHT_FILE_DOWNLOAD` | `0` — не качать вложения через Playwright (только Node HTTP) |
| `LENA_ICETRADE_PLAYWRIGHT_DOWNLOADS_DIR` | необязательно: корень для загрузок Chromium (по умолчанию `<cwd>/playwright-downloads`). **Не задавайте системный `%TEMP%`** — ежедневная очистка этого каталога удалит временные папки импорта (**lena-ice-***) и даст ENOENT при bootstrap. |
| `LENA_TELEGRAM_ICETRADE_IMPORT_ONLY` | по умолчанию **вкл.**: после ссылки IceTrade только импорт в **inputs**; **полный** конвейер в Telegram: `0` / `false` / `off` |

Для вложений с площадки обычно нужны **Playwright** и рабочая **сессия** (`STORAGE` или `COOKIE`). Подробнее см. `examples/env.telegram.example` (блок IceTrade). `/help`, `/product` (IceTrade, Drive, политика корпуса RAG — см. [PRODUCT_CONTEXT.md](PRODUCT_CONTEXT.md)), `/templates`, `/library`, `/orgdocs`, `/foundingdocs`, `/context`, `/bundle <tender_id> [ГГГГ|flat]`, `/ingest <tender_id> [ГГГГ|flat] <папка_Drive>`, `/ask …`, **`/archivesearch …`** (алиас `/searcharchive`), **`/archiveask …`** (алиас `/askarchive`), `/tenderask …`, `/newchat`.

Дополнительно в **группе** или в **личке**: бот обрабатывает входящий текст (кроме сообщений с `@` другого участника в начале); **ссылка IceTrade** запускает **bootstrap**: папка тендера на Drive, **`inputs/icetrade-import-snapshot.json`**, вложения в **`inputs`**, заметка в **`notes`**. По умолчанию (**`LENA_TELEGRAM_ICETRADE_IMPORT_ONLY`**) после импорта **не** запускаются анализ комплекта, парсинг **inputs** и LLM-карточка — только сообщение об успехе со ссылкой на **inputs**. Полный конвейер в Telegram: задайте `LENA_TELEGRAM_ICETRADE_IMPORT_ONLY=0` и при необходимости `LENA_ICETRADE_ANALYZE`, `LENA_TELEGRAM_EXTRACT_AFTER_BOOTSTRAP`, `LENA_TELEGRAM_CARD_AFTER_BOOTSTRAP`.

Тот же **IceTrade bootstrap** без Telegram:

```bash
node src/cli.js tenders icetrade-bootstrap <LENA_DRIVE_ROOT_или_id> "https://icetrade.by/tenders/all/view/1336510"
```

**Архив (RAG):** команды ищут по **локальному** индексу на машине, где запущен бот (на сервере — каталог вроде `/data/rag-index-…`, см. [lena-server](../scripts/lena-server/README.md)). Держите **сервер эмбеддингов** (`scripts/local_openai_embeddings/server.py`) на **той же** машине, если `LENA_EMBEDDING_BASE_URL=http://127.0.0.1:8765/v1`.

**Нейросеть:** `/ask` — диалог с краткой памятью в рамках чата (до нескольких последних реплик). `/tenderask` — в модель передаётся усечённый JSON того же вида, что и у `/bundle`, плюс ваш вопрос (удобно спрашивать про структуру папок и ссылки). Ключ API не коммитьте; при утечке перевыпустите в кабинете провайдера.

### Несколько тендеров в одной группе

В одном чате часто идут **несколько закупок**. Чтобы Лена не смешивала контекст:

1. Пользователь пишет в **ветке** нужного тендера: через **«Ответить»** на сообщение, с которым договорились работать для этой закупки (например на файл/ответ бота после `/bundle <tender_id>`, на реплику с вопросом по этому же тендеру, на закреп с `tender_id`).
2. Бот **видит все** сообщения в группе и **отвечает**, кроме тех, что **начинаются** с `@` **другого** участника (не бота) — такие **молча игнорируются** (переписка «в сторону» коллеги). Привязка к тендеру: прежде всего **«Ответить»** на ветку по закупке; также распознаются номер/IceTrade в тексте и `/tenderask` (§6a в [LENA_RULES.md](LENA_RULES.md)).
3. Лена **не додумывает** закупку без контекста и отвечает **кратко** — см. [LENA_RULES.md](LENA_RULES.md), раздел «Telegram: один чат, несколько тендеров».
4. Надёжный вариант без привязки к ветке: **`/tenderask <tender_id> …`** — `tender_id` в команде задаёт закупку явно.
5. Если в чате **указание без привязки** к тендеру и неясно, о какой закупке речь — бот и модель **не угадывают**: одна короткая фраза — повторить через **«Ответить»** на сообщение по закупке (см. [LENA_RULES.md](LENA_RULES.md) §6a).

**Опционально (бот):** задайте `LENA_TELEGRAM_GROUP_ASK_REQUIRE_REPLY=1` (см. таблицу переменных выше) — в группах и супергруппах команда **`/ask`** без поля «ответ на сообщение» **не вызывает** LLM: бот отвечает той же короткой подсказкой про **«Ответить»**. В **личке** с ботом ограничение не действует. Для `/tenderask` / `/bundle` / `/ingest` проверка не включена (там уже есть `tender_id` в тексте команды, кроме случаев, когда команда ошибочна — тогда сработает обычная справка по использованию).

### Лог переписки с менеджерами на Drive

Согласования и уточнения с менеджерами по **конкретному** тендеру (цена, НДС, условия, **подтверждение гипотез** по противоречивым требованиям заказчика к документам) нужно **дублировать в контекстном логе тендера** на Google Drive: один файл **`notes/telegram-managers-log.md`** внутри папки этого тендера (`notesFolderId` в `agent-bundle`). Правила для Лены — [LENA_RULES.md](LENA_RULES.md) §6e и §6f. Пока менеджер не закрыл запросы по файлам (справка банка и т.д.), Лена по **§6g** не обязана разгонять длинную генерацию пакета под эти вложения — сначала матрица и статусы.

**Запуск** (из корня репозитория):

```bash
npm run lena:telegram
```

или `node src/telegram/lena-bot.mjs`. Остановка: `Ctrl+C`.

**Windows:** в **cmd.exe** (`C:\...>`) нельзя использовать синтаксис PowerShell `$env:ИМЯ=...`. Комментарии в cmd — `rem`, не `#`. Задайте переменные так (без пробелов вокруг `=`, подставьте свои значения):

```bat
set TELEGRAM_BOT_TOKEN=...
set LENA_DRIVE_ROOT=https://drive.google.com/drive/folders/...
set GOOGLE_DRIVE_CREDENTIALS=C:\Users\...\key.json
set OPENAI_API_KEY=sk-...
set LENA_RAG_INDEX_DIR=C:\data\rag-index-2025-drive
set LENA_EMBEDDING_BASE_URL=http://127.0.0.1:8765/v1
set LENA_EMBEDDING_API_KEY=sk-local
set LENA_EMBEDDING_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
node src\telegram\lena-bot.mjs
```

В **PowerShell** то же самое: `$env:TELEGRAM_BOT_TOKEN="..."` и т.д. (одна строка на переменную; `#` там — комментарий только в конце строки после кода).

### Деплой на сервер (не держать ноутбук включённым)

Чтобы Лена работала **24/7** без вашего ноутбука, перенесите процесс на VPS или **Windows Server**: скопируйте `.env` и секреты Google/IceTrade, установите зависимости, включите **службу NSSM** (Windows) или **systemd** (Linux). **Важно:** с тем же `TELEGRAM_BOT_TOKEN` одновременно может работать только **один** экземпляр — после запуска на сервере остановите `lena-bot` на ноуте (`lena-bot.bat stop`), иначе в логе будет `Conflict`.

Пошагово: **[scripts/lena-server/README.md](../scripts/lena-server/README.md)** (для Windows Server — раздел в начале файла). RAG/embeddings на том же хосте — [scripts/remote-rag-worker/README.md](../scripts/remote-rag-worker/README.md).

## 5. Связка с Google Drive в тесте

Рекомендуемый порядок **ручной** проверки:

1. `node src/cli.js drive workspace-ensure "<url корневой папки>"`
2. Положить 1–2 файла в `_lena/context`, шаблон в `_lena/templates`.
3. `node src/cli.js drive agent-bundle "<root>" "ваш-tender-id"` — вывод JSON **выложить в группу** как файл `.json` или в сниппет (если небольшой).
4. В группе зафиксировать: ссылки `webViewLink` из JSON на шаблоны и контекст.

Для автоматической отправки `agent-bundle` в чат используйте бота «Лена» (раздел 4) или выложите JSON вручную.

## 6. Нераспознанные / нетекстовые файлы в проекте (правило для Лены)

**Контекст:** локальный RAG (`rag index`) индексирует только **`.txt`**, **`.md`**, **`.csv`**, **`.log`**. PDF, DOC, DOCX и прочие типы попадают в векторный поиск **только после** извлечения текста (например `scripts/corpus_extract_text`).

**Правило поведения Лены:** если в проекте на Drive (или в переданном инвентаре) есть файлы **вне** этого текстового контура, Лена **должна явно сигнализировать**, что их содержимое **не** попало в текстовый/RAG-пайплайн до предобработки (без выдумывания содержимого).

**Как именно сигнализировать** (отдельное сообщение, префикс в ответе, задача в чек-листе, реакция и т.д.) — **уточняется позже**; до этого достаточно явного предупреждения в тексте ответа.

## 7. Безопасность

- Тестовая группа не должна содержать боевые персональные данные и коммерческую тайну.
- Токен бота = полный доступ к боту; при утечке — `/revoke` в BotFather и новый токен.
