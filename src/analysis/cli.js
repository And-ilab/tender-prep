/**
 * CLI модуля «Анализ»: промпт для коммерческого предложения из JSON-контекста.
 *
 * Пример context.json:
 * {
 *   "tenderLabel": "IceTrade 1318894",
 *   "texts": [ "…весь или фрагмент текста документации…" ],
 *   "structuredSnapshot": { "procedure": { "estimatedTotalValue": "130 000 BYN", "otherInfo": "…" } }
 * }
 *
 * Запуск:
 *   node src/cli.js analysis commercial-prompt path/to/context.json
 */

import { readJsonFile } from "../io/jsonFile.js";
import {
  buildCommercialProposalAnalysis,
  buildCommercialProposalPromptPack,
} from "./commercialProposalContext.js";

function usageAnalysis() {
  console.error(`Анализ (коммерческое предложение)

  node src/cli.js analysis commercial-prompt <context.json>

context.json:
  texts: string[]           — тексты из парсинга (extracted / объединённые .txt)
  structuredSnapshot?: object — опционально, поля как у icetrade import snapshot (procedure и т.д.)
  tenderLabel?: string      — подпись для промпта

Переменные:
  LENA_ANALYSIS_MIN_SANITY_PRICE_MAJOR — порог «номинальной» цены (по умолчанию 100), ниже — только менеджер.
`);
  process.exitCode = 1;
}

/**
 * @param {string[]} argv
 */
export async function runAnalysisCli(argv) {
  const [sub, pathArg] = argv;
  if (sub !== "commercial-prompt" || !pathArg) {
    usageAnalysis();
    return;
  }

  /** @type {{ texts?: string[]; bundleText?: string; structuredSnapshot?: unknown; structured?: unknown; tenderLabel?: string }} */
  const ctx = readJsonFile(pathArg);
  const texts = [];
  if (Array.isArray(ctx.texts)) texts.push(...ctx.texts.filter((x) => typeof x === "string"));
  if (typeof ctx.bundleText === "string" && ctx.bundleText.trim()) texts.push(ctx.bundleText);
  const structured = ctx.structuredSnapshot ?? ctx.structured ?? undefined;

  const analysis = buildCommercialProposalAnalysis({ texts, structuredSnapshot: structured });
  const pack = buildCommercialProposalPromptPack(analysis, { tenderLabel: ctx.tenderLabel });

  const out = {
    analysis,
    llm: {
      systemAddendum: pack.systemAddendum,
      userPrompt: pack.userPrompt,
    },
  };
  console.log(JSON.stringify(out, null, 2));
}
