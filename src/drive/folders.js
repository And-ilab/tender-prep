import { getDrive } from "./ops.js";

const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * @param {string} name
 */
function escapeDriveName(name) {
  return name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * @param {string} parentId
 * @param {string} name
 * @returns {Promise<string | null>}
 */
export async function findChildFolderId(parentId, name) {
  const drive = await getDrive();
  const q = `'${parentId}' in parents and name = '${escapeDriveName(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const res = await drive.files.list({
    q,
    fields: "files(id, name)",
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = res.data.files ?? [];
  return files[0]?.id ?? null;
}

/**
 * @param {string} parentId
 * @param {string} name
 * @returns {Promise<{ id: string, created: boolean }>}
 */
export async function ensureChildFolder(parentId, name) {
  const existing = await findChildFolderId(parentId, name);
  if (existing) {
    return { id: existing, created: false };
  }
  const drive = await getDrive();
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
    },
    fields: "id, name",
    supportsAllDrives: true,
  });
  const id = res.data.id;
  if (!id) {
    throw new Error(`Не удалось создать папку «${name}»`);
  }
  return { id, created: true };
}
