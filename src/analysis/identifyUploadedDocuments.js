import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { downloadFile } from "../drive/ops.js";
import { extractBufferToText } from "../icetrade/inputDocumentsExtract.js";
import { CANONICAL_DOCUMENT_TYPES, normalizeToCanonicalDocument } from "./canonicalDocumentTypes.js";
import { fileMatchesCanonicalType } from "./resolveDocumentFormSource.js";
import { extractFirstDateIso, extractPoaExpiryDateIso } from "./verifyDocumentAvailability.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

/** @typedef {Object} IdentifiedDocument
 * @property {string} fileId
 * @property {string} fileName
 * @property {string | null} canonicalId
 * @property {string | null} title
 * @property {string | null} documentDateIso
 * @property {string | null} reportingPeriod
 * @property {boolean} needsReview
 * @property {string} [extractor]
 */

/**
 * @param {string} text
 * @returns {string | null}
 */
export function extractReportingPeriod(text) {
  const s = String(text ?? "");
  const qRoman = s.match(
    /\b(?:за\s+)?([iIvV]{1,4})\s*квартал(?:\s+(\d{4}))?\b/i,
  );
  if (qRoman) {
    const qMap = { i: 1, ii: 2, iii: 3, iv: 4 };
    const q = qMap[qRoman[1].toLowerCase()] ?? null;
    const y = qRoman[2] ?? s.match(/\b(20\d{2})\b/)?.[1];
    if (q && y) return `${y}-Q${q}`;
  }
  const qNum = s.match(/\b(?:за\s+)?(\d)\s*[-–]?\s*(?:й\s+)?квартал(?:\s+(\d{4}))?\b/i);
  if (qNum) {
    const y = qNum[2] ?? s.match(/\b(20\d{2})\b/)?.[1];
    if (y) return `${y}-Q${qNum[1]}`;
  }
  const isoQ = s.match(/\b(20\d{2})-Q([1-4])\b/i);
  if (isoQ) return `${isoQ[1]}-Q${isoQ[2]}`;
  const yearOnly = s.match(/\b(?:за|на)\s+(20\d{2})\s+г(?:од|\.)/i);
  if (yearOnly) return `${yearOnly[1]}-FY`;
  return null;
}

/**
 * @param {string} text
 * @param {string} fileName
 * @param {string[]} [scopeIds] — ограничить поиск этими canonical id
 * @returns {{ canonicalId: string, title: string, score: number } | null}
 */
export function classifyTextToCanonicalId(text, fileName, scopeIds) {
  const blob = `${fileName}\n${text}`.toLowerCase();
  /** @type {{ canonicalId: string, title: string, score: number } | null} */
  let best = null;
  for (const t of CANONICAL_DOCUMENT_TYPES) {
    if (scopeIds?.length && !scopeIds.includes(t.id)) continue;
    if (t.storage !== "org" && t.storage !== "founding") continue;
    let score = 0;
    if (fileMatchesCanonicalType(fileName, t.id)) score += 12;
    for (const syn of [t.title, ...t.synonyms]) {
      if (syn.length >= 4 && blob.includes(syn.toLowerCase())) score += 8;
    }
    if (t.id === "balance_sheet" && /форма\s*1|бухгалтерск/i.test(blob)) score += 6;
    if (t.id === "income_statement" && /форма\s*2|офр|финансовых\s+результат/i.test(blob)) score += 6;
    if (t.id === "bank_reference" && /справк\w*\s+(?:из\s+)?банк/i.test(blob)) score += 6;
    if (t.id === "power_of_attorney" && /доверенност/i.test(blob)) score += 8;
    if (t.id === "reference_list" && /отзыв|референс|reference/i.test(blob)) score += 6;
    if (!best || score > best.score) best = { canonicalId: t.id, title: t.title, score };
  }
  if (!best || best.score < 10) {
    const n = normalizeToCanonicalDocument(fileName.replace(/\.[^.]+$/, ""));
    if (n.id !== "other" && (!scopeIds?.length || scopeIds.includes(n.id))) {
      return { canonicalId: n.id, title: n.title, score: 10 };
    }
    return null;
  }
  return best;
}

/**
 * @param {string} fileId
 * @param {string} fileName
 * @param {string} [mimeType]
 * @param {{ scopeIds?: string[] }} [opts]
 * @returns {Promise<IdentifiedDocument>}
 */
export async function extractAndIdentifyDriveFile(fileId, fileName, mimeType, opts = {}) {
  const base = {
    fileId,
    fileName,
    canonicalId: null,
    title: null,
    documentDateIso: null,
    reportingPeriod: null,
    needsReview: true,
  };
  if (!fileId || mimeType === FOLDER_MIME) return base;

  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-ident-"));
  const dest = join(tmpRoot, fileName.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80));
  try {
    await downloadFile(fileId, dest);
    const buffer = await readFile(dest);
    const low = fileName.toLowerCase();
    const isImage = IMAGE_RE.test(low) || String(mimeType ?? "").startsWith("image/");
    let text = "";
    let extractor;
    if (isImage) {
      const { ocrPdfBufferLastResort } = await import("../icetrade/pdfOcrFallback.js");
      const ocr = await ocrPdfBufferLastResort(buffer);
      text = ocr.text?.trim() ?? "";
      extractor = ocr.via ?? "tesseract-image";
    } else {
      const r = await extractBufferToText(buffer, fileName, mimeType);
      text = r.text?.trim() ?? "";
      extractor = r.usedExtractor;
    }

    const hit = classifyTextToCanonicalId(text, fileName, opts.scopeIds);
    let documentDateIso = extractFirstDateIso(text) ?? extractFirstDateIso(fileName);
    if (hit?.canonicalId === "power_of_attorney") {
      documentDateIso = extractPoaExpiryDateIso(text) ?? documentDateIso;
    }
    const reportingPeriod = extractReportingPeriod(text) ?? extractReportingPeriod(fileName);

    return {
      ...base,
      canonicalId: hit?.canonicalId ?? null,
      title: hit?.title ?? null,
      documentDateIso,
      reportingPeriod,
      needsReview: !text || text.length < 40,
      extractor,
    };
  } catch {
    const hit = classifyTextToCanonicalId("", fileName, opts.scopeIds);
    return {
      ...base,
      canonicalId: hit?.canonicalId ?? null,
      title: hit?.title ?? null,
      documentDateIso: extractFirstDateIso(fileName),
      reportingPeriod: extractReportingPeriod(fileName),
      needsReview: true,
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {{ id?: string, name?: string, mimeType?: string }[]} files
 * @param {{ scopeIds?: string[], maxFiles?: number }} [opts]
 * @returns {Promise<Map<string, IdentifiedDocument>>}
 */
export async function buildUploadedFilesIndex(files, opts = {}) {
  const max = opts.maxFiles ?? 40;
  /** @type {Map<string, IdentifiedDocument>} */
  const index = new Map();
  let n = 0;
  for (const f of files) {
    if (n >= max) break;
    const id = String(f.id ?? "");
    const name = String(f.name ?? "");
    if (!id || f.mimeType === FOLDER_MIME) continue;
    n += 1;
    index.set(id, await extractAndIdentifyDriveFile(id, name, f.mimeType, opts));
  }
  return index;
}

/**
 * @param {{ id?: string, name?: string, mimeType?: string }[]} files
 * @param {Map<string, IdentifiedDocument>} index
 * @param {string} canonicalId
 */
export function findFileForCanonicalId(files, index, canonicalId) {
  for (const f of files) {
    const id = String(f.id ?? "");
    if (!id) continue;
    if (fileMatchesCanonicalType(String(f.name ?? ""), canonicalId)) return { id, name: String(f.name ?? "") };
    const identified = index.get(id);
    if (identified?.canonicalId === canonicalId) return { id, name: String(f.name ?? "") };
  }
  return null;
}

/**
 * @param {string | null | undefined} submissionDeadline
 * @returns {string | null} e.g. 2026-Q1
 */
export function computeLastReportingQuarterHint(submissionDeadline) {
  const iso = extractFirstDateIso(String(submissionDeadline ?? ""));
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  let q = Math.floor(m / 3);
  if (q === 0) {
    y -= 1;
    q = 4;
  }
  return `${y}-Q${q}`;
}

/**
 * @param {string | null | undefined} docPeriod
 * @param {string | null | undefined} expectedPeriod
 * @param {{ summary?: string } | null | undefined} rule
 */
export function isReportingPeriodValid(docPeriod, expectedPeriod, rule) {
  if (!docPeriod) return null;
  if (expectedPeriod && docPeriod === expectedPeriod) return true;
  const summary = String(rule?.summary ?? "").toLowerCase();
  if (/последн\w*\s+отчётн\w*\s+квартал|последн\w*\s+отчетн\w*\s+квартал/i.test(summary)) {
    if (expectedPeriod && docPeriod === expectedPeriod) return true;
  }
  if (docPeriod && !expectedPeriod && !summary) return true;
  if (expectedPeriod && docPeriod !== expectedPeriod) return false;
  return null;
}
