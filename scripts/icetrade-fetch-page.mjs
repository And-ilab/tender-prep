#!/usr/bin/env node
/**
 * Загрузка HTML страницы IceTrade с цепочкой fallback (как fetchPage.js).
 * Для Windmill/parserit: node scripts/icetrade-fetch-page.mjs [view_id|URL]
 *
 * stdout: одна JSON-строка { ok, via, page_url, html_len, blocked?, error? }
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { fetchIceTradeCardHtml } from "../src/icetrade/fetchPage.js";
import { normalizeIceTradeViewId } from "../src/icetrade/viewIds.js";

const LOG = join(process.cwd(), "debug-63ed93.log");
const SESSION = "63ed93";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "text/html,application/xhtml+xml",
  Referer: "https://icetrade.by/",
};
const TIMEOUT_MS = Number(process.env.LENA_ICETRADE_FETCH_TIMEOUT_MS ?? 25_000);

/** @param {Record<string, unknown>} data */
function agentLog(message, data) {
  // #region agent log
  try {
    appendFileSync(
      LOG,
      `${JSON.stringify({
        sessionId: SESSION,
        runId: process.env.DEBUG_RUN_ID ?? "fetch-page",
        hypothesisId: "C",
        location: "icetrade-fetch-page.mjs",
        message,
        data,
        timestamp: Date.now(),
      })}\n`,
      "utf8",
    );
  } catch {
    /* ignore */
  }
  // #endregion
}

function resolvePageUrl(arg) {
  const raw = String(arg ?? "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const viewId = normalizeIceTradeViewId(raw) ?? raw.replace(/\D/g, "");
  if (!viewId) return null;
  return `https://icetrade.by/tenders/all/view/${viewId}`;
}

async function main() {
  const pageUrl = resolvePageUrl(process.argv[2]);
  if (!pageUrl) {
    const err = {
      ok: false,
      error: "usage: node scripts/icetrade-fetch-page.mjs <view_id|URL>",
    };
    console.log(JSON.stringify(err));
    process.exitCode = 1;
    return;
  }

  agentLog("fetch-page start", { pageUrl, timeoutMs: TIMEOUT_MS });

  try {
    const t0 = Date.now();
    const { html, via } = await fetchIceTradeCardHtml(pageUrl, HEADERS, TIMEOUT_MS);
    const blocked = /403|forbidden|captcha|cloudflare|access denied/i.test(html.slice(0, 3000));
    const out = {
      ok: !blocked && html.length > 500,
      via,
      page_url: pageUrl,
      html_len: html.length,
      blocked,
      ms: Date.now() - t0,
    };
    agentLog("fetch-page ok", out);
    console.log(JSON.stringify(out));
    if (!out.ok) process.exitCode = 1;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const out = { ok: false, page_url: pageUrl, error: msg };
    agentLog("fetch-page fail", out);
    console.log(JSON.stringify(out));
    process.exitCode = 1;
  }
}

main();
