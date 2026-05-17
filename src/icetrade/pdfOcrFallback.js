import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * OCR по PDF — **последняя очередь**: после `pdf-parse`, если текст пустой/слишком короткий
 * или парсер упал (часто скан без текстового слоя).
 *
 * Зависимости: `tesseract.js`, `pdfjs-dist`, `@napi-rs/canvas` — `npm install`.
 *
 * Переменные окружения:
 * - **LENA_OCR_DISABLE** = 1 — не вызывать OCR.
 * - **LENA_OCR_PDF_MIN_TEXT_CHARS** (по умолчанию 48) — если `pdf-parse` дал меньше непустых символов, запускаем OCR.
 * - **LENA_OCR_PDF_MAX_PAGES** (по умолчанию 30, макс. 80) — лимит страниц (скорость/память).
 * - **LENA_OCR_PDF_SCALE** (по умолчанию 1.75) — масштаб рендера страницы (качество vs скорость).
 * - **LENA_OCR_LANG** (по умолчанию `rus+eng`) — языки Tesseract.
 */

function ocrDisabled() {
  const v = process.env.LENA_OCR_DISABLE?.trim().toLowerCase() ?? "";
  return v === "1" || v === "true" || v === "yes";
}

function minTextChars() {
  const n = Number.parseInt(process.env.LENA_OCR_PDF_MIN_TEXT_CHARS?.trim() ?? "48", 10);
  return Number.isFinite(n) && n >= 0 ? n : 48;
}

function maxPages() {
  const n = Number.parseInt(process.env.LENA_OCR_PDF_MAX_PAGES?.trim() ?? "30", 10);
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(n, 80);
}

function renderScale() {
  const n = Number.parseFloat(process.env.LENA_OCR_PDF_SCALE?.trim() ?? "1.75");
  if (!Number.isFinite(n) || n < 0.5) return 1.75;
  return Math.min(n, 3);
}

function ocrLang() {
  return process.env.LENA_OCR_LANG?.trim() || "rus+eng";
}

/**
 * Сравнение по «существенной» длине текста после pdf-parse (без повторного OCR).
 * @param {string} plainFromPdfParse
 */
export function pdfPlainTextIsTooShortForOcrTrigger(plainFromPdfParse) {
  const t = (plainFromPdfParse || "").replace(/\s+/g, " ").trim();
  return t.length < minTextChars();
}

/**
 * Рендер страниц PDF в растр и распознавание Tesseract.
 * @param {Buffer} buffer
 * @returns {Promise<{ text: string, error?: string }>}
 */
export async function ocrPdfBufferLastResort(buffer) {
  if (ocrDisabled()) {
    return { text: "", error: "OCR отключён (LENA_OCR_DISABLE)" };
  }

  try {
    const { createCanvas } = await import("@napi-rs/canvas");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { createWorker } = await import("tesseract.js");

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
    const lang = ocrLang();

    const worker = await createWorker(lang);
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

    return { text: parts.join("\n\n").trim() };
  } catch (e) {
    const c = e && typeof e === "object" && "code" in e ? String(/** @type {{ code?: string }} */ (e).code) : "";
    const hint =
      c === "ERR_MODULE_NOT_FOUND"
        ? " Установите пакеты: npm install tesseract.js pdfjs-dist @napi-rs/canvas"
        : "";
    return {
      text: "",
      error: `${e instanceof Error ? e.message : String(e)}${hint}`.slice(0, 520),
    };
  }
}
