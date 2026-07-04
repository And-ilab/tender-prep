import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findChildFolderId } from "./folders.js";
import { driveFolderWebLink, listChildren, uploadFile } from "./ops.js";
import { TENDER_SUB } from "./layoutConstants.js";
import { ensureTenderTree } from "./workspace.js";
import { isSharedReusableDocument } from "../analysis/canonicalDocumentTypes.js";
import { loadCompanyDocsIndex } from "../analysis/companyDocsIndex.js";
import { syncSubmissionShortcutsForSharedDocs } from "../analysis/ingestUploadedDocuments.js";
import { selectReferenceFilesForQualification } from "../analysis/referenceListMatching.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

/** @typedef {Object} SubmissionPackageManifest
 * @property {string} tenderId
 * @property {string} offerOrg
 * @property {string} updatedAt
 * @property {string | null} submissionFolderId
 * @property {string | null} submissionFolderWebViewLink
 * @property {{ canonicalId: string, shortcutId: string, targetFileId: string, name: string }[]} shortcuts
 * @property {{ fileId: string, name: string, canonicalId?: string }[]} physicalFiles
 * @property {{ fileId: string, name: string }[]} referenceShortcuts
 */

/**
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {import("./documentChecklist.js").NormalizedDoc[]} requiredDocuments
 * @param {import("./documentChecklist.js").AnalysisStructured} structured
 * @param {{ flat?: boolean, year?: string }} [treeOpts]
 * @returns {Promise<SubmissionPackageManifest>}
 */
export async function syncSubmissionPackage(
  userRootId,
  tenderId,
  offerOrg,
  requiredDocuments,
  structured,
  treeOpts = {},
) {
  const { index } = await loadCompanyDocsIndex(userRootId, offerOrg);
  const sharedDocs = requiredDocuments.filter((d) => isSharedReusableDocument(d));

  const { shortcuts, submissionFolderId } = await syncSubmissionShortcutsForSharedDocs(
    userRootId,
    tenderId,
    offerOrg,
    sharedDocs,
    index,
    treeOpts,
  );

  const refSelection = await selectReferenceFilesForQualification(
    userRootId,
    offerOrg,
    structured,
    index,
  );

  /** @type {{ fileId: string, name: string }[]} */
  const referenceShortcuts = [];
  if (submissionFolderId && refSelection.selected.length) {
    const { createDriveShortcut } = await import("../drive/ops.js");
    let refOrder = shortcuts.length + 1;
    for (const ref of refSelection.selected) {
      const name = `${String(refOrder).padStart(2, "0")}_Отзыв_${ref.fileName.slice(0, 40)}`;
      const sc = await createDriveShortcut(ref.fileId, submissionFolderId, name);
      referenceShortcuts.push({ fileId: String(sc.id ?? ""), name: String(sc.name ?? name) });
      refOrder += 1;
    }
  }

  const { tender } = await ensureTenderTree(userRootId, tenderId, treeOpts);
  /** @type {{ fileId: string, name: string, canonicalId?: string }[]} */
  const physicalFiles = [];
  if (submissionFolderId && tender.attachmentsId) {
    const children = await listChildren(submissionFolderId);
    for (const f of children) {
      if (f.mimeType === SHORTCUT_MIME || f.mimeType === FOLDER_MIME) continue;
      physicalFiles.push({ fileId: String(f.id ?? ""), name: String(f.name ?? "") });
    }
  }

  const manifest = /** @type {SubmissionPackageManifest} */ ({
    tenderId,
    offerOrg,
    updatedAt: new Date().toISOString(),
    submissionFolderId,
    submissionFolderWebViewLink: submissionFolderId ? driveFolderWebLink(submissionFolderId) : null,
    shortcuts,
    physicalFiles,
    referenceShortcuts,
  });

  if (tender.notesId) {
    const tmpRoot = await mkdtemp(join(tmpdir(), "lena-sub-"));
    const dest = join(tmpRoot, "submission-package.json");
    try {
      await writeFile(dest, JSON.stringify(manifest, null, 2), "utf8");
      await uploadFile(tender.notesId, dest, "submission-package.json");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  return manifest;
}

/**
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {{ flat?: boolean, year?: string }} [treeOpts]
 */
export async function resolveSubmissionFolderLink(userRootId, tenderId, treeOpts = {}) {
  const { tender } = await ensureTenderTree(userRootId, tenderId, treeOpts);
  let id = tender.submissionFolderId;
  if (!id && tender.attachmentsId) {
    id = await findChildFolderId(tender.attachmentsId, TENDER_SUB.submission);
  }
  return id ? driveFolderWebLink(id) : null;
}
