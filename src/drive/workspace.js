import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureChildFolder, findChildFolderId } from "./folders.js";
import {
  LENA_ROOT_FOLDER,
  LENA_SUB,
  TENDER_SUB,
  defaultTenderCalendarYear,
  normalizeTenderYear,
  tenderFolderName,
} from "./layoutConstants.js";
import {
  copyFileToFolder,
  downloadFile,
  exportGoogleFile,
  listChildren,
} from "./ops.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";

/**
 * @typedef {Object} LenaLayoutIds
 * @property {string} userRootId
 * @property {string | null} lenaRootId
 * @property {string | null} templatesId
 * @property {string | null} libraryId
 * @property {string | null} contextId
 * @property {string | null} tendersId
 */

/**
 * Только чтение текущих id (без создания).
 * @param {string} userRootId
 * @returns {Promise<LenaLayoutIds>}
 */
export async function resolveLayoutIds(userRootId) {
  const lenaRootId = await findChildFolderId(userRootId, LENA_ROOT_FOLDER);
  if (!lenaRootId) {
    return {
      userRootId,
      lenaRootId: null,
      templatesId: null,
      libraryId: null,
      contextId: null,
      tendersId: null,
    };
  }
  const templatesId = await findChildFolderId(lenaRootId, LENA_SUB.templates);
  const libraryId = await findChildFolderId(lenaRootId, LENA_SUB.library);
  const contextId = await findChildFolderId(lenaRootId, LENA_SUB.context);
  const tendersId = await findChildFolderId(lenaRootId, LENA_SUB.tenders);
  return { userRootId, lenaRootId, templatesId, libraryId, contextId, tendersId };
}

/**
 * Создаёт недостающие папки под `_lena/`.
 * @param {string} userRootId
 * @returns {Promise<{ layout: LenaLayoutIds, created: string[] }>}
 */
export async function ensureLenaTree(userRootId) {
  /** @type {string[]} */
  const created = [];
  const r1 = await ensureChildFolder(userRootId, LENA_ROOT_FOLDER);
  if (r1.created) created.push(LENA_ROOT_FOLDER);
  const lenaRootId = r1.id;

  const rT = await ensureChildFolder(lenaRootId, LENA_SUB.templates);
  if (rT.created) created.push(`${LENA_ROOT_FOLDER}/${LENA_SUB.templates}`);
  const rL = await ensureChildFolder(lenaRootId, LENA_SUB.library);
  if (rL.created) created.push(`${LENA_ROOT_FOLDER}/${LENA_SUB.library}`);
  const rC = await ensureChildFolder(lenaRootId, LENA_SUB.context);
  if (rC.created) created.push(`${LENA_ROOT_FOLDER}/${LENA_SUB.context}`);
  const rN = await ensureChildFolder(lenaRootId, LENA_SUB.tenders);
  if (rN.created) created.push(`${LENA_ROOT_FOLDER}/${LENA_SUB.tenders}`);

  return {
    layout: {
      userRootId,
      lenaRootId,
      templatesId: rT.id,
      libraryId: rL.id,
      contextId: rC.id,
      tendersId: rN.id,
    },
    created,
  };
}

/**
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {{ flat?: boolean, year?: string }} [opts]
 *   - по умолчанию (без `flat`): `_lena/tenders/<ГГГГ>/<tenderId>/…`, год = `LENA_DEFAULT_TENDER_YEAR` или текущий календарный;
 *   - `flat: true`: старый путь `_lena/tenders/<tenderId>/…` без года.
 */
export async function ensureTenderTree(userRootId, tenderId, opts) {
  const flat = opts?.flat === true;
  const year = flat
    ? undefined
    : opts?.year
      ? normalizeTenderYear(opts.year)
      : defaultTenderCalendarYear();
  const { layout, created } = await ensureLenaTree(userRootId);
  const tendersId = layout.tendersId;
  if (!tendersId) {
    throw new Error("Не удалось получить папку tenders");
  }

  let parentForTender = tendersId;
  if (!flat && year) {
    const ry = await ensureChildFolder(tendersId, year);
    if (ry.created) created.push(`${LENA_ROOT_FOLDER}/${LENA_SUB.tenders}/${year}`);
    parentForTender = ry.id;
  }

  const tName = tenderFolderName(tenderId);
  const r0 = await ensureChildFolder(parentForTender, tName);
  if (r0.created) {
    created.push(
      !flat && year
        ? `${LENA_ROOT_FOLDER}/${LENA_SUB.tenders}/${year}/${tName}`
        : `${LENA_ROOT_FOLDER}/${LENA_SUB.tenders}/${tName}`,
    );
  }
  const tenderRoot = r0.id;

  const rIn = await ensureChildFolder(tenderRoot, TENDER_SUB.inputs);
  if (rIn.created) created.push(`tender:${tName}/${TENDER_SUB.inputs}`);
  const rDr = await ensureChildFolder(tenderRoot, TENDER_SUB.drafts);
  if (rDr.created) created.push(`tender:${tName}/${TENDER_SUB.drafts}`);
  const rEx = await ensureChildFolder(tenderRoot, TENDER_SUB.exports);
  if (rEx.created) created.push(`tender:${tName}/${TENDER_SUB.exports}`);
  const rAt = await ensureChildFolder(tenderRoot, TENDER_SUB.attachments);
  if (rAt.created) created.push(`tender:${tName}/${TENDER_SUB.attachments}`);
  const rNo = await ensureChildFolder(tenderRoot, TENDER_SUB.notes);
  if (rNo.created) created.push(`tender:${tName}/${TENDER_SUB.notes}`);

  return {
    layout,
    tender: {
      tenderId,
      year: flat ? null : year,
      layoutMode: flat ? "flat" : "by_year",
      folderId: tenderRoot,
      inputsId: rIn.id,
      draftsId: rDr.id,
      exportsId: rEx.id,
      attachmentsId: rAt.id,
      notesId: rNo.id,
    },
    created,
  };
}

/**
 * @param {string} userRootId
 */
export async function listTemplateFiles(userRootId) {
  const { templatesId } = await resolveLayoutIds(userRootId);
  if (!templatesId) {
    return { templatesFolderId: null, files: [] };
  }
  const files = await listChildren(templatesId);
  return { templatesFolderId: templatesId, files };
}

/**
 * @param {string} userRootId
 */
export async function listLibraryFiles(userRootId) {
  const { libraryId } = await resolveLayoutIds(userRootId);
  if (!libraryId) {
    return { libraryFolderId: null, files: [] };
  }
  const files = await listChildren(libraryId);
  return { libraryFolderId: libraryId, files };
}

/**
 * @param {string} userRootId
 */
export async function listContextFiles(userRootId) {
  const { contextId } = await resolveLayoutIds(userRootId);
  if (!contextId) {
    return { contextFolderId: null, files: [] };
  }
  const files = await listChildren(contextId);
  return { contextFolderId: contextId, files };
}

/**
 * @param {string} userRootId
 * @param {string} localDir
 */
export async function pullContextToLocal(userRootId, localDir) {
  const { contextFolderId, files } = await listContextFiles(userRootId);
  if (!contextFolderId) {
    throw new Error("Папка _lena/context не найдена. Выполните: drive workspace ensure");
  }
  await mkdir(localDir, { recursive: true });
  /** @type {{ name: string, path: string, id: string, note?: string }[]} */
  const written = [];
  for (const f of files) {
    if (!f.id || !f.name || f.mimeType === FOLDER_MIME) continue;
    const safeName = f.name.replace(/[\\/:*?"<>|]+/g, "_");
    if (f.mimeType === GOOGLE_DOC) {
      const dest = join(localDir, `${safeName}.txt`);
      await exportGoogleFile(f.id, "text/plain", dest);
      written.push({ id: f.id, name: f.name, path: dest });
    } else if (f.mimeType === GOOGLE_SHEET) {
      const dest = join(localDir, `${safeName}.csv`);
      await exportGoogleFile(f.id, "text/csv", dest);
      written.push({ id: f.id, name: f.name, path: dest });
    } else if (f.mimeType?.startsWith("application/vnd.google-apps.")) {
      written.push({
        id: f.id,
        name: f.name,
        path: "",
        note: `пропуск: экспорт для ${f.mimeType} не настроен`,
      });
    } else {
      const dest = join(localDir, safeName);
      await downloadFile(f.id, dest);
      written.push({ id: f.id, name: f.name, path: dest });
    }
  }
  return { contextFolderId, localDir, written };
}

/**
 * @param {string} userRootId
 * @param {string} templateFileId
 * @param {string} tenderId
 * @param {{ flat?: boolean, year?: string, newName?: string }} [opts]
 */
export async function copyTemplateToTenderDrafts(userRootId, templateFileId, tenderId, opts) {
  const { tender } = await ensureTenderTree(userRootId, tenderId, {
    flat: opts?.flat === true,
    year: opts?.year,
  });
  const { files } = await listTemplateFiles(userRootId);
  const tpl = files.find((x) => x.id === templateFileId);
  const name =
    opts?.newName?.trim() || (tpl ? `Копия ${tpl.name}` : `Копия_${templateFileId}`);
  const copied = await copyFileToFolder(templateFileId, tender.draftsId, name);
  return { tender, copied };
}

/**
 * @param {string} userRootId
 * @param {string} [tenderId]
 * @param {{ flat?: boolean, year?: string }} [tenderOpts]
 */
export async function buildAgentDriveBundle(userRootId, tenderId, tenderOpts) {
  const layout = await resolveLayoutIds(userRootId);
  const templates = await listTemplateFiles(userRootId);
  const library = await listLibraryFiles(userRootId);
  const context = await listContextFiles(userRootId);

  /** @type {Record<string, unknown>} */
  const bundle = {
    userRootFolderId: layout.userRootId,
    lena: {
      rootFolderId: layout.lenaRootId,
      templatesFolderId: layout.templatesId,
      libraryFolderId: layout.libraryId,
      contextFolderId: layout.contextId,
      tendersFolderId: layout.tendersId,
    },
    templates: templates.files.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      webViewLink: f.webViewLink,
      modifiedTime: f.modifiedTime,
    })),
    libraryFiles: library.files.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      webViewLink: f.webViewLink,
      modifiedTime: f.modifiedTime,
    })),
    contextFiles: context.files.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      webViewLink: f.webViewLink,
      modifiedTime: f.modifiedTime,
    })),
  };

  if (tenderId?.trim()) {
    const { tender } = await ensureTenderTree(userRootId, tenderId, {
      flat: tenderOpts?.flat === true,
      year: tenderOpts?.year,
    });
    bundle.tender = {
      tenderId: tender.tenderId,
      year: tender.year,
      layoutMode: tender.layoutMode,
      rootFolderId: tender.folderId,
      inputsFolderId: tender.inputsId,
      draftsFolderId: tender.draftsId,
      exportsFolderId: tender.exportsId,
      attachmentsFolderId: tender.attachmentsId,
      notesFolderId: tender.notesId,
    };
  }

  return bundle;
}
