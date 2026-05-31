import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertCredentialsFile } from "../drive/config.js";
import { ensureChildFolder, findChildFolderId } from "../drive/folders.js";
import { TENDER_SUB } from "../drive/layoutConstants.js";
import {
  downloadFile,
  exportGoogleFile,
  getMetadata,
  listChildren,
  trashDriveFile,
  uploadFile,
} from "../drive/ops.js";
import { ensureTenderTree } from "../drive/workspace.js";

/**
 * Парсинг `inputs/`: правило продукта
 * - если **все** файлы читаются как текст без PDF/DOC/Office/Google-экспорта → папка **`inputs/extracted/` не создаётся** (достаточно `inputs/`);
 * - иначе → **`inputs/extracted/`** + `.txt`, **`extract-manifest.json`** (в т.ч. **`items[].ai`** для ИИ), **`AI-TEXT-SOURCES.md`**, библиотеки по цепочке (PDF → при пустом/коротком тексте **OCR** через Tesseract, DOC/DOCX, экспорт Google).
 * Аналитика: **`tender-pipeline-state.json`** в **корне папки тендера** — поля **`parsing.aiGuide`** и **`parsing.items[].ai`** (те же правила для ИИ, что и в манифесте).
 */

/** @param {unknown} e */
function npmInstallHint(e) {
  const c = e && typeof e === "object" && "code" in e ? String(/** @type {{ code?: string }} */ (e).code) : "";
  if (c === "ERR_MODULE_NOT_FOUND")
    return " установите зависимости в корне репозитория: npm install (при ошибках SSL на Windows: NODE_OPTIONS=--use-openssl-ca)";
  return "";
}

/** Подпапка в `inputs` с извлечённым текстом. */
export const INPUTS_EXTRACTED_SUBDIR = "extracted";

/**
 * Защита от неверного **LENA_DRIVE_ROOT** / рассинхрона id: не создаём `extracted` в корне «Мой диск».
 * @param {{ userRootId: string, tenderFolderId: string, inputsId: string }} p
 */
async function assertInputsFolderUnderTender(p) {
  const { userRootId, tenderFolderId, inputsId } = p;
  if (!inputsId || inputsId === userRootId) {
    throw new Error(
      "Папка **inputs** совпадает с корнем Drive — недопустимо. Укажите в **LENA_DRIVE_ROOT** тот же корень, что для `drive workspace-ensure` (родитель для `_lena/`), обычно «Мой диск» или общая папка, а не id отдельного файла.",
    );
  }
  const meta = await getMetadata(inputsId);
  const name = typeof meta.name === "string" ? meta.name : "";
  const parents = Array.isArray(meta.parents) ? meta.parents.map(String) : [];
  if (name !== TENDER_SUB.inputs || !parents.includes(tenderFolderId)) {
    throw new Error(
      [
        "Папка документов закупки (**inputs**) не лежит внутри папки тендера на Drive — извлечение остановлено, чтобы не создавать **extracted** в корне диска.",
        `Ожидалось: имя «${TENDER_SUB.inputs}», родитель — папка тендера \`${tenderFolderId}\`.`,
        `Сейчас у id каталога: имя «${name || "?"}», родители: ${parents.length ? parents.join(", ") : "—"}.`,
        "Проверьте **LENA_DRIVE_ROOT** и путь `_lena/tenders/<год>/<id>/inputs`.",
      ].join(" "),
    );
  }
}

const MANIFEST_NAME = "extract-manifest.json";

/** JSON статусов/аналитики по тендеру (корень папки закупки на Drive). */
export const TENDER_PIPELINE_STATE_NAME = "tender-pipeline-state.json";

/** Краткая таблица источников текста для людей/ИИ (только режим extracted_workspace). */
const AI_TEXT_SOURCES_MD = "AI-TEXT-SOURCES.md";

/**
 * Версия схемы блока `ai` в манифесте и в `tender-pipeline-state.json`.
 */
export const EXTRACT_AI_SCHEMA_VERSION = 1;

/**
 * Машинная разметка для ИИ: откуда читать текст, качество, OCR, подсказка.
 * @param {{
 *   mode: "native_only" | "extracted_workspace",
 *   sourceName: string,
 *   destTxtName: string,
 *   chars: number,
 *   error: string | null,
 *   usedExtractor?: string | null,
 *   truncated: boolean,
 * }} p
 */
export function buildAiMarkupForExtractItem(p) {
  const usedEx = (p.usedExtractor ?? "").trim();
  const ocr = /tesseract|ocr/i.test(usedEx);
  const errStr = p.error != null && String(p.error).trim() ? String(p.error).trim() : "";
  const hasErr = errStr.length > 0;
  const noText = p.chars === 0;

  /** @type {"failed" | "degraded" | "ocr" | "medium" | "high"} */
  let extractionQuality = "high";
  if (noText) extractionQuality = "failed";
  else if (hasErr) extractionQuality = "degraded";
  else if (ocr) extractionQuality = "ocr";
  else if (/^pdf-parse$/i.test(usedEx) && p.chars < 200) extractionQuality = "medium";

  /** @type {"none" | "native_inputs_utf8" | "extracted_txt"} */
  let textProvenance = "none";
  if (!noText) {
    textProvenance = p.mode === "extracted_workspace" ? "extracted_txt" : "native_inputs_utf8";
  }

  let canonicalTextPath = null;
  if (!noText) {
    if (p.mode === "extracted_workspace" && p.destTxtName) {
      canonicalTextPath = `inputs/extracted/${p.destTxtName}`;
    } else if (p.mode === "native_only") {
      canonicalTextPath = `inputs/${p.sourceName}`;
    }
  }

  const sourceBinaryPath = `inputs/${p.sourceName}`;
  const readOnlyThisForAnalysis = Boolean(canonicalTextPath);

  let hintForLlm = "";
  if (noText && hasErr) {
    hintForLlm =
      "Текст не извлечён — не трать токены на повторный разбор бинарника с нуля; опирайся на другие документы или запроси файл у пользователя.";
  } else if (noText) {
    hintForLlm = "Пустой текст — содержимое для анализа отсутствует.";
  } else if (ocr) {
    hintForLlm =
      "Текст получен через OCR — возможны искажения; важные цифры, суммы и даты сверяй с другими документами или оригиналом.";
  } else if (hasErr) {
    hintForLlm = "Текст извлечён с предупреждением конвертера — при критичных цитатах сверяй оригинал на Drive.";
  } else if (p.truncated) {
    hintForLlm = "Текст усечён по лимиту символов; полный объём в файле на Google Drive.";
  } else if (usedEx === "utf8") {
    hintForLlm = "Нативный текст в inputs — обычно достоверен для цитирования.";
  } else if (usedEx.startsWith("google_")) {
    hintForLlm = "Текст из экспорта Google Docs/Sheets/Slides — обычно структурно пригоден для анализа.";
  } else if (usedEx === "mammoth" || usedEx === "word-extractor") {
    hintForLlm = "Текст из DOC/DOCX — обычно пригоден; вёрстка таблиц может отличаться от PDF.";
  } else if (usedEx === "pdf-parse" || usedEx.includes("pdf-parse")) {
    hintForLlm = "Текст из текстового слоя PDF — обычно пригоден для цитирования.";
  } else {
    hintForLlm =
      "Используй canonicalTextPath как единственный источник текста для этого файла; не дублируй извлечение из бинарного оригинала.";
  }

  return {
    schemaVersion: EXTRACT_AI_SCHEMA_VERSION,
    canonicalTextPath,
    sourceBinaryPath,
    textProvenance,
    readOnlyThisForAnalysis,
    usedOcr: ocr,
    extractionQuality,
    truncated: p.truncated,
    parsingWarning: hasErr && !noText,
    hintForLlm,
  };
}

/**
 * Общие правила для промпта (дублируются в manifest и pipeline state).
 */
function buildExtractAiGuide(mode) {
  return {
    schemaVersion: EXTRACT_AI_SCHEMA_VERSION,
    mode,
    summaryForLlm:
      "Для каждого входного файла смотри items[].ai: поле canonicalTextPath задаёт, где лежит уже извлечённый текст. Не пытайся заново «читать» PDF/DOCX из inputs/, если для этой записи есть непустой canonicalTextPath в extracted.",
    rules: [
      "Читай текст только по canonicalTextPath (или из native inputs для режима без extracted).",
      "Если extractionQuality = failed — не выдумывай содержимое файла.",
      "Если extractionQuality = ocr или degraded — осторожнее с точными числами и таблицами.",
      "Если usedOcr = true — считай текст оптически распознанным.",
      "Используй hintForLlm по каждому файлу как краткую политику доверия.",
    ],
  };
}

/**
 * Краткий Markdown-обзор для папки extracted (удобно открыть в Drive).
 * @param {"native_only" | "extracted_workspace"} mode
 * @param {Array<{ sourceName: string, ai?: unknown }>} items
 */
function buildAiTextSourcesMarkdown(mode, items) {
  const lines = [
    "# Источники текста для анализа (авто, Лена / tender-prep)",
    "",
    `Режим: **${mode}**. Подробности в **extract-manifest.json** (\`items[].ai\`, \`aiGuide\`).`,
    "",
    "| Исходный файл (inputs) | Текст для ИИ | Качество | OCR |",
    "| --- | --- | --- | --- |",
  ];
  for (const i of items) {
    const ai = /** @type {{ canonicalTextPath?: string | null; extractionQuality?: string; usedOcr?: boolean } | undefined} */ (
      i.ai
    );
    const path = ai?.canonicalTextPath ?? "—";
    const q = ai?.extractionQuality ?? "—";
    const ocr = ai?.usedOcr ? "да" : "нет";
    const name = String(i.sourceName ?? "").replace(/\|/g, "\\|");
    lines.push(`| ${name} | ${String(path).replace(/\|/g, "\\|")} | ${q} | ${ocr} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * @param {string} name
 */
function safeSlug(name) {
  return (
    String(name)
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .slice(0, 120)
      .trim() || "file"
  );
}

/**
 * @typedef {'folder' | 'skip' | 'native_utf8' | 'binary_office' | 'google_doc' | 'google_sheet' | 'google_slides' | 'google_other' | 'unknown'} InputParseKind
 */

/**
 * Классификация файла в `inputs/` для решения, нужна ли зона `extracted/`.
 * @param {string} mimeType
 * @param {string} name
 * @returns {{ kind: InputParseKind }}
 */
export function classifyInputFileForParsing(mimeType, name) {
  const mime = (mimeType || "").toLowerCase();
  const low = name.toLowerCase();

  if (mime === "application/vnd.google-apps.folder") return { kind: "folder" };
  if (!name || name === MANIFEST_NAME) return { kind: "skip" };

  if (mime === "application/vnd.google-apps.document") return { kind: "google_doc" };
  if (mime === "application/vnd.google-apps.spreadsheet") return { kind: "google_sheet" };
  if (mime === "application/vnd.google-apps.presentation") return { kind: "google_slides" };
  if (mime.startsWith("application/vnd.google-apps.")) return { kind: "google_other" };

  if (mime.includes("pdf") || low.endsWith(".pdf")) return { kind: "binary_office" };
  if (
    mime.includes("wordprocessingml") ||
    low.endsWith(".docx") ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return { kind: "binary_office" };
  }
  if (mime.includes("msword") || low.endsWith(".doc")) return { kind: "binary_office" };

  if (
    mime.startsWith("text/") ||
    low.endsWith(".txt") ||
    low.endsWith(".md") ||
    low.endsWith(".csv") ||
    low.endsWith(".log") ||
    low.endsWith(".json") ||
    low.endsWith(".xml") ||
    low.endsWith(".html") ||
    low.endsWith(".htm")
  ) {
    return { kind: "native_utf8" };
  }
  if (mime === "application/json" || mime === "application/xml") return { kind: "native_utf8" };

  return { kind: "unknown" };
}

/**
 * @param {InputParseKind} kind
 */
function kindNeedsExtractedWorkspace(kind) {
  return kind !== "native_utf8" && kind !== "folder" && kind !== "skip";
}

/**
 * Извлечь текст из буфера (PDF / DOC / DOCX / plain).
 * @param {Buffer} buffer
 * @param {string} name — имя файла (расширение важно)
 * @param {string} [mimeType]
 * @returns {Promise<{ text: string, error?: string, usedExtractor?: string }>}
 */
export async function extractBufferToText(buffer, name, mimeType) {
  const low = name.toLowerCase();
  const mime = (mimeType || "").toLowerCase();

  try {
    if (mime.includes("pdf") || low.endsWith(".pdf")) {
      const pdfParseMod = await import("pdf-parse");
      const pdfParse = /** @type {(b: Buffer, o?: object) => Promise<{ text?: string }>} */ (
        pdfParseMod.default ?? pdfParseMod
      );
      /** @type {string} */
      let rawPdfText = "";
      /** @type {string | undefined} */
      let pdfParseErr;
      try {
        const res = await pdfParse(buffer);
        rawPdfText = (res?.text && String(res.text)) || "";
      } catch (pe) {
        pdfParseErr = pe instanceof Error ? pe.message : String(pe);
        rawPdfText = "";
      }
      const trimmedPdf = rawPdfText.trim();
      const { pdfShouldRunVisualExtractPipeline, ocrPdfBufferLastResort } = await import("./pdfOcrFallback.js");
      if (!pdfShouldRunVisualExtractPipeline(trimmedPdf) && trimmedPdf.length > 0) {
        return { text: trimmedPdf, usedExtractor: "pdf-parse" };
      }
      const ocr = await ocrPdfBufferLastResort(buffer);
      if (ocr.text.trim()) {
        const via = (ocr.via && String(ocr.via).trim()) || "tesseract-pdf-ocr";
        const usedExtractor = trimmedPdf.length > 0 ? `pdf-parse+${via}` : via;
        return {
          text: ocr.text.trim(),
          usedExtractor,
          error: ocr.error ? `OCR: ${ocr.error}` : undefined,
        };
      }
      if (trimmedPdf.length > 0) {
        return {
          text: trimmedPdf,
          usedExtractor: "pdf-parse",
          error: ocr.error ? `OCR: ${ocr.error}` : undefined,
        };
      }
      return {
        text: "",
        usedExtractor: undefined,
        error:
          [pdfParseErr, ocr.error].filter(Boolean).join("; ").slice(0, 520) ||
          "PDF: нет текстового слоя или OCR не дал результата (проверьте зависимости: npm install tesseract.js pdfjs-dist @napi-rs/canvas).",
      };
    }
    if (
      mime.includes("wordprocessingml") ||
      low.endsWith(".docx") ||
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const mammoth = (await import("mammoth")).default;
      const r = await mammoth.extractRawText({ buffer });
      return { text: (r.value || "").trim(), usedExtractor: "mammoth" };
    }
    if (mime.includes("msword") || low.endsWith(".doc")) {
      const weMod = await import("word-extractor");
      const WordExtractor = /** @type {new () => { extract: (p: string) => Promise<{ getBody: () => string }> }} */ (
        weMod.default ?? weMod
      );
      const root = await mkdtemp(join(tmpdir(), "lena-doc-"));
      const path = join(root, safeSlug(name).replace(/\.[^.]+$/, "") + ".doc");
      try {
        await writeFile(path, buffer);
        const extractor = new WordExtractor();
        const doc = await extractor.extract(path);
        const body = doc.getBody();
        return { text: (body || "").trim(), usedExtractor: "word-extractor" };
      } finally {
        await rm(root, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (
      mime.startsWith("text/") ||
      low.endsWith(".txt") ||
      low.endsWith(".md") ||
      low.endsWith(".csv") ||
      low.endsWith(".log") ||
      low.endsWith(".json") ||
      low.endsWith(".xml") ||
      low.endsWith(".html") ||
      low.endsWith(".htm")
    ) {
      return { text: buffer.toString("utf8").trim(), usedExtractor: "utf8" };
    }
    return { text: "", error: `формат не поддерживается для авто-текста (${mime || low})` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = npmInstallHint(e);
    return { text: "", error: `${msg.slice(0, 480)}${hint}` };
  }
}

/**
 * @param {string} fileId
 * @param {string} mimeType
 * @param {string} tmpRoot
 */
async function googleMimeToExportedText(fileId, mimeType, tmpRoot) {
  const mime = (mimeType || "").toLowerCase();
  if (mime === "application/vnd.google-apps.document") {
    const dest = join(tmpRoot, `gdoc-${fileId.slice(0, 12)}.txt`);
    await exportGoogleFile(fileId, "text/plain", dest);
    return { text: (await readFile(dest, "utf8")).trim(), usedExtractor: "google_docs_export_text_plain" };
  }
  if (mime === "application/vnd.google-apps.spreadsheet") {
    const dest = join(tmpRoot, `gs-${fileId.slice(0, 12)}.csv`);
    await exportGoogleFile(fileId, "text/csv", dest);
    return { text: (await readFile(dest, "utf8")).trim(), usedExtractor: "google_sheets_export_csv" };
  }
  if (mime === "application/vnd.google-apps.presentation") {
    const dest = join(tmpRoot, `gsl-${fileId.slice(0, 12)}.txt`);
    await exportGoogleFile(fileId, "text/plain", dest);
    return { text: (await readFile(dest, "utf8")).trim(), usedExtractor: "google_slides_export_text_plain" };
  }
  return {
    text: "",
    error: `экспорт Google не реализован для типа: ${mimeType}`,
    usedExtractor: "google_other_unsupported",
  };
}

/**
 * @param {string} tenderFolderId
 * @param {string} tmpRoot
 */
async function loadPreviousTenderPipelineState(tenderFolderId, tmpRoot) {
  const kids = await listChildren(tenderFolderId);
  const st = kids.find((f) => String(f.name) === TENDER_PIPELINE_STATE_NAME);
  if (!st?.id) return {};
  const path = join(tmpRoot, "prev-pipeline-state.json");
  try {
    await downloadFile(String(st.id), path);
    const raw = await readFile(path, "utf8");
    const o = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/**
 * Прочитать `tender-pipeline-state.json` из корня папки тендера на Drive (после парсинга inputs).
 * @param {string} tenderFolderId
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function readTenderPipelineState(tenderFolderId) {
  assertCredentialsFile();
  const kids = await listChildren(tenderFolderId);
  const st = kids.find((f) => String(f.name) === TENDER_PIPELINE_STATE_NAME);
  if (!st?.id) return null;
  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-pipeline-read-"));
  try {
    const path = join(tmpRoot, TENDER_PIPELINE_STATE_NAME);
    await downloadFile(String(st.id), path);
    const raw = await readFile(path, "utf8");
    const o = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? /** @type {Record<string, unknown>} */ (o) : null;
  } catch {
    return null;
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {Record<string, unknown>} prev
 * @param {Record<string, unknown>} patch
 */
function mergePipelineState(prev, patch) {
  const base = prev && typeof prev === "object" && !Array.isArray(prev) ? { ...prev } : {};
  Object.assign(base, patch);
  return base;
}

/**
 * @param {string} tenderFolderId
 * @param {Record<string, unknown>} stateObj
 * @param {string} tmpRoot
 */
async function persistTenderPipelineState(tenderFolderId, stateObj, tmpRoot) {
  const path = join(tmpRoot, `upload-${TENDER_PIPELINE_STATE_NAME}`);
  await writeFile(path, JSON.stringify(stateObj, null, 2), "utf8");
  const kids = await listChildren(tenderFolderId);
  const old = kids.find((f) => String(f.name) === TENDER_PIPELINE_STATE_NAME);
  if (old?.id) {
    try {
      await trashDriveFile(String(old.id));
    } catch {
      /* ignore */
    }
  }
  await uploadFile(tenderFolderId, path, TENDER_PIPELINE_STATE_NAME);
}

/**
 * Элемент extract-manifest / pipeline: источник → извлечённый текст + блок ai для ИИ.
 * @typedef {{
 *   sourceFileId: string,
 *   sourceName: string,
 *   mimeType: string,
 *   classification: string,
 *   chars: number,
 *   destName?: string,
 *   error?: string | null,
 *   usedExtractor?: string | null,
 *   ai: Record<string, unknown>,
 * }} ExtractManifestItem
 */

/**
 * Скачать вложения из `inputs` (кроме служебной `extracted/`), при необходимости — в `inputs/extracted/`.
 * Если все файлы «нативный текст» — `extracted/` не создаётся (старая удаляется в корзину).
 *
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {{ flat?: boolean; year?: string }} [opts]
 * @returns {Promise<{ manifest: Record<string, unknown>, extractedFolderId: string | null, inputsId: string, items: ExtractManifestItem[], mode: 'native_only' | 'extracted_workspace', tenderFolderId: string }>}
 */
export async function extractTenderInputDocumentsToExtracted(userRootId, tenderId, opts = {}) {
  assertCredentialsFile();

  const maxFiles =
    Number.parseInt(process.env.LENA_INPUT_EXTRACT_MAX_FILES?.trim() ?? "40", 10) || 40;
  const maxRaw = (process.env.LENA_INPUT_EXTRACT_MAX_CHARS?.trim() ?? "1200000").replace(
    /_/g,
    "",
  );
  const maxTextPerFile = Number.parseInt(maxRaw, 10) || 1_200_000;

  const { tender } = await ensureTenderTree(userRootId, tenderId, opts);
  const inputsId = tender.inputsId;
  const tenderFolderId = tender.folderId;
  await assertInputsFolderUnderTender({ userRootId, tenderFolderId, inputsId });

  const topLevel = await listChildren(inputsId);
  /** @type {{ id: string; name: string; mime: string; kind: InputParseKind }[]} */
  const work = [];
  for (const f of topLevel) {
    const mime = typeof f.mimeType === "string" ? f.mimeType : "";
    const id = String(f.id ?? "");
    const name = String(f.name ?? "file");
    if (mime === "application/vnd.google-apps.folder") continue;
    if (name === INPUTS_EXTRACTED_SUBDIR) continue;
    if (!id || !name || name === MANIFEST_NAME) continue;
    const { kind } = classifyInputFileForParsing(mime, name);
    if (kind === "folder" || kind === "skip") continue;
    work.push({ id, name, mime, kind });
  }

  const needsExtracted = work.length > 0 && work.some((w) => kindNeedsExtractedWorkspace(w.kind));

  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-inex-"));
  /** @type {ExtractManifestItem[]} */
  const items = [];
  /** @type {Set<string>} */
  const usedExtractors = new Set();

  try {
    const prevState = await loadPreviousTenderPipelineState(tenderFolderId, tmpRoot);

    /**
     * @param {string} id
     * @param {string} name
     * @param {string} mimeType
     * @param {InputParseKind} classification
     * @param {string} slice
     * @param {string} destTxtName
     * @param {string | null} error
     * @param {string | undefined} usedEx
     */
    function pushItem(id, name, mimeType, classification, slice, destTxtName, error, usedEx) {
      if (usedEx) usedExtractors.add(usedEx);
      const truncated = slice.includes("…[усечено");
      const errNorm = error == null || error === "" ? null : error;
      const destNorm = destTxtName || "";
      const ai = buildAiMarkupForExtractItem({
        mode: needsExtracted ? "extracted_workspace" : "native_only",
        sourceName: name,
        destTxtName: destNorm,
        chars: slice.length,
        error: errNorm,
        usedExtractor: usedEx ?? null,
        truncated,
      });
      items.push({
        sourceFileId: id,
        sourceName: name,
        mimeType,
        classification,
        chars: slice.length,
        destName: destNorm || undefined,
        error: errNorm,
        usedExtractor: usedEx ?? null,
        ai,
      });
    }

    if (!needsExtracted) {
      const existingExtracted = await findChildFolderId(inputsId, INPUTS_EXTRACTED_SUBDIR);
      if (existingExtracted) {
        try {
          await trashDriveFile(existingExtracted);
        } catch {
          /* ignore */
        }
      }

      let n = 0;
      for (const w of work) {
        if (n >= maxFiles) break;
        n += 1;
        const { id, name, mime } = w;
        const destBin = join(tmpRoot, `native-${id}-${safeSlug(name)}`);
        try {
          await downloadFile(id, destBin);
        } catch (e) {
          pushItem(
            id,
            name,
            mime,
            w.kind,
            "",
            "",
            e instanceof Error ? e.message.slice(0, 400) : String(e),
            undefined,
          );
          continue;
        }
        const buf = await readFile(destBin);
        let slice = buf.toString("utf8").trim();
        if (slice.length > maxTextPerFile) {
          slice = `${slice.slice(0, maxTextPerFile)}\n\n…[усечено ${maxTextPerFile} симв.]`;
        }
        if (!slice.length) {
          pushItem(id, name, mime, w.kind, "", "", "пустой текст", "utf8");
          continue;
        }
        pushItem(id, name, mime, w.kind, slice, "", null, "utf8");
      }

      const okN = items.filter((i) => !i.error).length;
      const errN = items.filter((i) => i.error).length;
      /** @type {Record<string, unknown>} */
      const manifest = {
        updatedAt: new Date().toISOString(),
        tenderId,
        mode: "native_only",
        inputsFolderId: inputsId,
        extractedFolderId: null,
        aiGuide: buildExtractAiGuide("native_only"),
        items,
      };

      const stateObj = mergePipelineState(prevState, {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        tenderId,
        tenderRootFolderId: tenderFolderId,
        parsing: {
          lastRunAt: new Date().toISOString(),
          lastAction: "parse_inputs",
          mode: "native_only",
          aiGuide: buildExtractAiGuide("native_only"),
          reason:
            work.length === 0
              ? "inputs пуст — extracted не создаётся"
              : "все файлы в inputs читаются как текст без PDF/DOC/Google-экспорта — extracted не создаётся",
          inputsFolderId: inputsId,
          extractedFolderId: null,
          usedExtractors: [...usedExtractors],
          counts: { total: items.length, ok: okN, errors: errN },
          items: items.map((i) => ({
            driveFileId: i.sourceFileId,
            name: i.sourceName,
            mimeType: i.mimeType,
            classification: i.classification,
            status: i.error ? "error" : "ok",
            chars: i.chars,
            error: i.error ?? undefined,
            usedExtractor: i.usedExtractor ?? undefined,
            ai: i.ai,
          })),
        },
      });

      await persistTenderPipelineState(tenderFolderId, stateObj, tmpRoot);

      return {
        manifest,
        extractedFolderId: null,
        inputsId,
        items,
        mode: /** @type {"native_only"} */ ("native_only"),
        tenderFolderId,
      };
    }

    const { id: extractedId } = await ensureChildFolder(inputsId, INPUTS_EXTRACTED_SUBDIR);
    const existingExtracted = await listChildren(extractedId);
    const byName = new Map(existingExtracted.map((f) => [String(f.name ?? ""), String(f.id ?? "")]));

    let n = 0;
    for (const w of work) {
      if (n >= maxFiles) break;
      n += 1;
      const { id, name, mime, kind } = w;
      const destTxtName = `extract-${id}.txt`;
      const oldId = byName.get(destTxtName);
      if (oldId) {
        try {
          await trashDriveFile(oldId);
        } catch {
          /* ignore */
        }
        byName.delete(destTxtName);
      }

      let slice = "";
      /** @type {string | null} */
      let err = null;
      /** @type {string | undefined} */
      let usedEx;

      try {
        if (
          kind === "google_doc" ||
          kind === "google_sheet" ||
          kind === "google_slides" ||
          kind === "google_other"
        ) {
          const g = await googleMimeToExportedText(id, mime, tmpRoot);
          slice = g.text;
          usedEx = g.usedExtractor;
          err = g.error ?? null;
          if (!slice.length && !err) err = "пустой текст после экспорта";
        } else if (kind === "native_utf8") {
          const destBin = join(tmpRoot, `src-${id}-${safeSlug(name)}`);
          await downloadFile(id, destBin);
          const buf = await readFile(destBin);
          slice = buf.toString("utf8").trim();
          usedEx = "utf8";
        } else {
          const destBin = join(tmpRoot, `src-${id}-${safeSlug(name)}`);
          await downloadFile(id, destBin);
          const buf = await readFile(destBin);
          const r = await extractBufferToText(buf, name, mime);
          slice = r.text;
          usedEx = r.usedExtractor;
          if (r.error && !slice.length) err = r.error;
          else if (r.error) err = r.error;
        }
      } catch (e) {
        err = e instanceof Error ? e.message.slice(0, 400) : String(e);
      }

      if (slice.length > maxTextPerFile) {
        slice = `${slice.slice(0, maxTextPerFile)}\n\n…[усечено ${maxTextPerFile} симв.]`;
      }

      if (err && !slice.length) {
        pushItem(id, name, mime, kind, "", destTxtName, err, usedEx);
        continue;
      }
      if (!slice.length) {
        pushItem(id, name, mime, kind, "", destTxtName, err ?? "пустой текст", usedEx);
        continue;
      }

      const txtPath = join(tmpRoot, destTxtName);
      await writeFile(txtPath, slice, "utf8");
      await uploadFile(extractedId, txtPath, destTxtName);

      pushItem(id, name, mime, kind, slice, destTxtName, null, usedEx);
    }

    /** @type {Record<string, unknown>} */
    const manifest = {
      updatedAt: new Date().toISOString(),
      tenderId,
      mode: "extracted_workspace",
      inputsFolderId: inputsId,
      extractedFolderId: extractedId,
      aiGuide: buildExtractAiGuide("extracted_workspace"),
      items,
    };

    const manDir = await mkdtemp(join(tmpdir(), "lena-man-"));
    const manPath = join(manDir, MANIFEST_NAME);
    await writeFile(manPath, JSON.stringify(manifest, null, 2), "utf8");
    try {
      const oldManId = (await listChildren(extractedId)).find((f) => f.name === MANIFEST_NAME)?.id;
      if (oldManId) {
        await trashDriveFile(String(oldManId));
      }
    } catch {
      /* ignore */
    }
    await uploadFile(extractedId, manPath, MANIFEST_NAME);
    await rm(manDir, { recursive: true, force: true }).catch(() => {});

    const mdDir = await mkdtemp(join(tmpdir(), "lena-aimd-"));
    const mdPath = join(mdDir, AI_TEXT_SOURCES_MD);
    await writeFile(mdPath, buildAiTextSourcesMarkdown("extracted_workspace", items), "utf8");
    try {
      const oldAiMd = (await listChildren(extractedId)).find((f) => f.name === AI_TEXT_SOURCES_MD)?.id;
      if (oldAiMd) {
        await trashDriveFile(String(oldAiMd));
      }
    } catch {
      /* ignore */
    }
    await uploadFile(extractedId, mdPath, AI_TEXT_SOURCES_MD);
    await rm(mdDir, { recursive: true, force: true }).catch(() => {});

    const okN = items.filter((i) => !i.error).length;
    const errN = items.filter((i) => i.error).length;

    const stateObj = mergePipelineState(prevState, {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      tenderId,
      tenderRootFolderId: tenderFolderId,
      parsing: {
        lastRunAt: new Date().toISOString(),
        lastAction: "parse_inputs",
        mode: "extracted_workspace",
        aiGuide: buildExtractAiGuide("extracted_workspace"),
        reason:
          "есть файлы, требующие PDF/DOC/DOCX/Google-экспорта или неизвестного извлечения — создана inputs/extracted",
        inputsFolderId: inputsId,
        extractedFolderId: extractedId,
        usedExtractors: [...usedExtractors],
        counts: { total: items.length, ok: okN, errors: errN },
        items: items.map((i) => ({
          driveFileId: i.sourceFileId,
          name: i.sourceName,
          mimeType: i.mimeType,
          classification: i.classification,
          status: i.error ? "error" : "ok",
          destTxtName: i.destName,
          chars: i.chars,
          error: i.error ?? undefined,
          usedExtractor: i.usedExtractor ?? undefined,
          ai: i.ai,
        })),
      },
    });

    await persistTenderPipelineState(tenderFolderId, stateObj, tmpRoot);

    return {
      manifest,
      extractedFolderId: extractedId,
      inputsId,
      items,
      mode: /** @type {"extracted_workspace"} */ ("extracted_workspace"),
      tenderFolderId,
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Собрать связный текст из `inputs/extracted/*.txt` (без manifest).
 * @param {string} extractedFolderId
 * @param {number} [maxTotalChars]
 */
export async function readExtractedTextsConcat(extractedFolderId, maxTotalChars = 95_000) {
  assertCredentialsFile();
  const files = await listChildren(extractedFolderId);
  const txts = files
    .filter((f) => {
      const n = String(f.name ?? "");
      return n.endsWith(".txt") && n !== MANIFEST_NAME;
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "ru"));

  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-conc-"));
  /** @type {string[]} */
  const parts = [];
  let total = 0;
  try {
    for (const f of txts) {
      const id = String(f.id ?? "");
      const name = String(f.name ?? "");
      if (!id) continue;
      if (total >= maxTotalChars) break;
      const dest = join(tmpRoot, safeSlug(name));
      try {
        await downloadFile(id, dest);
      } catch {
        continue;
      }
      const raw = await readFile(dest, "utf8");
      const header = `\n\n=== ${name} ===\n`;
      const budget = maxTotalChars - total - header.length;
      if (budget <= 0) break;
      const chunk = raw.length > budget ? `${raw.slice(0, budget)}\n…[файл усечён]` : raw;
      parts.push(header + chunk);
      total += header.length + chunk.length;
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
  return parts.join("").trim();
}

/**
 * Только «нативный» текст из корня `inputs/` (без вложенных папок и без `extracted/`-каталога как файла).
 * @param {string} inputsId
 * @param {number} [maxTotalChars]
 */
export async function readNativeInputsTextsConcat(inputsId, maxTotalChars = 95_000) {
  assertCredentialsFile();
  const top = await listChildren(inputsId);
  /** @type {{ id: string; name: string }[]} */
  const nat = [];
  for (const f of top) {
    const mime = typeof f.mimeType === "string" ? f.mimeType : "";
    const id = String(f.id ?? "");
    const name = String(f.name ?? "");
    if (!id || !name) continue;
    if (mime === "application/vnd.google-apps.folder") continue;
    if (name === INPUTS_EXTRACTED_SUBDIR) continue;
    if (name === MANIFEST_NAME) continue;
    const { kind } = classifyInputFileForParsing(mime, name);
    if (kind !== "native_utf8") continue;
    nat.push({ id, name });
  }
  nat.sort((a, b) => a.name.localeCompare(b.name, "ru"));

  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-native-"));
  /** @type {string[]} */
  const parts = [];
  let total = 0;
  try {
    for (const { id, name } of nat) {
      if (total >= maxTotalChars) break;
      const dest = join(tmpRoot, safeSlug(name));
      try {
        await downloadFile(id, dest);
      } catch {
        continue;
      }
      const raw = (await readFile(dest, "utf8")).trim();
      const header = `\n\n=== ${name} ===\n`;
      const budget = maxTotalChars - total - header.length;
      if (budget <= 0) break;
      const chunk = raw.length > budget ? `${raw.slice(0, budget)}\n…[файл усечён]` : raw;
      parts.push(header + chunk);
      total += header.length + chunk.length;
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
  return parts.join("").trim();
}

/**
 * Корпус для LLM: при наличии непустого `inputs/extracted` — оттуда, иначе только нативный текст из `inputs/`.
 * @param {string} inputsId
 * @param {number} [maxTotalChars]
 * @returns {Promise<{ source: 'extracted' | 'inputs_native', text: string }>}
 */
export async function resolveTenderDocumentCorpus(inputsId, maxTotalChars = 95_000) {
  assertCredentialsFile();
  const extractedId = await findChildFolderId(inputsId, INPUTS_EXTRACTED_SUBDIR);
  if (extractedId) {
    const kids = await listChildren(extractedId);
    const hasTxt = kids.some((f) => {
      const n = String(f.name ?? "");
      return n.endsWith(".txt") && n !== MANIFEST_NAME;
    });
    if (hasTxt) {
      const text = await readExtractedTextsConcat(extractedId, maxTotalChars);
      if (text.length) return { source: /** @type {"extracted"} */ ("extracted"), text };
    }
  }
  const text = await readNativeInputsTextsConcat(inputsId, maxTotalChars);
  return { source: /** @type {"inputs_native"} */ ("inputs_native"), text };
}
