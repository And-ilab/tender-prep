import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analyzeArchiveDocumentText,
  ARCHIVE_CONTENT_CLASSIFY_THRESHOLD,
} from "../analysis/analyzeArchiveDocumentContent.js";
import { CANONICAL_DOCUMENT_TYPES } from "../analysis/canonicalDocumentTypes.js";
import { classifyTextToCanonicalId } from "../analysis/identifyUploadedDocuments.js";
import { chatCompletion, isLlmConfigured } from "../llm/openaiCompatible.js";
import { extractBufferToText } from "../icetrade/inputDocumentsExtract.js";
import {
  classifyPath,
  DEFAULT_CUSTOMER_MARKERS,
  DEFAULT_SUBMISSION_MARKERS,
  markersFromEnv,
  splitProject,
} from "./archiveContext.js";
import { ARCHIVE_DOCUMENTS_INDEX_FILENAME } from "./layoutConstants.js";
import { resolveDriveId } from "./ids.js";
import { downloadFile, listChildren, uploadFile } from "./ops.js";
import { buildDriveFolderManifest, ensureLenaTree, resolveLayoutIds } from "./workspace.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_EXTENSIONS = /\.(docx?|rtf|odt|pdf|xlsx?)$/i;
const BUILD_STATE_BASENAME = ".lena-archive-index-build-state.json";
const CHECKPOINT_EVERY = 25;

/** @typedef {"customer" | "submission" | "ambiguous" | "other"} ArchivePathRole */

/**
 * @typedef {import("../analysis/analyzeArchiveDocumentContent.js").ArchiveStructureProfile} ArchiveStructureProfile
 */

/**
 * @typedef {Object} ArchiveDocumentsIndexEntry
 * @property {string} driveFileId
 * @property {string} fileName
 * @property {string | null} webViewLink
 * @property {string} drivePath
 * @property {string} project
 * @property {number | null} archiveYear
 * @property {ArchivePathRole} pathRole
 * @property {string | null} canonicalId
 * @property {string | null} title
 * @property {"content" | "content+llm" | "none"} identifyMethod
 * @property {boolean} needsReview
 * @property {number | null} [sizeBytes]
 * @property {number | null} [textLength]
 * @property {string | null} [modifiedTime]
 * @property {string | null} [extractor]
 * @property {string | null} [extractError]
 * @property {ArchiveStructureProfile | null} [structureProfile]
 * @property {string | null} [contentSnippet]
 * @property {number | null} [classifyScore]
 */

/**
 * @typedef {Object} ArchiveDocumentsIndex
 * @property {number} version
 * @property {string} builtAt
 * @property {number[]} years
 * @property {ArchiveDocumentsIndexEntry[]} entries
 */

/** @type {Map<string, ArchiveDocumentsIndex>} */
const indexCache = new Map();

/**
 * @returns {string[]}
 */
export function archiveFormCanonicalScopeIds() {
  const ids = new Set(
    CANONICAL_DOCUMENT_TYPES.filter((t) => t.preparedByDefault === "lena").map((t) => t.id),
  );
  for (const extra of [
    "reliability_letter",
    "reference_list",
    "commercial_proposal",
    "technical_proposal",
  ]) {
    ids.add(extra);
  }
  return [...ids];
}

/**
 * @param {string | number | null | undefined} rootNameOrYear
 * @param {string} [drivePath]
 * @returns {number | null}
 */
export function inferArchiveYear(rootNameOrYear, drivePath = "") {
  const fromRoot = String(rootNameOrYear ?? "").match(/^(20(?:24|25|26))$/);
  if (fromRoot) return Number(fromRoot[1]);
  const fromPath = String(drivePath).match(/\b(20(?:24|25|26))\b/);
  if (fromPath) return Number(fromPath[1]);
  return null;
}

/**
 * @deprecated v1 filename heuristic; v2 uses content only at build time.
 * @param {string} fileName
 * @param {string[]} [scopeIds]
 */
export function identifyArchiveFileFromName(fileName, scopeIds = archiveFormCanonicalScopeIds()) {
  const hit = classifyTextToCanonicalId("", fileName, scopeIds, { includeTenderTypes: true });
  if (!hit) return null;
  return {
    canonicalId: hit.canonicalId,
    title: hit.title,
    identifyMethod: "filename",
    needsReview: false,
  };
}

/**
 * @param {ArchiveDocumentsIndexEntry} entry
 * @param {string} canonicalId
 * @param {{ contextTokens?: string[], requirements?: unknown[] }} [opts]
 */
export function scoreArchiveAnalogEntry(entry, canonicalId, opts = {}) {
  if (entry.canonicalId !== canonicalId) return 0;
  let score = 100;
  if (entry.pathRole === "submission") score += 200;
  else if (entry.pathRole === "customer") score += 40;
  else if (entry.pathRole === "ambiguous") score += 10;
  if (entry.archiveYear) score += entry.archiveYear * 0.1;
  if (entry.sizeBytes) score += Math.min(entry.sizeBytes / 8000, 80);
  if (entry.textLength) score += Math.min(entry.textLength / 500, 50);
  else score -= 40;

  const profile = entry.structureProfile;
  if (profile?.hasTable) score += 12;
  if (profile?.headings?.length) score += Math.min(profile.headings.length * 2, 16);
  if (profile?.hasFormFields) score += 8;
  if (profile?.hasSignatureBlock) score += 6;

  if (entry.identifyMethod === "content+llm") score += 18;
  else if (entry.identifyMethod === "content") score += 14;
  if (!entry.needsReview) score += 15;
  else score -= 30;

  const blob = [
    entry.project,
    entry.contentSnippet,
    profile?.titleBlock,
    ...(profile?.matchedPhrases ?? []),
    ...(profile?.headings ?? []),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  for (const token of opts.contextTokens ?? []) {
    const t = String(token).toLowerCase().trim();
    if (t.length >= 5 && blob.includes(t)) score += 6;
  }
  if (canonicalId === "reference_list" && opts.requirements?.length) {
    for (const req of opts.requirements) {
      const r = String(req?.description ?? req?.summary ?? req ?? "").toLowerCase();
      if (r.length < 4) continue;
      for (const t of r.split(/\s+/).filter((w) => w.length >= 5).slice(0, 8)) {
        if (blob.includes(t)) score += 4;
      }
    }
  }

  if (entry.modifiedTime) {
    const t = Date.parse(entry.modifiedTime);
    if (Number.isFinite(t)) score += t * 1e-10;
  }
  return score;
}

/**
 * @param {ArchiveDocumentsIndexEntry[]} entries
 * @param {string} canonicalId
 * @param {{ preferSubmission?: boolean, contextTokens?: string[], requirements?: unknown[] }} [opts]
 * @returns {ArchiveDocumentsIndexEntry | null}
 */
export function pickBestArchiveAnalog(entries, canonicalId, opts = {}) {
  const preferSubmission = opts.preferSubmission !== false;
  /** @type {ArchiveDocumentsIndexEntry | null} */
  let best = null;
  let bestScore = 0;
  for (const e of entries) {
    if (e.canonicalId !== canonicalId) continue;
    if (preferSubmission && e.pathRole !== "submission" && e.pathRole !== "customer") continue;
    const s = scoreArchiveAnalogEntry(e, canonicalId, opts);
    if (s > bestScore) {
      bestScore = s;
      best = e;
    }
  }
  return best;
}

/**
 * @returns {ArchiveDocumentsIndex}
 */
export function emptyArchiveDocumentsIndex() {
  return { version: 2, builtAt: new Date().toISOString(), years: [], entries: [] };
}

/**
 * @param {string} userRootId
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<ArchiveDocumentsIndex>}
 */
export async function loadArchiveDocumentsIndex(userRootId, opts = {}) {
  const cacheKey = resolveDriveId(userRootId);
  if (!opts.force && indexCache.has(cacheKey)) {
    return indexCache.get(cacheKey);
  }
  const { contextId } = await resolveLayoutIds(cacheKey);
  if (!contextId) {
    const empty = emptyArchiveDocumentsIndex();
    indexCache.set(cacheKey, empty);
    return empty;
  }
  const children = await listChildren(contextId);
  const hit = children.find(
    (f) => f.mimeType !== FOLDER_MIME && String(f.name ?? "") === ARCHIVE_DOCUMENTS_INDEX_FILENAME,
  );
  if (!hit?.id) {
    const empty = emptyArchiveDocumentsIndex();
    indexCache.set(cacheKey, empty);
    return empty;
  }
  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-archive-idx-"));
  const dest = join(tmpRoot, ARCHIVE_DOCUMENTS_INDEX_FILENAME);
  try {
    await downloadFile(String(hit.id), dest);
    const raw = await readFile(dest, "utf8");
    const index = /** @type {ArchiveDocumentsIndex} */ (JSON.parse(raw));
    indexCache.set(cacheKey, index);
    return index;
  } catch {
    const empty = emptyArchiveDocumentsIndex();
    indexCache.set(cacheKey, empty);
    return empty;
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {string} checkpointPath
 */
async function loadBuildCheckpoint(checkpointPath) {
  try {
    await access(checkpointPath);
    const raw = await readFile(checkpointPath, "utf8");
    return /** @type {{ version?: number, processedIds?: string[], entries?: ArchiveDocumentsIndexEntry[], years?: number[] }} */ (
      JSON.parse(raw)
    );
  } catch {
    return null;
  }
}

/**
 * @param {string} checkpointPath
 * @param {{ processedIds: string[], entries: ArchiveDocumentsIndexEntry[], years: number[] }} state
 */
async function saveBuildCheckpoint(checkpointPath, state) {
  await writeFile(
    checkpointPath,
    JSON.stringify(
      {
        version: 2,
        processedIds: state.processedIds,
        entries: state.entries,
        years: state.years,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

/**
 * @param {string} text
 * @param {string} snippet
 * @param {string[]} scopeIds
 */
async function classifyArchiveWithLlm(text, snippet, scopeIds) {
  if (!isLlmConfigured()) return null;
  const typeList = scopeIds
    .map((id) => {
      const c = CANONICAL_DOCUMENT_TYPES.find((t) => t.id === id);
      return c ? `${id}: ${c.title}` : id;
    })
    .join("\n");
  const body = (snippet || text).slice(0, 3500);
  try {
    const raw = await chatCompletion(
      [
        {
          role: "system",
          content:
            "Определи тип тендерного документа по тексту. Ответь одной строкой JSON: {\"canonicalId\":\"...\" или null,\"title\":\"...\"}. Только id из списка или null.",
        },
        {
          role: "user",
          content: `Типы:\n${typeList}\n\nТекст:\n${body}`,
        },
      ],
      { temperature: 0, max_tokens: 120 },
    );
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const canonicalId = typeof parsed.canonicalId === "string" ? parsed.canonicalId : null;
    if (canonicalId && !scopeIds.includes(canonicalId)) return null;
    return {
      canonicalId,
      title: typeof parsed.title === "string" ? parsed.title : null,
    };
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   id: string,
 *   name?: string,
 *   mimeType?: string,
 *   path?: string,
 *   webViewLink?: string,
 *   modifiedTime?: string,
 *   size?: string,
 * }} file
 * @param {number | null} archiveYear
 * @param {string[]} customerMarkers
 * @param {string[]} submissionMarkers
 * @param {string[]} scopeIds
 * @param {boolean} useLlm
 */
async function entryFromManifestFile(file, archiveYear, customerMarkers, submissionMarkers, scopeIds, useLlm) {
  const name = String(file.name ?? "");
  const drivePath = String(file.path ?? name);
  const { project, underProject } = splitProject(drivePath);
  const pathRole = classifyPath(underProject, customerMarkers, submissionMarkers);
  const sizeBytes = file.size != null ? Number(file.size) : null;

  /** @type {ArchiveDocumentsIndexEntry} */
  const base = {
    driveFileId: String(file.id),
    fileName: name,
    webViewLink: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
    drivePath,
    project,
    archiveYear: archiveYear ?? inferArchiveYear(null, drivePath),
    pathRole,
    canonicalId: null,
    title: null,
    identifyMethod: "none",
    needsReview: true,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    textLength: null,
    modifiedTime: file.modifiedTime ?? null,
    extractor: null,
    extractError: null,
    structureProfile: null,
    contentSnippet: null,
    classifyScore: null,
  };

  if (file.mimeType === FOLDER_MIME || !DOC_EXTENSIONS.test(name)) {
    return base;
  }

  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-archive-extract-"));
  const dest = join(tmpRoot, name.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80));
  try {
    await downloadFile(String(file.id), dest);
    const buffer = await readFile(dest);
    const extracted = await extractBufferToText(buffer, name, file.mimeType);
    const text = extracted.text?.trim() ?? "";

    const analyzed = analyzeArchiveDocumentText(text, scopeIds);
    let canonicalId = analyzed.canonicalId;
    let title = analyzed.title;
    let needsReview = analyzed.needsReview;
    let identifyMethod = analyzed.identifyMethod;
    let classifyScore = analyzed.score;

    if (useLlm && needsReview && text.length >= 40) {
      const llm = await classifyArchiveWithLlm(text, analyzed.contentSnippet, scopeIds);
      if (llm?.canonicalId) {
        canonicalId = llm.canonicalId;
        title = llm.title ?? CANONICAL_DOCUMENT_TYPES.find((t) => t.id === llm.canonicalId)?.title ?? null;
        needsReview = false;
        identifyMethod = "content+llm";
        classifyScore = ARCHIVE_CONTENT_CLASSIFY_THRESHOLD;
      }
    }

    return {
      ...base,
      canonicalId,
      title,
      identifyMethod,
      needsReview,
      textLength: analyzed.textLength,
      extractor: extracted.usedExtractor ?? null,
      extractError: extracted.error ?? (text.length < 40 ? "мало текста" : null),
      structureProfile: analyzed.structureProfile,
      contentSnippet: analyzed.contentSnippet,
      classifyScore,
    };
  } catch (e) {
    return {
      ...base,
      extractError: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {string[]} archiveRoots
 * @param {string} lenaUserRootRaw
 * @param {{
 *   maxDepth?: number,
 *   maxFiles?: number,
 *   useLlm?: boolean,
 *   resume?: boolean,
 *   dryRun?: boolean,
 *   localJsonPath?: string,
 *   checkpointPath?: string,
 *   onProgress?: (msg: string) => void,
 * }} [opts]
 */
export async function buildArchiveDocumentsIndex(archiveRoots, lenaUserRootRaw, opts = {}) {
  const onProgress = opts.onProgress ?? (() => {});
  const useLlm = opts.useLlm === true || process.env.LENA_ARCHIVE_INDEX_LLM === "1";
  const resume = opts.resume === true || process.env.LENA_ARCHIVE_INDEX_RESUME === "1";
  const maxIndexFiles =
    Number.parseInt(process.env.LENA_ARCHIVE_INDEX_MAX_FILES?.trim() ?? "", 10) ||
    opts.maxFiles ||
    undefined;
  const checkpointPath =
    opts.checkpointPath?.trim() ||
    process.env.LENA_ARCHIVE_INDEX_CHECKPOINT?.trim() ||
    join(process.cwd(), BUILD_STATE_BASENAME);

  const customerMarkers = markersFromEnv("LENA_ARCHIVE_CUSTOMER_MARKERS", DEFAULT_CUSTOMER_MARKERS);
  const submissionMarkers = markersFromEnv("LENA_ARCHIVE_SUBMISSION_MARKERS", DEFAULT_SUBMISSION_MARKERS);
  const scopeIds = archiveFormCanonicalScopeIds();

  /** @type {ArchiveDocumentsIndexEntry[]} */
  let entries = [];
  /** @type {Set<string>} */
  const processedIds = new Set();
  /** @type {Set<number>} */
  const years = new Set();

  if (resume) {
    const cp = await loadBuildCheckpoint(checkpointPath);
    if (cp?.entries?.length) {
      entries = cp.entries;
      for (const e of entries) processedIds.add(e.driveFileId);
      for (const y of cp.years ?? []) years.add(y);
      onProgress(`возобновление: уже обработано ${entries.length} файлов`);
    }
  }

  /** @type {{ file: object, archiveYear: number | null }[]} */
  const queue = [];

  for (const rootRaw of archiveRoots) {
    const rootId = resolveDriveId(rootRaw.trim());
    onProgress(`сканирую архив ${rootRaw}…`);
    const manifest = await buildDriveFolderManifest(rootId, {
      maxDepth: opts.maxDepth,
      maxFiles: opts.maxFiles,
      onProgress: (m) => onProgress(m),
    });
    const archiveYear = inferArchiveYear(manifest.rootName);
    if (archiveYear) years.add(archiveYear);
    for (const f of manifest.files) {
      if (f.mimeType === FOLDER_MIME) continue;
      if (!DOC_EXTENSIONS.test(String(f.name ?? ""))) continue;
      queue.push({ file: f, archiveYear });
    }
  }

  let processedThisRun = 0;
  for (let i = 0; i < queue.length; i += 1) {
    const { file, archiveYear } = queue[i];
    const fileId = String(file.id);
    if (processedIds.has(fileId)) continue;
    if (maxIndexFiles && entries.length >= maxIndexFiles) {
      onProgress(`достигнут LENA_ARCHIVE_INDEX_MAX_FILES=${maxIndexFiles}`);
      break;
    }

    if (processedThisRun > 0 && processedThisRun % 50 === 0) {
      onProgress(`извлекаю содержимое: ${processedThisRun}/${queue.length - processedIds.size + processedThisRun}`);
    }

    const entry = await entryFromManifestFile(
      file,
      archiveYear,
      customerMarkers,
      submissionMarkers,
      scopeIds,
      useLlm,
    );
    entries.push(entry);
    processedIds.add(fileId);
    processedThisRun += 1;

    if (processedThisRun % CHECKPOINT_EVERY === 0) {
      await saveBuildCheckpoint(checkpointPath, {
        processedIds: [...processedIds],
        entries,
        years: [...years],
      });
      onProgress(`checkpoint: ${entries.length} записей`);
    }
  }

  /** @type {ArchiveDocumentsIndex} */
  const index = {
    version: 2,
    builtAt: new Date().toISOString(),
    years: [...years].sort((a, b) => a - b),
    entries,
  };

  const userRootId = resolveDriveId(lenaUserRootRaw);
  let layout = await resolveLayoutIds(userRootId);
  if (!layout.contextId) {
    onProgress("нет _lena/context — создаю дерево workspace…");
    const ensured = await ensureLenaTree(userRootId);
    layout = ensured.layout;
  }

  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-archive-idx-build-"));
  const dest = join(tmpRoot, ARCHIVE_DOCUMENTS_INDEX_FILENAME);
  await writeFile(dest, JSON.stringify(index, null, 2), "utf8");

  const persistLocal = Boolean(opts.localJsonPath?.trim());
  if (persistLocal) {
    await writeFile(/** @type {string} */ (opts.localJsonPath?.trim()), JSON.stringify(index, null, 2), "utf8");
  }

  await saveBuildCheckpoint(checkpointPath, {
    processedIds: [...processedIds],
    entries,
    years: [...years],
  });

  /** @type {{ id?: string, name?: string } | null} */
  let uploadedFile = null;
  if (!opts.dryRun && layout.contextId) {
    onProgress(`загружаю ${ARCHIVE_DOCUMENTS_INDEX_FILENAME} в _lena/context…`);
    try {
      uploadedFile = await uploadFile(layout.contextId, dest, ARCHIVE_DOCUMENTS_INDEX_FILENAME);
      indexCache.set(userRootId, index);
    } catch (e) {
      onProgress(`загрузка не удалась: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

  return {
    ok: true,
    index,
    uploadedFile,
    entryCount: entries.length,
    typedCount: entries.filter((e) => e.canonicalId && !e.needsReview).length,
    needsReviewCount: entries.filter((e) => e.needsReview).length,
    submissionCount: entries.filter((e) => e.pathRole === "submission").length,
    localJsonPath: persistLocal ? opts.localJsonPath : undefined,
    checkpointPath,
  };
}
