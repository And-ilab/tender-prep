import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, relative, resolve, sep } from "node:path";
import { chunkText } from "./chunk.js";
import { embedAll, embeddingModel } from "./embeddings.js";

const BUILD_STATE_BASENAME = ".lena-rag-build-state.json";

/**
 * @param {string} p
 */
async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Читает chunks.jsonl построчно (без загрузки всего файла в память).
 * @param {string} chunksPath
 * @returns {Promise<Set<string>>}
 */
async function loadExistingChunkIds(chunksPath) {
  const ids = new Set();
  if (!(await pathExists(chunksPath))) return ids;
  const stream = createReadStream(chunksPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = /** @type {{ chunkId?: string }} */ (JSON.parse(t));
      if (typeof row.chunkId === "string" && row.chunkId) ids.add(row.chunkId);
    } catch {
      /* пропуск битой строки */
    }
  }
  return ids;
}

/**
 * @param {string} outDir
 * @param {string} sourceDirResolved
 * @param {{ maxChars: number, overlapChars: number | undefined }} chunking
 */
async function writeBuildState(outDir, sourceDirResolved, chunking) {
  const payload = {
    sourceDirResolved,
    maxChars: chunking.maxChars,
    overlapChars: chunking.overlapChars ?? null,
    embeddingModel: embeddingModel(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(outDir, BUILD_STATE_BASENAME), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * @param {string} outDir
 */
async function readBuildState(outDir) {
  const p = join(outDir, BUILD_STATE_BASENAME);
  if (!(await pathExists(p))) return null;
  try {
    const raw = await readFile(p, "utf8");
    return /** @type {{ sourceDirResolved?: string, maxChars?: number, overlapChars?: number | null, embeddingModel?: string }} */ (
      JSON.parse(raw)
    );
  } catch {
    return null;
  }
}

/**
 * Сравнение параметров возобновления с состоянием первого прогона.
 */
function assertResumeMatches(
  state,
  sourceDirResolved,
  chunking,
  /** @type {(msg: string) => void} */ onProgress,
) {
  if (!state) {
    onProgress(
      "возобновление: нет .lena-rag-build-state.json — убедитесь, что те же maxChars/overlap и та же папка корпуса",
    );
    return;
  }
  const mc = chunking.maxChars;
  const oc = chunking.overlapChars ?? null;
  const stOc = state.overlapChars ?? null;
  const problems = [];
  if (state.sourceDirResolved && state.sourceDirResolved !== sourceDirResolved) {
    problems.push(`другой корень корпуса (было ${state.sourceDirResolved})`);
  }
  if (state.maxChars !== undefined && state.maxChars !== mc) {
    problems.push(`maxChars: было ${state.maxChars}, сейчас ${mc}`);
  }
  if (stOc !== oc) {
    problems.push(`overlap: было ${String(stOc)}, сейчас ${String(oc)}`);
  }
  const em = embeddingModel();
  if (state.embeddingModel && state.embeddingModel !== em) {
    problems.push(`модель эмбеддингов: было ${state.embeddingModel}, сейчас ${em}`);
  }
  if (problems.length) {
    throw new Error(
      `Возобновление несовместимо: ${problems.join("; ")}. Удалите chunks.jsonl и ${BUILD_STATE_BASENAME} или запустите с теми же параметрами.`,
    );
  }
}

const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".log"]);
const SKIP_DIR = new Set([".git", "node_modules", ".lena-rag"]);
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * @param {string} absPath
 */
function shouldSkipPath(absPath) {
  const parts = absPath.split(/[/\\]/);
  return parts.some((p) => SKIP_DIR.has(p));
}

/**
 * @param {string} filePath
 */
function isTextFile(filePath) {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  return TEXT_EXT.has(ext);
}

/**
 * @param {string} rootDir
 * @param {(rel: string, abs: string) => Promise<void>} onFile
 */
async function walkLocalTree(rootDir, onFile) {
  /** @type {string[]} */
  const stack = [rootDir];
  while (stack.length) {
    const dir = /** @type {string} */ (stack.pop());
    if (shouldSkipPath(dir)) continue;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (shouldSkipPath(abs)) continue;
      if (ent.isDirectory()) {
        stack.push(abs);
      } else if (ent.isFile() && isTextFile(abs)) {
        const rel = relative(rootDir, abs).split(sep).join("/");
        await onFile(rel, abs);
      }
    }
  }
}

/**
 * @param {string} chunksPath
 */
async function readFirstChunkLine(chunksPath) {
  try {
    const buf = await readFile(chunksPath, "utf8");
    const line = buf.split("\n").find((l) => l.trim());
    if (!line) return null;
    return /** @type {{ embedding?: number[] }} */ (JSON.parse(line));
  } catch {
    return null;
  }
}

/**
 * @param {string} sourceDir
 * @param {string} outDir
 * @param {{
 *   maxChars?: number,
 *   overlapChars?: number,
 *   maxFiles?: number,
 *   onProgress?: (msg: string) => void,
 *   resume?: boolean,
 * }} [opts]
 */
export async function runIndexBuild(sourceDir, outDir, opts) {
  const onProgress = opts?.onProgress ?? (() => {});
  const maxFiles = opts?.maxFiles ?? 50_000;
  const chunkOpts = { maxChars: opts?.maxChars, overlapChars: opts?.overlapChars };
  const sourceDirResolved = resolve(sourceDir);
  const manifestPath = join(outDir, "manifest.json");
  const chunksPath = join(outDir, "chunks.jsonl");

  const hasChunks = await pathExists(chunksPath);
  const hasManifest = await pathExists(manifestPath);
  let resume =
    opts?.resume ??
    (process.env.LENA_RAG_INDEX_RESUME === "0"
      ? false
      : hasChunks && !hasManifest);
  if (resume && hasManifest) {
    resume = false;
  }

  await mkdir(outDir, { recursive: true });

  /** @type {Set<string>} */
  let existingChunkIds = new Set();
  if (resume) {
    existingChunkIds = await loadExistingChunkIds(chunksPath);
    const state = await readBuildState(outDir);
    assertResumeMatches(
      state,
      sourceDirResolved,
      {
        maxChars: chunkOpts.maxChars ?? 3500,
        overlapChars: chunkOpts.overlapChars,
      },
      onProgress,
    );
    onProgress(
      `возобновление: в индексе уже ${existingChunkIds.size} чанков — остальные будут дописаны`,
    );
  } else {
    if (hasChunks && !resume) {
      onProgress("полная пересборка: перезапись chunks.jsonl");
    }
  }

  const chunkingForState = {
    maxChars: chunkOpts.maxChars ?? 3500,
    overlapChars: chunkOpts.overlapChars,
  };

  if (!resume) {
    await writeBuildState(outDir, sourceDirResolved, chunkingForState);
  }

  const stream = createWriteStream(chunksPath, {
    encoding: "utf8",
    flags: resume ? "a" : "w",
  });

  let filesSeen = 0;
  let filesSkipped = 0;
  /** Уже в файле + новые записанные строки */
  let chunkTotal = existingChunkIds.size;
  /** @type {string[]} */
  const pendingTexts = [];
  /** @type {{ chunkId: string, text: string, metadata: Record<string, unknown> }[]} */
  const pendingMeta = [];

  const flushBatch = async () => {
    if (pendingTexts.length === 0) return;
    const texts = pendingTexts.splice(0, pendingTexts.length);
    const metas = pendingMeta.splice(0, pendingMeta.length);
    onProgress(`эмбеддинги: пачка из ${texts.length} чанков…`);
    const vectors = await embedAll(texts, {
      onProgress: (done, total) => {
        if (done === total || done % 256 === 0) onProgress(`эмбеддинги: ${done}/${total}`);
      },
    });
    for (let i = 0; i < metas.length; i++) {
      const row = {
        chunkId: metas[i].chunkId,
        text: metas[i].text,
        embedding: vectors[i],
        metadata: metas[i].metadata,
      };
      stream.write(`${JSON.stringify(row)}\n`);
      chunkTotal += 1;
    }
    await writeBuildState(outDir, sourceDirResolved, chunkingForState);
  };

  const BATCH = 48;

  await walkLocalTree(sourceDir, async (relPath, absPath) => {
    if (filesSeen >= maxFiles) return;
    let st;
    try {
      st = await stat(absPath);
    } catch {
      filesSkipped += 1;
      return;
    }
    if (st.size > MAX_FILE_BYTES) {
      onProgress(`пропуск (слишком большой файл): ${relPath}`);
      filesSkipped += 1;
      return;
    }
    let raw;
    try {
      raw = await readFile(absPath, "utf8");
    } catch {
      filesSkipped += 1;
      return;
    }
    filesSeen += 1;
    const pieces = chunkText(raw, chunkOpts);
    if (pieces.length === 0) return;
    let already = 0;
    for (let idx = 0; idx < pieces.length; idx++) {
      const chunkId = `${relPath}#${idx}`;
      if (existingChunkIds.has(chunkId)) {
        already += 1;
        continue;
      }
      const text = pieces[idx];
      pendingTexts.push(text);
      pendingMeta.push({
        chunkId,
        text,
        metadata: {
          sourcePath: relPath,
          chunkIndex: idx,
          chunkCount: pieces.length,
        },
      });
      if (pendingTexts.length >= BATCH) {
        await flushBatch();
      }
    }
    const skipNote = already > 0 ? ` (${already} уже в индексе)` : "";
    onProgress(`файл ${relPath} → ${pieces.length} чанков${skipNote}`);
  });

  await flushBatch();
  await new Promise((resolve, reject) => {
    stream.end(() => resolve(undefined));
    stream.on("error", reject);
  });

  const first = await readFirstChunkLine(join(outDir, "chunks.jsonl"));
  const dimensions = first?.embedding?.length ?? 0;

  /** @type {Record<string, unknown>} */
  const manifest = {
    createdAt: new Date().toISOString(),
    sourceDir,
    outDir,
    embeddingModel: embeddingModel(),
    dimensions,
    chunkCount: chunkTotal,
    filesScanned: filesSeen,
    filesSkipped,
    chunking: {
      maxChars: chunkOpts.maxChars ?? 3500,
      overlapChars: chunkOpts.overlapChars,
    },
    textExtensions: [...TEXT_EXT],
  };
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  onProgress(`готово: чанков ${chunkTotal}, manifest.json записан`);
  if (chunkTotal === 0) {
    throw new Error(
      "Не собрано ни одного чанка: в папке нет .txt/.md/.csv или все файлы слишком большие. Сначала corpus-pull или положите текст.",
    );
  }
  return manifest;
}
