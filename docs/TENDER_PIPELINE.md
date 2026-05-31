# Конвейер тендера (IceTrade → Drive)

**Источник истины по шагам процесса.** При добавлении нового этапа или изменении артефактов — обновить этот файл и соответствующий код (`src/icetrade/`, `src/tenders/cli.js`, бот).

| Шаг | Имя в коде / CLI | Вход | Выход на Drive | Статус |
|-----|-------------------|------|----------------|--------|
| **1 · Import** | `bootstrapIceTradeToDrive`, `tenders icetrade-bootstrap`, ссылка IceTrade в Telegram | URL/view id, HTML карточки | `inputs/` — вложения заказчика; **`inputs/icetrade-import-snapshot.json`** — снимок полей карточки и **события**; `notes/icetrade-bootstrap-*.md` | в разработке: снимок страницы + события |
| **2 · Extract** | `extractTenderInputDocumentsToExtracted`, `tenders tender-extract`, `/tenderextract` | файлы в `inputs/` | `inputs/extracted/*.txt`, `extract-manifest.json` | есть; PDF/DOC/DOCX — базово |
| **3 · Card** | `buildTenderTelegramCard`, `tenders tender-card`, `/tendercard` | `inputs/extracted` + опционально HTML IceTrade | `notes/tender-card-*.md`, сообщение Telegram | есть |
| **4 · Analyze** | `analyzeTenderAfterBootstrap`, `tenders icetrade-analyze` | текст из inputs (без полного PDF-извлечения в analyze) | `notes/icetrade-analysis-*.md` | есть, устар. под Extract |

## Import (детали)

1. Загрузка HTML карточки (HTTP / Playwright по `LENA_ICETRADE_PLAYWRIGHT`).
2. Кандидаты вложений + скачивание в `inputs/`.
3. **Снимок карточки** — эвристический разбор HTML в JSON (**не замена** юридическому Извещению): URL, `view_id`, заголовок, телефоны, строки про цену/бюджет, блок **«События в хронологическом…»** (отмена и др.) для последующего **отслеживания** (повторный import или отдельный процесс сравнения — позже).

Файл: **`inputs/icetrade-import-snapshot.json`**, поля см. `schemaVersion` / `kind` внутри файла; логические блоки карточки и стабильные ключи **`structured`** — [ICETRADE_CARD_SNAPSHOT.md](ICETRADE_CARD_SNAPSHOT.md).

## Extract (парсинг файлов)

Отдельный процесс: **не смешивать** с Import. После ручного добавления файлов в `inputs/` снова запускают **Extract**.

Папка **`inputs/extracted/`** создаётся **только** внутри `_lena/tenders/<год>/<view>/inputs/` (родитель каталога `extracted` всегда — папка **`inputs`** тендера). Если **Telegram** или CLI при парсинге создали на «Моём диске» в корне несколько папок с именем **`extracted`**, почти всегда это неверный **`LENA_DRIVE_ROOT`**: должен быть тот же корень, что для **`drive workspace-ensure`** (родитель для `_lena/`), а не id другой папки или файла. Перед извлечением код проверяет метаданные каталога `inputs`; при рассинхроне — ошибка с подсказкой, без создания папки в корне.

## Дальнейшие процессы

- Сравнение двух снимков (дельта событий) — запланировано.
- Полный разбор PDF/DOC в `extracted` — см. `LENA_INPUT_EXTRACT_*`, развитие `inputDocumentsExtract.js`.

## См. также

- [ICETRADE_CARD_SNAPSHOT.md](ICETRADE_CARD_SNAPSHOT.md) — шаблон карточки IceTrade и JSON **`structured`**.
- [PRODUCT_CONTEXT.md](PRODUCT_CONTEXT.md) — продуктовый контекст.
- [GOOGLE_DRIVE.md](GOOGLE_DRIVE.md) — структура `_lena/tenders/…`.

