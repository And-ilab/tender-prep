import { resolveDriveId } from "../drive/ids.js";
import { analyzeTenderAfterBootstrap } from "../icetrade/analyzeAfterBootstrap.js";
import { bootstrapIceTradeToDrive } from "../icetrade/bootstrapDrive.js";
import { extractTenderInputDocumentsToExtracted } from "../icetrade/inputDocumentsExtract.js";
import { normalizeIceTradeViewId } from "../icetrade/viewIds.js";

function usage() {
  console.error(
    [
      "lena tenders — модульный конвейер IceTrade → Drive",
      "",
      "  1) Импорт: вложения в inputs/ + **icetrade-import-snapshot.json** (поля карточки, события):",
      "     tenders icetrade-bootstrap <rootFolderUrlOrId> <iceUrl|viewId> [flat|ГГГГ]",
      "",
      "  2) Парсинг **inputs/**: при необходимости **inputs/extracted/** + **tender-pipeline-state.json** в корне тендера:",
      "     tenders tender-extract <rootFolderUrlOrId> <viewId> [flat|ГГГГ]",
      "",
      "  3) Карточка (LLM по extracted + HTML IceTrade):",
      "     tenders tender-card <rootFolderUrlOrId> <viewId> [flat|ГГГГ] [--extract]",
      "     По умолчанию **не** запускает парсинг; флаг --extract = сначала шаг (2), потом карточка.",
      "",
      "  Прочее:",
      "     tenders icetrade-analyze <rootFolderUrlOrId> <viewId> [flat|ГГГГ]",
      "",
      "Переменные bootstrap: LENA_ICETRADE_BOOT_MAX_FILES, LENA_ICETRADE_FETCH_TIMEOUT_MS.",
      "Парсинг: LENA_INPUT_EXTRACT_MAX_FILES, LENA_INPUT_EXTRACT_MAX_CHARS.",
      "Карточка: LENA_TENDER_CARD_MIN_INPUT_CHARS, LENA_TENDER_CARD_MAX_CORPUS_CHARS, LENA_TENDER_CARD_RUN_EXTRACT.",
      "analyze: LENA_ICETRADE_ANALYZE_MAX_FILES, LENA_ICETRADE_ANALYZE_MAX_CORPUS, LENA_RAG_INDEX_DIR.",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}

/**
 * @param {string[]} args — argv без «node» и «tenders»
 */
export async function runTendersCli(args) {
  const runExtractFlag = args.includes("--extract");
  const pos = args.filter((a) => a !== "--extract");
  const [cmd, root, urlOrId, y] = pos;
  if (!cmd || !root || !urlOrId) {
    usage();
    return;
  }

  if (cmd === "tender-extract") {
    try {
      const rootId = resolveDriveId(root);
      const flat = y === "flat";
      const year = y && y !== "flat" && /^\d{4}$/.test(y) ? y : undefined;
      const tenderId = normalizeIceTradeViewId(urlOrId) ?? urlOrId.trim();
      const result = await extractTenderInputDocumentsToExtracted(rootId, tenderId, { flat, year });
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "tender-card") {
    try {
      const rootId = resolveDriveId(root);
      const flat = y === "flat";
      const year = y && y !== "flat" && /^\d{4}$/.test(y) ? y : undefined;
      const tenderId = normalizeIceTradeViewId(urlOrId) ?? urlOrId.trim();
      const { buildTenderTelegramCard } = await import("../icetrade/tenderTelegramCard.js");
      const result = await buildTenderTelegramCard(rootId, tenderId, {
        flat,
        year,
        runExtract: runExtractFlag,
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 2;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "icetrade-analyze") {
    try {
      const rootId = resolveDriveId(root);
      const flat = y === "flat";
      const year = y && y !== "flat" && /^\d{4}$/.test(y) ? y : undefined;
      const tenderId = normalizeIceTradeViewId(urlOrId) ?? urlOrId.trim();
      const result = await analyzeTenderAfterBootstrap(rootId, tenderId, { flat, year });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 2;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
    return;
  }

  if (cmd !== "icetrade-bootstrap") {
    usage();
    return;
  }

  try {
    const rootId = resolveDriveId(root);
    const flat = y === "flat";
    const year = y && y !== "flat" && /^\d{4}$/.test(y) ? y : undefined;
    const result = await bootstrapIceTradeToDrive(rootId, urlOrId, { flat, year });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
