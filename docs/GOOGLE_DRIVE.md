# Google Drive и «Лена»: папки, шаблоны, контекст

**Пошаговая настройка Google Cloud, Drive API и JSON-ключа:** отдельный файл [GOOGLE_DRIVE_GCP_SETUP.md](GOOGLE_DRIVE_GCP_SETUP.md).

Цель — чтобы **Лена** — **специалист по подготовке тендерных документов** (агент по сценарию или оператор) — работала с **одной согласованной структурой** на Google Drive: сама **создавала и переименовывала** папки под тендеры, **видела шаблоны** документов, **подтягивала ранее положенные файлы** как общий контекст.

## Корень и служебная папка `_lena`

1. Вы создаёте на Диске **одну корневую папку** под проект (например «Тендеры ACME») и **расшариваете** её сервисному аккаунту с правом **Редактор** (см. ниже про ключ).
2. Внутри этой папки код создаёт каталог **`_lena/`** (префикс снижает риск пересечения с вашими уже существующими именами).

Структура после команды `workspace-ensure`:

```text
<ваша корневая папка>/
  _lena/
    templates/     ← шаблоны заявок; внутри подпапки по юрлицу — **gs-retail**, **finselvat** (бланки, типовые письма); при необходимости общие файлы можно оставить в корне templates
    library/       ← справочники, регламенты, выдержки (не обязательно «шаблон на копирование»)
    context/       ← общий контекст между тендерами: стиль, глоссарий, фрагменты прошлых ответов
    org-docs/      ← операционные документы организации (справка банка со сроком, баланс, ОФР); внутри **gs-retail/** и **finselvat/** — не смешивать юрлица; см. [LENA_RULES.md](LENA_RULES.md) §6b
    founding-docs/ ← учредительные и редко меняющиеся: устав, регистрация, приказ о директоре — те же **gs-retail/**, **finselvat/**; см. [LENA_RULES.md](LENA_RULES.md) §6c
    tenders/
      <ГГГГ>/                        ← по умолчанию текущий год (или LENA_DEFAULT_TENDER_YEAR)
        <tender_id>/
          inputs/                    ← комплект документов закупки с площадки / из извещения (в продукте: «документы заказчика»); сюда же кладём скачанные файлы до парсинга; при **bootstrap IceTrade** — `icetrade-import-snapshot.json` (поля карточки и события)
          drafts/
          exports/
          attachments/               ← доказательства, приложения к матрице
          notes/                     ← разъяснения, переписка, короткие заметки; лог с менеджерами в Telegram — `telegram-managers-log.md` (см. LENA_RULES §6e)
      <tender_id>/                   ← только если явно указали режим flat (без года)
        inputs/                     ← то же: комплект закупки («документы заказчика»); при bootstrap IceTrade — `icetrade-import-snapshot.json`
        …
```

**Год в пути (как у вас по годам):** по умолчанию тендер создаётся в **`_lena/tenders/<ГГГГ>/<tender_id>/…`**, где **`<ГГГГ>`** — текущий календарный год (например 2026), либо значение переменной **`LENA_DEFAULT_TENDER_YEAR`**, если задали её в окружении (удобно в конце года). Явно другой год: третий аргумент **`2025`**. Старый «плоский» путь без года: третий аргумент **`flat`** (для уже существующих деревьев).

Ваши папки **«ГС Ритейл» → 2024 / 2025 / 2026** на «Моём диске» можно оставить как есть: `_lena` — отдельное служебное дерево **внутри той корневой папки**, которую вы передаёте в `workspace-ensure` (часто это и есть «ГС Ритейл»).

**Важно:** если вы раньше создавали тендеры **без года** (`_lena/tenders/<id>/…`), для новых команд по умолчанию путь станет **с годом**. Старые папки не удаляются; для новых операций с тем же id без года передайте **`flat`**.

**Шаблоны:** `_lena/templates` — `templates-list`, `agent-bundle`. Статика по компаниям (**ГС Ритейл** / **Финсельват**): подкаталоги **`gs-retail`** и **`finselvat`** (создаются при `workspace-ensure`). Имена совпадают с ключами в коде (`layoutConstants` ↔ выбор в Telegram при `/tenderkp`).

**Справочники:** `_lena/library` — `library-list`, `agent-bundle` (поле `libraryFiles`).

**Контекст:** `_lena/context` — `context-list`, `context-pull`, поле `contextFiles` в `agent-bundle`. Дополнительно можно задать **`LENA_EXTRA_CONTEXT_FOLDERS`**: через запятую/перенос строки — URL или id **других папок** на том же Диске (расшаренных на тот же сервисный аккаунт); файлы из корня каждой папки **подмешиваются** в тот же список и в бандл (с полями `lenaContextSource`, `lenaContextExtraRootId`). Вложенные подпапки внутри доп. корней не обходятся.

**Документы организации (операционные):** `_lena/org-docs` — справка банка со сроком, бухгалтерская отчётность и аналоги. Для **нескольких юрлиц** материалы кладите в **`_lena/org-docs/gs-retail/`** или **`_lena/org-docs/finselvat/`**, не смешивая компании. Корень `org-docs` можно использовать только для общих, не привязанных к юрлицу файлов. Создаётся при `workspace-ensure`; список: `drive org-docs-list <root>` (в выборке — и подпапки, и файлы в корне); в `agent-bundle` — **`lena.orgDocsFolderId`** и **`orgDocsFiles`**. Сценарий Лены — в [LENA_RULES.md](LENA_RULES.md) §6b.

**Учредительные документы:** `_lena/founding-docs` — устав, регистрация, приказ о директоре и т.п. Структура как у `org-docs`: подпапки **`gs-retail`**, **`finselvat`**. Те же правила загрузки и реестра. Создаётся при `workspace-ensure`; список: `drive founding-docs-list <root>`; в `agent-bundle` — **`lena.foundingDocsFolderId`** и **`foundingDocsFiles`**. Подробнее — [LENA_RULES.md](LENA_RULES.md) §6c.

**Тендер:** `workspace-tender` (год по умолчанию или `ГГГГ`, либо `flat`); внутри — `inputs`, `drafts`, `exports`, `attachments`, **`notes`** (в т.ч. **`telegram-managers-log.md`** — контекстный лог переписки с менеджерами по этому тендеру, см. [LENA_RULES.md](LENA_RULES.md) §6e). Копия шаблона: `template-copy` (см. `drive` — `flat`, год или только новое имя).

<a id="lena-long-memory-archive"></a>

### Долгая память: архив тендеров

Цель — чтобы Лена видела **накопленный архив** (например папка года на Drive с проектами «заказчик / участие») как **единый индекс со ссылками**, не обязательно вытягивая все PDF в промпт.

1. **Корень Лены** — папка, в которой после `workspace-ensure` есть `_lena/context` (тот же `<root>`, что в Telegram и в `agent-bundle`).
2. **Архив** — отдельная папка на Drive (может быть вне `_lena`), расшарена на тот же сервисный аккаунт с правом **чтения** (для обхода достаточно просмотра и построения манифеста).
3. Собрать индекс:  
   `node src/cli.js drive archive-context-build <URL_или_id_архива> <URL_или_id_корня_Лены> [maxDepth] [maxFiles]`  
   Команда строит Markdown и пытается загрузить его в `_lena/context`. Если загрузка с сервисного аккаунта в «Мой диск» возвращает **403 (нет квоты у SA)** — файл остаётся в **текущей рабочей папке** проекта (`archive-context-…md`); его нужно **один раз вручную** перенести в `_lena/context` в UI Drive (или перенести рабочий корень на [общий диск](#общие-диски-shared-drives), где SA может создавать файлы).
4. **Проверка:** `drive context-list <root>` — в списке должен появиться новый `.md`. В Telegram: `/context`.
5. **`LENA_EXTRA_CONTEXT_FOLDERS`** для архива годится только если нужные файлы лежат **в корне** указанных папок (вложенность не индексируется). Для дерева «проект/подпапки/файлы» надёжнее именно **индекс** из шага 3 в `_lena/context`.

Общая стратегия «архив vs короткие директивы» — в [LENA_CONTEXT_STRATEGY.md](LENA_CONTEXT_STRATEGY.md).

## Настройка доступа (сервисный аккаунт)

Полная пошаговая инструкция (проект, биллинг, включение API, ключ, шаринг папки, `GOOGLE_DRIVE_CREDENTIALS`, проверка `node`): **[GOOGLE_DRIVE_GCP_SETUP.md](GOOGLE_DRIVE_GCP_SETUP.md)**.

Кратко: JSON-ключ сервисного аккаунта + переменная **`GOOGLE_DRIVE_CREDENTIALS`** (или **`GOOGLE_APPLICATION_CREDENTIALS`**) + папка на Диске расшарена на **`client_email`** из JSON с ролью **Редактор**.

**Личный аккаунт Gmail (без Workspace):** запись от имени пользователя через OAuth — **[GOOGLE_DRIVE_OAUTH.md](GOOGLE_DRIVE_OAUTH.md)** (`GOOGLE_DRIVE_OAUTH_CLIENT`, `GOOGLE_DRIVE_OAUTH_TOKEN`, команда `drive oauth-login`).

## Установка

Для команд **Google Drive** отдельные npm-пакеты **не нужны** (используются `fetch` и JWT в `src/drive/`).

```bash
cd tender-prep
```

`npm install` требуется только если в проекте снова появятся зависимости в `package.json`. Раньше использовался пакет `googleapis`; он **убран**, в том числе чтобы обойти проблемы корпоративного TLS при `npm install`.

## Команды CLI (сводка)

| Команда | Назначение |
|---------|------------|
| `drive workspace-ensure <root>` | Создать `_lena/{templates,library,context,org-docs,founding-docs,tenders}` и подпапки компаний **`gs-retail`**, **`finselvat`** в templates / org-docs / founding-docs |
| `drive workspace-layout <root>` | Показать id папок (без создания) |
| `drive workspace-tender <root> <tenderId> [ГГГГ\|flat]` | Папка тендера; по умолчанию год в пути; `flat` — без года (legacy) |
| `drive templates-list <root>` | Список в `_lena/templates` |
| `drive library-list <root>` | Список в `_lena/library` |
| `drive org-docs-list <root>` | Список в `_lena/org-docs` |
| `drive founding-docs-list <root>` | Список в `_lena/founding-docs` (учредительные и редко меняющиеся) |
| `drive context-list <root>` | Объединённый список: `_lena/context` + папки из `LENA_EXTRA_CONTEXT_FOLDERS` |
| `drive context-pull <root> <локальнаяПапка>` | Выгрузить контекст локально (подпапки по источнику: `_lena_context`, имя доп. папки) |
| `drive template-copy <root> <id> <tenderId> [flat\|ГГГГ\|имя] [имя]` | Копия в `drafts`; год по умолчанию; `flat` — без года |
| `drive item-rename <id> <новоеИмя>` | Переименовать файл или папку |
| `drive agent-bundle <root> [tenderId] [ГГГГ\|flat]` | JSON: папки, шаблоны, library, контекст, тендер |
| `drive tenders-inventory <root>` | Сводка всех тендеров под `_lena/tenders`: год, имя папки, число файлов в inputs/drafts/… ([CORPUS_AND_RAG.md](CORPUS_AND_RAG.md)) |
| `drive corpus-manifest <folder> [maxDepth] [maxFiles]` | Рекурсивный список всех **файлов** под папкой (метаданные; для архива вроде «тендеры 2025»). См. [CORPUS_AND_RAG.md](CORPUS_AND_RAG.md) |
| `drive corpus-pull <folder> <локальнаяПапка> [maxDepth] [maxFiles]` | Рекурсивная **выгрузка** файлов с Drive в локальную папку (сохранение путей). См. [CORPUS_AND_RAG.md](CORPUS_AND_RAG.md) |
| `drive corpus-jsonl <folder> [maxDepth] [maxFiles]` | В stdout: **JSONL** — по строке на каждый файл (очередь для parserit). См. [PARSERIT_INTEGRATION.md](PARSERIT_INTEGRATION.md) |
| `drive archive-context-build <архив> <корень_Лены> [maxDepth] [maxFiles]` | Рекурсивный обход архива → Markdown-индекс (проект / заказчик / участие) → загрузка в `_lena/context`; при 403 SA — файл в cwd, см. [раздел «Долгая память»](#lena-long-memory-archive) |

Низкоуровневые `list`, `meta`, `download`, `upload` сохраняются для произвольных путей.

Пример (PowerShell):

```powershell
$env:GOOGLE_DRIVE_CREDENTIALS = "C:\secrets\lena-drive.json"
node src/cli.js drive workspace-ensure "https://drive.google.com/drive/folders/ROOT_ID"
node src/cli.js drive workspace-tender "ROOT_ID" "zakupka-2026-042"
node src/cli.js drive workspace-tender "ROOT_ID" "old-flat-tender" flat
node src/cli.js drive agent-bundle "ROOT_ID" "zakupka-2026-042"
```

`<root>` везде — **id или URL** той самой **корневой** папки проекта (не обязательно `_lena`).

## Как этим пользоваться в сценарии «Лена»

1. Один раз: `workspace-ensure`, положить шаблоны и контекстные файлы в нужные подпапки.
2. На новый тендер: `workspace-tender` (или сразу `agent-bundle` с `tenderId` — дерево создастся само).
3. Перед генерацией ответа агенту: `agent-bundle` или `context-pull` + `templates-list`, чтобы в промпт попали **имена, ссылки и типы** файлов.
4. Черновик: `template-copy` копирует шаблон в `drafts`; дальше правки — в Google Docs вручную или через другие интеграции.

## Общие диски (Shared Drives)

Запросы к API идут с `supportsAllDrives: true`. Корневая папка может жить на общем диске, если сервисный аккаунт добавлен в участники с нужной ролью.

## Связка с репозиторием

Локальные команды `validate-input`, `matrix` и т.д. не зависят от Диска. Типичный поток: **скачать** комплект в `inputs/` (через `upload` или вручную в UI), затем локально прогнать парсинг и положить `exports/matrix.json` на Диск через `upload`.
