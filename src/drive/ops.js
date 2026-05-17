import { createWriteStream } from "node:fs";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { assertCredentialsFile } from "./config.js";
import {
  driveDownloadMedia,
  driveExport,
  driveFilesCopy,
  driveFilesCreate,
  driveFilesGetMeta,
  driveFilesList,
  driveFilesTrash,
  driveFilesUpdate,
  driveMultipartUpload,
} from "./driveHttp.js";

/**
 * @param {string} folderId
 */
export async function listChildren(folderId) {
  assertCredentialsFile();
  const q = `'${folderId}' in parents and trashed = false`;
  const fields = "nextPageToken, files(id, name, mimeType, modifiedTime, size, webViewLink)";
  /** @type {Record<string, unknown>[]} */
  const all = [];
  let pageToken;
  do {
    const data = await driveFilesList(q, fields, "folder,name", pageToken);
    const chunk = data.files ?? [];
    for (const f of chunk) all.push(f);
    pageToken = /** @type {string | undefined} */ (data.nextPageToken);
  } while (pageToken);
  return all;
}

/**
 * @param {string} fileId
 */
export async function getMetadata(fileId) {
  assertCredentialsFile();
  return driveFilesGetMeta(
    fileId,
    "id, name, mimeType, size, modifiedTime, webViewLink, parents, driveId",
  );
}

/**
 * @param {string} fileId
 * @param {string} destPath
 */
export async function downloadFile(fileId, destPath) {
  assertCredentialsFile();
  await driveDownloadMedia(fileId, createWriteStream(destPath));
}

/**
 * @param {string} folderId
 * @param {string} localPath
 * @param {string} [destName]
 */
export async function uploadFile(folderId, localPath, destName) {
  assertCredentialsFile();
  const name = destName?.trim() || basename(localPath);
  return driveMultipartUpload(folderId, localPath, name);
}

/**
 * @param {string} fileId
 * @param {string} newName
 */
export async function updateFileName(fileId, newName) {
  assertCredentialsFile();
  return driveFilesUpdate(fileId, { name: newName }, "id, name, webViewLink, mimeType");
}

/**
 * @param {string} fileId
 * @param {string} destFolderId
 * @param {string} newName
 */
export async function copyFileToFolder(fileId, destFolderId, newName) {
  assertCredentialsFile();
  return driveFilesCopy(
    fileId,
    { name: newName, parents: [destFolderId] },
    "id, name, webViewLink, mimeType",
  );
}

/**
 * @param {string} fileId
 * @param {string} exportMime
 * @param {string} destPath
 */
export async function exportGoogleFile(fileId, exportMime, destPath) {
  assertCredentialsFile();
  await driveExport(fileId, exportMime, createWriteStream(destPath));
}

/**
 * Переместить файл в корзину Drive (освободить имя в папке).
 * @param {string} fileId
 */
export async function trashDriveFile(fileId) {
  assertCredentialsFile();
  await driveFilesTrash(fileId);
}
