/**
 * Подсказки для КП из inputs/icetrade-import-snapshot.json (карточка IceTrade).
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertCredentialsFile } from "../drive/config.js";
import { downloadFile, listChildren } from "../drive/ops.js";
import {
  iceTradeCustomerValueIsDocReference,
  pickIceTradeCustomerOrganizationName,
} from "../icetrade/importPageMeta.js";

const SNAPSHOT_NAMES = ["icetrade-import-snapshot.json"];

/**
 * Ориентировочная / начальная стоимость с карточки IceTrade (structured / labeledFields).
 * @param {unknown} snap
 * @returns {string}
 */
export function snapshotProcedureBudgetHint(snap) {
  if (!snap || typeof snap !== "object") return "";
  const o = /** @type {Record<string, unknown>} */ (snap);
  const st = o.structured && typeof o.structured === "object" ? /** @type {Record<string, unknown>} */ (o.structured) : null;
  const proc = st?.procedure && typeof st.procedure === "object" ? /** @type {Record<string, unknown>} */ (st.procedure) : null;
  const fromStruct = typeof proc?.estimatedTotalValue === "string" ? proc.estimatedTotalValue.trim() : "";
  if (fromStruct) return fromStruct.slice(0, 400);
  const hints = o.priceHints;
  if (Array.isArray(hints) && hints[0] != null) return String(hints[0]).trim().slice(0, 400);
  const labeled = o.labeledFields && typeof o.labeledFields === "object" ? /** @type {Record<string, string>} */ (o.labeledFields) : null;
  if (labeled) {
    for (const [k, val] of Object.entries(labeled)) {
      if (/стоимост|нмц|цен\w*\s+лот|ориентировочн/i.test(k) && val?.trim()) return val.trim().slice(0, 400);
    }
  }
  return "";
}

/**
 * Дедлайн приёма предложений с карточки IceTrade.
 * @param {unknown} snap
 * @returns {string}
 */
export function snapshotBidsDeadlineHint(snap) {
  if (!snap || typeof snap !== "object") return "";
  const o = /** @type {Record<string, unknown>} */ (snap);
  const st = o.structured && typeof o.structured === "object" ? /** @type {Record<string, unknown>} */ (o.structured) : null;
  const proc = st?.procedure && typeof st.procedure === "object" ? /** @type {Record<string, unknown>} */ (st.procedure) : null;
  const fromStruct = typeof proc?.bidsDeadlineAt === "string" ? proc.bidsDeadlineAt.trim() : "";
  if (fromStruct) return fromStruct.slice(0, 400);
  const labeled = o.labeledFields && typeof o.labeledFields === "object" ? /** @type {Record<string, string>} */ (o.labeledFields) : null;
  if (labeled) {
    for (const [k, val] of Object.entries(labeled)) {
      if (/окончани|подач|прием\w*\s+предложен/i.test(k) && val?.trim()) return val.trim().slice(0, 400);
    }
  }
  return "";
}

/**
 * Добавить к корпусу анализа явные строки из snapshot (цена/дедлайн с сайта).
 * @param {unknown} snap
 */
export function buildSnapshotCorpusAugmentation(snap) {
  const budget = snapshotProcedureBudgetHint(snap);
  const dl = snapshotBidsDeadlineHint(snap);
  if (!budget && !dl) return "";
  /** @type {string[]} */
  const inner = [];
  if (budget) inner.push(`Ориентировочная / начальная стоимость закупки (карточка IceTrade): ${budget}`);
  if (dl) inner.push(`Дата и время окончания приёма предложений (карточка IceTrade): ${dl}`);
  return `### Данные карточки IceTrade (inputs/icetrade-import-snapshot.json)\n\n${inner.join("\n\n")}`;
}

/**
 * @param {unknown} snap
 * @returns {string | null}
 */
export function snapshotCustomerNameHint(snap) {
  if (!snap || typeof snap !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (snap);
  const labeled = o.labeledFields && typeof o.labeledFields === "object" ? /** @type {Record<string, string>} */ (o.labeledFields) : null;
  const ranked = labeled ? pickIceTradeCustomerOrganizationName(labeled) : null;
  if (ranked) return ranked.trim().slice(0, 480);

  const st = o.structured && typeof o.structured === "object" ? /** @type {Record<string, unknown>} */ (o.structured) : null;
  const customer = st?.customer && typeof st.customer === "object" ? /** @type {Record<string, unknown>} */ (st.customer) : null;
  const unp = typeof customer?.customerNameAddressUnp === "string" ? customer.customerNameAddressUnp.trim() : "";
  if (unp && !iceTradeCustomerValueIsDocReference(unp)) return unp.slice(0, 480);
  const conducted = typeof customer?.procurementConductedBy === "string" ? customer.procurementConductedBy.trim() : "";
  if (conducted && !iceTradeCustomerValueIsDocReference(conducted)) return conducted.slice(0, 480);

  if (labeled) {
    for (const [k, val] of Object.entries(labeled)) {
      if (/заказчик|организатор/i.test(k) && val?.trim() && !iceTradeCustomerValueIsDocReference(val))
        return val.trim().slice(0, 480);
    }
  }
  return null;
}

/**
 * @param {unknown} snap
 * @returns {string | null}
 */
export function snapshotDocumentTitleHint(snap) {
  if (!snap || typeof snap !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (snap);
  const t = typeof o.title === "string" ? o.title.trim() : "";
  if (t.length >= 6) return t.slice(0, 500);
  const st = o.structured && typeof o.structured === "object" ? /** @type {Record<string, unknown>} */ (o.structured) : null;
  const proc = st?.procedure && typeof st.procedure === "object" ? /** @type {Record<string, unknown>} */ (st.procedure) : null;
  const other = typeof proc?.otherInfo === "string" ? proc.otherInfo.trim().slice(0, 300) : "";
  if (other.length >= 12) return other;
  return null;
}

/**
 * @param {string} inputsFolderId
 * @returns {Promise<unknown | null>}
 */
export async function readIceTradeImportSnapshot(inputsFolderId) {
  assertCredentialsFile();
  const kids = await listChildren(inputsFolderId);
  const hit = kids.find((f) => SNAPSHOT_NAMES.includes(String(f.name ?? "")) && f.id);
  if (!hit?.id) return null;
  const tmp = await mkdtemp(join(tmpdir(), "lena-snap-"));
  const p = join(tmp, "snap.json");
  try {
    await downloadFile(String(hit.id), p);
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Наименование заказчика в шапке: не смешивать с адресом — «Республика Беларусь» с новой строки.
 * @param {string} text
 */
export function formatCustomerHeaderMultiline(text) {
  let s = String(text || "").trim();
  if (!s) return s;
  s = s.replace(/,\s*(Республика\s+Беларусь)/gi, "\n$1");
  s = s.replace(/([«»"])\s+(Республика\s+Беларусь)/gi, "$1\n$2");
  s = s.replace(/([.!?])\s+(Республика\s+Беларусь)/gi, "$1\n$2");
  s = s.replace(/\n{3,}/g, "\n").trim();
  return s;
}

/**
 * Грубое извлечение строки заказчика из текста извещения.
 * @param {string} corpus
 */
export function guessCustomerLineFromCorpus(corpus) {
  const c = String(corpus || "");
  const patterns = [
    /(?:полное\s+)?наименование\s+заказчика\s*[:\s]+([^\n]+)/i,
    /заказчик\s*[:\s]+([^\n]+)/i,
    /организатор\s+закупк\w*\s*[:\s]+([^\n]+)/i,
  ];
  for (const rx of patterns) {
    const m = c.match(rx);
    const cand = m?.[1]?.trim();
    if (cand && !iceTradeCustomerValueIsDocReference(cand)) return cand.slice(0, 480);
  }
  return "";
}

/**
 * @param {string} inputsFolderId
 */
export async function loadCpSnapshotHints(inputsFolderId) {
  const snap = await readIceTradeImportSnapshot(inputsFolderId);
  return {
    snapshot: snap,
    customerName: snapshotCustomerNameHint(snap),
    procurementTitle: snapshotDocumentTitleHint(snap),
  };
}
