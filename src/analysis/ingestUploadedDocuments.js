import { findChildFolderId } from "../drive/folders.js";
import {
  createDriveShortcut,
  listChildren,
  moveFileToFolder,
  updateFileName,
} from "../drive/ops.js";
import { TENDER_SUB } from "../drive/layoutConstants.js";
import { attachmentSlugForDocId } from "./ensureDocumentUploadTargets.js";
import { ensureTenderTree } from "../drive/workspace.js";
import { getCanonicalTypeById, isSharedReusableDocument } from "./canonicalDocumentTypes.js";
import {
  companyIndexToIdentifiedMap,
  indexEntryFromIdentified,
  loadCompanyDocsIndex,
  masterPathForCanonicalId,
  pickBestFileForCanonicalId,
  resolveCompanyMasterFolderIds,
  saveCompanyDocsIndex,
  upsertIndexEntry,
} from "./companyDocsIndex.js";
import { extractAndIdentifyDriveFile } from "./identifyUploadedDocuments.js";
import { validateIdentifiedDocument } from "./validateOrgDocumentRules.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

/** @typedef {Object} IngestFileResult
 * @property {string} fileId
 * @property {string} fileName
 * @property {string | null} canonicalId
 * @property {"valid" | "needsReview" | "rejected"} qualificationStatus
 * @property {boolean} promoted
 * @property {string} [note]
 */

/** @typedef {Object} IngestResult
 * @property {IngestFileResult[]} processed
 * @property {import("./companyDocsIndex.js").CompanyDocsIndex} index
 */

/**
 * @param {string} canonicalId
 * @param {{ orgCompanyFolderId: string | null, foundingCompanyFolderId: string | null, referencesFolderId: string | null }} folders
 */
function masterFolderIdForCanonical(canonicalId, folders) {
  const path = masterPathForCanonicalId(canonicalId);
  if (path === "founding-docs") return folders.foundingCompanyFolderId;
  if (path === "references") return folders.referencesFolderId;
  return folders.orgCompanyFolderId;
}

/**
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {{ flat?: boolean, year?: string }} treeOpts
 */
async function collectIngestCandidateFiles(userRootId, tenderId, offerOrg, treeOpts) {
  const folders = await resolveCompanyMasterFolderIds(userRootId, offerOrg);
  const { tender } = await ensureTenderTree(userRootId, tenderId, treeOpts);

  /** @type {{ file: { id?: string, name?: string, mimeType?: string }, sourceFolderId: string, expectedCanonicalId?: string }[]} */
  const out = [];

  const pushFolder = async (folderId, expectedCanonicalId) => {
    if (!folderId) return;
    for (const f of await listChildren(folderId)) {
      if (f.mimeType === FOLDER_MIME || f.mimeType === SHORTCUT_MIME) continue;
      out.push({ file: f, sourceFolderId: folderId, expectedCanonicalId });
    }
  };

  await pushFolder(folders.foundingCompanyFolderId);
  await pushFolder(folders.orgCompanyFolderId);
  await pushFolder(folders.referencesFolderId);

  if (tender.incomingFolderId) {
    await pushFolder(tender.incomingFolderId);
  } else if (tender.attachmentsId) {
    const incomingId = await findChildFolderId(tender.attachmentsId, TENDER_SUB.incoming);
    await pushFolder(incomingId);
  }

  if (tender.attachmentsId) {
    const attachmentChildren = await listChildren(tender.attachmentsId);
    for (const sub of attachmentChildren) {
      if (sub.mimeType !== FOLDER_MIME) continue;
      const subName = String(sub.name ?? "");
      if (subName === TENDER_SUB.submission || subName === TENDER_SUB.incoming) continue;
      await pushFolder(String(sub.id), subName.replace(/-/g, "_"));
    }
  }

  return { candidates: out, folders, tender };
}

/**
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {import("./documentChecklist.js").NormalizedDoc[]} requiredDocuments
 * @param {import("./documentChecklist.js").AnalysisStructured} structured
 * @param {{ flat?: boolean, year?: string, maxFiles?: number }} [opts]
 * @returns {Promise<IngestResult>}
 */
export async function ingestUploadedDocuments(
  userRootId,
  tenderId,
  offerOrg,
  requiredDocuments,
  structured,
  opts = {},
) {
  const treeOpts = { flat: opts.flat, year: opts.year };
  const max = opts.maxFiles ?? Number(process.env.LENA_COMPANY_DOCS_INDEX_MAX ?? 40);
  const { candidates, folders } = await collectIngestCandidateFiles(
    userRootId,
    tenderId,
    offerOrg,
    treeOpts,
  );

  const expectedBySlug = new Map(
    requiredDocuments.filter((d) => isSharedReusableDocument(d)).map((d) => [attachmentSlugForDocId(d.id), d.id]),
  );

  const { index, indexFileId } = await loadCompanyDocsIndex(userRootId, offerOrg);
  /** @type {IngestFileResult[]} */
  const processed = [];
  let n = 0;

  for (const { file, sourceFolderId, expectedCanonicalId } of candidates) {
    if (n >= max) break;
    const fileId = String(file.id ?? "");
    const fileName = String(file.name ?? "");
    if (!fileId) continue;

    const slugExpected = expectedBySlug.get(String(file.name ?? "").split("__")[0]);
    const expectedId =
      expectedCanonicalId && getCanonicalTypeById(expectedCanonicalId.replace(/-/g, "_"))
        ? expectedCanonicalId.replace(/-/g, "_")
        : slugExpected;

    n += 1;
    const identified = await extractAndIdentifyDriveFile(fileId, fileName, file.mimeType, {
      scopeIds: expectedId ? [expectedId] : undefined,
    });

    if (!identified.canonicalId || !isSharedReusableDocument(identified.canonicalId)) {
      processed.push({
        fileId,
        fileName,
        canonicalId: identified.canonicalId,
        qualificationStatus: "rejected",
        promoted: false,
        note: identified.canonicalId ? "не shared-документ" : "тип не распознан",
      });
      continue;
    }

    const validation = validateIdentifiedDocument(identified, {
      structured,
      expectedCanonicalId: expectedId ?? undefined,
    });

    let promoted = false;
    const targetFolderId = masterFolderIdForCanonical(identified.canonicalId, folders);
    if (targetFolderId && sourceFolderId !== targetFolderId) {
      await moveFileToFolder(fileId, targetFolderId, sourceFolderId);
      promoted = true;
    }

    if (validation.status !== "rejected") {
      upsertIndexEntry(
        index,
        indexEntryFromIdentified(
          identified,
          masterPathForCanonicalId(identified.canonicalId),
          validation.status,
          validation.note,
        ),
      );
    }

    processed.push({
      fileId,
      fileName,
      canonicalId: identified.canonicalId,
      qualificationStatus: validation.status,
      promoted,
      note: validation.note,
    });
  }

  await saveCompanyDocsIndex(userRootId, offerOrg, index, indexFileId);
  return { processed, index };
}

/**
 * @param {import("./companyDocsIndex.js").CompanyDocsIndex} index
 * @param {string} canonicalId
 */
export function bestMasterFromIndex(index, canonicalId) {
  return pickBestFileForCanonicalId(index.files, canonicalId);
}

export { companyIndexToIdentifiedMap, pickBestFileForCanonicalId };

/**
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {import("./documentChecklist.js").NormalizedDoc[]} sharedDocs
 * @param {import("./companyDocsIndex.js").CompanyDocsIndex} index
 * @param {{ flat?: boolean, year?: string }} treeOpts
 */
export async function syncSubmissionShortcutsForSharedDocs(
  userRootId,
  tenderId,
  offerOrg,
  sharedDocs,
  index,
  treeOpts,
) {
  const { tender } = await ensureTenderTree(userRootId, tenderId, treeOpts);
  let submissionFolderId = tender.submissionFolderId;
  if (!submissionFolderId && tender.attachmentsId) {
    submissionFolderId = await findChildFolderId(tender.attachmentsId, TENDER_SUB.submission);
  }
  if (!submissionFolderId) return { shortcuts: [], submissionFolderId: null };

  const existing = await listChildren(submissionFolderId);
  for (const f of existing) {
    if (f.mimeType === SHORTCUT_MIME && f.id) {
      const { trashDriveFile } = await import("../drive/ops.js");
      await trashDriveFile(String(f.id)).catch(() => {});
    }
  }

  /** @type {{ canonicalId: string, shortcutId: string, targetFileId: string, name: string }[]} */
  const shortcuts = [];
  let order = 1;
  for (const doc of sharedDocs) {
    if (!isSharedReusableDocument(doc)) continue;
    const best = pickBestFileForCanonicalId(index.files, doc.id, { preferValid: true });
    if (!best || best.qualificationStatus === "rejected") continue;
    const prefix = String(order).padStart(2, "0");
    const name = `${prefix}_${doc.title.slice(0, 60)}`;
    const sc = await createDriveShortcut(best.fileId, submissionFolderId, name);
    shortcuts.push({
      canonicalId: doc.id,
      shortcutId: String(sc.id ?? ""),
      targetFileId: best.fileId,
      name: String(sc.name ?? name),
    });
    order += 1;
  }

  return { shortcuts, submissionFolderId };
}

/**
 * @param {string} fileId
 * @param {string} canonicalTitle
 */
export async function renameToCanonicalIfNeeded(fileId, canonicalTitle) {
  const safe = canonicalTitle.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
  return updateFileName(fileId, `${safe}.pdf`).catch(() => null);
}
