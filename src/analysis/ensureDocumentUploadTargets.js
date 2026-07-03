import { ensureChildFolder } from "../drive/folders.js";
import { driveFolderWebLink } from "../drive/ops.js";
import { ensureLenaTree, ensureTenderTree } from "../drive/workspace.js";
import { lenaCompanyFolderName } from "../drive/layoutConstants.js";
import { getCanonicalTypeById } from "./canonicalDocumentTypes.js";

/**
 * @typedef {Object} DocumentUploadTarget
 * @property {string} docId
 * @property {string} title
 * @property {string} webViewLink
 * @property {"founding" | "org" | "tender"} storage
 */

/**
 * Папки Drive для догрузки документов менеджером (после выбора компании).
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {"gs_retail" | "finselvat"} offerOrg
 * @param {{ id: string, title: string, storage: "founding" | "org" | "tender" }[]} managerDocs
 * @param {{ flat?: boolean, year?: string }} [treeOpts]
 * @returns {Promise<DocumentUploadTarget[]>}
 */
export async function ensureDocumentUploadTargets(
  userRootId,
  tenderId,
  offerOrg,
  managerDocs,
  treeOpts = {},
) {
  const companyFolder = lenaCompanyFolderName(offerOrg);
  if (!companyFolder) return [];

  const { layout } = await ensureLenaTree(userRootId);
  const { tender } = await ensureTenderTree(userRootId, tenderId, treeOpts);

  /** @type {Map<string, DocumentUploadTarget>} */
  const out = new Map();

  for (const doc of managerDocs) {
    if (out.has(doc.id)) continue;

    let folderId = null;
    if (doc.storage === "founding" && layout.foundingDocsId) {
      const co = await ensureChildFolder(layout.foundingDocsId, companyFolder);
      folderId = co.id;
    } else if (doc.storage === "org" && layout.orgDocsId) {
      const co = await ensureChildFolder(layout.orgDocsId, companyFolder);
      folderId = co.id;
    } else if (doc.storage === "tender" && tender.attachmentsId) {
      const slug = doc.id.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 48) || "other";
      const sub = await ensureChildFolder(tender.attachmentsId, slug);
      folderId = sub.id;
    }

    if (!folderId) continue;

    const link = driveFolderWebLink(folderId);
    out.set(doc.id, {
      docId: doc.id,
      title: doc.title,
      webViewLink: link,
      storage: doc.storage,
    });
  }

  return [...out.values()];
}

/**
 * @param {string} docId
 * @returns {string}
 */
export function attachmentSlugForDocId(docId) {
  const t = getCanonicalTypeById(docId);
  return t?.id ?? (docId.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 48) || "other");
}
