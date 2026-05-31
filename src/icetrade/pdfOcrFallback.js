import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { ocrPdfBufferViaPython } from "./pdfOcrPython.js";

/**
 * OCR / извлечение текста из PDF — когда сырой слой из `pdf-parse` нельзя доверять.
 *
 * 1. **Python** (`scripts/lena_pdf_ocr.py`): PyMuPDF — текст по блокам; сканы — растр **400 DPI** + **системный Tesseract** `rus+eng` (или `LENA_OCR_TESSERACT_LANG`), `--oem 1` (PSM по умолчанию **3**).
 * 2. **Node** (fallback): `pdfjs` + `@napi-rs/canvas` + `tesseract.js`, LSTM, PSM **auto**, масштаб **по умолчанию 3.25**, язык **`LENA_OCR_TESSERACT_LANG`** (по умолчанию `rus+eng`).
 *
 * Переменные окружения:
 * - **LENA_OCR_DISABLE** = 1 — не вызывать ни Python, ни Node OCR.
 * - **LENA_PDF_OCR_PYTHON** = 0 — не вызывать Python (сразу Node tesseract.js).
 * - **LENA_OCR_PDF_IGNORE_TEXT_LAYER** = 1 — всегда визуальный пайплайн (игнорировать «длинный» текстовый слой pdf-parse).
 * - **LENA_OCR_PDF_SKIP_CORRUPT_HEURISTIC** = 1 — не запускать пайплайн из‑за низкой доли кириллицы в слое.
 * - **LENA_PYTHON** — интерпретатор (по умолчанию `python`).
 * - **LENA_OCR_PDF_MIN_TEXT_CHARS** (по умолчанию 48) — порог «мало текста» (см. `pdfPlainTextIsTooShortForOcrTrigger`).
 * - **LENA_OCR_PDF_MAX_PAGES** (по умолчанию 30, макс. 120) — лимит страниц для Node; Python читает тот же env.
 * - **LENA_OCR_TESSERACT_LANG** — языки для Node `tesseract.js` и для Python CLI (по умолчанию **rus+eng**).
 * - **LENA_OCR_PDF_SCALE** (по умолчанию **3.25**) — только для ветки Node.
 * - **LENA_OCR_PDF_MOJIBAKE_CJK_RATIO** (по умолчанию **0.018**) — если доля «восточных» символов
 *   (CJK/Hangul и т.п.) среди букв превышает порог, слой считаем битым (типично подмена глифов в PDF).
 * - **LENA_OCR_PDF_FRAG_SHORT_LINE_RATIO** (по умолчанию **0.33**) — доля очень коротких непустых строк
 *   (≤3 символов), выше которой запускаем визуальный пайплайн (разметка «столбиком» после pdf-parse).
 *
 */

function ocrDisabled() {
  const v = process.env.LENA_OCR_DISABLE?.trim().toLowerCase() ?? "";
  return v === "1" || v === "true" || v === "yes";
}

function maxPages() {
  const n = Number.parseInt(process.env.LENA_OCR_PDF_MAX_PAGES?.trim() ?? "30", 10);
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(n, 120);
}

function renderScale() {
  const n = Number.parseFloat(process.env.LENA_OCR_PDF_SCALE?.trim() ?? "3.25");
  if (!Number.isFinite(n) || n < 0.5) return 3.25;
  return Math.min(n, 4);
}

function tesseractLang() {
  const s = process.env.LENA_OCR_TESSERACT_LANG?.trim();
  return s && s.length > 0 ? s : "rus+eng";
}

/**
 * Сравнение по «существенной» длине текста после pdf-parse (без повторного OCR).
 * @param {string} plainFromPdfParse
 */
export function pdfPlainTextIsTooShortForOcrTrigger(plainFromPdfParse) {
  const t = (plainFromPdfParse || "").replace(/\s+/g, " ").trim();
  const n = Number.parseInt(process.env.LENA_OCR_PDF_MIN_TEXT_CHARS?.trim() ?? "48", 10);
  const minC = Number.isFinite(n) && n >= 0 ? n : 48;
  return t.length < minC;
}

const RU_LETTERS = /[\u0400-\u04FF]/g;
const LATIN_LETTERS = /[A-Za-z]/g;
/** CJK + полная ширина + корейский — в типовом русском положении к закупке почти не встречаются; всплеск = mojibake слоя PDF. */
const MOJIBAKE_LETTERS =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffe6]/g;

function envFloat(name, def) {
  const n = Number.parseFloat(process.env[name]?.trim() ?? "");
  return Number.isFinite(n) ? n : def;
}

/**
 * Длинный текстовый слой, но с низкой долей кириллицы — типичный «битый» слой (псевдокириллица).
 * @param {string} plain
 */
export function pdfPlainTextLayerLikelyGarbageCyrillic(plain) {
  if (process.env.LENA_OCR_PDF_SKIP_CORRUPT_HEURISTIC?.trim() === "1") return false;
  const compact = (plain || "").replace(/\s+/g, "");
  if (compact.length < 200) return false;
  const cyr = (compact.match(RU_LETTERS) || []).length;
  const lat = (compact.match(LATIN_LETTERS) || []).length;
  const letters = cyr + lat;
  if (letters < 150) return false;
  return cyr / letters < 0.38;
}

/**
 * «Китайские» и т.п. символы в русскоязычном PDF — часто ошибка ToUnicode / pdf-parse, а не реальный текст.
 * @param {string} plain
 */
export function pdfPlainTextLikelyMojibakeCjk(plain) {
  if (process.env.LENA_OCR_PDF_SKIP_CORRUPT_HEURISTIC?.trim() === "1") return false;
  const compact = (plain || "").replace(/\s+/g, "");
  if (compact.length < 120) return false;
  const cyr = (compact.match(RU_LETTERS) || []).length;
  const lat = (compact.match(LATIN_LETTERS) || []).length;
  const cjk = (compact.match(MOJIBAKE_LETTERS) || []).length;
  const letters = cyr + lat + cjk;
  if (letters < 100) return false;
  const thresh = envFloat("LENA_OCR_PDF_MOJIBAKE_CJK_RATIO", 0.018);
  if (cjk / letters > thresh) return true;
  const repl = (plain.match(/\uFFFD/g) || []).length;
  if (repl >= 4 && repl > plain.length / 400) return true;
  return false;
}

/**
 * Слой с «лесенкой» из коротких строк — типично испорченный порядок/колонки после простого pdf-parse.
 * @param {string} plain
 */
export function pdfPlainTextLikelyFragmentedLines(plain) {
  const lines = (plain || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 36) return false;
  const shortCnt = lines.filter((l) => l.length <= 3).length;
  const ratio = shortCnt / lines.length;
  const fragThresh = envFloat("LENA_OCR_PDF_FRAG_SHORT_LINE_RATIO", 0.33);
  if (ratio > fragThresh) return true;
  const avg = lines.reduce((s, l) => s + l.length, 0) / lines.length;
  if (lines.length >= 60 && avg < 5.5) return true;
  return false;
}

/**
 * Нужен ли PyMuPDF / OCR вместо одного только pdf-parse.
 * @param {string} plainTrimmed
 */
export function pdfShouldRunVisualExtractPipeline(plainTrimmed) {
  if (process.env.LENA_OCR_PDF_IGNORE_TEXT_LAYER?.trim() === "1") return true;
  if (pdfPlainTextIsTooShortForOcrTrigger(plainTrimmed)) return true;
  if (pdfPlainTextLayerLikelyGarbageCyrillic(plainTrimmed)) return true;
  if (pdfPlainTextLikelyMojibakeCjk(plainTrimmed)) return true;
  if (pdfPlainTextLikelyFragmentedLines(plainTrimmed)) return true;
  return false;
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<{ text: string, error?: string, via?: string }>}
 */
export async function ocrPdfBufferLastResort(buffer) {
  if (ocrDisabled()) {
    return { text: "", error: "OCR отключён (LENA_OCR_DISABLE)" };
  }

  const py = await ocrPdfBufferViaPython(buffer);
  if (py.text.trim()) {
    return { text: py.text.trim(), via: py.via, error: py.error ? py.error : undefined };
  }

  try {
    const { createWorker, OEM, PSM } = await import("tesseract.js");
    const { createCanvas } = await import("@napi-rs/canvas");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { getDocument, GlobalWorkerOptions } = pdfjs;
    const require = createRequire(import.meta.url);
    const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;

    const data = new Uint8Array(buffer);
    const loadingTask = getDocument({
      data,
      disableFontFace: true,
      isEvalSupported: false,
    });
    const doc = await loadingTask.promise;
    const pages = Math.min(doc.numPages, maxPages());
    const scale = renderScale();

    const worker = await createWorker(tesseractLang());
    await worker.setParameters({
      tessedit_ocr_engine_mode: OEM.LSTM_ONLY,
      tessedit_pageseg_mode: PSM.AUTO,
      preserve_interword_spaces: "1",
    });

    /** @type {string[]} */
    const parts = [];
    try {
      for (let p = 1; p <= pages; p += 1) {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale });
        const w = Math.max(1, Math.floor(viewport.width));
        const h = Math.max(1, Math.floor(viewport.height));
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext("2d");
        const renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;
        const png = await canvas.encode("png");
        const { data: rec } = await worker.recognize(png);
        const t = (rec?.text && String(rec.text).trim()) || "";
        if (t) parts.push(t);
      }
    } finally {
      await worker.terminate().catch(() => {});
      await doc.destroy().catch(() => {});
    }

    const hintPy = py.error ? ` Python: ${py.error}` : "";
    const text = parts.join("\n\n").trim();
    if (text) {
      return { text, via: "tesseract-js-pdf-ocr" };
    }
    return {
      text: "",
      error: `Node OCR не дал текста.${hintPy}`.slice(0, 520),
    };
  } catch (e) {
    const c = e && typeof e === "object" && "code" in e ? String(/** @type {{ code?: string }} */ (e).code) : "";
    const hint =
      c === "ERR_MODULE_NOT_FOUND"
        ? " Установите пакеты: npm install tesseract.js pdfjs-dist @napi-rs/canvas"
        : "";
    const tail = py.error ? ` Python: ${py.error}` : "";
    return {
      text: "",
      error: `${e instanceof Error ? e.message : String(e)}${hint}${tail}`.slice(0, 520),
    };
  }
}
