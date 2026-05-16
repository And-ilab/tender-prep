import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * @param {string} url
 */
function escapePsSingleQuoted(url) {
  return url.replace(/'/g, "''");
}

/**
 * @param {Record<string, string>} headers
 */
function fetchHtmlNodeHttps(urlStr, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opt = {
      hostname: u.hostname,
      port: u.port || 443,
      path: `${u.pathname}${u.search}`,
      method: "GET",
      headers,
      servername: u.hostname,
      timeout: timeoutMs,
    };
    const req = https.request(opt, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        resolve(body);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

/**
 * Тот же стек TLS, что и у многих корпоративных скриптов на Windows; часто работает, когда падает undici fetch.
 * @param {string} url
 * @param {number} timeoutMs
 */
async function fetchHtmlPowerShell(url, timeoutMs) {
  const sec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const cmd = `(Invoke-WebRequest -Uri '${escapePsSingleQuoted(url)}' -UseBasicParsing -TimeoutSec ${sec}).Content`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", cmd],
    { maxBuffer: 18 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
  );
  return typeof stdout === "string" ? stdout : stdout.toString("utf8");
}

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 */
async function fetchHtmlCurl(url, headers, timeoutMs) {
  const sec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const ua = headers["User-Agent"] ?? "curl";
  const { stdout } = await execFileAsync(
    "curl",
    ["-sSL", "--max-time", String(sec), "-A", ua, "-H", `Accept: ${headers.Accept ?? "*/*"}`, url],
    { maxBuffer: 18 * 1024 * 1024, encoding: "utf8" },
  );
  return typeof stdout === "string" ? stdout : stdout.toString("utf8");
}

/**
 * HTML карточки IceTrade. На части Windows `fetch` (undici) даёт «fetch failed», тогда как IE/WebRequest нормально тянут HTTPS.
 *
 * LENA_ICETRADE_FETCH_BACKEND: `auto` | `fetch` | `https` | `powershell` | `curl`
 * LENA_ICETRADE_NO_POWERSHELL_FALLBACK=1 — не вызывать PowerShell после ошибок (только auto)
 *
 * @param {string} pageUrl
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @returns {Promise<{ html: string, via: string }>}
 */
export async function fetchIceTradeCardHtml(pageUrl, headers, timeoutMs) {
  const backend = process.env.LENA_ICETRADE_FETCH_BACKEND?.trim().toLowerCase() ?? "auto";

  const tryFetch = async () => {
    const res = await fetch(pageUrl, {
      redirect: "follow",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };

  if (backend === "powershell") {
    const html = await fetchHtmlPowerShell(pageUrl, timeoutMs);
    return { html, via: "powershell" };
  }
  if (backend === "curl") {
    const html = await fetchHtmlCurl(pageUrl, headers, timeoutMs);
    return { html, via: "curl" };
  }
  if (backend === "https") {
    const html = await fetchHtmlNodeHttps(pageUrl, headers, timeoutMs);
    return { html, via: "node:https" };
  }
  if (backend === "fetch") {
    const html = await tryFetch();
    return { html, via: "fetch" };
  }

  /** @type {Error[]} */
  const errs = [];
  try {
    const html = await tryFetch();
    return { html, via: "fetch" };
  } catch (e1) {
    errs.push(e1 instanceof Error ? e1 : new Error(String(e1)));
  }
  try {
    const html = await fetchHtmlNodeHttps(pageUrl, headers, timeoutMs);
    return { html, via: "node:https" };
  } catch (e2) {
    errs.push(e2 instanceof Error ? e2 : new Error(String(e2)));
  }
  if (process.platform === "win32" && process.env.LENA_ICETRADE_NO_POWERSHELL_FALLBACK !== "1") {
    try {
      const html = await fetchHtmlPowerShell(pageUrl, timeoutMs);
      return { html, via: "powershell" };
    } catch (e3) {
      errs.push(e3 instanceof Error ? e3 : new Error(String(e3)));
    }
  }
  try {
    const html = await fetchHtmlCurl(pageUrl, headers, timeoutMs);
    return { html, via: "curl" };
  } catch (e4) {
    errs.push(e4 instanceof Error ? e4 : new Error(String(e4)));
  }

  const msg = errs.map((e) => e.message).join(" | ");
  throw new Error(msg || "fetch failed");
}

/**
 * @param {string} urlStr
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @returns {Promise<{ buffer: Buffer, contentDisposition: string | null }>}
 */
function httpsGetBinary(urlStr, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opt = {
      hostname: u.hostname,
      port: u.port || 443,
      path: `${u.pathname}${u.search}`,
      method: "GET",
      headers,
      servername: u.hostname,
      timeout: timeoutMs,
    };
    const req = https.request(opt, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const rawCd = res.headers["content-disposition"];
        const contentDisposition =
          typeof rawCd === "string" ? rawCd : Array.isArray(rawCd) ? rawCd[0] ?? null : null;
        resolve({ buffer: Buffer.concat(chunks), contentDisposition });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 */
async function fetchBinaryFetch(url, headers, timeoutMs) {
  const res = await fetch(url, {
    redirect: "follow",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return { buffer: Buffer.from(ab), contentDisposition: res.headers.get("content-disposition") };
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 */
async function downloadBinaryPowerShell(url, timeoutMs) {
  const sec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const dir = await mkdtemp(join(tmpdir(), "lena-ps-dl-"));
  const outPath = join(dir, "f.bin");
  try {
    const cmd = `Invoke-WebRequest -Uri '${escapePsSingleQuoted(url)}' -OutFile '${escapePsSingleQuoted(outPath)}' -UseBasicParsing -TimeoutSec ${sec}`;
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    const buffer = await readFile(outPath);
    return { buffer, contentDisposition: null };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 */
async function downloadBinaryCurl(url, headers, timeoutMs) {
  const sec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const ua = headers["User-Agent"] ?? "curl";
  const dir = await mkdtemp(join(tmpdir(), "lena-curl-dl-"));
  const outPath = join(dir, "f.bin");
  try {
    await execFileAsync(
      "curl",
      ["-sSL", "--max-time", String(sec), "-A", ua, "-o", outPath, url],
      { maxBuffer: 256 * 1024 },
    );
    const buffer = await readFile(outPath);
    return { buffer, contentDisposition: null };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Бинарное скачивание вложения (тот же каскад, что и для HTML).
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @returns {Promise<{ buffer: Buffer, contentDisposition: string | null, via: string }>}
 */
export async function downloadIceTradeBinary(url, headers, timeoutMs) {
  const backend = process.env.LENA_ICETRADE_FETCH_BACKEND?.trim().toLowerCase() ?? "auto";
  const h = { ...headers, Accept: headers.Accept ?? "*/*" };

  if (backend === "powershell") {
    const { buffer, contentDisposition } = await downloadBinaryPowerShell(url, timeoutMs);
    return { buffer, contentDisposition, via: "powershell" };
  }
  if (backend === "curl") {
    const { buffer, contentDisposition } = await downloadBinaryCurl(url, h, timeoutMs);
    return { buffer, contentDisposition, via: "curl" };
  }
  if (backend === "https") {
    const { buffer, contentDisposition } = await httpsGetBinary(url, h, timeoutMs);
    return { buffer, contentDisposition, via: "node:https" };
  }
  if (backend === "fetch") {
    const { buffer, contentDisposition } = await fetchBinaryFetch(url, h, timeoutMs);
    return { buffer, contentDisposition, via: "fetch" };
  }

  try {
    const { buffer, contentDisposition } = await fetchBinaryFetch(url, h, timeoutMs);
    return { buffer, contentDisposition, via: "fetch" };
  } catch {
    /* try next */
  }
  try {
    const { buffer, contentDisposition } = await httpsGetBinary(url, h, timeoutMs);
    return { buffer, contentDisposition, via: "node:https" };
  } catch {
    /* try next */
  }
  if (process.platform === "win32" && process.env.LENA_ICETRADE_NO_POWERSHELL_FALLBACK !== "1") {
    try {
      const { buffer, contentDisposition } = await downloadBinaryPowerShell(url, timeoutMs);
      return { buffer, contentDisposition, via: "powershell" };
    } catch {
      /* try next */
    }
  }
  const { buffer, contentDisposition } = await downloadBinaryCurl(url, h, timeoutMs);
  return { buffer, contentDisposition, via: "curl" };
}
