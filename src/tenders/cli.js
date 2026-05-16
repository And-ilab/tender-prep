import { resolveDriveId } from "../drive/ids.js";
import { analyzeTenderAfterBootstrap } from "../icetrade/analyzeAfterBootstrap.js";
import { bootstrapIceTradeToDrive } from "../icetrade/bootstrapDrive.js";
import { normalizeIceTradeViewId } from "../icetrade/viewIds.js";

function usage() {
  console.error(
    [
      "lena tenders — базовый флоу IceTrade → Drive",
      "",
      "  tenders icetrade-bootstrap <rootFolderUrlOrId> <iceUrl|viewId> [flat|ГГГГ]",
      "  tenders icetrade-analyze <rootFolderUrlOrId> <viewId> [flat|ГГГГ]",
      "",
      "bootstrap: создаёт `_lena/tenders/…/<id>/`, кладёт ссылки-кандидаты/скачанные файлы в inputs, пишет заметку в notes.",
      "analyze: читает inputs (текст), опционально RAG, зовёт LLM, пишет icetrade-analysis-*.md в notes (нужен API key).",
      "Переменные bootstrap: LENA_ICETRADE_BOOT_MAX_FILES (по умолчанию 30), LENA_ICETRADE_FETCH_TIMEOUT_MS (25000).",
      "Переменные analyze: LENA_ICETRADE_ANALYZE_MAX_FILES, LENA_ICETRADE_ANALYZE_MAX_CORPUS, LENA_RAG_INDEX_DIR.",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}

/**
 * @param {string[]} args
 */
export async function runTendersCli(args) {
  const [cmd, root, urlOrId, y] = args;
  if (!cmd || !root || !urlOrId) {
    usage();
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
