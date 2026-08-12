#!/usr/bin/env node
/**
 * One-shot icetrade.by connectivity probe for debug session 63ed93.
 * Writes NDJSON to debug-63ed93.log in repo root.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fetchIceTradeCardHtml } from "../src/icetrade/fetchPage.js";

const LOG = join(process.cwd(), "debug-63ed93.log");
const SESSION = "63ed93";
const CARD = "https://icetrade.by/tenders/all/view/1336510";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "text/html,application/xhtml+xml",
  Referer: "https://icetrade.by/",
};

/** @param {string} hypothesisId @param {string} location @param {string} message @param {Record<string, unknown>} data */
function log(hypothesisId, location, message, data) {
  const line = JSON.stringify({
    sessionId: SESSION,
    runId: "connectivity-probe",
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  });
  appendFileSync(LOG, line + "\n", "utf8");
  console.log(message, JSON.stringify(data));
}

async function probeFetch(label, hypothesisId) {
  const t0 = Date.now();
  try {
    const res = await fetch(CARD, {
      redirect: "follow",
      headers: HEADERS,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    log(hypothesisId, "debug-icetrade-connectivity.mjs:probeFetch", `${label} ok`, {
      status: res.status,
      ms: Date.now() - t0,
      htmlLen: text.length,
      looksBlocked: /403|forbidden|captcha|cloudflare|access denied/i.test(text.slice(0, 2000)),
    });
    return true;
  } catch (e) {
    log(hypothesisId, "debug-icetrade-connectivity.mjs:probeFetch", `${label} fail`, {
      ms: Date.now() - t0,
      err: e instanceof Error ? e.message : String(e),
      code: e instanceof Error && "cause" in e && e.cause && typeof e.cause === "object" && "code" in e.cause ? String(e.cause.code) : undefined,
    });
    return false;
  }
}

async function main() {
  log("E", "debug-icetrade-connectivity.mjs:main", "probe start", {
    node: process.version,
    backend: process.env.LENA_ICETRADE_FETCH_BACKEND ?? "auto",
    nodeOptions: process.env.NODE_OPTIONS ?? "",
  });

  await probeFetch("undici fetch", "C");

  try {
    const t0 = Date.now();
    const { html, via } = await fetchIceTradeCardHtml(CARD, HEADERS, 25000);
    log("C", "debug-icetrade-connectivity.mjs:fetchIceTradeCardHtml", "card html ok", {
      via,
      ms: Date.now() - t0,
      htmlLen: html.length,
      hasTender: /tender|лот|закуп/i.test(html.slice(0, 5000)),
    });
  } catch (e) {
    log("C", "debug-icetrade-connectivity.mjs:fetchIceTradeCardHtml", "card html fail", {
      err: e instanceof Error ? e.message : String(e),
    });
  }

  // post-fix CLI used by Windmill/parserit
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("node", ["scripts/icetrade-fetch-page.mjs", "1336510"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DEBUG_RUN_ID: "post-fix" },
    }).trim();
    log("C", "debug-icetrade-connectivity.mjs:icetrade-fetch-page", "fetch-page cli", {
      result: JSON.parse(out),
    });
  } catch (e) {
    log("C", "debug-icetrade-connectivity.mjs:icetrade-fetch-page", "fetch-page cli fail", {
      err: e instanceof Error ? e.message : String(e),
    });
  }

  log("A", "debug-icetrade-connectivity.mjs:main", "probe done", {});
}

main().catch((e) => {
  log("A", "debug-icetrade-connectivity.mjs:main", "fatal", { err: String(e) });
  process.exitCode = 1;
});
