#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Извлечение текста из PDF для tender-prep: лучшее качество, чем связка pdf.js + tesseract.js.

- Векторный PDF: **колонки как TSV** — сначала `find_tables()` (таб между ячейками); иначе
  `get_text("dict")` с табами между span'ами при большом горизонтальном зазоре; затем запасной
  разбор по блокам.
- Страница почти без текста: растр **400 DPI**, grayscale → системный **tesseract** (`rus+eng` по
  умолчанию, OEM LSTM, PSM по умолчанию **3** — полная авторазметка).

Цепочка PDF→DOCX (pdf2docx) для сканов почти не улучшает распознавание и не используется: важнее
движок рендера (MuPDF) и нативный Tesseract CLI.

Вход: путь к PDF — argv[1]
Выход: одна строка JSON в stdout: {"text":"…","via":"…","error":null}

Окружение:
  LENA_OCR_PDF_MAX_PAGES — лимит страниц (по умолчанию 30, макс. 120)
  LENA_OCR_TESSERACT — путь к бинарнику tesseract (по умолчанию «tesseract» в PATH)
  LENA_OCR_TESSERACT_PSM — режим PSM 0–13 (по умолчанию 3)
  LENA_OCR_TESSERACT_LANG — языки Tesseract (по умолчанию rus+eng)
  LENA_OCR_PDF_IGNORE_TEXT_LAYER — 1: не брать встроенный текст, только растр+OCR
  LENA_OCR_PDF_SKIP_CORRUPT_HEURISTIC — 1: не считать встроенный текст «битым» по эвристикам
  LENA_OCR_PDF_TAB_GAP_PT — порог (pt) для таба между колонками в dict-режиме (по умолчанию 10)
  LENA_OCR_PDF_MOJIBAKE_CJK_RATIO — порог доли CJK среди букв (по умолчанию 0.018)
  LENA_OCR_PDF_FRAG_SHORT_LINE_RATIO — порог доли коротких строк (≤3 симв., по умолчанию 0.33)

Требования: pip install pymupdf; в PATH — tesseract с traineddata rus (и eng при rus+eng).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from typing import Any

MIN_NATIVE_CHARS_PER_PAGE = 50
PAGE_OCR_TIMEOUT_SEC = 180
DPI = 400

try:
    import fitz  # PyMuPDF
except ImportError:
    print(json.dumps({"text": "", "via": "", "error": "Нет pymupdf: pip install pymupdf"}, ensure_ascii=False))
    sys.exit(2)


def _max_pages() -> int:
    raw = os.environ.get("LENA_OCR_PDF_MAX_PAGES", "30").strip()
    try:
        n = int(raw)
    except ValueError:
        return 30
    return max(1, min(n, 120))


def _tesseract_bin() -> str:
    return os.environ.get("LENA_OCR_TESSERACT", "tesseract").strip() or "tesseract"


def _tesseract_psm() -> str:
    p = os.environ.get("LENA_OCR_TESSERACT_PSM", "3").strip()
    if p.isdigit() and 0 <= int(p) <= 13:
        return p
    return "3"


def _tesseract_lang() -> str:
    return os.environ.get("LENA_OCR_TESSERACT_LANG", "rus+eng").strip() or "rus+eng"


def _ignore_text_layer() -> bool:
    v = os.environ.get("LENA_OCR_PDF_IGNORE_TEXT_LAYER", "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _tab_gap_pt() -> float:
    try:
        return float(os.environ.get("LENA_OCR_PDF_TAB_GAP_PT", "10").strip())
    except ValueError:
        return 10.0


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)).strip())
    except ValueError:
        return default


def _layer_likely_mojibake_cjk(s: str) -> bool:
    """Всплеск CJK / replacement в русскоязычном PDF — подозрение на битый ToUnicode (как у pdf-parse)."""
    if os.environ.get("LENA_OCR_PDF_SKIP_CORRUPT_HEURISTIC", "").strip() == "1":
        return False
    compact = re.sub(r"\s+", "", s)
    if len(compact) < 120:
        return False
    cyr = len(re.findall(r"[\u0400-\u04FF]", compact))
    lat = len(re.findall(r"[A-Za-z]", compact))
    cjk = len(
        re.findall(
            r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffe6]",
            compact,
        )
    )
    letters = cyr + lat + cjk
    if letters < 100:
        return False
    if cjk / letters > _env_float("LENA_OCR_PDF_MOJIBAKE_CJK_RATIO", 0.018):
        return True
    repl = len(re.findall("\ufffd", s))
    if repl >= 4 and repl > len(s) / 400:
        return True
    return False


def _layer_likely_fragmented_lines(s: str) -> bool:
    """Много строк по 1–3 символа — часто сломанная вёрстка извлечённого текста."""
    lines = [ln.strip() for ln in s.replace("\r\n", "\n").split("\n") if ln.strip()]
    if len(lines) < 36:
        return False
    short_cnt = sum(1 for ln in lines if len(ln) <= 3)
    if short_cnt / len(lines) > _env_float("LENA_OCR_PDF_FRAG_SHORT_LINE_RATIO", 0.33):
        return True
    avg = sum(len(ln) for ln in lines) / len(lines) if lines else 0.0
    if len(lines) >= 60 and avg < 5.5:
        return True
    return False


def _layer_likely_garbage_cyrillic(s: str) -> bool:
    """Тот же смысл, что pdfPlainTextLayerLikelyGarbageCyrillic в Node — битый слой с латиницей."""
    if os.environ.get("LENA_OCR_PDF_SKIP_CORRUPT_HEURISTIC", "").strip() == "1":
        return False
    compact = re.sub(r"\s+", "", s)
    if len(compact) < 200:
        return False
    cyr = len(re.findall(r"[\u0400-\u04FF]", compact))
    lat = len(re.findall(r"[A-Za-z]", compact))
    letters = cyr + lat
    if letters < 150:
        return False
    return (cyr / letters) < 0.38


def _text_from_tables_tsv(page: fitz.Page) -> str:
    """Явные таблицы PyMuPDF → строки TSV (колонки через таб)."""
    try:
        tf = page.find_tables()
    except Exception:
        return ""
    tables: list[Any] = []
    if tf is not None:
        if hasattr(tf, "tables"):
            tables = list(tf.tables or [])
        elif hasattr(tf, "__iter__") and not isinstance(tf, (str, bytes)):
            try:
                tables = list(tf)
            except Exception:
                tables = []
    lines: list[str] = []
    for tix, tab in enumerate(tables):
        try:
            rows = tab.extract()
        except Exception:
            continue
        for row in rows or []:
            cells: list[str] = []
            for cell in row or []:
                if cell is None:
                    s = ""
                else:
                    s = str(cell).replace("\r", " ").replace("\n", " ").replace("\t", " ")
                    s = re.sub(r"[ \f\v]+", " ", s).strip()
                cells.append(s)
            if any(x.strip() for x in cells):
                lines.append("\t".join(cells))
        if tix < len(tables) - 1 and lines:
            lines.append("")
    return "\n".join(lines).strip()


def _text_from_dict_with_tabs(page: fitz.Page) -> str:
    """Строки из dict: между span'ами большой зазор → таб (колонки таблицы без явной сетки)."""
    gap_tab = _tab_gap_pt()
    gap_space = max(2.0, min(5.0, gap_tab * 0.38))
    d = page.get_text("dict") or {}
    out: list[str] = []
    for block in d.get("blocks", []) or []:
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []) or []:
            spans = line.get("spans", []) or []
            parts: list[str] = []
            prev_x1: float | None = None
            for sp in spans:
                bbox = sp.get("bbox") or (0.0, 0.0, 0.0, 0.0)
                x0, x1 = float(bbox[0]), float(bbox[2])
                txt = (sp.get("text") or "").strip()
                if not txt:
                    continue
                if prev_x1 is not None:
                    g = x0 - prev_x1
                    if g >= gap_tab:
                        parts.append("\t")
                    elif g >= gap_space:
                        parts.append(" ")
                parts.append(txt)
                prev_x1 = x1
            line_s = "".join(parts).strip()
            if line_s:
                out.append(line_s)
    return "\n".join(out).strip()


def _native_page_text_blocks_fallback(page: fitz.Page) -> str:
    """Запасной порядок: блоки сверху вниз (старая логика)."""
    blocks: list[Any] = page.get_text("blocks") or []
    text_blocks: list[tuple[float, float, str]] = []
    for b in blocks:
        if len(b) >= 7:
            x0, y0, _x1, _y1, txt, _no, btype = b[0], b[1], b[2], b[3], b[4], b[5], b[6]
            if int(btype) != 0:
                continue
            t = (txt or "").strip()
            if t:
                text_blocks.append((float(y0), float(x0), t))
        elif len(b) >= 5:
            y0, x0 = float(b[1]), float(b[0])
            t = (str(b[4]) if b[4] is not None else "").strip()
            if t:
                text_blocks.append((y0, x0, t))
    text_blocks.sort(key=lambda r: (round(r[0], 1), round(r[1], 1)))
    if not text_blocks:
        return (page.get_text("text") or "").strip()
    return "\n".join(tb[2] for tb in text_blocks).strip()


def _native_page_text(page: fitz.Page) -> str:
    """Нативный текст с сохранением колонок (TSV / табы по координатам)."""
    tsv = _text_from_tables_tsv(page)
    if tsv and (tsv.count("\t") >= 2 or sum(1 for ln in tsv.split("\n") if "\t" in ln) >= 2):
        return tsv
    dtxt = _text_from_dict_with_tabs(page)
    if dtxt:
        return dtxt
    return _native_page_text_blocks_fallback(page)


def _normalize_ws_preserve_tsv(s: str) -> str:
    """Сжимает пробелы внутри ячеек, не схлопывает разделители колонок (таб)."""
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    lines = s.split("\n")
    out_lines: list[str] = []
    for line in lines:
        cells = line.split("\t")
        norm_cells = [re.sub(r"[ \f\v]+", " ", c).strip() for c in cells]
        out_lines.append("\t".join(norm_cells))
    s = "\n".join(out_lines)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _normalize_ws(s: str) -> str:
    return _normalize_ws_preserve_tsv(s)


def _ocr_page_raster(page: fitz.Page) -> tuple[str, str | None]:
    """Рендер страницы (DPI из константы), Tesseract CLI. Возвращает (text, err)."""
    mat = fitz.Matrix(DPI / 72.0, DPI / 72.0)
    pix = page.get_pixmap(matrix=mat, alpha=False, colorspace=fitz.csGRAY)
    tcmd = _tesseract_bin()
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        png_path = tmp.name
    try:
        pix.save(png_path)
        cmd = [
            tcmd,
            png_path,
            "stdout",
            "-l",
            _tesseract_lang(),
            "--oem",
            "1",
            "--psm",
            _tesseract_psm(),
            "--dpi",
            str(DPI),
            "-c",
            "preserve_interword_spaces=1",
        ]
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=PAGE_OCR_TIMEOUT_SEC,
            encoding="utf-8",
            errors="replace",
        )
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "tesseract failed").strip()
            return "", err[:800]
        return _normalize_ws(proc.stdout), None
    except FileNotFoundError:
        return "", f"Не найден бинарник tesseract (ожидался `{tcmd}` в PATH)."
    except subprocess.TimeoutExpired:
        return "", "tesseract: превышено время распознавания страницы."
    finally:
        try:
            os.unlink(png_path)
        except OSError:
            pass


def extract_pdf(path: str) -> dict[str, Any]:
    if not os.path.isfile(path):
        return {"text": "", "via": "", "error": f"Файл не найден: {path}"}

    max_p = _max_pages()
    doc = fitz.open(path)
    try:
        n = min(doc.page_count, max_p)
        parts: list[str] = []
        used_native = 0
        used_ocr = 0
        last_err: str | None = None

        for i in range(n):
            page = doc[i]
            native = "" if _ignore_text_layer() else _native_page_text(page)
            if native and (
                _layer_likely_garbage_cyrillic(native)
                or _layer_likely_mojibake_cjk(native)
                or _layer_likely_fragmented_lines(native)
            ):
                native = ""
            if len(native) >= MIN_NATIVE_CHARS_PER_PAGE:
                parts.append(native)
                used_native += 1
                continue
            ocr_text, err = _ocr_page_raster(page)
            if err:
                last_err = err
            if ocr_text:
                parts.append(ocr_text)
                used_ocr += 1
            elif native:
                parts.append(native)

        text = _normalize_ws("\n\n".join(parts))
        if not text:
            return {
                "text": "",
                "via": "",
                "error": last_err or "Нет текста (ни слоя, ни OCR).",
            }

        via = "pymupdf-native"
        if used_ocr and used_native:
            via = "pymupdf-native+pymupdf-raster-tesseract"
        elif used_ocr:
            via = "pymupdf-raster-tesseract"

        return {"text": text, "via": via, "error": None}
    finally:
        doc.close()


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"text": "", "via": "", "error": "Укажите путь к PDF."}, ensure_ascii=False))
        sys.exit(1)
    out = extract_pdf(sys.argv[1])
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
