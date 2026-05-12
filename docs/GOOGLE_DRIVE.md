# Google Drive и «Лена»: папки, шаблоны, контекст

**Пошаговая настройка Google Cloud, Drive API и JSON-ключа:** отдельный файл [GOOGLE_DRIVE_GCP_SETUP.md](GOOGLE_DRIVE_GCP_SETUP.md).

Цель — чтобы **Лена** (агент или оператор по сценарию) работала с **одной согласованной структурой** на Google Drive: сама **создавала и переименовывала** папки под тендеры, **видела шаблоны** документов, **подтягивала ранее положенные файлы** как общий контекст.

## Корень и служебная папка `_lena`

1. Вы создаёте на Диске **одну корневую папку** под проект (например «Тендеры ACME») и **расшариваете** её сервисному аккаунту с правом **Редактор** (см. ниже про ключ).
2. Внутри этой папки код создаёт каталог **`_lena/`** (префикс снижает риск пересечения с вашими уже существующими именами).

Структура после команды `workspace-ensure`:

```text
<ваша корневая папка>/
  _lena/
    templates/     ← шаблоны заявок (копируете в тендер через template-copy)
    library/       ← справочники, регламенты, выдержки (не обязательно «шаблон на копирование»)
    context/       ← общий контекст между тендерами: стиль, глоссарий, фрагменты прошлых ответов
    tenders/
      <ГГГГ>/                        ← по умолчанию текущий год (или LENA_DEFAULT_TENDER_YEAR)
        <tender_id>/
          inputs/
          drafts/
          exports/
          attachments/               ← доказательства, приложения к матрице
          notes/                     ← разъяснения, переписка, короткие заметки
      <tender_id>/                   ← только если явно указали режим flat (без года)
        inputs/
        …
```

**Год в пути (как у вас по годам):** по умолчанию тендер создаётся в **`_lena/tenders/<ГГГГ>/<tender_id>/…`**, где **`<ГГГГ>`** — текущий календарный год (например 2026), либо значение переменной **`LENA_DEFAULT_TENDER_YEAR`**, если задали её в окружении (удобно в конце года). Явно другой год: третий аргумент **`2025`**. Старый «плоский» путь без года: третий аргумент **`flat`** (для уже существующих деревьев).

Ваши папки **«ГС Ритейл» → 2024 / 2025 / 2026** на «Моём диске» можно оставить как есть: `_lena` — отдельное служебное дерево **внутри той корневой папки**, которую вы передаёте в `workspace-ensure` (часто это и есть «ГС Ритейл»).

**Важно:** если вы раньше создавали тендеры **без года** (`_lena/tenders/<id>/…`), для новых команд по умолчанию путь станет **с годом**. Старые папки не удаляются; для новых операций с тем же id без года передайте **`flat`**.

**Шаблоны:** `_lena/templates` — `templates-list`, `agent-bundle`.

**Справочники:** `_lena/library` — `library-list`, `agent-bundle` (поле `libraryFiles`).

**Контекст:** `_lena/context` — `context-list`, `context-pull`.

**Тендер:** `workspace-tender` (год по умолчанию или `ГГГГ`, либо `flat`); внутри — `inputs`, `drafts`, `exports`, `attachments`, `notes`. Копия шаблона: `template-copy` (см. `drive` — `flat`, год или только новое имя).

## Настройка доступа (сервисный аккаунт)

Полная пошаговая инструкция (проект, биллинг, включение API, ключ, шаринг папки, `GOOGLE_DRIVE_CREDENTIALS`, проверка `node`): **[GOOGLE_DRIVE_GCP_SETUP.md](GOOGLE_DRIVE_GCP_SETUP.md)**.

Кратко: JSON-ключ сервисного аккаунта + переменная **`GOOGLE_DRIVE_CREDENTIALS`** (или **`GOOGLE_APPLICATION_CREDENTIALS`**) + папка на Диске расшарена на **`client_email`** из JSON с ролью **Редактор**.

## Установка

Для команд **Google Drive** отдельные npm-пакеты **не нужны** (используются `fetch` и JWT в `src/drive/`).

```bash
cd tender-prep
```

`npm install` требуется только если в проекте снова появятся зависимости в `package.json`. Раньше использовался пакет `googleapis`; он **убран**, в том числе чтобы обойти проблемы корпоративного TLS при `npm install`.

## Команды CLI (сводка)

| Команда | Назначение |
|---------|------------|
| `drive workspace-ensure <root>` | Создать `_lena/{templates,library,context,tenders}` при отсутствии |
| `drive workspace-layout <root>` | Показать id папок (без создания) |
| `drive workspace-tender <root> <tenderId> [ГГГГ\|flat]` | Папка тендера; по умолчанию год в пути; `flat` — без года (legacy) |
| `drive templates-list <root>` | Список в `_lena/templates` |
| `drive library-list <root>` | Список в `_lena/library` |
| `drive context-list <root>` | Список в `_lena/context` |
| `drive context-pull <root> <локальнаяПапка>` | Выгрузить контекст локально |
| `drive template-copy <root> <id> <tenderId> [flat\|ГГГГ\|имя] [имя]` | Копия в `drafts`; год по умолчанию; `flat` — без года |
| `drive item-rename <id> <новоеИмя>` | Переименовать файл или папку |
| `drive agent-bundle <root> [tenderId] [ГГГГ\|flat]` | JSON: папки, шаблоны, library, контекст, тендер |

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
