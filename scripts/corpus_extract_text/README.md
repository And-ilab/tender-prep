# Извлечение текста из корпуса (Python)

Сохраняет **исходные файлы**; рядом с зеркальной структурой в `--output` пишет **`.txt` в UTF-8**.

## Установка

```bash
cd scripts/corpus_extract_text
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## Запуск

```bash
python corpus_extract_text.py --input "C:\data\corpus-2025" --output "C:\data\corpus-2025-txt"
```

Опции:

- `--force` — перезаписать уже существующие `.txt`
- `--dry-run` — только посчитать файлы по типам, ничего не писать
- `--no-pdf` — не обрабатывать PDF (если не ставили pymupdf)
- `--libreoffice "C:\Program Files\LibreOffice\program\soffice.exe"` — явный путь к **soffice.exe** (если не находится сам)

Если LibreOffice **установлен**, но папка `program` не в **PATH**, задайте переменную (cmd):

```bat
set LENA_LIBREOFFICE_SOFFICE=C:\Program Files\LibreOffice\program\soffice.exe
```

Проверка: `python corpus_extract_text.py -i "C:\data\corpus-2025" -o "C:\data\corpus-2025-txt" --dry-run` — в JSON поле **`libreoffice`** должно быть полным путём к `soffice.exe`, не `null`.

## Что поддерживается

| Расширение | Метод |
|------------|--------|
| `.docx` | `python-docx`; если не OOXML-ZIP или ошибка чтения — **LibreOffice** (если доступен) |
| `.pdf` | `pymupdf` (если установлен; иначе пропуск с записью в лог) |
| `.doc` | Только если доступен **LibreOffice** (`soffice --headless --convert-to txt`) или укажите путь `--libreoffice` |
| `.txt`, `.md`, `.csv`, `.log` | Копия в выход с нормализацией переводов строк |

Папки `.git`, `node_modules`, `__pycache__`, `.venv` пропускаются.

Итог: `report.json` в `--output` — счётчики и списки ошибок (пути относительно `--input`).

Перезапустите скрипт из **актуальной копии репозитория** `tender-prep`. В `report.json` должно быть поле **`script_version`** (≥ 3). Проверка: `python corpus_extract_text.py --version` → `3`.

### Ошибка `Package not found` / не читается .docx

Часто это **не настоящий** файл Office Open XML: обрыв загрузки с Drive, 0 байт, или под расширением `.docx` лежит HTML. Скрипт проверяет структуру OOXML; если `python-docx` не читает — вызывается **LibreOffice**. Убедитесь, что **`libreoffice` в dry-run не null** (см. выше), затем перезапуск с **`--force`**.