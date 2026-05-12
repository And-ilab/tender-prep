import { assertCredentialsFile } from "./config.js";
import { driveFilesCreate, driveFilesList } from "./driveHttp.js";

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
  assertCredentialsFile();
  const q = `'${parentId}' in parents and name = '${escapeDriveName(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const data = await driveFilesList(q, "files(id, name)", undefined);
  const files = data.files ?? [];
  return files[0]?.id ?? null;
}

/**
 * @param {string} parentId
 * @param {string} name
 * @returns {Promise<{ id: string, created: boolean }>}
 */
export async function ensureChildFolder(parentId, name) {
  assertCredentialsFile();
  const existing = await findChildFolderId(parentId, name);
  if (existing) {
    return { id: existing, created: false };
  }
  const data = await driveFilesCreate(
    {
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
    },
    "id, name",
  );
  const id = data.id;
  if (!id) {
    throw new Error(`Не удалось создать папку «${name}»`);
  }
  return { id, created: true };
}
