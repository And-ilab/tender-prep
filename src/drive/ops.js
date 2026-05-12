import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { assertCredentialsFile } from "./config.js";

/**
 * @returns {Promise<import("googleapis").drive_v3.Drive>}
 */
export async function getDrive() {
  let google;
  try {
    ({ google } = await import("googleapis"));
  } catch {
    throw new Error("Пакет googleapis не найден. Выполните в корне репозитория: npm install");
  }
  const keyFile = assertCredentialsFile();
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  const client = await auth.getClient();
  return google.drive({ version: "v3", auth: client });
}

const driveOpts = { supportsAllDrives: true, includeItemsFromAllDrives: true };

/**
 * @param {string} folderId
 */
export async function listChildren(folderId) {
  const drive = await getDrive();
  const q = `'${folderId}' in parents and trashed = false`;
  const res = await drive.files.list({
    q,
    fields: "files(id, name, mimeType, modifiedTime, size, webViewLink)",
    orderBy: "folder,name",
    pageSize: 200,
    ...driveOpts,
  });
  return res.data.files ?? [];
}

/**
 * @param {string} fileId
 */
export async function getMetadata(fileId) {
  const drive = await getDrive();
  const res = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, size, modifiedTime, webViewLink, parents, driveId",
    ...driveOpts,
  });
  return res.data;
}

/**
 * @param {string} fileId
 * @param {string} destPath
 */
export async function downloadFile(fileId, destPath) {
  const drive = await getDrive();
  const res = await drive.files.get(
    { fileId, alt: "media", ...driveOpts },
    { responseType: "stream" },
  );
  await pipeline(res.data, createWriteStream(destPath));
}

/**
 * Загрузка нового файла в папку (или корень общего диска с правами).
 * @param {string} folderId
 * @param {string} localPath
 * @param {string} [destName]
 */
export async function uploadFile(folderId, localPath, destName) {
  const drive = await getDrive();
  const name = destName?.trim() || basename(localPath);
  const res = await drive.files.create({
    requestBody: {
      name,
      parents: [folderId],
    },
    media: {
      body: createReadStream(localPath),
    },
    fields: "id, name, webViewLink, mimeType",
    ...driveOpts,
  });
  return res.data;
}

/**
 * Переименовать файл или папку.
 * @param {string} fileId
 * @param {string} newName
 */
export async function updateFileName(fileId, newName) {
  const drive = await getDrive();
  const res = await drive.files.update({
    fileId,
    requestBody: { name: newName },
    fields: "id, name, webViewLink, mimeType",
    supportsAllDrives: true,
  });
  return res.data;
}

/**
 * Копировать файл (в т.ч. Google Doc как шаблон) в папку.
 * @param {string} fileId
 * @param {string} destFolderId
 * @param {string} newName
 */
export async function copyFileToFolder(fileId, destFolderId, newName) {
  const drive = await getDrive();
  const res = await drive.files.copy({
    fileId,
    requestBody: {
      name: newName,
      parents: [destFolderId],
    },
    fields: "id, name, webViewLink, mimeType",
    supportsAllDrives: true,
  });
  return res.data;
}

/**
 * Экспорт Google Docs/Sheets в файл на диск.
 * @param {string} fileId
 * @param {string} exportMime
 * @param {string} destPath
 */
export async function exportGoogleFile(fileId, exportMime, destPath) {
  const drive = await getDrive();
  const res = await drive.files.export(
    { fileId, mimeType: exportMime },
    { responseType: "stream" },
  );
  await pipeline(res.data, createWriteStream(destPath));
}
