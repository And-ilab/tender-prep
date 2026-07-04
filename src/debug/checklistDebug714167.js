import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { uploadFile } from "../drive/ops.js";

const ENDPOINT = "http://127.0.0.1:7556/ingest/0fbf9c34-aa58-4c41-8b66-36b66355e6e0";
const SESSION = "714167";
const LOG_REL = join("logs", "checklist-debug-714167.ndjson");

/**
 * @param {string} location
 * @param {string} message
 * @param {Record<string, unknown>} data
 * @param {string} hypothesisId
 */
export function checklistDebug714167(location, message, data, hypothesisId) {
  const payload = {
    sessionId: SESSION,
    location,
    message,
    data,
    hypothesisId,
    timestamp: Date.now(),
  };
  // #region agent log
  fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": SESSION },
    body: JSON.stringify(payload),
  }).catch(() => {});
  const line = `${JSON.stringify(payload)}\n`;
  mkdir(join(process.cwd(), "logs"), { recursive: true })
    .then(() => appendFile(join(process.cwd(), LOG_REL), line))
    .catch(() => {});
  appendFile(join(process.cwd(), "debug-714167.log"), line).catch(() => {});
  console.error(`[debug-714167] ${message} ${JSON.stringify(data).slice(0, 500)}`);
  // #endregion
}

/**
 * @param {string | undefined} notesFolderId
 * @param {Record<string, unknown>} snapshot
 */
export async function checklistDebug714167UploadNotes(notesFolderId, snapshot) {
  checklistDebug714167("checklistDebug714167.js:snapshot", "analyze checklist snapshot", snapshot, "H1-H5");
  if (!notesFolderId) return;
  const tmp = join(tmpdir(), `checklist-debug-${Date.now()}.json`);
  try {
    await writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
    await uploadFile(notesFolderId, tmp, "checklist-debug-latest.json");
  } catch {
    /* ignore upload errors */
  }
}
