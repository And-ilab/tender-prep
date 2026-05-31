import { getDriveAccessToken } from "./authToken.js";

const DOCS_V1 = "https://docs.googleapis.com/v1/documents";

/**
 * @param {string} documentId
 */
export async function docsGet(documentId) {
  const token = await getDriveAccessToken();
  const url = `${DOCS_V1}/${encodeURIComponent(documentId)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Docs API GET ${res.status}: ${text.slice(0, 2000)}`);
  }
  return JSON.parse(text);
}

/**
 * @param {string} documentId
 * @param {Record<string, unknown>[]} requests
 */
export async function docsBatchUpdate(documentId, requests) {
  const token = await getDriveAccessToken();
  const url = `${DOCS_V1}/${encodeURIComponent(documentId)}:batchUpdate`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Docs API batchUpdate ${res.status}: ${text.slice(0, 2000)}`);
  }
  return JSON.parse(text);
}
