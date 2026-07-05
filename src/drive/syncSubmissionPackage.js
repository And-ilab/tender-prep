import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findChildFolderId } from "./folders.js";
import { copyFileToFolder, createDriveShortcut, driveFolderWebLink, listChildren, uploadFile } from "./ops.js";
import { TENDER_SUB } from "./layoutConstants.js";
import { ensureLenaTree, ensureTenderTree } from "./workspace.js";
import { isSharedReusableDocument } from "../analysis/canonicalDocumentTypes.js";
import { pickBestFileForCanonicalId, loadCompanyDocsIndex, companyIndexToIdentifiedMap } from "../analysis/companyDocsIndex.js";
import { ingestUploadedDocuments } from "../analysis/ingestUploadedDocuments.js";
import { findFileForCanonicalId } from "../analysis/identifyUploadedDocuments.js";
import { selectReferenceFilesForQualification } from "../analysis/referenceListMatching.js";
import { resolveDocumentFormSource, fileMatchesCanonicalType } from "../analysis/resolveDocumentFormSource.js";
import { verifyStatusIsValidForPackage } from "../analysis/validateOrgDocumentRules.js";
import {
  findMatchingDriveFile,
  isLenaPreparedChecklistItem,
  listCompanySubfolderFiles,
  verifyDocumentsForChecklist,
} from "../analysis/verifyDocumentAvailability.js";

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
 * @param {import("../analysis/documentChecklist.js").NormalizedDoc} doc
 * @param {import("../analysis/companyDocsIndex.js").CompanyDocsIndex} index
 * @param {{ doc: import("../analysis/documentChecklist.js").NormalizedDoc, verify: import("../analysis/verifyDocumentAvailability.js").DocumentVerifyResult } | undefined} verifyRow
 * @param {{ foundingFiles: { id?: string, name?: string }[], orgFiles: { id?: string, name?: string }[], foundingIndex: Map<string, unknown>, orgIndex: Map<string, unknown> }} driveCtx
 * @returns {{ fileId: string, fileName: string } | null}
 */
export function resolveSharedDocShortcutTarget(doc, index, verifyRow, driveCtx) {
  const best = pickBestFileForCanonicalId(index.files, doc.id, { preferValid: true });
  if (best && best.qualificationStatus !== "rejected") {
    return { fileId: best.fileId, fileName: best.fileName };
  }
  const verify = verifyRow?.verify;
  if (!verify || !verifyStatusIsValidForPackage(verify.status, doc.id)) return null;

  const match =
    findFileForCanonicalId(driveCtx.foundingFiles, driveCtx.foundingIndex, doc.id) ??
    findMatchingDriveFile(driveCtx.foundingFiles, doc.id) ??
    findFileForCanonicalId(driveCtx.orgFiles, driveCtx.orgIndex, doc.id) ??
    findMatchingDriveFile(driveCtx.orgFiles, doc.id);
  if (!match?.id) return null;
  return { fileId: String(match.id), fileName: String(match.name ?? doc.title) };
}

/**
 * @param {string} userRootId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {import("../analysis/documentChecklist.js").NormalizedDoc} doc
 * @param {string} draftsFolderId
 * @param {import("../analysis/documentChecklist.js").AnalysisStructured} structured
 * @param {{ inputFiles?: { name?: string, id?: string, mimeType?: string }[], corpus?: string }} ctx
 * @returns {Promise<{ fileId: string, fileName: string } | null>}
 */
export async function resolveTenderDraftShortcutTarget(
  userRootId,
  offerOrg,
  doc,
  draftsFolderId,
  structured,
  ctx,
) {
  if (doc.id === "commercial_proposal") {
    const kids = await listChildren(draftsFolderId);
    const kp = kids
      .filter((f) => /^КП-/i.test(String(f.name ?? "")))
      .sort(
        (a, b) =>
          Date.parse(String(b.modifiedTime ?? 0)) - Date.parse(String(a.modifiedTime ?? 0)),
      )[0];
    if (kp?.id) return { fileId: String(kp.id), fileName: String(kp.name ?? doc.title) };
    return null;
  }

  if (doc.id === "compliance_statement" && isLenaPreparedChecklistItem(doc, structured)) {
    const form = await resolveDocumentFormSource(userRootId, offerOrg, doc, {
      inputFiles: ctx.inputFiles,
      corpus: ctx.corpus ?? "",
      pickTemplateStrategy: "best_match",
    });
    if (form.formSource === "missing" || !form.driveFileId) return null;

    const draftsKids = await listChildren(draftsFolderId);
    const existing = draftsKids.find((f) => fileMatchesCanonicalType(String(f.name ?? ""), doc.id));
    if (existing?.id) {
      return { fileId: String(existing.id), fileName: String(existing.name ?? doc.title) };
    }

    const safeName = `${doc.title}.docx`.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120);
    const copied = await copyFileToFolder(form.driveFileId, draftsFolderId, safeName);
    if (copied?.id) {
      return { fileId: String(copied.id), fileName: String(copied.name ?? safeName) };
    }
    return { fileId: form.driveFileId, fileName: form.fileName ?? safeName };
  }

  return null;
}

/**
 * @param {string} submissionFolderId
 */
async function clearSubmissionShortcuts(submissionFolderId) {
  const existing = await listChildren(submissionFolderId);
  for (const f of existing) {
    if (f.mimeType === SHORTCUT_MIME && f.id) {
      const { trashDriveFile } = await import("../drive/ops.js");
      await trashDriveFile(String(f.id)).catch(() => {});
    }
  }
}

/**
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {import("../analysis/documentChecklist.js").NormalizedDoc[]} requiredDocuments
 * @param {import("../analysis/documentChecklist.js").AnalysisStructured} structured
 * @param {{ flat?: boolean, year?: string }} [treeOpts]
 * @param {{ verifyResults?: { doc: import("../analysis/documentChecklist.js").NormalizedDoc, verify: import("../analysis/verifyDocumentAvailability.js").DocumentVerifyResult }[], corpus?: string, inputFiles?: { name?: string, id?: string, mimeType?: string }[] }} [opts]
 * @returns {Promise<SubmissionPackageManifest>}
 */
export async function syncSubmissionPackage(
  userRootId,
  tenderId,
  offerOrg,
  requiredDocuments,
  structured,
  treeOpts = {},
  opts = {},
) {
  const { index } = await loadCompanyDocsIndex(userRootId, offerOrg);
  const { layout } = await ensureLenaTree(userRootId);
  const { tender } = await ensureTenderTree(userRootId, tenderId, treeOpts);

  let submissionFolderId = tender.submissionFolderId;
  if (!submissionFolderId && tender.attachmentsId) {
    submissionFolderId = await findChildFolderId(tender.attachmentsId, TENDER_SUB.submission);
  }

  const foundingFiles = layout.foundingDocsId
    ? await listCompanySubfolderFiles(layout.foundingDocsId, offerOrg)
    : [];
  const orgFiles = layout.orgDocsId ? await listCompanySubfolderFiles(layout.orgDocsId, offerOrg) : [];
  const registryOrgIndex = companyIndexToIdentifiedMap(index);
  const registryFoundingIndex = companyIndexToIdentifiedMap({
    ...index,
    files: index.files.filter((f) => f.masterPath === "founding-docs"),
  });

  const verifyById = new Map((opts.verifyResults ?? []).map((row) => [row.doc.id, row]));

  let inputFiles = opts.inputFiles;
  if (!inputFiles?.length && tender.inputsId) {
    inputFiles = await listChildren(tender.inputsId);
  }

  /** @type {{ canonicalId: string, shortcutId: string, targetFileId: string, name: string }[]} */
  const shortcuts = [];

  if (submissionFolderId) {
    await clearSubmissionShortcuts(submissionFolderId);
    let order = 1;

    for (const doc of requiredDocuments) {
      if (!isSharedReusableDocument(doc)) continue;
      const verifyRow = verifyById.get(doc.id);
      if (verifyRow && !verifyStatusIsValidForPackage(verifyRow.verify.status, doc.id)) continue;
      const target = resolveSharedDocShortcutTarget(doc, index, verifyRow, {
        foundingFiles,
        orgFiles,
        foundingIndex: registryFoundingIndex,
        orgIndex: registryOrgIndex,
      });
      if (!target) continue;
      const name = `${String(order).padStart(2, "0")}_${doc.title.slice(0, 60)}`;
      const sc = await createDriveShortcut(target.fileId, submissionFolderId, name);
      shortcuts.push({
        canonicalId: doc.id,
        shortcutId: String(sc.id ?? ""),
        targetFileId: target.fileId,
        name: String(sc.name ?? name),
      });
      order += 1;
    }

    if (tender.draftsId) {
      for (const doc of requiredDocuments) {
        if (isSharedReusableDocument(doc)) continue;
        if (!isLenaPreparedChecklistItem(doc, structured)) continue;
        const target = await resolveTenderDraftShortcutTarget(
          userRootId,
          offerOrg,
          doc,
          tender.draftsId,
          structured,
          { inputFiles, corpus: opts.corpus ?? "" },
        );
        if (!target) continue;
        const name = `${String(order).padStart(2, "0")}_${doc.title.slice(0, 60)}`;
        const sc = await createDriveShortcut(target.fileId, submissionFolderId, name);
        shortcuts.push({
          canonicalId: doc.id,
          shortcutId: String(sc.id ?? ""),
          targetFileId: target.fileId,
          name: String(sc.name ?? name),
        });
        order += 1;
      }
    }
  }

  const refSelection = await selectReferenceFilesForQualification(
    userRootId,
    offerOrg,
    structured,
    index,
  );

  /** @type {{ fileId: string, name: string }[]} */
  const referenceShortcuts = [];
  if (submissionFolderId && refSelection.selected.length) {
    let refOrder = shortcuts.length + 1;
    for (const ref of refSelection.selected) {
      const name = `${String(refOrder).padStart(2, "0")}_Отзыв_${ref.fileName.slice(0, 40)}`;
      const sc = await createDriveShortcut(ref.fileId, submissionFolderId, name);
      referenceShortcuts.push({ fileId: String(sc.id ?? ""), name: String(sc.name ?? name) });
      refOrder += 1;
    }
  }

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
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {import("../analysis/documentChecklist.js").AnalysisStructured} structured
 * @param {import("../analysis/documentChecklist.js").NormalizedDoc[]} requiredDocuments
 * @param {{ flat?: boolean, year?: string }} [treeOpts]
 * @param {{ corpus?: string, inputFiles?: { name?: string, id?: string, mimeType?: string }[], runIngest?: boolean }} [opts]
 */
export async function rebuildSubmissionPrintPackage(
  userRootId,
  tenderId,
  offerOrg,
  structured,
  requiredDocuments,
  treeOpts = {},
  opts = {},
) {
  if (opts.runIngest !== false) {
    try {
      await ingestUploadedDocuments(userRootId, tenderId, offerOrg, requiredDocuments, structured, treeOpts);
    } catch {
      /* optional on network errors */
    }
  }

  const verifyResults = await verifyDocumentsForChecklist(
    userRootId,
    tenderId,
    offerOrg,
    requiredDocuments,
    structured,
    { ...treeOpts, corpus: opts.corpus, inputFiles: opts.inputFiles },
  );

  return syncSubmissionPackage(userRootId, tenderId, offerOrg, requiredDocuments, structured, treeOpts, {
    verifyResults,
    corpus: opts.corpus,
    inputFiles: opts.inputFiles,
  });
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
