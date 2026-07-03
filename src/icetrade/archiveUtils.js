import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** @typedef {"zip" | "rar" | "7z"} ArchiveKind */

/**
 * @param {string} name
 */
export function isArchiveFileName(name) {
  return /\.(zip|rar|7z)$/i.test(String(name ?? "").trim());
}

/**
 * @param {string} archiveFileName
 */
export function archiveStemFromFileName(archiveFileName) {
  return String(archiveFileName ?? "")
    .replace(/\.(zip|rar|7z)$/i, "")
    .trim();
}

/**
 * Имя файла на Drive для элемента архива: `<stem>__<path-with-__>.ext`
 * @param {string} archiveFileName
 * @param {string} relativePath — путь внутри архива (POSIX или Windows)
 */
export function driveNameForArchiveMember(archiveFileName, relativePath) {
  const stem = archiveStemFromFileName(archiveFileName);
  const rel = String(relativePath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .join("__")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const base = rel || "file";
  const out = `${stem}__${base}`.slice(0, 180).trim();
  return out || `${stem}__file`;
}

/**
 * @param {string} relativePath
 */
export function shouldSkipArchiveMemberPath(relativePath) {
  const norm = String(relativePath ?? "").replace(/\\/g, "/");
  const low = norm.toLowerCase();
  if (!norm || low.endsWith("/")) return true;
  if (/(^|\/)__macosx\//i.test(norm)) return true;
  if (low.endsWith(".ds_store") || low.endsWith("thumbs.db") || low.endsWith("desktop.ini")) return true;
  return false;
}

/**
 * @param {string} name
 */
export function isUsefulArchiveMemberName(name) {
  const low = String(name ?? "").toLowerCase();
  if (!low || isArchiveFileName(low)) return true;
  return /\.(pdf|docx?|xlsx?|pptx?|csv|txt|md|json|xml|html?|rtf)$/i.test(low);
}

/**
 * @param {Buffer} buffer
 * @returns {ArchiveKind | null}
 */
export function detectArchiveKindFromBuffer(buffer) {
  if (!buffer || buffer.length < 6) return null;
  const sig4 = buffer.subarray(0, 4).toString("latin1");
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) return "zip";
  if (sig4 === "Rar!") return "rar";
  if (sig4 === "7z\xBC") return "7z";
  return null;
}

/**
 * @param {string} fileName
 * @param {Buffer} [buffer]
 * @returns {ArchiveKind | null}
 */
export function resolveArchiveKind(fileName, buffer) {
  const fromBuf = buffer ? detectArchiveKindFromBuffer(buffer) : null;
  if (fromBuf) return fromBuf;
  const low = String(fileName ?? "").toLowerCase();
  if (low.endsWith(".zip")) return "zip";
  if (low.endsWith(".rar")) return "rar";
  if (low.endsWith(".7z")) return "7z";
  return null;
}

/**
 * @returns {Promise<string | null>} путь к 7z.exe / unrar / команда из env
 */
export async function resolveArchiveExtractorBinary() {
  const env = process.env.LENA_ARCHIVE_EXTRACT_CMD?.trim();
  if (env && existsSync(env)) return env;

  /** @type {string[]} */
  const candidates = [
    "C:\\Program Files\\7-Zip\\7z.exe",
    "C:\\Program Files (x86)\\7-Zip\\7z.exe",
    "C:\\Program Files\\WinRAR\\UnRAR.exe",
    "C:\\Program Files\\WinRAR\\WinRAR.exe",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("where", ["7z"], { windowsHide: true, timeout: 8000 });
      const first = stdout.trim().split(/\r?\n/)[0]?.trim();
      if (first && existsSync(first)) return first;
    } catch {
      /* ignore */
    }
    try {
      const { stdout } = await execFileAsync("where", ["unrar"], { windowsHide: true, timeout: 8000 });
      const first = stdout.trim().split(/\r?\n/)[0]?.trim();
      if (first && existsSync(first)) return first;
    } catch {
      /* ignore */
    }
  }

  return null;
}

/**
 * @param {string} archivePath
 * @param {string} destDir
 * @param {ArchiveKind} kind
 */
async function extractVia7z(exe, archivePath, destDir, kind) {
  const args =
    /unrar/i.test(exe) && kind === "rar"
      ? ["x", "-y", archivePath, destDir + "\\"]
      : ["x", "-y", `-o${destDir}`, archivePath];
  await execFileAsync(exe, args, { windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
}

/**
 * @param {string} archivePath
 * @param {string} destDir
 */
async function extractZipViaPowerShell(archivePath, destDir) {
  const ps = [
    "$ErrorActionPreference='Stop'",
    `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
  ].join("; ");
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
}

/**
 * Распаковать архив во временную папку.
 * @param {string} archivePath — абсолютный путь к файлу
 * @param {string} destDir — абсолютный путь к каталогу назначения
 * @param {{ kind?: ArchiveKind | null }} [opts]
 * @returns {Promise<{ via: string }>}
 */
export async function extractArchiveToDirectory(archivePath, destDir, opts = {}) {
  const kind = opts.kind ?? resolveArchiveKind(archivePath);
  if (!kind) throw new Error("неизвестный тип архива");

  const exe = await resolveArchiveExtractorBinary();
  if (exe) {
    await extractVia7z(exe, archivePath, destDir, kind);
    return { via: exe.includes("UnRAR") || exe.includes("WinRAR") ? "unrar" : "7z" };
  }

  if (kind === "zip" && process.platform === "win32") {
    await extractZipViaPowerShell(archivePath, destDir);
    return { via: "powershell_expand-archive" };
  }

  throw new Error(
    "нет утилиты распаковки: установите 7-Zip (https://www.7-zip.org/) или задайте LENA_ARCHIVE_EXTRACT_CMD=путь\\к\\7z.exe",
  );
}

/**
 * Рекурсивный обход распакованного каталога.
 * @param {string} rootDir
 * @param {string} [relPrefix]
 * @returns {Promise<{ relativePath: string, fullPath: string, size: number }[]>}
 */
export async function listExtractedFilesRecursive(rootDir, relPrefix = "") {
  /** @type {{ relativePath: string, fullPath: string, size: number }[]} */
  const out = [];
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const e of entries) {
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    const full = join(rootDir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listExtractedFilesRecursive(full, rel)));
      continue;
    }
    if (!e.isFile()) continue;
    const st = await stat(full);
    out.push({ relativePath: rel.replace(/\\/g, "/"), fullPath: full, size: st.size });
  }
  return out;
}
