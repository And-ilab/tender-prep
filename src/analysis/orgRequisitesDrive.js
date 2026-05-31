/**
 * Текст реквизитов организации с Drive (плоские файлы в папке).
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertCredentialsFile } from "../drive/config.js";
import { resolveDriveId } from "../drive/ids.js";
import { downloadFile, exportGoogleFile, listChildren } from "../drive/ops.js";

const TEXT_MIME = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
]);

/**
 * @param {string} mime
 */
function isGoogleNative(mime) {
  return typeof mime === "string" && mime.startsWith("application/vnd.google-apps.");
}

/**
 * @param {string} folderIdOrUrl
 * @param {{ maxChars?: number }} [opts]
 */
export async function loadOrgRequisitesSnippet(folderIdOrUrl, opts = {}) {
  assertCredentialsFile();
  const maxChars = opts.maxChars ?? 12_000;
  /** @type {string[]} */
  const warnings = [];
  let fid;
  try {
    fid = resolveDriveId(folderIdOrUrl.trim());
  } catch (e) {
    warnings.push(`Реквизиты: неверный id/URL папки — ${e instanceof Error ? e.message : String(e)}`);
    return { text: "", warnings };
  }

  const kids = await listChildren(fid);
  /** @type {{ id: string; name: string; mimeType?: string }[]} */
  const files = [];
  for (const f of kids) {
    if (f.mimeType === "application/vnd.google-apps.folder") continue;
    if (!f.id) continue;
    files.push({ id: String(f.id), name: String(f.name ?? ""), mimeType: String(f.mimeType ?? "") });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, "ru"));

  /** @type {string[]} */
  const parts = [];
  let total = 0;
  const tmp = await mkdtemp(join(tmpdir(), "lena-orgreq-"));
  try {
    for (const f of files) {
      if (total >= maxChars) break;
      const mime = f.mimeType || "";
      const dest = join(tmp, `f-${f.id.slice(0, 8)}`);
      try {
        let chunk = "";
        if (mime === "application/vnd.google-apps.document") {
          await exportGoogleFile(f.id, "text/plain", dest);
          chunk = (await readFile(dest, "utf8")).trim();
        } else if (mime === "application/vnd.google-apps.spreadsheet") {
          await exportGoogleFile(f.id, "text/csv", dest);
          chunk = (await readFile(dest, "utf8")).trim();
        } else if (TEXT_MIME.has(mime) || /\.(txt|md|json)$/i.test(f.name)) {
          await downloadFile(f.id, dest);
          chunk = (await readFile(dest, "utf8")).trim();
        } else if (!isGoogleNative(mime)) {
          await downloadFile(f.id, dest);
          chunk = (await readFile(dest, "utf8")).trim();
          if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(chunk.slice(0, 400))) {
            chunk = "";
          }
        }
        if (!chunk) continue;
        const header = `\n### Реквизиты · файл: ${f.name}\n`;
        const room = maxChars - total - header.length;
        if (room <= 40) break;
        const slice = chunk.length > room ? `${chunk.slice(0, room)}\n…[усечено]` : chunk;
        parts.push(`${header}${slice}`);
        total += header.length + slice.length;
      } catch (e) {
        warnings.push(`${f.name}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  if (!parts.length && files.length) {
    warnings.push(
      "В папке реквизитов нет подходящих текстовых файлов (txt/md/json/Google Doc/Sheet) или не удалось экспортировать.",
    );
  }

  return { text: parts.join("\n").trim(), warnings };
}

/**
 * Папка из LENA_ORG_REQUISITES_FOLDER_ID или пусто.
 */
export async function loadOrgRequisitesFromEnv() {
  const raw = process.env.LENA_ORG_REQUISITES_FOLDER_ID?.trim();
  if (!raw) return { text: "", warnings: [] };
  return loadOrgRequisitesSnippet(raw);
}
