import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureChildFolder, findChildFolderId } from "../drive/folders.js";
import {
  COMPANY_DOCS_INDEX_FILENAME,
  LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG,
  ORG_REFERENCES_SUBFOLDER,
} from "../drive/layoutConstants.js";
import { downloadFile, listChildren, trashDriveFile, uploadFile } from "../drive/ops.js";
import { ensureLenaTree } from "../drive/workspace.js";
import { getCanonicalTypeById } from "./canonicalDocumentTypes.js";
import { buildUploadedFilesIndex } from "./identifyUploadedDocuments.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

/** @typedef {Object} CompanyDocsIndexEntry
 * @property {string} fileId
 * @property {string} canonicalId
 * @property {"org-docs" | "founding-docs" | "references"} masterPath
 * @property {string} fileName
 * @property {string | null} [documentDateIso]
 * @property {string | null} [reportingPeriod]
 * @property {string} identifiedAt
 * @property {string} [extractor]
 * @property {boolean} [needsReview]
 * @property {"valid" | "needsReview" | "rejected"} [qualificationStatus]
 * @property {string} [note]
 */

/** @typedef {Object} CompanyDocsIndex
 * @property {number} version
 * @property {string} company
 * @property {string} updatedAt
 * @property {CompanyDocsIndexEntry[]} files
 */

/**
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @returns {string}
 */
export function companyFolderNameForOfferOrg(offerOrg) {
  const name = LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG[offerOrg];
  if (!name) throw new Error(`Unknown offerOrg: ${offerOrg}`);
  return name;
}

/**
 * @param {CompanyDocsIndex | null | undefined} index
 * @param {"gs_retail" | "finselvat"} offerOrg
 */
export function assertIndexCompanyMatch(index, offerOrg) {
  if (!index?.company) return;
  const expected = companyFolderNameForOfferOrg(offerOrg);
  if (index.company !== expected) {
    throw new Error(`company-docs-index company mismatch: ${index.company} !== ${expected}`);
  }
}

/**
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @returns {CompanyDocsIndex}
 */
export function emptyCompanyDocsIndex(offerOrg) {
  return {
    version: 1,
    company: companyFolderNameForOfferOrg(offerOrg),
    updatedAt: new Date().toISOString(),
    files: [],
  };
}

/**
 * @param {string} userRootId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @returns {Promise<{ orgCompanyFolderId: string | null, foundingCompanyFolderId: string | null, referencesFolderId: string | null }>}
 */
export async function resolveCompanyMasterFolderIds(userRootId, offerOrg) {
  const { layout } = await ensureLenaTree(userRootId);
  const sub = companyFolderNameForOfferOrg(offerOrg);
  const orgCompanyFolderId =
    layout.orgDocsId != null ? await findChildFolderId(layout.orgDocsId, sub) : null;
  const foundingCompanyFolderId =
    layout.foundingDocsId != null ? await findChildFolderId(layout.foundingDocsId, sub) : null;
  const referencesFolderId =
    orgCompanyFolderId != null
      ? await findChildFolderId(orgCompanyFolderId, ORG_REFERENCES_SUBFOLDER)
      : null;
  return { orgCompanyFolderId, foundingCompanyFolderId, referencesFolderId };
}

/**
 * @param {string} userRootId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @returns {Promise<{ index: CompanyDocsIndex, indexFileId: string | null }>}
 */
export async function loadCompanyDocsIndex(userRootId, offerOrg) {
  const { orgCompanyFolderId } = await resolveCompanyMasterFolderIds(userRootId, offerOrg);
  if (!orgCompanyFolderId) {
    return { index: emptyCompanyDocsIndex(offerOrg), indexFileId: null };
  }
  const children = await listChildren(orgCompanyFolderId);
  const hit = children.find(
    (f) => f.mimeType !== FOLDER_MIME && String(f.name ?? "") === COMPANY_DOCS_INDEX_FILENAME,
  );
  if (!hit?.id) {
    return { index: emptyCompanyDocsIndex(offerOrg), indexFileId: null };
  }
  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-idx-"));
  const dest = join(tmpRoot, COMPANY_DOCS_INDEX_FILENAME);
  try {
    await downloadFile(String(hit.id), dest);
    const raw = await readFile(dest, "utf8");
    const index = /** @type {CompanyDocsIndex} */ (JSON.parse(raw));
    assertIndexCompanyMatch(index, offerOrg);
    return { index, indexFileId: String(hit.id) };
  } catch {
    return { index: emptyCompanyDocsIndex(offerOrg), indexFileId: String(hit.id) };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {string} userRootId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {CompanyDocsIndex} index
 * @param {string | null} existingFileId
 */
export async function saveCompanyDocsIndex(userRootId, offerOrg, index, existingFileId) {
  const { orgCompanyFolderId } = await resolveCompanyMasterFolderIds(userRootId, offerOrg);
  if (!orgCompanyFolderId) throw new Error("org-docs company folder missing");
  assertIndexCompanyMatch(index, offerOrg);
  index.updatedAt = new Date().toISOString();
  index.company = companyFolderNameForOfferOrg(offerOrg);

  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-idx-"));
  const dest = join(tmpRoot, COMPANY_DOCS_INDEX_FILENAME);
  try {
    await writeFile(dest, JSON.stringify(index, null, 2), "utf8");
    if (existingFileId) {
      await trashDriveFile(existingFileId).catch(() => {});
    }
    const uploaded = await uploadFile(orgCompanyFolderId, dest, COMPANY_DOCS_INDEX_FILENAME);
    return String(uploaded.id ?? "");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {CompanyDocsIndex} index
 * @param {CompanyDocsIndexEntry} entry
 */
export function upsertIndexEntry(index, entry) {
  const i = index.files.findIndex((f) => f.fileId === entry.fileId);
  if (i >= 0) index.files[i] = entry;
  else index.files.push(entry);
}

/**
 * @param {CompanyDocsIndexEntry[]} entries
 * @param {string} canonicalId
 * @param {{ preferValid?: boolean }} [ctx]
 * @returns {CompanyDocsIndexEntry | null}
 */
export function pickBestFileForCanonicalId(entries, canonicalId, ctx = {}) {
  const preferValid = ctx.preferValid !== false;
  const hits = entries.filter((e) => e.canonicalId === canonicalId);
  if (!hits.length) return null;
  const sorted = [...hits].sort((a, b) => {
    if (preferValid) {
      const rank = (s) => (s === "valid" ? 2 : s === "needsReview" ? 1 : 0);
      const dr = rank(b.qualificationStatus ?? "needsReview") - rank(a.qualificationStatus ?? "needsReview");
      if (dr !== 0) return dr;
    }
    const da = a.documentDateIso ?? "";
    const db = b.documentDateIso ?? "";
    if (da !== db) return db.localeCompare(da);
    return String(b.identifiedAt ?? "").localeCompare(String(a.identifiedAt ?? ""));
  });
  return sorted[0] ?? null;
}

/**
 * @param {import("./identifyUploadedDocuments.js").IdentifiedDocument} identified
 * @param {"org-docs" | "founding-docs" | "references"} masterPath
 * @param {"valid" | "needsReview" | "rejected"} qualificationStatus
 * @param {string} [note]
 * @returns {CompanyDocsIndexEntry}
 */
export function indexEntryFromIdentified(identified, masterPath, qualificationStatus, note) {
  return {
    fileId: identified.fileId,
    canonicalId: identified.canonicalId ?? "other",
    masterPath,
    fileName: identified.fileName,
    documentDateIso: identified.documentDateIso,
    reportingPeriod: identified.reportingPeriod,
    identifiedAt: new Date().toISOString(),
    extractor: identified.extractor,
    needsReview: identified.needsReview,
    qualificationStatus,
    note,
  };
}

/**
 * @param {string} canonicalId
 * @returns {"org-docs" | "founding-docs" | "references"}
 */
export function masterPathForCanonicalId(canonicalId) {
  if (canonicalId === "reference_list") return "references";
  const t = getCanonicalTypeById(canonicalId);
  if (t?.storage === "founding") return "founding-docs";
  return "org-docs";
}

/**
 * @param {string} userRootId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {{ maxFiles?: number }} [opts]
 */
export async function rebuildCompanyDocsIndex(userRootId, offerOrg, opts = {}) {
  const max = opts.maxFiles ?? Number(process.env.LENA_COMPANY_DOCS_INDEX_MAX ?? 40);
  const folders = await resolveCompanyMasterFolderIds(userRootId, offerOrg);
  /** @type {{ id?: string, name?: string, mimeType?: string, _masterPath: CompanyDocsIndexEntry["masterPath"] }[]} */
  const allFiles = [];

  if (folders.foundingCompanyFolderId) {
    for (const f of await listChildren(folders.foundingCompanyFolderId)) {
      if (f.mimeType === FOLDER_MIME) continue;
      if (String(f.name ?? "") === COMPANY_DOCS_INDEX_FILENAME) continue;
      allFiles.push({ ...f, _masterPath: "founding-docs" });
    }
  }
  if (folders.orgCompanyFolderId) {
    for (const f of await listChildren(folders.orgCompanyFolderId)) {
      if (f.mimeType === FOLDER_MIME) continue;
      if (String(f.name ?? "") === COMPANY_DOCS_INDEX_FILENAME) continue;
      allFiles.push({ ...f, _masterPath: "org-docs" });
    }
  }
  if (folders.referencesFolderId) {
    for (const f of await listChildren(folders.referencesFolderId)) {
      if (f.mimeType === FOLDER_MIME) continue;
      allFiles.push({ ...f, _masterPath: "references" });
    }
  }

  const identifiedMap = await buildUploadedFilesIndex(allFiles, { maxFiles: max });
  const index = emptyCompanyDocsIndex(offerOrg);
  for (const f of allFiles) {
    const id = String(f.id ?? "");
    if (!id) continue;
    const identified = identifiedMap.get(id);
    if (!identified?.canonicalId) continue;
    upsertIndexEntry(
      index,
      indexEntryFromIdentified(
        identified,
        f._masterPath,
        identified.needsReview ? "needsReview" : "valid",
      ),
    );
  }

  const { indexFileId } = await loadCompanyDocsIndex(userRootId, offerOrg);
  await saveCompanyDocsIndex(userRootId, offerOrg, index, indexFileId);
  return index;
}

/**
 * @param {CompanyDocsIndex} index
 * @returns {Map<string, import("./identifyUploadedDocuments.js").IdentifiedDocument>}
 */
export function companyIndexToIdentifiedMap(index) {
  /** @type {Map<string, import("./identifyUploadedDocuments.js").IdentifiedDocument>} */
  const map = new Map();
  for (const e of index.files) {
    map.set(e.fileId, {
      fileId: e.fileId,
      fileName: e.fileName,
      canonicalId: e.canonicalId,
      title: getCanonicalTypeById(e.canonicalId)?.title ?? null,
      documentDateIso: e.documentDateIso ?? null,
      reportingPeriod: e.reportingPeriod ?? null,
      needsReview: e.needsReview ?? e.qualificationStatus !== "valid",
    });
  }
  return map;
}

/**
 * @param {string} userRootId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {string} canonicalId
 */
export async function ensureReferencesFolderId(userRootId, offerOrg) {
  const { orgCompanyFolderId } = await resolveCompanyMasterFolderIds(userRootId, offerOrg);
  if (!orgCompanyFolderId) return null;
  const ref = await ensureChildFolder(orgCompanyFolderId, ORG_REFERENCES_SUBFOLDER);
  return ref.id;
}
