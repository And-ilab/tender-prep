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
 * @returns {Promise<{ buffer: Buffer, contentDisposition: string | null, contentType: string | null }>}
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
        const rawCt = res.headers["content-type"];
        const rawCtStr = typeof rawCt === "string" ? rawCt : Array.isArray(rawCt) ? rawCt[0] : null;
        const contentType = rawCtStr ? rawCtStr.split(";")[0].trim().toLowerCase() : null;
        resolve({ buffer: Buffer.concat(chunks), contentDisposition, contentType });
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
  const ctRaw = res.headers.get("content-type");
  const contentType = ctRaw ? ctRaw.split(";")[0].trim().toLowerCase() : null;
  return { buffer: Buffer.from(ab), contentDisposition: res.headers.get("content-disposition"), contentType };
}

/**
 * @param {string} url
 */
function guessBasenameFromUrl(url) {
  try {
    const u = new URL(url);
    const base = u.pathname.split("/").pop() || "download";
    return decodeURIComponent(base.split("?")[0]) || "download.bin";
  } catch {
    return "download.bin";
  }
}

/**
 * Ответ по URL вложения похож на HTML-заглушку, а не на файл (типично getFile без Referer/cookies).
 * @param {string} url
 * @param {Buffer} buffer
 * @param {string | null | undefined} contentType
 * @param {string} fileNameHint
 */
export function attachmentResponseLooksLikeHtmlStub(url, buffer, contentType, fileNameHint) {
  const v = validateAttachmentBuffer(buffer, fileNameHint, contentType);
  if (!v.ok) return true;
  if (contentType?.includes("text/html")) return true;
  const low = url.toLowerCase();
  const expectBinary =
    low.endsWith(".pdf") ||
    low.includes("/getfile") ||
    low.includes("getfile") ||
    /[?&]f=detail\b/i.test(low) ||
    /\.(docx?|zip|rar|7z|xlsx?)(\?|#|$)/i.test(fileNameHint);
  if (!expectBinary || !buffer || buffer.length < 8) return false;
  const sig = buffer.subarray(0, 5).toString("latin1");
  if (sig.startsWith("%PDF")) return false;
  const head = buffer
    .subarray(0, Math.min(500, buffer.length))
    .toString("utf8")
    .trimStart()
    .toLowerCase();
  return head.startsWith("<") || head.includes("<!doctype") || head.includes("<html");
}
/**
 * @param {Record<string, string>} headers
 * @returns {{ setup: string, arg: string }}
 */
function powershellHeaderBlock(headers) {
  /** @type {string[]} */
  const hdrPairs = [];
  const ua = headers["User-Agent"];
  const ref = headers.Referer;
  const cookie = headers.Cookie;
  const accept = headers.Accept;
  if (ua) hdrPairs.push(`'User-Agent'='${escapePsSingleQuoted(ua)}'`);
  if (ref) hdrPairs.push(`'Referer'='${escapePsSingleQuoted(ref)}'`);
  if (cookie) hdrPairs.push(`'Cookie'='${escapePsSingleQuoted(cookie)}'`);
  if (accept) hdrPairs.push(`'Accept'='${escapePsSingleQuoted(accept)}'`);
  if (!hdrPairs.length) return { setup: "", arg: "" };
  return {
    setup: `$headers = @{ ${hdrPairs.join("; ")} }; `,
    arg: " -Headers $headers",
  };
}

/**
 * IceTrade getFile: сначала открыть карточку в WebSession (куки), затем скачать файл — как клик в браузере.
 * @param {string} fileUrl
 * @param {string} cardPageUrl
 * @param {number} timeoutMs
 * @param {Record<string, string>} headers
 */
async function downloadBinaryPowerShellWithCardSession(fileUrl, cardPageUrl, timeoutMs, headers) {
  const sec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const dir = await mkdtemp(join(tmpdir(), "lena-ps-sess-"));
  const outPath = join(dir, "f.bin");
  const cardHdr = { ...headers };
  delete cardHdr.Referer;
  const fileHdr = { ...headers, Referer: headers.Referer || cardPageUrl };
  const warm = powershellHeaderBlock({
    ...cardHdr,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });
  const file = powershellHeaderBlock(fileHdr);
  try {
    const cmd = [
      "$ProgressPreference = 'SilentlyContinue';",
      "$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession;",
      `${warm.setup}Invoke-WebRequest -Uri '${escapePsSingleQuoted(cardPageUrl)}' -WebSession $session -UseBasicParsing -TimeoutSec ${sec}${warm.arg} | Out-Null;`,
      `${file.setup}Invoke-WebRequest -Uri '${escapePsSingleQuoted(fileUrl)}' -WebSession $session -OutFile '${escapePsSingleQuoted(outPath)}' -UseBasicParsing -TimeoutSec ${sec}${file.arg};`,
    ].join(" ");
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    const buffer = await readFile(outPath);
    return { buffer, contentDisposition: null, contentType: null };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @param {Record<string, string>} [headers]
 */
async function downloadBinaryPowerShell(url, timeoutMs, headers = {}) {
  const sec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const dir = await mkdtemp(join(tmpdir(), "lena-ps-dl-"));
  const outPath = join(dir, "f.bin");
  try {
    const { setup: hdrSetup, arg: hdrArg } = powershellHeaderBlock(headers);
    const cmd = `${hdrSetup}Invoke-WebRequest -Uri '${escapePsSingleQuoted(url)}' -OutFile '${escapePsSingleQuoted(outPath)}' -UseBasicParsing -TimeoutSec ${sec}${hdrArg}`;
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    const buffer = await readFile(outPath);
    return { buffer, contentDisposition: null, contentType: null };
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
    /** @type {string[]} */
    const args = ["-sSL", "--max-time", String(sec), "-A", ua, "-o", outPath];
    if (headers.Referer) args.push("-H", `Referer: ${headers.Referer}`);
    if (headers.Cookie) args.push("-H", `Cookie: ${headers.Cookie}`);
    args.push(url);
    await execFileAsync("curl", args, { maxBuffer: 256 * 1024 });
    const buffer = await readFile(outPath);
    return { buffer, contentDisposition: null, contentType: null };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Проверка скачанного вложения: отсекаем HTML-заглушки и «не-PDF» с расширением .pdf.
 * @param {Buffer} buffer
 * @param {string} fileName
 * @param {string | null | undefined} contentType — основной тип из HTTP (без параметров)
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateAttachmentBuffer(buffer, fileName, contentType) {
  const low = fileName.toLowerCase();
  const ct = (contentType || "").toLowerCase();
  if (!buffer || buffer.length < 16) {
    return { ok: false, reason: "пустой или слишком короткий ответ" };
  }
  if (low.endsWith(".pdf")) {
    const sig = buffer.subarray(0, 5).toString("latin1");
    if (!sig.startsWith("%PDF")) {
      const head = buffer
        .subarray(0, Math.min(800, buffer.length))
        .toString("utf8")
        .trimStart()
        .slice(0, 200);
      const hl = head.toLowerCase();
      if (
        head.startsWith("<") ||
        hl.includes("<!doctype") ||
        hl.includes("<html") ||
        hl.includes("login") ||
        hl.includes("доступ")
      ) {
        return {
          ok: false,
          reason:
            "вместо PDF получен HTML — для публичных карточек это часто отличие автоматического клиента от браузера (заголовки, TLS, антибот); имеет смысл **LENA_ICETRADE_PLAYWRIGHT** / прогрев карточки, опционально **LENA_ICETRADE_COOKIE** или **STORAGE** как у реального браузера",
        };
      }
      return { ok: false, reason: `ожидался PDF (сигнатура %PDF), получено: «${sig.slice(0, 8)}»` };
    }
    if (ct.includes("text/html")) {
      return { ok: false, reason: "Content-Type указывает text/html при имени .pdf" };
    }
  }
  return { ok: true };
}

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @param {string} fileNameHint
 * @param {string | undefined} cardPageUrl — URL карточки IceTrade для WebSession (Windows / getFile)
 * @returns {Promise<{ buffer: Buffer, contentDisposition: string | null, contentType: string | null, via: string }>}
 */
async function downloadIceTradeBinaryViaBackends(url, headers, timeoutMs, fileNameHint, cardPageUrl) {
  const low = url.toLowerCase();
  const isIceGetFile =
    /icetrade\.by/i.test(url) &&
    (low.includes("/getfile") || low.includes("getfile") || /[?&]f=detail\b/i.test(low));

  /** @type {{ via: string, run: () => Promise<{ buffer: Buffer, contentDisposition: string | null, contentType: string | null }> }[]} */
  const chain = [];

  if (process.platform === "win32" && process.env.LENA_ICETRADE_NO_POWERSHELL_FALLBACK !== "1") {
    if (cardPageUrl && isIceGetFile) {
      chain.push({
        via: "powershell:session",
        run: () => downloadBinaryPowerShellWithCardSession(url, cardPageUrl, timeoutMs, headers),
      });
    }
    chain.push({
      via: "powershell",
      run: () => downloadBinaryPowerShell(url, timeoutMs, headers),
    });
  }

  chain.push(
    { via: "fetch", run: () => fetchBinaryFetch(url, headers, timeoutMs) },
    { via: "node:https", run: () => httpsGetBinary(url, headers, timeoutMs) },
    { via: "curl", run: () => downloadBinaryCurl(url, headers, timeoutMs) },
  );

  /** @type {string[]} */
  const rejects = [];
  for (const step of chain) {
    try {
      const { buffer, contentDisposition, contentType } = await step.run();
      if (attachmentResponseLooksLikeHtmlStub(url, buffer, contentType, fileNameHint)) {
        rejects.push(`${step.via}: HTML вместо файла`);
        continue;
      }
      return { buffer, contentDisposition, contentType, via: step.via };
    } catch (e) {
      rejects.push(`${step.via}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(rejects.join(" | ") || "download failed");
}

/**
 * Бинарное скачивание вложения (каскад бэкендов; при HTML-заглушке пробует следующий, в т.ч. PowerShell на Windows).
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @param {{ fileNameHint?: string, cardPageUrl?: string }} [opts]
 * @returns {Promise<{ buffer: Buffer, contentDisposition: string | null, contentType: string | null, via: string }>}
 */
export async function downloadIceTradeBinary(url, headers, timeoutMs, opts = {}) {
  const backend = process.env.LENA_ICETRADE_FETCH_BACKEND?.trim().toLowerCase() ?? "auto";
  const h = { ...headers, Accept: headers.Accept ?? "*/*" };
  const fileNameHint = opts.fileNameHint ?? guessBasenameFromUrl(url);

  if (backend === "powershell") {
    const { buffer, contentDisposition, contentType } = await downloadBinaryPowerShell(url, timeoutMs, h);
    return { buffer, contentDisposition, contentType, via: "powershell" };
  }
  if (backend === "curl") {
    const { buffer, contentDisposition, contentType } = await downloadBinaryCurl(url, h, timeoutMs);
    return { buffer, contentDisposition, contentType, via: "curl" };
  }
  if (backend === "https") {
    const { buffer, contentDisposition, contentType } = await httpsGetBinary(url, h, timeoutMs);
    return { buffer, contentDisposition, contentType, via: "node:https" };
  }
  if (backend === "fetch") {
    const { buffer, contentDisposition, contentType } = await fetchBinaryFetch(url, h, timeoutMs);
    return { buffer, contentDisposition, contentType, via: "fetch" };
  }

  return downloadIceTradeBinaryViaBackends(url, h, timeoutMs, fileNameHint, opts.cardPageUrl);
}
