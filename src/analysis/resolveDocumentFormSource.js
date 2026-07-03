import { findChildFolderId } from "../drive/folders.js";
import { getMetadata, listChildren } from "../drive/ops.js";
import { LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG } from "../drive/layoutConstants.js";
import { listTemplateFiles } from "../drive/workspace.js";
import { getCanonicalTypeById } from "./canonicalDocumentTypes.js";

const FORM_HINT_RE = /(?:форма|образец|бланк|приложени\w*)/i;
const DOC_EXTENSIONS = /\.(docx?|rtf|odt|pdf)$/i;
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** @typedef {"customer" | "template" | "missing"} FormSourceKind */

/**
 * @typedef {Object} DocumentFormSource
 * @property {FormSourceKind} formSource
 * @property {string} canonicalId
 * @property {string} title
 * @property {string} [driveFileId]
 * @property {string} [fileName]
 * @property {string} [webViewLink]
 */

/**
 * @param {string} name
 */
export function normalizeFormFileStem(name) {
  return String(name)
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

/**
 * @param {string} fileName
 * @param {string} canonicalId
 */
export function fileMatchesCanonicalType(fileName, canonicalId) {
  const canon = getCanonicalTypeById(canonicalId);
  if (!canon) return false;
  const stem = normalizeFormFileStem(fileName);
  const needles = [canon.title, ...canon.synonyms].map((s) => s.toLowerCase());
  return needles.some((n) => n.length >= 4 && stem.includes(n));
}

/**
 * @param {string} fileName
 * @param {string} canonicalId
 * @param {string} [corpus]
 */
export function scoreCustomerFormFile(fileName, canonicalId, corpus = "") {
  if (!DOC_EXTENSIONS.test(fileName) && !/\.doc/i.test(fileName)) return 0;
  let score = 0;
  if (fileMatchesCanonicalType(fileName, canonicalId)) score += 10;
  if (FORM_HINT_RE.test(fileName)) score += 3;
  const stem = normalizeFormFileStem(fileName);
  if (corpus && corpus.toLowerCase().includes(stem.slice(0, Math.min(40, stem.length)))) score += 5;
  return score;
}

/**
 * @param {string} canonicalId
 * @param {string} [attachedFormHint]
 * @param {{ name?: string, id?: string, mimeType?: string }[]} inputFiles
 * @param {string} [corpus]
 */
export function pickBestCustomerFormFile(inputFiles, canonicalId, corpus = "", attachedFormHint = "") {
  const hint = attachedFormHint.trim().toLowerCase();
  /** @type {{ id: string, name: string, score: number } | null} */
  let best = null;
  for (const f of inputFiles) {
    const name = String(f.name ?? "");
    const id = String(f.id ?? "");
    if (!id || f.mimeType === FOLDER_MIME) continue;
    if (hint && name.toLowerCase().includes(hint)) {
      return { id, name, score: 100 };
    }
    const score = scoreCustomerFormFile(name, canonicalId, corpus);
    if (!best || score > best.score) best = { id, name, score };
  }
  if (best && best.score >= 10) return best;
  return null;
}

/**
 * @param {{ name?: string, id?: string, mimeType?: string, modifiedTime?: string }[]} candidates
 * @param {string} canonicalId
 * @param {"best_match" | "most_complete"} strategy
 */
export function pickBestTemplateFile(candidates, canonicalId, strategy = "best_match") {
  /** @type {{ id: string, name: string, score: number }[]} */
  const matches = [];
  for (const f of candidates) {
    const name = String(f.name ?? "");
    const id = String(f.id ?? "");
    if (!id) continue;
    if (
      fileMatchesCanonicalType(name, canonicalId) ||
      name.toLowerCase().startsWith(`${canonicalId}__`)
    ) {
      let score = 10;
      if (strategy === "most_complete") {
        score += Math.min(name.length, 200);
        if (f.modifiedTime) score += 0.001 * Date.parse(f.modifiedTime);
      }
      matches.push({ id, name, score });
    }
  }
  if (!matches.length) return null;
  matches.sort((a, b) => b.score - a.score);
  return matches[0];
}

/**
 * Приоритет: форма заказчика в inputs → шаблон org в _lena/templates → missing.
 * @param {string} userRootId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {{ id: string, title: string, rawName?: string }} doc
 * @param {{ inputFiles?: { name?: string, id?: string, mimeType?: string }[], corpus?: string, attachedFormHint?: string, pickTemplateStrategy?: "best_match" | "most_complete" }} [opts]
 * @returns {Promise<DocumentFormSource>}
 */
export async function resolveDocumentFormSource(userRootId, offerOrg, doc, opts = {}) {
  const {
    inputFiles = [],
    corpus = "",
    attachedFormHint = "",
    pickTemplateStrategy = "best_match",
  } = opts;
  const canonicalId = doc.id;
  const base = { canonicalId, title: doc.title };

  if (canonicalId === "other") {
    return { formSource: "missing", ...base };
  }

  const customer = pickBestCustomerFormFile(inputFiles, canonicalId, corpus, attachedFormHint);
  if (customer) {
    const meta = await getMetadata(customer.id).catch(() => null);
    return {
      formSource: "customer",
      ...base,
      driveFileId: customer.id,
      fileName: customer.name,
      webViewLink: typeof meta?.webViewLink === "string" ? meta.webViewLink : undefined,
    };
  }

  const subName = LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG[offerOrg];
  const { templatesFolderId, files } = await listTemplateFiles(userRootId);
  if (templatesFolderId) {
    const orgFolderId = await findChildFolderId(templatesFolderId, subName);
    const candidates = orgFolderId ? await listChildren(orgFolderId) : files;
    const filtered = candidates.filter((f) => f.mimeType !== FOLDER_MIME);
    const best = pickBestTemplateFile(filtered, canonicalId, pickTemplateStrategy);
    if (best) {
      const meta = await getMetadata(best.id).catch(() => null);
      return {
        formSource: "template",
        ...base,
        driveFileId: best.id,
        fileName: best.name,
        webViewLink: typeof meta?.webViewLink === "string" ? meta.webViewLink : undefined,
      };
    }
  }

  return { formSource: "missing", ...base };
}

/**
 * @param {DocumentFormSource} form
 */
export function formatFormSourceTelegramHint(form) {
  if (form.formSource === "customer" && form.webViewLink) {
    return ` _форма: из КД — [${form.fileName ?? "файл"}](${form.webViewLink})_`;
  }
  if (form.formSource === "customer") {
    return ` _форма: из КД (${form.fileName ?? "файл"})_`;
  }
  if (form.formSource === "template" && form.webViewLink) {
    return ` _форма: шаблон org — [${form.fileName ?? "шаблон"}](${form.webViewLink})_`;
  }
  if (form.formSource === "template") {
    return ` _форма: шаблон org (${form.fileName ?? "шаблон"})_`;
  }
  return " _форма: уточните по КД или `_lena/templates`_";
}
