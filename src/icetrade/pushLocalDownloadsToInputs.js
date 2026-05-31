import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { assertCredentialsFile } from "../drive/config.js";
import { listChildren, uploadFile } from "../drive/ops.js";
import { ensureTenderTree } from "../drive/workspace.js";

/**
 * Имя без суффикса коллизии Playwright `saveAs`: `name-1.pdf` → `name.pdf`
 * @param {string} filename
 */
function canonicalLocalDownloadName(filename) {
  /** Суффикс коллизии Playwright: `-1` … `-999`, не трогаем `...-2024.pdf`. */
  const m = /^(.*)-(\d{1,3})(\.[^./]+)$/i.exec(filename);
  if (m) return m[1] + m[3];
  return filename;
}

/**
 * Из набора файлов в одной папке выбирает один экземпляр на каноническое имя
 * (убирает дубли `foo.pdf`, `foo-1.pdf`, `foo-2.pdf` от persistIceTradePlaywrightDownload).
 * Победитель: максимальный размер (типично полный PDF); при равенстве — более новый mtime.
 * @param {{ name: string, fullPath: string, size: number, mtimeMs: number }[]} files
 * @returns {{ picks: { destName: string, fullPath: string, sourceName: string }[], omitted: { name: string, reason: string }[] }}
 */
function pickUniqueLocalUploads(files) {
  /** @type {Map<string, { name: string, fullPath: string, size: number, mtimeMs: number }[]>} */
  const byCanon = new Map();
  for (const f of files) {
    const canon = canonicalLocalDownloadName(f.name);
    const list = byCanon.get(canon) ?? [];
    list.push(f);
    byCanon.set(canon, list);
  }

  /** @type {{ destName: string, fullPath: string, sourceName: string }[]} */
  const picks = [];
  /** @type {{ name: string, reason: string }[]} */
  const omitted = [];

  for (const [destName, group] of byCanon) {
    if (group.length === 1) {
      const g = group[0];
      picks.push({ destName, fullPath: g.fullPath, sourceName: g.name });
      continue;
    }
    /** @type {typeof group[0]} */
    let best = group[0];
    for (const g of group.slice(1)) {
      if (g.size > best.size) best = g;
      else if (g.size === best.size && g.mtimeMs > best.mtimeMs) best = g;
    }
    picks.push({ destName, fullPath: best.fullPath, sourceName: best.name });
    for (const g of group) {
      if (g.name !== best.name) {
        omitted.push({ name: g.name, reason: "duplicate_local_variant" });
      }
    }
  }

  picks.sort((a, b) => a.destName.localeCompare(b.destName));
  return { picks, omitted };
}

/**
 * Заливает файлы из локальной папки в **inputs** тендера на Drive (дерево `_lena/tenders/…` создаётся через API).
 * Существующие в **inputs** имена пропускаются (без перезаписи).
 * Локальные варианты **`имя-1.ext`**, **`имя-2.ext`** (коллизии после `saveAs` в Playwright) **схлопываются**:
 * на Drive уходит один файл с каноническим именем **`имя.ext`** — берётся копия с **наибольшим размером**.
 *
 * @param {string} userRootId — id или URL корневой папки Лены на Drive
 * @param {string} tenderId — id тендера (IceTrade view id)
 * @param {string} localDir — абсолютный путь к каталогу с файлами
 * @param {{ flat?: boolean, year?: string }} [opts]
 * @returns {Promise<{ ok: boolean, tenderId: string, inputsId: string, localDir: string, uploaded: { name: string, fromLocal?: string, id?: string, webViewLink?: string }[], skipped: { name: string, reason: string }[], errors: { name: string, message: string }[] }>}
 */
export async function pushLocalFilesToTenderInputs(userRootId, tenderId, localDir, opts = {}) {
  assertCredentialsFile();
  const abs = resolve(localDir);
  if (!existsSync(abs)) {
    throw new Error(`Локальная папка не найдена: ${abs}`);
  }

  const { tender } = await ensureTenderTree(userRootId, tenderId, {
    flat: opts.flat === true,
    year: opts.year,
  });
  const inputsId = tender.inputsId;

  const entries = await readdir(abs, { withFileTypes: true });
  /** @type {{ name: string, fullPath: string, size: number, mtimeMs: number }[]} */
  const fileMeta = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const fullPath = resolve(abs, e.name);
    const st = await stat(fullPath);
    fileMeta.push({
      name: e.name,
      fullPath,
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  }

  const { picks, omitted } = pickUniqueLocalUploads(fileMeta);
  const inputChildren = await listChildren(inputsId);
  const existing = new Set(inputChildren.map((f) => f.name));

  /** @type {{ name: string, id?: string, webViewLink?: string }[]} */
  const uploaded = [];
  /** @type {{ name: string, reason: string }[]} */
  const skipped = [];
  /** @type {{ name: string, message: string }[]} */
  const errors = [];

  for (const o of omitted) {
    skipped.push(o);
  }

  for (const { destName, fullPath, sourceName } of picks) {
    if (existing.has(destName)) {
      skipped.push({ name: destName, reason: "already_in_inputs" });
      continue;
    }
    try {
      const meta = await uploadFile(inputsId, fullPath, destName);
      const o = /** @type {{ id?: string, webViewLink?: string }} */ (meta);
      uploaded.push({
        name: destName,
        fromLocal: sourceName !== destName ? sourceName : undefined,
        id: o.id,
        webViewLink: o.webViewLink,
      });
      existing.add(destName);
    } catch (e) {
      errors.push({ name: destName, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    ok: errors.length === 0,
    tenderId,
    inputsId,
    localDir: abs,
    uploaded,
    skipped,
    errors,
  };
}