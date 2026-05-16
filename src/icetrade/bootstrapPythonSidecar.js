import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Доп. сбор URL вложений через Python (scripts/icetrade_fetch/fetch_card.py).
 * Вкл.: LENA_ICETRADE_PYTHON_FETCH=1. Интерпретатор: LENA_ICETRADE_PYTHON (по умолчанию Windows: py -3, иначе python3).
 *
 * @param {string} viewId
 * @param {number} timeoutMs
 * @returns {Promise<{ urls: string[], via: string, ok: boolean, error?: string }>}
 */
export async function runPythonIceTradeFetch(viewId, timeoutMs) {
  const script = join(process.cwd(), "scripts", "icetrade_fetch", "fetch_card.py");
  if (!existsSync(script)) {
    return { urls: [], via: "python-missing-script", ok: false, error: `Нет файла ${script}` };
  }

  const custom = process.env.LENA_ICETRADE_PYTHON?.trim();
  /** @type {string} */
  let exe;
  /** @type {string[]} */
  let prefix;
  if (custom) {
    exe = custom;
    prefix = [];
  } else if (process.platform === "win32") {
    exe = "py";
    prefix = ["-3"];
  } else {
    exe = "python3";
    prefix = [];
  }

  const args = [...prefix, script, viewId, "--json"];
  const storage = process.env.LENA_ICETRADE_PLAYWRIGHT_STORAGE?.trim();
  if (storage && existsSync(storage)) {
    args.push("--storage", storage);
  }
  args.push("--timeout-ms", String(Math.max(15_000, timeoutMs)));
  const settle = process.env.LENA_ICETRADE_PLAYWRIGHT_SETTLE_MS?.trim();
  if (settle) args.push("--settle-ms", settle);
  if (process.env.LENA_ICETRADE_PLAYWRIGHT_HEADED?.trim() === "1") {
    args.push("--headed");
  }
  const maxResp = process.env.LENA_ICETRADE_PLAYWRIGHT_MAX_RESPONSE_BYTES?.trim();
  if (maxResp) args.push("--max-response-bytes", maxResp);

  if (process.env.LENA_ICETRADE_PYTHON_HTTP_ONLY?.trim() === "1") {
    args.push("--http-only");
  }

  try {
    const { stdout, stderr } = await execFileAsync(exe, args, {
      maxBuffer: 12 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env },
      cwd: process.cwd(),
    });
    void stderr;
    const line = stdout.trim();
    const data = /** @type {Record<string, unknown>} */ (JSON.parse(line));
    if (data.ok === false) {
      return {
        urls: [],
        via: String(data.via ?? "python-error"),
        ok: false,
        error: String(data.error ?? "unknown"),
      };
    }
    const urls = /** @type {string[]} */ (data.all_file_urls ?? data.urls ?? []);
    return { urls: Array.isArray(urls) ? urls : [], via: String(data.via ?? "python"), ok: true };
  } catch (e) {
    let msg = e instanceof Error ? e.message : String(e);
    if (/No module named ['"]playwright['"]/i.test(msg)) {
      msg += ` → в том же Python: pip install -r scripts/icetrade_fetch/requirements.txt && playwright install chromium`;
    }
    return { urls: [], via: "python-exec", ok: false, error: msg };
  }
}

/**
 * `off` | `always` | `auto` — auto: только если после Node не осталось кандидатов к скачиванию.
 * @returns {"off" | "always" | "auto"}
 */
export function iceTradePythonFetchMode() {
  const v = process.env.LENA_ICETRADE_PYTHON_FETCH?.trim().toLowerCase() ?? "";
  if (v === "1" || v === "true" || v === "yes" || v === "on" || v === "always") return "always";
  if (v === "auto") return "auto";
  return "off";
}
