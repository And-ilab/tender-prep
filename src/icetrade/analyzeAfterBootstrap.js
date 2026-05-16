import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";

import { assertCredentialsFile } from "../drive/config.js";
import {
  downloadFile,
  exportGoogleFile,
  getMetadata,
  listChildren,
  uploadFile,
} from "../drive/ops.js";
import { ensureTenderTree } from "../drive/workspace.js";
import { chatCompletion, isLlmConfigured } from "../llm/openaiCompatible.js";
import { runQuery } from "../rag/queryLocal.js";

function safeSliceName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]+/g, "_")
    .slice(0, 120)
    .trim() || "file";
}

/**
 * @param {string} indexDirAbs
 */
async function ragDirReady(indexDirAbs) {
  try {
    const { access } = await import("node:fs/promises");
    const { join: j } = await import("node:path");
    await access(j(indexDirAbs, "manifest.json"));
    await access(j(indexDirAbs, "chunks.jsonl"));
    return true;
  } catch {
    return false;
  }
}

function resolvedRagIndexDir() {
  const raw = process.env.LENA_RAG_INDEX_DIR?.trim();
  if (!raw) return null;
  return pathResolve(raw);
}

/**
 * @param {string} fileId
 * @param {string} name
 * @param {string} [mimeType]
 * @param {string} tmpRoot
 * @returns {Promise<string | null>}
 */
async function extractTextSnippet(fileId, name, mimeType, tmpRoot) {
  const low = name.toLowerCase();
  const safe = safeSliceName(name);
  const dest = join(tmpRoot, `ex-${fileId.slice(0, 12)}-${safe}`);
  try {
    if (mimeType === "application/vnd.google-apps.folder") return null;
    if (mimeType === "application/vnd.google-apps.document") {
      await exportGoogleFile(fileId, "text/plain", dest);
      return (await readFile(dest, "utf8")).slice(0, 14_000);
    }
    if (mimeType === "application/vnd.google-apps.spreadsheet") {
      await exportGoogleFile(fileId, "text/csv", dest);
      return (await readFile(dest, "utf8")).slice(0, 14_000);
    }
    if (
      mimeType?.startsWith("text/") ||
      /\.(txt|md|csv|log|json|xml|html)$/i.test(low)
    ) {
      await downloadFile(fileId, dest);
      return (await readFile(dest, "utf8")).slice(0, 14_000);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {string} raw
 */
function parseLlmJson(raw) {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  return /** @type {Record<string, unknown>} */ (JSON.parse(s));
}

/**
 * @param {Record<string, unknown>} o
 */
function normalizeAnalysis(o) {
  const tenderTitle = typeof o.tenderTitle === "string" ? o.tenderTitle.trim() : null;
  const sumOrBudget = typeof o.sumOrBudget === "string" ? o.sumOrBudget.trim() : null;
  const submissionOverview =
    typeof o.submissionOverview === "string" ? o.submissionOverview.trim() : null;

  /** @type {{ name: string; basis: string }[]} */
  const lenaCanPrepare = [];
  /** @type {{ name: string; reason: string }[]} */
  const managerMustProvide = [];

  const a = typeof o.lenaCanPrepare === "object" && o.lenaCanPrepare !== null ? o.lenaCanPrepare : [];
  const b =
    typeof o.managerMustProvide === "object" && o.managerMustProvide !== null
      ? o.managerMustProvide
      : [];

  if (Array.isArray(a)) {
    for (const x of a) {
      if (!x || typeof x !== "object") continue;
      const name = typeof /** @type {{ name?: string }} */ (x).name === "string" ? x.name.trim() : "";
      const basis =
        typeof /** @type {{ basis?: string }} */ (x).basis === "string" ? x.basis.trim() : "";
      if (name) lenaCanPrepare.push({ name, basis: basis || "—" });
    }
  }
  if (Array.isArray(b)) {
    for (const x of b) {
      if (!x || typeof x !== "object") continue;
      const name = typeof /** @type {{ name?: string }} */ (x).name === "string" ? x.name.trim() : "";
      const reason =
        typeof /** @type {{ reason?: string }} */ (x).reason === "string" ? x.reason.trim() : "";
      if (name) managerMustProvide.push({ name, reason: reason || "—" });
    }
  }

  return {
    tenderTitle: tenderTitle || null,
    sumOrBudget: sumOrBudget || null,
    submissionOverview: submissionOverview || null,
    lenaCanPrepare,
    managerMustProvide,
  };
}

function buildAnalysisMarkdown(viewId, structured, notParsedFiles, ragUsed) {
  const lines = [
    `# IceTrade · анализ комплекта · ${viewId}`,
    "",
    `- UTC: ${new Date().toISOString()}`,
    `- RAG: ${ragUsed ? "да (фрагменты в промпт)" : "нет"}`,
    "",
    "## Наименование / предмет",
    structured.tenderTitle || "_(не выделено автоматически)_",
    "",
    "## Сумма / начальная (макс.) цена / бюджет",
    structured.sumOrBudget || "_(не выделено — проверьте в ТЗ/извещении)_",
    "",
    "## Перечень к подаче (кратко)",
    structured.submissionOverview || "—",
    "",
    "## Лена может подготовить сама (шаблон у заказчика или аналог из архива)",
    structured.lenaCanPrepare.length
      ? structured.lenaCanPrepare.map((x) => `- **${x.name}** — ${x.basis}`).join("\n")
      : "—",
    "",
    "## Нужно от менеджера (оригиналы, данные компании, внешние справки)",
    structured.managerMustProvide.length
      ? structured.managerMustProvide.map((x) => `- **${x.name}** — ${x.reason}`).join("\n")
      : "—",
    "",
    "## Файлы без извлечённого текста (PDF/DOC и т.п. — нужен parserit / ручной разбор)",
    notParsedFiles.length ? notParsedFiles.map((n) => `- ${n}`).join("\n") : "- нет",
    "",
  ];
  return lines.join("\n");
}

/**
 * Форматирование для Telegram после analyzeTenderAfterBootstrap.
 * @param {Awaited<ReturnType<typeof analyzeTenderAfterBootstrap>>} r
 */
export function formatIceTradeAnalysisForTelegram(r) {
  if (!r.ok) {
    return `**Анализ:** не выполнен — ${r.error ?? "ошибка"}`;
  }
  if ("insufficientInputText" in r && r.insufficientInputText) {
    const min = r.minInputCharsRequired ?? 120;
    const got = r.inputTextChars ?? 0;
    const fc = r.inputsFileCount ?? 0;
    const lines = [
      "---",
      "**Анализ по этой закупке не выполнялся**",
      "",
      `В **inputs** мало **распознанного текста** из документов заказчика (сейчас **~${got}** знаков, нужно **≥${min}** — обычно Google Docs/Sheets или txt/md/csv; PDF/DOC без извлечения не учитываются).`,
    ];
    if (fc > 0) {
      lines.push("", `Файлов в inputs: **${fc}**`);
      if (r.notParsedFiles.length) {
        lines.push(
          `Без авто-текста: ${r.notParsedFiles.slice(0, 10).join(", ")}${r.notParsedFiles.length > 10 ? "…" : ""}`,
        );
      }
    } else {
      lines.push(
        "",
        "Папка **inputs** пустая: IceTrade мог не отдать страницу (**fetch failed**), отдать **страницу входа**, или вложения подгружаются только в браузере. **Положите комплект вручную** (после настройки Drive для SA — см. ниже).",
      );
    }
    lines.push(
      "",
      "_Раньше модель могла выдать «типовые формы» без ваших файлов — это не надёжно; такой вывод теперь **не показывается**._",
    );
    return lines.join("\n").trim();
  }
  const { structured, notParsedFiles, ragUsed } = r;
  const lines = [
    "---",
    "**Результат разбора комплекта**",
    "",
    `**Наименование:** ${structured.tenderTitle || "— (уточните по документам)"}`,
    `**Сумма / бюджет:** ${structured.sumOrBudget || "— (уточните в извещении/ТЗ)"}`,
    "",
    structured.submissionOverview
      ? `**К подаче (суть):** ${structured.submissionOverview}`
      : "",
    "",
    "**Лена может подготовить сама** (есть форма/шаблон у заказчика или опора на архив):",
    structured.lenaCanPrepare.length
      ? structured.lenaCanPrepare.map((x) => `• ${x.name} — _${x.basis}_`).join("\n")
      : "• _(пока не выделено — мало текста в inputs или нужен полный парсинг PDF)_",
    "",
    "**Нужно от менеджера** (данные компании, банк, референс-лист и т.п.):",
    structured.managerMustProvide.length
      ? structured.managerMustProvide.map((x) => `• ${x.name} — _${x.reason}_`).join("\n")
      : "• _(пока не выделено)_",
    "",
    notParsedFiles.length
      ? `**Без авто-текста (нужен разбор):** ${notParsedFiles.slice(0, 12).join(", ")}${notParsedFiles.length > 12 ? "…" : ""}`
      : "",
    "noteUploadError" in r && r.noteUploadError
      ? (() => {
          const msg = String(r.noteUploadError).slice(0, 600);
          const quotaHint =
            /storage quota|storageQuota|Service Accounts do not have storage/i.test(msg)
              ? "\n_Подсказка: перенесите корень Лены на **общий диск (Shared drive)** и добавьте сервисный аккаунт участником — см. docs/GOOGLE_DRIVE.md § «Общие диски»._"
              : "";
          return `\n**Заметка на Drive не записана:** ${msg}${quotaHint}`;
        })()
      : "",
    ragUsed ? "" : "\n_(Архив RAG не использован — задайте LENA_RAG_INDEX_DIR для подсказок.)_",
  ].filter(Boolean);
  return lines.join("\n").trim();
}

/**
 * После bootstrap: читает inputs, тянет фрагменты RAG, зовёт LLM, кладёт отчёт в notes.
 * @param {string} userRootId
 * @param {string} tenderId
 * @param {{ flat?: boolean; year?: string }} [opts]
 */
export async function analyzeTenderAfterBootstrap(userRootId, tenderId, opts = {}) {
  assertCredentialsFile();
  if (!isLlmConfigured()) {
    return {
      ok: false,
      error: "Нужен LENA_OPENAI_API_KEY или OPENAI_API_KEY для анализа комплекта.",
    };
  }

  const maxFiles =
    Number.parseInt(process.env.LENA_ICETRADE_ANALYZE_MAX_FILES?.trim() ?? "35", 10) || 35;
  const maxCorpus =
    Number.parseInt(process.env.LENA_ICETRADE_ANALYZE_MAX_CORPUS?.trim() ?? "42000", 10) || 42_000;

  const { tender } = await ensureTenderTree(userRootId, tenderId, opts);
  const inputsId = tender.inputsId;
  const notesId = tender.notesId;

  const files = await listChildren(inputsId);
  /** @type {string[]} */
  const notParsedFiles = [];
  /** @type {string[]} */
  const corpusParts = [];

  const tmpRoot = await mkdtemp(join(tmpdir(), "lena-analyze-"));
  try {
    let n = 0;
    for (const f of files) {
      if (n >= maxFiles) break;
      const id = String(f.id ?? "");
      const name = String(f.name ?? "file");
      if (!id) continue;
      const mime = typeof f.mimeType === "string" ? f.mimeType : "";
      if (mime === "application/vnd.google-apps.folder") continue;

      n += 1;
      const meta = await getMetadata(id).catch(() => null);
      const mimeType = meta && typeof meta.mimeType === "string" ? meta.mimeType : mime;
      const snip = await extractTextSnippet(id, name, mimeType, tmpRoot);
      if (snip && snip.trim().length > 40) {
        corpusParts.push(`### Файл: ${name}\n${snip.trim()}`);
      } else {
        notParsedFiles.push(name);
      }
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  let corpus = corpusParts.join("\n\n").trim();
  if (corpus.length > maxCorpus) corpus = `${corpus.slice(0, maxCorpus)}\n\n…[усечено]`;

  const minInput =
    Number.parseInt(process.env.LENA_ICETRADE_ANALYZE_MIN_INPUT_CHARS?.trim() ?? "120", 10) || 120;
  const inputTextChars = corpus.replace(/\s+/g, " ").trim().length;

  let inputsFileCount = 0;
  for (const f of files) {
    const m = typeof f.mimeType === "string" ? f.mimeType : "";
    if (m === "application/vnd.google-apps.folder") continue;
    if (!String(f.id ?? "")) continue;
    inputsFileCount += 1;
  }

  if (inputTextChars < minInput) {
    return {
      ok: true,
      insufficientInputText: true,
      minInputCharsRequired: minInput,
      inputTextChars,
      inputsFileCount,
      notParsedFiles,
      ragUsed: false,
      tenderNotesFolderId: notesId,
    };
  }

  /** @type {string} */
  let ragBlock = "";
  let ragUsed = false;
  const ragDir = resolvedRagIndexDir();
  if (ragDir && (await ragDirReady(ragDir))) {
    try {
      const { hits } = await runQuery(
        ragDir,
        "перечень документов заявки справка банка референс лист квалификация коммерческое предложение приложения к заявке",
        { topK: 6, stripEmbedding: true },
      );
      ragBlock = hits
        .map((h) => String(/** @type {{ text?: string }} */ (h).text ?? "").trim())
        .filter(Boolean)
        .join("\n---\n")
        .slice(0, 6500);
      ragUsed = ragBlock.length > 20;
    } catch {
      ragBlock = "";
    }
  }

  const system = [
    "Ты «Лена» — специалист по тендерам на Беларуси (IceTrade). Отвечай только JSON без Markdown и без текста вокруг.",
    "Задача: по фрагментам из документов закупки и (если есть) фрагментам архива разделить документы на два списка.",
    "Правила:",
    "- tenderTitle — краткое наименование закупки/предмета, если есть в тексте; иначе null.",
    "- sumOrBudget — начальная цена, максимальная цена участника, бюджет, лимит или «не указано» одной строкой; если в тексте нет цифр и формулировок — null.",
    "- submissionOverview — 2–5 предложений: что в целом должно войти в заявку по этим документам.",
    "- lenaCanPrepare: позиции, которые можно подготовить по типовым формам/шаблонам ЗАКАЗЧИКА из комплекта ИЛИ очевидно собрать по аналогии с архивом (references в тексте). Укажи basis: откуда форма (файл/раздел) или «аналог из RAG».",
    "- managerMustProvide: то, что требует данных организации-участника, банка, контрагентов, оригиналов, печатей, референс-листа, сертификатов с чужой стороны — Лена не может это сгенерировать без файлов менеджера.",
    "- Не выдумывай конкретные суммы и названия лотов, если их нет во входном тексте — тогда null или осторожная формулировка.",
    "Форма ответа (пример структуры):",
    '{"tenderTitle":string|null,"sumOrBudget":string|null,"submissionOverview":string|null,"lenaCanPrepare":[{"name":string,"basis":string}],"managerMustProvide":[{"name":string,"reason":string}]}',
  ].join(" ");

  const userContent = [
    `viewId/tender_id на площадке: ${tenderId}`,
    "",
    "### Фрагменты из inputs",
    corpus.length ? corpus : "_(нет извлечённого текста — возможно только PDF/DOC; списки будут общими)_",
    "",
    "### Фрагменты архива RAG (если пусто — игнорируй)",
    ragBlock || "_(нет)_",
  ].join("\n");

  let rawLlm = "";
  let structured = {
    tenderTitle: null,
    sumOrBudget: null,
    submissionOverview: null,
    lenaCanPrepare: /** @type {{ name: string; basis: string }[]} */ ([]),
    managerMustProvide: /** @type {{ name: string; reason: string }[]} */ ([]),
  };

  try {
    rawLlm = await chatCompletion(
      [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      { temperature: 0.25, max_tokens: 3500 },
    );
    const parsed = parseLlmJson(rawLlm);
    structured = normalizeAnalysis(parsed);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      rawLlm: rawLlm.slice(0, 1500),
      notParsedFiles,
      ragUsed,
    };
  }

  const md = buildAnalysisMarkdown(tenderId, structured, notParsedFiles, ragUsed);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const noteName = `icetrade-analysis-${tenderId}-${stamp}.md`;
  const tmp = await mkdtemp(join(tmpdir(), "lena-anote-"));
  const notePath = join(tmp, noteName);
  let noteUpload = null;
  /** @type {string | undefined} */
  let noteUploadError;
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(notePath, md, "utf8");
    try {
      noteUpload = await uploadFile(notesId, notePath, noteName);
    } catch (ue) {
      noteUploadError = ue instanceof Error ? ue.message : String(ue);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  return {
    ok: true,
    structured,
    notParsedFiles,
    ragUsed,
    noteFile: noteUpload,
    noteUploadError,
    tenderNotesFolderId: notesId,
  };
}
