/**
 * КП в Google Docs: копия шаблона на Drive + подстановка текста через Docs API.
 * В шаблоне желательно один абзац-плейсхолдер с текстом {{LENA_KP_BODY}} — он заменяется на текст черновика (plain).
 * Если плейсхолдера нет — текст дописывается в конец документа.
 */

import { copyFileToFolder, getMetadata, listChildren } from "../drive/ops.js";
import { findChildFolderId } from "../drive/folders.js";
import { resolveDriveId } from "../drive/ids.js";
import { LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG } from "../drive/layoutConstants.js";
import { resolveLayoutIds } from "../drive/workspace.js";
import { docsBatchUpdate, docsGet } from "../drive/docsHttp.js";

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

/** Видно в UI шаблона; заменяется на тело КП (plain). */
export const KP_BODY_PLACEHOLDER = "{{LENA_KP_BODY}}";

/** Подстановки шаблона в квадратных скобках (как в бланках организации). */
export const KP_TEMPLATE_CUSTOMER = "[Наименование заказчика]";
export const KP_TEMPLATE_DOC_TITLE = "[Наименование документа]";
export const KP_TEMPLATE_NUMBER_DATE = "[Номер и дата предложения]";
export const KP_TEMPLATE_BODY = "[Текст документа]";

const APPEND_FALLBACK_NOTE =
  "[Автовставка Лены: в шаблон добавьте абзац «{{LENA_KP_BODY}}», чтобы черновик попадал в нужное место разметки.]\n\n";

/** Маркеры «жирный» для прохода markdown→plain (не встречаются в типовом тексте КП). */
const KP_BOLD_START = "\uE000";
const KP_BOLD_END = "\uE001";

/**
 * Грубое снятие markdown для Google Docs (индексы UTF-16 совпадают с .length в JS для BMP).
 * @param {string} md
 */
export function markdownishToPlain(md) {
  let s = md.replace(/\r\n/g, "\n");
  s = s.replace(/^---[\s\S]*?^---\s*/m, "");
  s = s.replace(/```[\s\S]*?```/g, "\n");
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/^\s*[-*+]\s+/gm, "• ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trimEnd();
}

/**
 * Markdown КП → текст с маркерами жирного (ещё не plain).
 * @param {string} md
 */
export function kpMarkdownWithBoldMarkers(md) {
  let s = String(md || "").replace(/\r\n/g, "\n");
  s = s.replace(/^---[\s\S]*?^---\s*/m, "");
  s = s.replace(/```[\s\S]*?```/g, "\n");
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/\*\*([^*]+)\*\*/g, `${KP_BOLD_START}$1${KP_BOLD_END}`);
  s = s.replace(/\*([^*\n]+)\*/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/^\s*[-*+]\s+/gm, "• ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trimEnd();
}

/**
 * @param {string} marked
 * @returns {{ plain: string, boldSpans: { start: number, end: number }[] }}
 */
function stripBoldMarkersAndCollectSpans(marked) {
  /** @type {{ start: number, end: number }[]} */
  const boldSpans = [];
  let out = "";
  for (let i = 0; i < marked.length; ) {
    const ch = marked[i];
    if (ch === KP_BOLD_START) {
      const end = marked.indexOf(KP_BOLD_END, i + 1);
      if (end === -1) {
        out += ch;
        i++;
        continue;
      }
      const inner = marked.slice(i + 1, end);
      const startIdx = out.length;
      out += inner;
      boldSpans.push({ start: startIdx, end: out.length });
      i = end + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return { plain: out, boldSpans };
}

/**
 * Первая строка блока может быть целиком в маркерах жирного KP — для распознавания заголовков снимаем внешнюю пару.
 * @param {string} line
 */
function stripOuterKpBoldMarkerPair(line) {
  const t = line.trim();
  if (t.length >= 2 && t[0] === KP_BOLD_START && t[t.length - 1] === KP_BOLD_END) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/**
 * Красная строка для абзацев текста КП в Google Doc (после конвертации в plain).
 * Нумерованные заголовки «1. …», вложенные «2.1 …», маркеры списка и строки «(1) …» не трогаем (без красной строки в первой строке блока).
 * @param {string} plain
 */
export function applyCpBodyParagraphIndents(plain) {
  const blocks = plain.split(/\n\n+/);
  /** @type {string[]} */
  const out = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = trimmed.split(/\n/);
    const head = lines[0] ?? "";
    const hTrim = stripOuterKpBoldMarkerPair(head);
    if (/^\d+\.\s+[А-ЯЁA-Zа-яё]/.test(hTrim)) {
      out.push(trimmed);
      continue;
    }
    if (/^\d+\.\d+\s+[А-ЯЁA-Zа-яё]/.test(hTrim)) {
      out.push(trimmed);
      continue;
    }
    if (/^\(\d+\)\s/.test(hTrim)) {
      out.push(trimmed);
      continue;
    }
    if (/^[•\-—]\s/.test(hTrim)) {
      out.push(trimmed);
      continue;
    }
    const firstRaw = lines[0];
    const first = /^\t|^ {4,}/.test(firstRaw) ? firstRaw : `\t${firstRaw}`;
    out.push([first, ...lines.slice(1)].join("\n"));
  }
  return out.join("\n\n");
}

/**
 * Plain-текст для вставки в Google Doc: markdown → plain → абзацы и отступы + диапазоны жирного (по **…** из черновика).
 * @param {string} md
 * @returns {{ plain: string, boldSpans: { start: number, end: number }[] }}
 */
export function finalizeCommercialProposalPlainForGoogleDoc(md) {
  const marked = kpMarkdownWithBoldMarkers(md);
  const indented = applyCpBodyParagraphIndents(marked);
  return stripBoldMarkersAndCollectSpans(indented);
}

/**
 * @param {Record<string, unknown>} doc — ответ documents.get
 * @param {string} needle
 * @returns {number} индекс первого символа needle в координатах Google Docs API или -1
 */
function findPlaceholderGoogleStart(doc, needle) {
  if (!needle) return -1;
  for (const el of doc.body?.content ?? []) {
    const p = el.paragraph;
    if (!p?.elements) continue;
    for (const pe of p.elements) {
      const si = typeof pe.startIndex === "number" ? pe.startIndex : undefined;
      const c = pe.textRun?.content;
      if (typeof c !== "string" || typeof si !== "number") continue;
      const ix = c.indexOf(needle);
      if (ix !== -1) return si + ix;
    }
  }
  return -1;
}

/**
 * @param {string} documentId
 * @param {number} bodyStartGoogle — индекс первого символа тела КП после replace (как в API)
 * @param {{ start: number, end: number }[]} boldSpans — смещения в plain-тексте тела [start,end)
 */
async function docsApplyBoldSpans(documentId, bodyStartGoogle, boldSpans) {
  if (!boldSpans?.length || bodyStartGoogle < 1) return;
  const requests = boldSpans
    .filter((sp) => sp.end > sp.start && sp.start >= 0)
    .map((sp) => ({
      updateTextStyle: {
        range: {
          startIndex: bodyStartGoogle + sp.start,
          endIndex: bodyStartGoogle + sp.end,
        },
        textStyle: { bold: true },
        fields: "bold",
      },
    }));
  if (!requests.length) return;
  await docsBatchUpdate(documentId, requests);
}

/**
 * @param {Record<string, unknown>} doc
 */
function docAppendInsertIndex(doc) {
  const content = doc.body?.content;
  if (!Array.isArray(content) || content.length === 0) {
    return 1;
  }
  let max = 1;
  for (const el of content) {
    const end = /** @type {{ endIndex?: number }} */ (el).endIndex;
    if (typeof end === "number" && end > max) {
      max = end;
    }
  }
  return max - 1;
}

/**
 * @param {string} plain
 * @param {number} maxUnits
 * @returns {string[]}
 */
function chunkPlainForInsert(plain, maxUnits) {
  if (plain.length <= maxUnits) {
    return [plain];
  }
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < plain.length; i += maxUnits) {
    out.push(plain.slice(i, i + maxUnits));
  }
  return out;
}

/**
 * @param {string} documentId
 * @param {string} plain
 */
async function appendPlainToDocEnd(documentId, plain) {
  const chunks = chunkPlainForInsert(plain, 5500);
  for (const chunk of chunks) {
    const doc = await docsGet(documentId);
    const idx = docAppendInsertIndex(doc);
    await docsBatchUpdate(documentId, [
      { insertText: { location: { index: idx }, text: chunk } },
    ]);
  }
}

/**
 * @param {string} documentId
 * @param {{ containsText: string; replaceText: string }}[] specs
 */
async function docsReplaceAllSequential(documentId, specs) {
  for (const spec of specs) {
    await docsBatchUpdate(documentId, [
      {
        replaceAllText: {
          containsText: { text: spec.containsText, matchCase: true },
          replaceText: spec.replaceText,
        },
      },
    ]);
  }
}

/**
 * @param {string} documentId
 * @param {string} plainBody
 * @param {{ numberDateLine?: string; customerName?: string; documentTitle?: string }} [headers]
 * @param {{ start: number, end: number }[]} [boldSpans] — диапазоны **жирного** в plainBody (символьные смещения UTF-16)
 */
export async function fillGoogleDocCommercialProposal(documentId, plainBody, headers = {}, boldSpans) {
  /** @type {{ containsText: string; replaceText: string }[]} */
  const specs = [];
  if (headers.numberDateLine?.trim()) {
    specs.push({ containsText: KP_TEMPLATE_NUMBER_DATE, replaceText: headers.numberDateLine.trim() });
  }
  if (headers.customerName?.trim()) {
    specs.push({ containsText: KP_TEMPLATE_CUSTOMER, replaceText: headers.customerName.trim() });
  }
  if (headers.documentTitle?.trim()) {
    specs.push({ containsText: KP_TEMPLATE_DOC_TITLE, replaceText: headers.documentTitle.trim() });
  }

  const bodySpecs = [
    { containsText: KP_BODY_PLACEHOLDER, replaceText: plainBody },
    { containsText: KP_TEMPLATE_BODY, replaceText: plainBody },
  ];

  const metaOut = /** @type {{ headerModes: string[]; bodyMode: "placeholder" | "append" }} */ ({
    headerModes: [],
    bodyMode: "append",
  });

  if (specs.length) {
    await docsReplaceAllSequential(documentId, specs);
    metaOut.headerModes.push("brackets");
  }

  const docBeforeBody = await docsGet(documentId);
  let bodyGoogleStart = findPlaceholderGoogleStart(docBeforeBody, KP_BODY_PLACEHOLDER);
  if (bodyGoogleStart === -1) {
    bodyGoogleStart = findPlaceholderGoogleStart(docBeforeBody, KP_TEMPLATE_BODY);
  }

  let bodyHits = 0;
  for (const bs of bodySpecs) {
    const resp = await docsBatchUpdate(documentId, [
      {
        replaceAllText: {
          containsText: { text: bs.containsText, matchCase: true },
          replaceText: plainBody,
        },
      },
    ]);
    const replies = Array.isArray(resp.replies) ? resp.replies : [];
    const occ = /** @type {{ replaceAllText?: { occurrencesChanged?: number } }} */ (replies[0]);
    const n = typeof occ?.replaceAllText?.occurrencesChanged === "number" ? occ.replaceAllText.occurrencesChanged : 0;
    bodyHits += n;
    if (n > 0) {
      metaOut.bodyMode = "placeholder";
      break;
    }
  }

  if (bodyHits > 0 && boldSpans?.length && bodyGoogleStart >= 1) {
    try {
      await docsApplyBoldSpans(documentId, bodyGoogleStart, boldSpans);
    } catch {
      /* жирный — необязательное улучшение; тело уже подставлено */
    }
  }

  if (bodyHits === 0) {
    await appendPlainToDocEnd(documentId, `${APPEND_FALLBACK_NOTE}${plainBody}`);
    metaOut.bodyMode = "append";
  }

  return metaOut;
}

/**
 * @deprecated используйте fillGoogleDocCommercialProposal
 */
export async function fillGoogleDocWithCommercialBody(documentId, plain) {
  return fillGoogleDocCommercialProposal(documentId, plain, {});
}

/**
 * @param {{ id: string; name: string }[]} docs
 */
function sortDocsByName(docs) {
  return [...docs].sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

/**
 * @param {string} folderId
 */
async function pickPreferredGoogleDocInFolder(folderId) {
  const kids = await listChildren(folderId);
  /** @type {{ id: string; name: string }[]} */
  const docs = [];
  for (const f of kids) {
    if (f.mimeType === GOOGLE_DOC_MIME && f.id) {
      docs.push({ id: String(f.id), name: String(f.name ?? "") });
    }
  }
  if (!docs.length) {
    return null;
  }
  const preferred = docs.filter((d) => /кп|commercial|шаблон|template/i.test(d.name));
  const pool = preferred.length ? preferred : docs;
  return sortDocsByName(pool)[0]?.id ?? null;
}

/**
 * Папка из LENA_CP_DOC_TEMPLATE_FOLDER_ID: сначала подпапка gs-retail / finselvat;
 * если её нет — эвристика по имени файла в корне папки.
 * @param {string} folderId
 * @param {"gs_retail" | "finselvat"} offerOrg
 */
async function templateDocFromSharedFolder(folderId, offerOrg) {
  const subName = LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG[offerOrg];
  const subId = await findChildFolderId(folderId, subName);
  if (subId) {
    return pickPreferredGoogleDocInFolder(subId);
  }
  const kids = await listChildren(folderId);
  const docs = kids.filter((f) => f.mimeType === GOOGLE_DOC_MIME && f.id);
  const hint =
    offerOrg === "gs_retail"
      ? (n) => /гс|gs|ритейл|retail/i.test(n)
      : (n) => /финсель|finsel/i.test(n);
  const filtered = docs.filter((f) => hint(String(f.name ?? "")));
  const pool = filtered.length ? filtered : docs;
  const sorted = [...pool].sort((a, b) =>
    String(a.name ?? "").localeCompare(String(b.name ?? ""), "ru"),
  );
  const pick = sorted[0];
  return pick?.id ? String(pick.id) : null;
}

/**
 * id шаблона Google Doc для КП или null (тогда только Markdown на Drive).
 *
 * Порядок: переменные `LENA_CP_DOC_TEMPLATE_ID_*` → `LENA_CP_DOC_TEMPLATE_FOLDER_ID`
 * (подпапки **gs-retail** / **finselvat**, как в `_lena/templates`) → `_lena/templates/<компания>/`.
 *
 * @param {string} userRootId
 * @param {"gs_retail" | "finselvat" | undefined} offerOrg
 */
export async function resolveCommercialProposalGoogleDocTemplateId(userRootId, offerOrg) {
  if (!offerOrg) {
    return null;
  }
  const envDirect =
    offerOrg === "gs_retail"
      ? process.env.LENA_CP_DOC_TEMPLATE_ID_GS_RETAIL?.trim()
      : process.env.LENA_CP_DOC_TEMPLATE_ID_FINSELVAT?.trim();
  if (envDirect) {
    try {
      return resolveDriveId(envDirect);
    } catch {
      return null;
    }
  }

  const sharedRoot = process.env.LENA_CP_DOC_TEMPLATE_FOLDER_ID?.trim();
  if (sharedRoot) {
    try {
      const fid = resolveDriveId(sharedRoot);
      const tid = await templateDocFromSharedFolder(fid, offerOrg);
      if (tid) {
        return tid;
      }
    } catch {
      /* ignore */
    }
  }

  const layout = await resolveLayoutIds(userRootId);
  if (!layout.templatesId) {
    return null;
  }
  const co = LENA_COMPANY_SUBFOLDER_BY_OFFER_ORG[offerOrg];
  const companyFolderId = await findChildFolderId(layout.templatesId, co);
  if (!companyFolderId) {
    return null;
  }
  return pickPreferredGoogleDocInFolder(companyFolderId);
}

/**
 * @param {{
 *   templateFileId: string;
 *   draftsFolderId: string;
 *   destTitle: string;
 *   markdownBody: string;
 *   headerReplacements?: { numberDateLine?: string; customerName?: string; documentTitle?: string };
 * }} p
 */
export async function copyTemplateAndFillCommercialProposalDoc(p) {
  const { plain, boldSpans } = finalizeCommercialProposalPlainForGoogleDoc(p.markdownBody);
  const copied = await copyFileToFolder(p.templateFileId, p.draftsFolderId, p.destTitle);
  const docId = copied?.id ? String(copied.id) : "";
  if (!docId) {
    throw new Error("Drive copy: нет id у копии документа");
  }
  const fill = await fillGoogleDocCommercialProposal(docId, plain, p.headerReplacements ?? {}, boldSpans);
  const meta = await getMetadata(docId);
  const webViewLink = typeof meta.webViewLink === "string" ? meta.webViewLink : undefined;
  const name = typeof meta.name === "string" ? meta.name : p.destTitle;
  return {
    documentId: docId,
    webViewLink,
    fileName: name,
    fillMode: fill.bodyMode === "placeholder" ? "placeholder" : "append",
  };
}
