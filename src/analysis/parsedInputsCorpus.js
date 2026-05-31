/**
 * Сборка текста документов заказчика из **tender-pipeline-state.json** (после парсинга inputs).
 * Используется анализом комплекта и генерацией КП — один источник правды по корпусу.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertCredentialsFile } from "../drive/config.js";
import { findChildFolderId } from "../drive/folders.js";
import { downloadFile, listChildren } from "../drive/ops.js";
import { ensureTenderTree } from "../drive/workspace.js";
import {
  INPUTS_EXTRACTED_SUBDIR,
  readTenderPipelineState,
} from "../icetrade/inputDocumentsExtract.js";

function safeSliceName(name) {
  return (
    String(name)
      .replace(/[\\/:*?"<>|]+/g, "_")
      .slice(0, 120)
      .trim() || "file"
  );
}

/**
 * @param {string} relFromInputs
 * @param {string} inputsFolderId
 * @param {string | null} extractedFolderId
 */
async function resolveInputsRelativeToFileId(relFromInputs, inputsFolderId, extractedFolderId) {
  const norm = relFromInputs.replace(/^\/+/, "").replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[0] === INPUTS_EXTRACTED_SUBDIR && parts.length >= 2) {
    if (!extractedFolderId) return null;
    const leaf = parts[parts.length - 1];
    const kids = await listChildren(extractedFolderId);
    const hit = kids.find(
      (f) =>
        String(f.name ?? "") === leaf && f.mimeType !== "application/vnd.google-apps.folder",
    );
    return hit?.id ? String(hit.id) : null;
  }
  const leaf = parts[parts.length - 1];
  const kids = await listChildren(inputsFolderId);
  const hit = kids.find(
    (f) => String(f.name ?? "") === leaf && f.mimeType !== "application/vnd.google-apps.folder",
  );
  return hit?.id ? String(hit.id) : null;
}

/**
 * @param {string} canonicalTextPath
 * @param {string} inputsFolderId
 * @param {string | null} extractedFolderId
 */
async function resolveCanonicalTextPathToId(canonicalTextPath, inputsFolderId, extractedFolderId) {
  const raw = String(canonicalTextPath || "").trim();
  if (!raw.startsWith("inputs/")) return null;
  return resolveInputsRelativeToFileId(raw.slice("inputs/".length), inputsFolderId, extractedFolderId);
}

/**
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {{ flat?: boolean; year?: string }} [opts]
 * @param {{ maxFiles?: number; maxTotalChars?: number; maxPerFileChars?: number }} [limits]
 */
export async function buildParsedInputsCorpus(userRootId, tenderId, opts = {}, limits = {}) {
  assertCredentialsFile();

  const maxFiles =
    limits.maxFiles ??
    (Number.parseInt(process.env.LENA_CP_MAX_PIPELINE_ITEMS?.trim() ?? "40", 10) || 40);
  const maxTotal =
    limits.maxTotalChars ??
    (Number.parseInt(process.env.LENA_CP_MAX_CORPUS_CHARS?.trim() ?? "120000", 10) || 120_000);
  const maxPerFile =
    limits.maxPerFileChars ??
    (Number.parseInt(process.env.LENA_CP_MAX_CHARS_PER_FILE?.trim() ?? "65000", 10) || 65_000);

  const treeOpts = { flat: opts.flat, year: opts.year };
  const { tender } = await ensureTenderTree(userRootId, tenderId, treeOpts);
  const state = await readTenderPipelineState(tender.folderId);

  if (!state) {
    return {
      corpus: "",
      usedPipeline: false,
      warnings: [],
      notParsedFiles: [],
      inputTextChars: 0,
      tenderFolderId: tender.folderId,
      inputsId: tender.inputsId,
      draftsId: tender.draftsId,
    };
  }

  const parsing = state.parsing;
  if (!parsing || typeof parsing !== "object" || !Array.isArray(/** @type {{ items?: unknown }} */ (parsing).items)) {
    return {
      corpus: "",
      usedPipeline: false,
      warnings: ["Нет блока parsing.items в tender-pipeline-state.json"],
      notParsedFiles: [],
      inputTextChars: 0,
      tenderFolderId: tender.folderId,
      inputsId: tender.inputsId,
      draftsId: tender.draftsId,
    };
  }

  /** @type {{ items: Record<string, unknown>[] }} */
  const p = /** @type {{ items: Record<string, unknown>[] }} */ (parsing);
  const inputsId = tender.inputsId;
  const extractedId = await findChildFolderId(inputsId, INPUTS_EXTRACTED_SUBDIR);

  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-pcorpus-"));
  /** @type {string[]} */
  const corpusParts = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const notParsedFiles = [];

  let n = 0;
  try {
    for (const it of p.items) {
      const name = typeof it.name === "string" ? it.name : "";
      const status = typeof it.status === "string" ? it.status : "";
      const ai = it.ai && typeof it.ai === "object" ? /** @type {Record<string, unknown>} */ (it.ai) : null;
      const pathRaw = ai && typeof ai.canonicalTextPath === "string" ? ai.canonicalTextPath.trim() : "";

      if (status === "error" || !pathRaw) {
        if (name) notParsedFiles.push(name);
        if (name && status === "error") warnings.push(`${name}: ошибка парсинга`);
        continue;
      }

      if (n >= maxFiles) break;
      n += 1;

      const fid = await resolveCanonicalTextPathToId(pathRaw, inputsId, extractedId);
      if (!fid) {
        notParsedFiles.push(name || pathRaw);
        if (name) warnings.push(`${name}: не найден файл для ${pathRaw}`);
        continue;
      }

      const dest = join(tmpRoot, `c-${safeSliceName(name)}-${fid.slice(0, 8)}.txt`);
      try {
        await downloadFile(fid, dest);
        let text = (await readFile(dest, "utf8")).trim();
        if (!text.length) {
          notParsedFiles.push(name);
          continue;
        }
        if (text.length > maxPerFile) text = `${text.slice(0, maxPerFile)}\n\n…[усечено]`;
        corpusParts.push(`### Документ: ${name}\n_Путь: ${pathRaw}_\n\n${text}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        notParsedFiles.push(name);
        warnings.push(`${name}: ${msg.slice(0, 200)}`);
      }
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  let corpus = corpusParts.join("\n\n").trim();
  if (corpus.length > maxTotal) corpus = `${corpus.slice(0, maxTotal)}\n\n…[корпус усечён]`;
  const inputTextChars = corpus.replace(/\s+/g, " ").trim().length;

  return {
    corpus,
    usedPipeline: true,
    warnings,
    notParsedFiles,
    inputTextChars,
    tenderFolderId: tender.folderId,
    inputsId: tender.inputsId,
    draftsId: tender.draftsId,
  };
}
