import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getDriveAccessToken } from "./authToken.js";

const DRIVE_V3 = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

function sharedParams() {
  return "supportsAllDrives=true&includeItemsFromAllDrives=true";
}

/**
 * @param {string} pathWithLeadingSlash e.g. /files
 * @param {Record<string, string | number | undefined>} [query]
 */
function buildUrl(base, path, query) {
  const u = new URL(base + path);
  u.searchParams.set("supportsAllDrives", "true");
  u.searchParams.set("includeItemsFromAllDrives", "true");
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function readJsonResponse(url, init) {
  const token = await getDriveAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init?.headers },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Drive API ${res.status}: ${text.slice(0, 2000)}`);
  }
  return JSON.parse(text);
}

/**
 * @param {string} q
 * @param {string} fields
 * @param {string} [orderBy]
 */
export async function driveFilesList(q, fields, orderBy, pageToken) {
  const u = new URL(`${DRIVE_V3}/files`);
  u.searchParams.set("supportsAllDrives", "true");
  u.searchParams.set("includeItemsFromAllDrives", "true");
  u.searchParams.set("q", q);
  u.searchParams.set("fields", fields);
  u.searchParams.set("pageSize", "200");
  if (orderBy) u.searchParams.set("orderBy", orderBy);
  if (pageToken) u.searchParams.set("pageToken", pageToken);
  return readJsonResponse(u.toString(), { method: "GET" });
}

/**
 * @param {Record<string, unknown>} body
 * @param {string} fields
 */
export async function driveFilesCreate(body, fields) {
  const u = buildUrl(DRIVE_V3, "/files", { fields });
  return readJsonResponse(u, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * @param {string} fileId
 * @param {Record<string, unknown>} body
 * @param {string} fields
 */
export async function driveFilesUpdate(fileId, body, fields) {
  const u = new URL(`${DRIVE_V3}/files/${encodeURIComponent(fileId)}`);
  u.searchParams.set("supportsAllDrives", "true");
  u.searchParams.set("includeItemsFromAllDrives", "true");
  u.searchParams.set("fields", fields);
  return readJsonResponse(u.toString(), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * @param {string} fileId
 * @param {Record<string, unknown>} body
 * @param {string} fields
 */
export async function driveFilesCopy(fileId, body, fields) {
  const u = new URL(`${DRIVE_V3}/files/${encodeURIComponent(fileId)}/copy`);
  u.searchParams.set("supportsAllDrives", "true");
  u.searchParams.set("includeItemsFromAllDrives", "true");
  u.searchParams.set("fields", fields);
  return readJsonResponse(u.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * @param {string} fileId
 * @param {string} fields
 */
export async function driveFilesGetMeta(fileId, fields) {
  const u = new URL(`${DRIVE_V3}/files/${encodeURIComponent(fileId)}`);
  u.searchParams.set("supportsAllDrives", "true");
  u.searchParams.set("includeItemsFromAllDrives", "true");
  u.searchParams.set("fields", fields);
  return readJsonResponse(u.toString(), { method: "GET" });
}

/**
 * @param {string} fileId
 * @param {import('node:stream').Writable} dest
 */
export async function driveDownloadMedia(fileId, dest) {
  const token = await getDriveAccessToken();
  const u = `${DRIVE_V3}/files/${encodeURIComponent(fileId)}?alt=media&${sharedParams()}`;
  const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Drive download ${res.status}: ${t.slice(0, 500)}`);
  }
  if (!res.body) throw new Error("Нет тела ответа");
  await pipeline(Readable.fromWeb(/** @type {import('stream/web').ReadableStream} */ (res.body)), dest);
}

/**
 * @param {string} fileId
 * @param {string} exportMime
 * @param {import('node:stream').Writable} dest
 */
export async function driveExport(fileId, exportMime, dest) {
  const token = await getDriveAccessToken();
  const u = new URL(`${DRIVE_V3}/files/${encodeURIComponent(fileId)}/export`);
  u.searchParams.set("mimeType", exportMime);
  const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Drive export ${res.status}: ${t.slice(0, 500)}`);
  }
  if (!res.body) throw new Error("Нет тела ответа");
  await pipeline(Readable.fromWeb(/** @type {import('stream/web').ReadableStream} */ (res.body)), dest);
}

/**
 * Multipart upload (metadata + файл).
 * @param {string} folderId
 * @param {string} localPath
 * @param {string} destName
 */
export async function driveMultipartUpload(folderId, localPath, destName) {
  const token = await getDriveAccessToken();
  const name = destName.trim() || basename(localPath);
  const metadata = JSON.stringify({ name, parents: [folderId] });
  const content = readFileSync(localPath);
  const boundary = `lena_${randomBytes(16).toString("hex")}`;
  const crlf = "\r\n";
  const head = Buffer.from(
    `--${boundary}${crlf}Content-Type: application/json; charset=UTF-8${crlf}${crlf}${metadata}${crlf}` +
      `--${boundary}${crlf}Content-Type: application/octet-stream${crlf}${crlf}`,
    "utf8",
  );
  const tail = Buffer.from(`${crlf}--${boundary}--${crlf}`, "utf8");
  const body = Buffer.concat([head, content, tail]);
  const fields = encodeURIComponent("id, name, webViewLink, mimeType");
  const u = `${UPLOAD_BASE}/files?uploadType=multipart&supportsAllDrives=true&fields=${fields}`;
  const res = await fetch(u, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Drive upload ${res.status}: ${text.slice(0, 2000)}`);
  }
  return JSON.parse(text);
}
