/**
 * Сквозной счётчик исходящих документов Лены (КП и др.) в `_lena/context/lena-global-document-counter.json`.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertCredentialsFile } from "../drive/config.js";
import { resolveLayoutIds } from "../drive/workspace.js";
import { downloadFile, listChildren, trashDriveFile, uploadFile } from "../drive/ops.js";

const COUNTER_NAME = "lena-global-document-counter.json";

/**
 * Дата для шапки документов ДД.ММ.ГГГГ (локальное время ОС).
 */
export function formatDocumentCounterDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/**
 * Строка вида «номер, дата» — устаревший краткий формат (резерв).
 * @param {number} seq
 * @param {string} [dateLabel]
 */
export function formatDocumentSerialLine(seq, dateLabel) {
  const d = dateLabel ?? formatDocumentCounterDate();
  return `${seq}, ${d}`;
}

/**
 * Исходящий номер для шапки КП: «Исх. № … от ДД.ММ.ГГГГ».
 * Префикс различает организацию-участника (ГС Ритейл / Финсельват).
 * @param {number} seq
 * @param {string} [dateLabel] — ДД.ММ.ГГГГ
 * @param {"gs_retail" | "finselvat" | null | undefined} [offerOrg]
 */
export function formatCommercialProposalOutgoingRef(seq, dateLabel, offerOrg) {
  const d = (dateLabel ?? formatDocumentCounterDate()).trim();
  const yearMatch = d.match(/\.(\d{4})$/);
  const year = yearMatch?.[1] ?? String(new Date().getFullYear());
  const n = String(Math.max(0, Math.floor(Number(seq) || 0))).padStart(4, "0");
  if (offerOrg === "gs_retail") {
    return `Исх. № ГСР-${year}/${n} от ${d}`;
  }
  if (offerOrg === "finselvat") {
    return `Исх. № ФСВ-${year}/${n} от ${d}`;
  }
  return `Исх. № ЛН-${year}/${n} от ${d}`;
}

/**
 * Атомарно увеличить счётчик и вернуть новое значение.
 * @param {string} userRootId
 * @returns {Promise<{ seq: number; dateLabel: string; serialLine: string }>}
 */
export async function allocateNextDocumentSerial(userRootId) {
  assertCredentialsFile();
  const layout = await resolveLayoutIds(userRootId);
  if (!layout.contextId) {
    throw new Error(
      "Нет папки _lena/context на Drive — выполните workspace-ensure для корня Лены.",
    );
  }
  const folderId = layout.contextId;
  const kids = await listChildren(folderId);
  const hit = kids.find((f) => String(f.name ?? "") === COUNTER_NAME && f.id);
  const tmp = await mkdtemp(join(tmpdir(), "lena-doccnt-"));
  const localPath = join(tmp, COUNTER_NAME);
  let seq = 0;
  /** @type {string | null} */
  let oldId = null;
  try {
    if (hit?.id) {
      oldId = String(hit.id);
      await downloadFile(oldId, localPath);
      try {
        const raw = JSON.parse(await readFile(localPath, "utf8"));
        const n = Number(raw?.seq ?? raw?.next ?? raw?.counter ?? 0);
        seq = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
      } catch {
        seq = 0;
      }
    }
    seq += 1;
    await writeFile(localPath, `${JSON.stringify({ seq, updatedAt: new Date().toISOString() })}\n`, "utf8");
    await uploadFile(folderId, localPath, COUNTER_NAME);
    if (oldId) {
      await trashDriveFile(oldId).catch(() => {});
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  const dateLabel = formatDocumentCounterDate();
  return { seq, dateLabel, serialLine: formatDocumentSerialLine(seq, dateLabel) };
}
