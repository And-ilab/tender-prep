/**
 * Модуль «Парсинг»: извлечение текста из папки inputs (включая OCR для PDF без текстового слоя).
 * В Telegram — по кнопке «Анализ документов» или по slash-команде tenderextract.
 */

import { analyzeTenderAfterBootstrap } from "../icetrade/analyzeAfterBootstrap.js";
import { extractTenderInputDocumentsToExtracted } from "../icetrade/inputDocumentsExtract.js";
import { isLlmConfigured } from "../llm/openaiCompatible.js";
import {
  buildRequiredDocumentsList,
  formatDocumentCompositionStep1Telegram,
} from "../analysis/documentChecklist.js";

/**
 * Сводка результата extract (для Telegram / оркестрации).
 * @param {{ items: { chars?: number; error?: unknown }[]; mode?: string }} ex
 */
export function formatTenderExtractMarkdown(ex) {
  const okN = ex.items.filter((i) => i.chars > 0 && !i.error).length;
  const failN = ex.items.filter((i) => i.error).length;
  const modeLine =
    ex.mode === "native_only"
      ? "**Режим:** **native_only** — **inputs/extracted/** не создана (достаточно текста в **inputs**)."
      : "**Режим:** **extracted_workspace** — см. **inputs/extracted/** и **extract-manifest.json**.";
  const aiLine =
    ex.mode === "extracted_workspace"
      ? "**Для ИИ:** `extract-manifest.json` → `items[].ai` + `aiGuide`; **AI-TEXT-SOURCES.md**; корень тендера **`tender-pipeline-state.json`** → `parsing.aiGuide`."
      : "**Для ИИ:** **`tender-pipeline-state.json`** → `parsing.items[].ai` и `parsing.aiGuide` (канонический текст в **inputs**).";
  return [
    `**Готово.** С текстом: **${okN}** / ${ex.items.length} файл(ов).`,
    modeLine,
    aiLine,
    `Сводка и статусы: **\`tender-pipeline-state.json\`** в корне папки тендера на Drive.`,
    failN
      ? `Ошибки по файлам: **${failN}** (поля **error** в состоянии парсинга / во **extract-manifest.json** при режиме extracted).`
      : "",
    "",
    "Дальше: **/tendercard** …",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Парсинг inputs + анализ для Telegram-воронки (шаг 1: состав документов).
 * @param {{ rootId: string, tenderId: string, opts?: { flat?: boolean, year?: string } }} p
 */
export async function runTenderInputsExtractForTelegram(p) {
  const { rootId, tenderId, opts = {} } = p;
  const ex = await extractTenderInputDocumentsToExtracted(rootId, tenderId, opts);
  const okN = ex.items.filter((i) => i.chars > 0 && !i.error).length;
  const failN = ex.items.filter((i) => i.error).length;
  const extractBrief =
    failN > 0
      ? `_Извлечение: с текстом ${okN}/${ex.items.length}, ошибок по файлам: ${failN}._`
      : null;

  if (!isLlmConfigured()) {
    return {
      ok: false,
      tenderId,
      opts,
      extractBrief,
      error:
        "Анализ не запускался: задайте **OPENAI_API_KEY** или **LENA_OPENAI_API_KEY**.",
    };
  }

  const ar = await analyzeTenderAfterBootstrap(rootId, tenderId, opts);
  if (!ar.ok) {
    return {
      ok: false,
      tenderId,
      opts,
      extractBrief,
      error: `Анализ не выполнен — ${ar.error ?? "ошибка"}`,
    };
  }
  if ("insufficientInputText" in ar && ar.insufficientInputText) {
    const min = ar.minInputCharsRequired ?? 120;
    const got = ar.inputTextChars ?? 0;
    return {
      ok: false,
      tenderId,
      opts,
      extractBrief,
      error: `Мало текста в inputs (~${got} знаков, нужно ≥${min}). Положите комплект или настройте парсинг PDF.`,
    };
  }

  const corpus = "corpus" in ar && typeof ar.corpus === "string" ? ar.corpus : undefined;
  const requiredDocuments = buildRequiredDocumentsList(ar.structured, { corpus });
  const inputsFolderWebViewLink =
    "inputsFolderWebViewLink" in ar ? ar.inputsFolderWebViewLink : undefined;
  const extractFileNames = ex.items.map((i) => String(i.sourceName ?? "")).filter(Boolean);
  const step1Text = formatDocumentCompositionStep1Telegram(
    ar.structured,
    requiredDocuments,
    inputsFolderWebViewLink,
  );
  return {
    ok: true,
    tenderId,
    opts,
    extractBrief,
    analysis: ar,
    structured: ar.structured,
    requiredDocuments,
    inputsFolderWebViewLink,
    extractFileNames,
    step1Text,
  };
}

/**
 * @deprecated CLI — полный markdown; в Telegram используйте runTenderInputsExtractForTelegram.
 * @param {{ rootId: string, tenderId: string, opts?: { flat?: boolean, year?: string } }} p
 */
export async function runTenderInputsExtractMarkdown(p) {
  const r = await runTenderInputsExtractForTelegram(p);
  if (!r.ok) {
    return [r.extractBrief, r.error].filter(Boolean).join("\n\n");
  }
  return [r.extractBrief, r.step1Text].filter(Boolean).join("\n\n");
}
