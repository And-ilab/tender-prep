# Локальные эмбеддинги на CPU (OpenAI-совместимый API)

Сервер поднимает **`POST /v1/embeddings`** в формате, который ожидает `node src/cli.js rag index|query|ask` (через `LENA_EMBEDDING_BASE_URL`). Модель считает векторы на **CPU** через **sentence-transformers** (PyTorch), без GPU.

## Установка

Из корня репозитория. Если папки **`.venv` ещё нет** — сначала создайте окружение (подставьте путь к своему `python.exe`, см. `where python`):

```powershell
cd C:\tender-prep
# пример: Python из Microsoft Store / python.org
& "C:\Users\...\AppData\Local\Python\bin\python.exe" -m venv .venv
# или: py -3.12 -m venv .venv   — если стоит несколько версий
.\.venv\Scripts\python.exe -m pip install -U pip
.\.venv\Scripts\python.exe -m pip install -r scripts\local_openai_embeddings\requirements.txt
```

### Windows: `Unable to copy ... venvlauncher.exe ... to .venv\Scripts\python.exe`

Обычно мешает **антивирус / Защитник Windows** (сканирование в момент копирования), **занятый процесс** (закройте терминалы и IDE, где уже запускали этот `.venv`), или **битая половина** старой папки `.venv`.

1. Закройте все процессы `python.exe`, которые могли использовать `C:\tender-prep\.venv`.
2. Удалите окружение и создайте снова:

```powershell
cd C:\tender-prep
Remove-Item -Recurse -Force .venv -ErrorAction SilentlyContinue
& "C:\Users\ВАШ_ПОЛЬЗОВАТЕЛЬ\AppData\Local\Python\bin\python.exe" -m venv .venv
```

3. Если снова ошибка: временно **добавьте исключение** для `C:\tender-prep` в Защитнике (или отключите проверку папки на минуту) и повторите шаг 2.
4. Запустите PowerShell **от имени администратора** и повторите создание `venv` (редко, но помогает при политиках доступа).
5. Обходной путь: виртуальное окружение **вне репозитория** (нет блокировок от индексации Git/Cursor):

```powershell
& "$env:LOCALAPPDATA\Python\bin\python.exe" -m venv C:\venvs\tender-prep-embed
C:\venvs\tender-prep-embed\Scripts\python.exe -m pip install -U pip
C:\venvs\tender-prep-embed\Scripts\python.exe -m pip install -r C:\tender-prep\scripts\local_openai_embeddings\requirements.txt
# сервер: C:\venvs\tender-prep-embed\Scripts\python.exe C:\tender-prep\scripts\local_openai_embeddings\server.py
```

Требуется **Python 3.10+**. На **Python 3.14** используется связка **sentence-transformers + torch** (тяжёлее, чем FastEmbed, но ставится без Rust). Пакет **fastembed** на 3.14 часто ломается из‑за сборки `py-rust-stemmers`.

Первый запуск скачает **torch** и веса модели с Hugging Face (сотни МБ).

### Ошибка SSL при загрузке модели (`CERTIFICATE_VERIFY_FAILED`)

1. Установите зависимости из `requirements.txt` — в них есть **`truststore`**: при старте сервера вызывается `truststore.inject_into_ssl()` (типичный фикс для Windows + Hugging Face).
2. Дополнительно подставляется **certifi** в `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE`.
3. Если стоит **антивирус / корпоративный SSL‑инспектор** — добавьте исключение или установите корневой сертификат организации в хранилище Windows.
4. Крайний вариант (только для отладки, **снижает безопасность**): перед запуском сервера задайте **`LOCAL_EMBEDDINGS_INSECURE_SSL=1`** — отключается проверка сертификата при загрузке весов с Hugging Face.

## Запуск сервера

В отдельном окне PowerShell:

```powershell
cd C:\tender-prep
$env:LOCAL_EMBEDDINGS_MODEL = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'
.\.venv\Scripts\python.exe scripts\local_openai_embeddings\server.py
```

Первый запуск может долго качать веса с Hugging Face. По умолчанию слушает **`http://127.0.0.1:8765`**.

Опционально:

- `LOCAL_EMBEDDINGS_HOST`, `LOCAL_EMBEDDINGS_PORT` — хост и порт.
- `LOCAL_EMBEDDINGS_API_KEY` — если задан, клиент должен передать тот же `Bearer` (в Node: `LENA_EMBEDDING_API_KEY`).

Список моделей: в Python `from fastembed import TextEmbedding; print(TextEmbedding.list_supported_models())` или [документация FastEmbed](https://qdrant.github.io/fastembed/examples/Supported_Models/).

## Настройка Node (`rag index`)

В окне, где запускаете индекс:

```powershell
$env:LENA_EMBEDDING_BASE_URL = 'http://127.0.0.1:8765/v1'
$env:LENA_EMBEDDING_MODEL = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'
$env:LENA_EMBEDDING_API_KEY = 'sk-local'
# Не задавайте LENA_EMBEDDING_DIMENSIONS, если не уверены — размерность задаётся моделью.
node src/cli.js rag index "C:\data\corpus" "C:\data\rag-index"
```

Поле **`LENA_EMBEDDING_MODEL`** в запросе должно совпадать с выбранной на сервере моделью (для `manifest.json` и единообразия запрос/индекс).

## Проверка

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -Method Get
```

## Замечания

- Индекс и запросы должны использовать **одну и ту же** модель и размерность вектора.
- На больших корпусах индексация на CPU может занять много времени — это нормально.
- Для чата по-прежнему можно использовать DeepSeek (`LENA_OPENAI_BASE_URL` и т.д.) — это отдельно от эмбеддингов.
