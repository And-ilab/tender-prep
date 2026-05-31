/**
 * Модуль «Парсинг»: извлечение текста из папки inputs (включая OCR для PDF без текстового слоя).
 * В Telegram — по кнопке «Анализ документов» или по slash-команде tenderextract.
 */

import { analyzeTenderAfterBootstrap, formatIceTradeAnalysisForTelegram } from "../icetrade/analyzeAfterBootstrap.js";
import { extractTenderInputDocumentsToExtracted } from "../icetrade/inputDocumentsExtract.js";
import { isLlmConfigured } from "../llm/openaiCompatible.js";

/** Подпись стадии диалога в Telegram: парсинг inputs + при наличии ключа LLM анализ комплекта. */
const STAGE_PARSING_ANALYSIS_HEADER = "**Parsing+Analysis**\n\n";

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
 * Парсинг inputs + при доступном LLM — тот же строгий анализ комплекта, что и после bootstrap (матрица из цитат).
 * @param {{ rootId: string, tenderId: string, opts?: { flat?: boolean, year?: string } }} p
 */
export async function runTenderInputsExtractMarkdown(p) {
  const { rootId, tenderId, opts = {} } = p;
  const ex = await extractTenderInputDocumentsToExtracted(rootId, tenderId, opts);
  const extractMd = formatTenderExtractMarkdown(ex);
  if (!isLlmConfigured()) {
    return [
      STAGE_PARSING_ANALYSIS_HEADER,
      extractMd,
      "",
      "_**Анализ и матрица требований** не запускались: задайте **OPENAI_API_KEY** или **LENA_OPENAI_API_KEY**._",
    ].join("\n");
  }
  const ar = await analyzeTenderAfterBootstrap(rootId, tenderId, opts);
  const analysisMd = ar.ok
    ? formatIceTradeAnalysisForTelegram(ar)
    : [
        `**Анализ:** не выполнен — ${ar.error ?? "ошибка"}`,
        "",
        "_Извлечение текста из файлов прошло; это ошибка **разбора JSON ответа LLM** (модель вернула невалидный JSON). Повторите кнопку или **/tenderextract**._",
      ].join("\n");
  return [STAGE_PARSING_ANALYSIS_HEADER, extractMd, "", "---", "", analysisMd].join("\n");
}
