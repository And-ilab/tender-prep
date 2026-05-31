import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ensureChildFolder, findChildFolderId } from "./folders.js";
import {
  LENA_ROOT_FOLDER,
  LENA_SUB,
  TENDER_SUB,
  defaultTenderCalendarYear,
  lenaCompanyDriveSubfolderNames,
  normalizeTenderYear,
  tenderFolderName,
} from "./layoutConstants.js";
import {
  copyFileToFolder,
  downloadFile,
  exportGoogleFile,
  getMetadata,
  listChildren,
} from "./ops.js";
import { resolveDriveId } from "./ids.js";

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
 * @property {string | null} orgDocsId
 * @property {string | null} foundingDocsId
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
      orgDocsId: null,
      foundingDocsId: null,
      tendersId: null,
    };
  }
  const templatesId = await findChildFolderId(lenaRootId, LENA_SUB.templates);
  const libraryId = await findChildFolderId(lenaRootId, LENA_SUB.library);
  const contextId = await findChildFolderId(lenaRootId, LENA_SUB.context);
  const orgDocsId = await findChildFolderId(lenaRootId, LENA_SUB.orgDocs);
  const foundingDocsId = await findChildFolderId(lenaRootId, LENA_SUB.foundingDocs);
  const tendersId = await findChildFolderId(lenaRootId, LENA_SUB.tenders);
  return { userRootId, lenaRootId, templatesId, libraryId, contextId, orgDocsId, foundingDocsId, tendersId };
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
  const rO = await ensureChildFolder(lenaRootId, LENA_SUB.orgDocs);
  if (rO.created) created.push(`${LENA_ROOT_FOLDER}/${LENA_SUB.orgDocs}`);
  const rF = await ensureChildFolder(lenaRootId, LENA_SUB.foundingDocs);
  if (rF.created) created.push(`${LENA_ROOT_FOLDER}/${LENA_SUB.foundingDocs}`);
  const rN = await ensureChildFolder(lenaRootId, LENA_SUB.tenders);
  if (rN.created) created.push(`${LENA_ROOT_FOLDER}/${LENA_SUB.tenders}`);

  for (const co of lenaCompanyDriveSubfolderNames()) {
    const tc = await ensureChildFolder(rT.id, co);
    if (tc.created) created.push(`${LENA_ROOT_FOLDER}/${LENA_SUB.templates}/${co}`);
    const oc = await ensureChildFolder(rO.id, co);
    if (oc.created) created.push(`${LENA_ROOT_FOLDER}/${LENA_SUB.orgDocs}/${co}`);
    const fc = await ensureChildFolder(rF.id, co);
    if (fc.created) created.push(`${LENA_ROOT_FOLDER}/${LENA_SUB.foundingDocs}/${co}`);
  }

  return {
    layout: {
      userRootId,
      lenaRootId,
      templatesId: rT.id,
      libraryId: rL.id,
      contextId: rC.id,
      orgDocsId: rO.id,
      foundingDocsId: rF.id,
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
 * Список файлов и папок в `_lena/templates` (корень и при необходимости подпапки компаний `gs-retail`, `finselvat` — как элементы списка).
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
 * Документы организации: `_lena/org-docs` (корень + подпапки **`gs-retail`**, **`finselvat`**).
 * @param {string} userRootId
 */
export async function listOrgDocsFiles(userRootId) {
  const { orgDocsId } = await resolveLayoutIds(userRootId);
  if (!orgDocsId) {
    return { orgDocsFolderId: null, files: [] };
  }
  const files = await listChildren(orgDocsId);
  return { orgDocsFolderId: orgDocsId, files };
}

/**
 * Учредительные документы: `_lena/founding-docs` (подпапки **`gs-retail`**, **`finselvat`**).
 * @param {string} userRootId
 */
export async function listFoundingDocsFiles(userRootId) {
  const { foundingDocsId } = await resolveLayoutIds(userRootId);
  if (!foundingDocsId) {
    return { foundingDocsFolderId: null, files: [] };
  }
  const files = await listChildren(foundingDocsId);
  return { foundingDocsFolderId: foundingDocsId, files };
}

/**
 * Дополнительные папки с контекстом на Drive: URL или id через запятую, точку с запятой или перевод строки.
 * Каждая папка должна быть расшарена на тот же сервисный аккаунт. См. docs/GOOGLE_DRIVE.md.
 * @returns {string[]}
 */
export function parseExtraContextFolderIdsFromEnv() {
  const raw = process.env.LENA_EXTRA_CONTEXT_FOLDERS?.trim();
  if (!raw) return [];
  const parts = raw.split(/[,;\r\n]+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  /** @type {string[]} */
  const ids = [];
  for (const p of parts) {
    try {
      const id = resolveDriveId(p);
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    } catch {
      // пропускаем невалидные фрагменты
    }
  }
  return ids;
}

/**
 * Файлы из доп. папок (только корень каждой папки; вложенные подпапки не обходятся).
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function listExtraContextTaggedFiles() {
  const roots = parseExtraContextFolderIdsFromEnv();
  /** @type {Record<string, unknown>[]> */
  const out = [];
  for (const id of roots) {
    try {
      const meta = await getMetadata(id);
      if (meta.mimeType !== FOLDER_MIME) continue;
      const label = (meta.name && String(meta.name)) || id;
      const kids = await listChildren(id);
      for (const f of kids) {
        if (!f.id || !f.name) continue;
        if (f.mimeType === FOLDER_MIME) continue;
        out.push({
          ...f,
          lenaContextGroup: "extra",
          lenaContextSource: label,
          lenaContextExtraRootId: id,
        });
      }
    } catch {
      // нет доступа или неверный id
    }
  }
  return out;
}

/**
 * @param {string} userRootId
 */
export async function listContextFiles(userRootId) {
  const extraTagged = await listExtraContextTaggedFiles();
  const { contextId } = await resolveLayoutIds(userRootId);
  /** @type {Record<string, unknown>[]} */
  const primaryTagged = [];
  if (contextId) {
    const files = await listChildren(contextId);
    for (const f of files) {
      primaryTagged.push({
        ...f,
        lenaContextGroup: "primary",
        lenaContextSource: "_lena/context",
      });
    }
  }
  const files = [...primaryTagged, ...extraTagged];
  return {
    contextFolderId: contextId,
    files,
    extraContextRoots: parseExtraContextFolderIdsFromEnv().length,
  };
}

/**
 * @param {string} userRootId
 * @param {string} localDir
 */
export async function pullContextToLocal(userRootId, localDir) {
  const { contextFolderId, files } = await listContextFiles(userRootId);
  if (!files.length) {
    throw new Error(
      "Нет файлов контекста: нет _lena/context и не задана / пуста LENA_EXTRA_CONTEXT_FOLDERS. См. docs/GOOGLE_DRIVE.md",
    );
  }
  await mkdir(localDir, { recursive: true });
  /** @type {Set<string>} */
  const dirsReady = new Set();
  /** @type {{ name: string, path: string, id: string, note?: string }[]} */
  const written = [];

  /**
   * @param {string} s
   */
  function safeDirSegment(s) {
    const t = String(s).replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").trim();
    return t.slice(0, 120) || "context";
  }

  for (const f of files) {
    if (!f.id || !f.name || f.mimeType === FOLDER_MIME) continue;
    const src = /** @type {{ lenaContextSource?: string }} */ (f).lenaContextSource ?? "_lena/context";
    const sub = safeDirSegment(src);
    const baseDir = join(localDir, sub);
    if (!dirsReady.has(baseDir)) {
      await mkdir(baseDir, { recursive: true });
      dirsReady.add(baseDir);
    }
    const safeName = f.name.replace(/[\\/:*?"<>|]+/g, "_");
    if (f.mimeType === GOOGLE_DOC) {
      const dest = join(baseDir, `${safeName}.txt`);
      await exportGoogleFile(f.id, "text/plain", dest);
      written.push({ id: f.id, name: f.name, path: dest });
    } else if (f.mimeType === GOOGLE_SHEET) {
      const dest = join(baseDir, `${safeName}.csv`);
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
      const dest = join(baseDir, safeName);
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
  const orgDocs = await listOrgDocsFiles(userRootId);
  const foundingDocs = await listFoundingDocsFiles(userRootId);
  const context = await listContextFiles(userRootId);

  /** @type {Record<string, unknown>} */
  const bundle = {
    userRootFolderId: layout.userRootId,
    lena: {
      rootFolderId: layout.lenaRootId,
      templatesFolderId: layout.templatesId,
      libraryFolderId: layout.libraryId,
      contextFolderId: layout.contextId,
      orgDocsFolderId: layout.orgDocsId,
      foundingDocsFolderId: layout.foundingDocsId,
      tendersFolderId: layout.tendersId,
      extraContextFoldersFromEnv: context.extraContextRoots ?? 0,
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
    orgDocsFiles: orgDocs.files.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      webViewLink: f.webViewLink,
      modifiedTime: f.modifiedTime,
      lenaContextSource: "_lena/org-docs",
    })),
    foundingDocsFiles: foundingDocs.files.map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      webViewLink: f.webViewLink,
      modifiedTime: f.modifiedTime,
      lenaContextSource: "_lena/founding-docs",
    })),
    contextFiles: context.files.map((f) => {
      const row = {
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        webViewLink: f.webViewLink,
        modifiedTime: f.modifiedTime,
      };
      const ff = /** @type {Record<string, unknown>} */ (f);
      if (ff.lenaContextSource) row.lenaContextSource = ff.lenaContextSource;
      if (ff.lenaContextExtraRootId) row.lenaContextExtraRootId = ff.lenaContextExtraRootId;
      return row;
    }),
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

/**
 * Уникальное имя файла в папке назначения (при коллизии имён).
 * @param {string} original
 * @param {Set<string>} usedNames
 */
function uniqueDestName(original, usedNames) {
  if (!usedNames.has(original)) {
    usedNames.add(original);
    return original;
  }
  const dot = original.lastIndexOf(".");
  const base = dot > 0 ? original.slice(0, dot) : original;
  const ext = dot > 0 ? original.slice(dot) : "";
  let i = 2;
  /** @type {string} */
  let candidate;
  do {
    candidate = `${base} (${i})${ext}`;
    i += 1;
  } while (usedNames.has(candidate));
  usedNames.add(candidate);
  return candidate;
}

/**
 * Копирует **файлы** из внешней папки Google Drive в `_lena/tenders/…/inputs`.
 * Подпапки в источнике пропускаются. У сервисного аккаунта должен быть доступ к исходной папке (Share на client_email).
 *
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {string} sourceFolderRaw id или URL папки-источника
 * @param {{ flat?: boolean, year?: string }} [tenderOpts]
 * @returns {Promise<{ tender: object, sourceFolderId: string, copied: { name: string, id: string, webViewLink?: string }[], skippedFolders: string[], errors: string[] }>}
 */
export async function ingestDriveFolderToTenderInputs(userRootId, tenderId, sourceFolderRaw, tenderOpts) {
  const sourceId = resolveDriveId(sourceFolderRaw);
  const meta = await getMetadata(sourceId);
  if (meta.mimeType !== FOLDER_MIME) {
    throw new Error(
      "Нужна ссылка на **папку** Google Drive. Для одного файла — положите его в папку и дайте ссылку на папку.",
    );
  }
  const { tender } = await ensureTenderTree(userRootId, tenderId, tenderOpts);
  const inputsId = tender.inputsId;
  const children = await listChildren(sourceId);

  /** @type {string[]} */
  const skippedFolders = [];
  /** @type {{ name: string, id: string, webViewLink?: string }[]} */
  const copied = [];
  /** @type {string[]} */
  const errors = [];

  const usedNames = new Set();
  for (const ch of children) {
    if (!ch.id || !ch.name) continue;
    if (ch.mimeType === FOLDER_MIME) {
      skippedFolders.push(ch.name);
      continue;
    }
    const destName = uniqueDestName(ch.name, usedNames);
    try {
      const out = await copyFileToFolder(ch.id, inputsId, destName);
      copied.push({ name: out.name ?? destName, id: out.id, webViewLink: out.webViewLink });
    } catch (e) {
      errors.push(`${ch.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { tender, sourceFolderId: sourceId, copied, skippedFolders, errors };
}

/**
 * Считает файлы (не папки) непосредственно в папке.
 * @param {string | null | undefined} folderId
 * @returns {Promise<number>}
 */
async function countFilesInFolder(folderId) {
  if (!folderId) return 0;
  const files = await listChildren(folderId);
  return files.filter((f) => f.mimeType !== FOLDER_MIME).length;
}

/**
 * Обход `_lena/tenders`: годовые подпапки `ГГГГ` и/или «плоские» тендеры сразу под `tenders`.
 * Имя папки тендера на диске — как в `tenderFolderName` (может отличаться от исходного tender_id).
 *
 * @param {string} userRootId
 * @returns {Promise<{ tendersFolderId: string | null, scannedAt: string, entries: { year: string | null, tenderFolderName: string, tenderRootFolderId: string, inputs: number, drafts: number, exports: number, attachments: number, notes: number }[] }>}
 */
export async function inventoryTendersOnDrive(userRootId) {
  const layout = await resolveLayoutIds(userRootId);
  const tendersId = layout.tendersId;
  const scannedAt = new Date().toISOString();
  if (!tendersId) {
    return { tendersFolderId: null, scannedAt, entries: [] };
  }

  /** @type {{ year: string | null, tenderFolderName: string, tenderRootFolderId: string, inputs: number, drafts: number, exports: number, attachments: number, notes: number }[]} */
  const entries = [];

  /**
   * @param {string | null} year
   * @param {string} tenderFolderName
   * @param {string} tenderRootId
   */
  async function scanTenderRoot(year, tenderFolderName, tenderRootId) {
    const inputsId = await findChildFolderId(tenderRootId, TENDER_SUB.inputs);
    const draftsId = await findChildFolderId(tenderRootId, TENDER_SUB.drafts);
    const exportsId = await findChildFolderId(tenderRootId, TENDER_SUB.exports);
    const attId = await findChildFolderId(tenderRootId, TENDER_SUB.attachments);
    const notesId = await findChildFolderId(tenderRootId, TENDER_SUB.notes);
    entries.push({
      year,
      tenderFolderName,
      tenderRootFolderId: tenderRootId,
      inputs: await countFilesInFolder(inputsId),
      drafts: await countFilesInFolder(draftsId),
      exports: await countFilesInFolder(exportsId),
      attachments: await countFilesInFolder(attId),
      notes: await countFilesInFolder(notesId),
    });
  }

  const top = await listChildren(tendersId);
  const folders = top.filter((x) => x.mimeType === FOLDER_MIME && x.id && x.name);
  const yearFolders = folders.filter((f) => /^\d{4}$/.test(f.name ?? ""));
  const nonYearFolders = folders.filter((f) => !/^\d{4}$/.test(f.name ?? ""));

  for (const yf of yearFolders) {
    const year = /** @type {string} */ (yf.name);
    const subs = await listChildren(yf.id);
    for (const t of subs) {
      if (t.mimeType !== FOLDER_MIME || !t.id || !t.name) continue;
      await scanTenderRoot(year, t.name, t.id);
    }
  }
  for (const f of nonYearFolders) {
    await scanTenderRoot(null, f.name, f.id);
  }

  return { tendersFolderId: tendersId, scannedAt, entries };
}

/**
 * Рекурсивный обход **любой** папки на Drive (например архив «тендеры 2025»): только метаданные файлов, без чтения PDF/DOC.
 * Ограничения: `maxDepth` (глубина вложенности), `maxFiles` (чтобы не упереться в квоты при сотнях тысяч файлов).
 *
 * @param {string} rootFolderRaw id или URL корня обхода
 * @param {{ maxDepth?: number, maxFiles?: number, onProgress?: (msg: string) => void }} [opts]
 */
export async function buildDriveFolderManifest(rootFolderRaw, opts) {
  const rootId = resolveDriveId(rootFolderRaw);
  const meta = await getMetadata(rootId);
  if (meta.mimeType !== FOLDER_MIME) {
    throw new Error("Корень манифеста должен быть папкой Google Drive");
  }
  const maxDepth = opts?.maxDepth ?? 30;
  const maxFiles = opts?.maxFiles ?? 100_000;
  const scannedAt = new Date().toISOString();
  opts?.onProgress?.("манифест: начинаю обход корня на Google Drive…");

  /** @type {{ id: string, name: string, mimeType?: string, path: string, webViewLink?: string, modifiedTime?: string, size?: string }[]} */
  const files = [];
  let folderCount = 0;

  /**
   * @param {string} folderId
   * @param {string} relPath
   * @param {number} depth
   */
  async function walk(folderId, relPath, depth) {
    if (files.length >= maxFiles) return;
    if (depth > maxDepth) return;
    folderCount += 1;
    if (opts?.onProgress && folderCount % 40 === 0) {
      opts.onProgress(`манифест: папок обойдено ${folderCount}, файлов собрано ${files.length}…`);
    }
    const kids = await listChildren(folderId);
    for (const ch of kids) {
      if (!ch.id || !ch.name) continue;
      const rel = relPath ? `${relPath}/${ch.name}` : ch.name;
      if (ch.mimeType === FOLDER_MIME) {
        await walk(ch.id, rel, depth + 1);
        if (files.length >= maxFiles) return;
      } else {
        files.push({
          id: ch.id,
          name: ch.name,
          mimeType: ch.mimeType,
          path: rel,
          webViewLink: ch.webViewLink,
          modifiedTime: ch.modifiedTime,
          size: ch.size,
        });
        if (opts?.onProgress && files.length % 200 === 0) {
          opts.onProgress(`манифест: собрано файлов ${files.length} (папок ${folderCount})…`);
        }
        if (files.length >= maxFiles) return;
      }
    }
  }

  await walk(rootId, "", 0);
  const capped = files.length >= maxFiles;
  opts?.onProgress?.(
    `манифест: готово — файлов ${files.length}, папок посещено ${folderCount}${capped ? ", достигнут лимит maxFiles" : ""}.`,
  );
  return {
    scannedAt,
    rootFolderId: rootId,
    rootName: meta.name,
    maxDepth,
    maxFiles,
    capped,
    folderCount,
    fileCount: files.length,
    files,
  };
}

/**
 * @param {string} s
 */
function sanitizePathSegment(s) {
  const t = s.replace(/[\\/:*?"<>|]+/g, "_").trim();
  return t || "_";
}

/**
 * Локальный путь с сохранением относительной структуры (сегменты из пути на Drive).
 * @param {string} localRoot
 * @param {string} drivePath — путь вида `папка/файл.ext`
 */
function drivePathToLocalPath(localRoot, drivePath) {
  const parts = drivePath.split("/").map(sanitizePathSegment).filter(Boolean);
  if (parts.length === 0) return join(localRoot, "_unknown");
  return join(localRoot, ...parts);
}

/**
 * Рекурсивная выгрузка файлов из папки Drive (архив тендеров и т.д.) в локальный каталог.
 * Документы Google → `.txt`, таблицы → `.csv`, остальное — бинарная загрузка; прочие `application/vnd.google-apps.*` пропускаются с записью в `skipped`.
 *
 * @param {string} rootFolderRaw
 * @param {string} localRoot — корень на диске (создаётся при необходимости)
 * @param {{ maxDepth?: number, maxFiles?: number, onProgress?: (msg: string) => void }} [opts]
 */
export async function pullDriveFolderTreeToLocal(rootFolderRaw, localRoot, opts) {
  const manifest = await buildDriveFolderManifest(rootFolderRaw, {
    maxDepth: opts?.maxDepth,
    maxFiles: opts?.maxFiles,
    onProgress: opts?.onProgress,
  });
  opts?.onProgress?.(`выгрузка: начинаю запись ${manifest.fileCount} файлов в ${localRoot}…`);
  await mkdir(localRoot, { recursive: true });

  /** @type {{ path: string, localPath: string }[]} */
  const written = [];
  /** @type {{ path: string, note: string }[]} */
  const skipped = [];
  /** @type {{ path: string, error: string }[]} */
  const failed = [];

  let n = 0;
  for (const f of manifest.files) {
    if (!f.id || !f.path) continue;
    n += 1;
    if (opts?.onProgress && (n === 1 || n % 25 === 0 || n === manifest.files.length)) {
      opts.onProgress(`выгрузка: ${n} / ${manifest.files.length} — ${f.path.slice(0, 120)}`);
    }
    const baseDest = drivePathToLocalPath(localRoot, f.path);
    try {
      await mkdir(dirname(baseDest), { recursive: true });
      if (f.mimeType === GOOGLE_DOC) {
        const dest = baseDest.toLowerCase().endsWith(".txt") ? baseDest : `${baseDest}.txt`;
        await mkdir(dirname(dest), { recursive: true });
        await exportGoogleFile(f.id, "text/plain", dest);
        written.push({ path: f.path, localPath: dest });
      } else if (f.mimeType === GOOGLE_SHEET) {
        const withoutExt = baseDest.replace(/\.[^\\/]+$/, "");
        const dest = `${withoutExt}.csv`;
        await mkdir(dirname(dest), { recursive: true });
        await exportGoogleFile(f.id, "text/csv", dest);
        written.push({ path: f.path, localPath: dest });
      } else if (f.mimeType?.startsWith("application/vnd.google-apps.")) {
        skipped.push({
          path: f.path,
          note: `пропуск: экспорт для ${f.mimeType} не настроен`,
        });
      } else {
        await downloadFile(f.id, baseDest);
        written.push({ path: f.path, localPath: baseDest });
      }
    } catch (e) {
      failed.push({
        path: f.path,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  opts?.onProgress?.(
    `выгрузка: завершено — записано ${written.length}, пропусков ${skipped.length}, ошибок ${failed.length}.`,
  );

  return {
    ok: true,
    localRoot,
    rootFolderId: manifest.rootFolderId,
    rootName: manifest.rootName,
    capped: manifest.capped,
    fileCount: manifest.fileCount,
    writtenCount: written.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
    written,
    skipped,
    failed,
  };
}
