import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { downloadFile, listChildren, uploadFile } from "../drive/ops.js";
import {
  archiveStemFromFileName,
  driveNameForArchiveMember,
  extractArchiveToDirectory,
  isArchiveFileName,
  isUsefulArchiveMemberName,
  listExtractedFilesRecursive,
  resolveArchiveKind,
  shouldSkipArchiveMemberPath,
} from "./archiveUtils.js";

export const ARCHIVE_EXPAND_MANIFEST_NAME = "archive-expand-manifest.json";

/**
 * @param {unknown} raw
 * @returns {Set<string>}
 */
function expandedArchiveStemsFromManifest(raw) {
  /** @type {Set<string>} */
  const stems = new Set();
  if (!raw || typeof raw !== "object") return stems;
  const entries = /** @type {{ entries?: unknown[] }} */ (raw).entries;
  if (!Array.isArray(entries)) return stems;
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const stem = typeof /** @type {{ archiveStem?: string }} */ (e).archiveStem === "string"
      ? e.archiveStem.trim()
      : "";
    if (stem) stems.add(stem);
  }
  return stems;
}

/**
 * @param {string} inputsId
 */
async function loadExpandManifestStems(inputsId) {
  const kids = await listChildren(inputsId);
  const man = kids.find((f) => f.name === ARCHIVE_EXPAND_MANIFEST_NAME);
  if (!man?.id) return new Set();
  const tmp = await mkdtemp(join(tmpdir(), "lena-axm-"));
  const dest = join(tmp, ARCHIVE_EXPAND_MANIFEST_NAME);
  try {
    await downloadFile(String(man.id), dest);
    const raw = JSON.parse(await readFile(dest, "utf8"));
    return expandedArchiveStemsFromManifest(raw);
  } catch {
    return new Set();
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {string} inputsId
 * @param {Record<string, unknown>} manifest
 */
async function persistExpandManifest(inputsId, manifest) {
  const tmp = await mkdtemp(join(tmpdir(), "lena-axw-"));
  const path = join(tmp, ARCHIVE_EXPAND_MANIFEST_NAME);
  try {
    await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
    await uploadFile(inputsId, path, ARCHIVE_EXPAND_MANIFEST_NAME);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Распаковать архивы в **inputs/** и загрузить содержимое с префиксом `<имя-архива>__…`.
 * Повторный запуск пропускает уже обработанные архивы (по **archive-expand-manifest.json**).
 *
 * @param {string} inputsId
 * @param {{ maxDepth?: number, maxFiles?: number, maxArchiveBytes?: number, onProgress?: (msg: string) => void }} [opts]
 */
export async function expandArchivesInInputs(inputsId, opts = {}) {
  const maxDepth = Math.max(1, opts.maxDepth ?? 2);
  const maxFiles =
    Number.parseInt(process.env.LENA_ARCHIVE_EXPAND_MAX_FILES?.trim() ?? String(opts.maxFiles ?? 80), 10) || 80;
  const maxArchiveBytes =
    Number.parseInt(process.env.LENA_ARCHIVE_EXPAND_MAX_BYTES?.trim() ?? String(opts.maxArchiveBytes ?? 45 * 1024 * 1024), 10) ||
    45 * 1024 * 1024;
  const onProgress = opts.onProgress;

  /** @type {{ name: string, webViewLink?: string }[]} */
  const uploaded = [];
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {Record<string, unknown>[]} */
  const manifestEntries = [];

  let inputChildren = await listChildren(inputsId);
  let existing = new Set(inputChildren.map((f) => String(f.name ?? "")));
  const expandedStems = await loadExpandManifestStems(inputsId);
  let totalUploaded = 0;

  /**
   * @param {string} archiveDriveName
   * @param {string} archiveFileId
   * @param {number} depth
   */
  async function expandOne(archiveDriveName, archiveFileId, depth) {
    if (depth > maxDepth) {
      skipped.push(`${archiveDriveName}: maxDepth`);
      return;
    }
    if (totalUploaded >= maxFiles) {
      skipped.push(`${archiveDriveName}: лимит файлов (${maxFiles})`);
      return;
    }

    const stem = archiveStemFromFileName(archiveDriveName);
    if (expandedStems.has(stem)) {
      skipped.push(`${archiveDriveName}: уже в manifest`);
      return;
    }

    const tmpRoot = await mkdtemp(join(tmpdir(), "lena-ax-"));
    const localArchive = join(tmpRoot, archiveDriveName.replace(/[\\/:*?"<>|]+/g, "_"));
    const extractDir = join(tmpRoot, "out");
    /** @type {string[]} */
    const memberNames = [];
    /** @type {string} */
    let via = "";

    try {
      onProgress?.(`распаковка ${archiveDriveName}…`);
      await downloadFile(archiveFileId, localArchive);
      const buf = await readFile(localArchive);
      if (buf.byteLength > maxArchiveBytes) {
        throw new Error(`архив слишком большой (${buf.byteLength} B, лимит ${maxArchiveBytes})`);
      }
      const kind = resolveArchiveKind(archiveDriveName, buf);
      if (!kind) throw new Error("не распознан как zip/rar/7z");

      const { mkdir } = await import("node:fs/promises");
      await mkdir(extractDir, { recursive: true });
      const ex = await extractArchiveToDirectory(localArchive, extractDir, { kind });
      via = ex.via;

      const members = await listExtractedFilesRecursive(extractDir);
      for (const m of members) {
        if (totalUploaded >= maxFiles) break;
        if (shouldSkipArchiveMemberPath(m.relativePath)) continue;
        if (!isUsefulArchiveMemberName(m.relativePath)) continue;

        const destName = driveNameForArchiveMember(archiveDriveName, m.relativePath);
        if (existing.has(destName)) {
          skipped.push(`${destName}: уже в inputs`);
          memberNames.push(destName);
          continue;
        }

        const meta = await uploadFile(inputsId, m.fullPath, destName);
        const metaObj = /** @type {{ name?: string; webViewLink?: string }} */ (meta);
        uploaded.push({ name: metaObj.name ?? destName, webViewLink: metaObj.webViewLink });
        existing.add(destName);
        memberNames.push(destName);
        totalUploaded += 1;

        if (isArchiveFileName(destName)) {
          const nestedId = String(/** @type {{ id?: string }} */ (meta).id ?? "");
          if (nestedId) await expandOne(destName, nestedId, depth + 1);
        }
      }

      expandedStems.add(stem);
      manifestEntries.push({
        archiveName: archiveDriveName,
        archiveStem: stem,
        expandedAt: new Date().toISOString(),
        via,
        memberCount: memberNames.length,
        members: memberNames,
      });
    } catch (e) {
      errors.push(`${archiveDriveName}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  for (const f of inputChildren) {
    const name = String(f.name ?? "");
    const id = String(f.id ?? "");
    if (!name || !id) continue;
    if (name === ARCHIVE_EXPAND_MANIFEST_NAME) continue;
    if (!isArchiveFileName(name)) continue;
    await expandOne(name, id, 1);
    if (totalUploaded >= maxFiles) break;
  }

  if (manifestEntries.length > 0) {
    await persistExpandManifest(inputsId, {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      inputsFolderId: inputsId,
      entries: manifestEntries,
    });
    existing.add(ARCHIVE_EXPAND_MANIFEST_NAME);
  }

  return { uploaded, skipped, errors, expandedCount: manifestEntries.length };
}
