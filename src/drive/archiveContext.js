import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDriveId } from "./ids.js";
import { uploadFile } from "./ops.js";
import {
  buildDriveFolderManifest,
  ensureLenaTree,
  resolveLayoutIds,
} from "./workspace.js";

/** @type {readonly string[]} */
const DEFAULT_CUSTOMER_MARKERS = ["заказч", "требован", "извещ", "технич", "техзад"];

/** @type {readonly string[]} */
const DEFAULT_SUBMISSION_MARKERS = ["участ", "подач", "заяв", "коммерц", "предложен"];

/**
 * @param {string} envName
 * @param {readonly string[]} defaults
 */
function markersFromEnv(envName, defaults) {
  const raw = process.env[envName]?.trim();
  if (!raw) return [...defaults];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * @param {string} pathFromArchiveRoot — путь без корня архива
 * @param {string[]} customer
 * @param {string[]} submission
 */
function classifyPath(pathFromArchiveRoot, customer, submission) {
  const s = pathFromArchiveRoot.toLowerCase();
  const hasC = customer.some((m) => s.includes(m));
  const hasS = submission.some((m) => s.includes(m));
  if (hasC && !hasS) return "customer";
  if (hasS && !hasC) return "submission";
  if (hasC && hasS) return "ambiguous";
  return "other";
}

/**
 * @param {string} drivePath
 * @returns {{ project: string, underProject: string }}
 */
function splitProject(drivePath) {
  const parts = drivePath.split("/").filter(Boolean);
  if (parts.length === 0) return { project: "_корень_архива", underProject: "" };
  const project = parts[0];
  const underProject = parts.slice(1).join("/");
  return { project, underProject };
}

/**
 * Загрузка в папку «Мой диск» через сервисный аккаунт: владелец файла — SA, у него нет квоты → 403.
 * Решения: общий диск (Shared Drive) или OAuth под пользователем.
 * @param {string} message
 */
function isServiceAccountMyDriveUploadBlocked(message) {
  const m = message.toLowerCase();
  return (
    m.includes("storagequotaexceeded") ||
    m.includes("service accounts do not have storage quota")
  );
}

/**
 * @param {{
 *   scannedAt: string,
 *   rootFolderId: string,
 *   rootName?: string,
 *   fileCount: number,
 *   capped: boolean,
 *   files: { id: string, name?: string, mimeType?: string, path?: string, webViewLink?: string, modifiedTime?: string, size?: string }[],
 * }} manifest
 */
function buildMarkdown(manifest, customerMarkers, submissionMarkers) {
  const lines = [];
  lines.push("# Индекс архива тендеров для контекста Лены");
  lines.push("");
  lines.push(`Сгенерировано (UTC): \`${manifest.scannedAt}\``);
  lines.push(`Корень на Drive: **${manifest.rootName ?? "?"}** (\`${manifest.rootFolderId}\`)`);
  lines.push(`Файлов в индексе: **${manifest.fileCount}**${manifest.capped ? " (достигнут лимит maxFiles)" : ""}`);
  lines.push("");
  lines.push("Классификация по **подстрокам в пути** после имени проекта:");
  lines.push(`- документация заказчика / требования: \`${customerMarkers.join("`, `")}\``);
  lines.push(`- документация для участия: \`${submissionMarkers.join("`, `")}\``);
  lines.push("");
  lines.push(
    "Переопределение: переменные `LENA_ARCHIVE_CUSTOMER_MARKERS` и `LENA_ARCHIVE_SUBMISSION_MARKERS` (списки через запятую, без пробелов внутри маркера не обязательно).",
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  /** @type {Map<string, Map<string, typeof manifest.files>>} */
  const byProject = new Map();

  for (const f of manifest.files) {
    if (!f.path) continue;
    const { project, underProject } = splitProject(f.path);
    const cat = classifyPath(underProject, customerMarkers, submissionMarkers);
    if (!byProject.has(project)) {
      byProject.set(project, new Map());
    }
    const m = byProject.get(project);
    if (!m.has(cat)) m.set(cat, []);
    m.get(cat).push(f);
  }

  const projects = [...byProject.keys()].sort((a, b) => a.localeCompare(b, "ru"));

  const sectionTitle = {
    customer: "### Документация заказчика (требования)",
    submission: "### Документация для участия",
    other: "### Прочие файлы (маркеры не сработали)",
    ambiguous: "### Неоднозначный путь (есть маркеры и заказчика, и участия)",
  };

  for (const project of projects) {
    lines.push(`## Проект: ${project}`);
    lines.push("");
    const cats = byProject.get(project);
    const order = ["customer", "submission", "ambiguous", "other"];
    for (const cat of order) {
      const files = cats?.get(cat);
      if (!files?.length) continue;
      lines.push(sectionTitle[cat]);
      lines.push("");
      for (const f of [...files].sort((x, y) => (x.path ?? "").localeCompare(y.path ?? "", "ru"))) {
        const link = f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`;
        const mime = f.mimeType ?? "";
        const size = f.size != null ? ` · ${f.size} B` : "";
        lines.push(`- **${f.name ?? f.id}** (\`${mime}\`${size})`);
        lines.push(`  - путь: \`${f.path}\``);
        lines.push(`  - [Открыть на Google Drive](${link})`);
        lines.push("");
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Сканирует папку-архив на Drive, строит Markdown-индекс по проектам и типам документов,
 * загружает файл в `_lena/context` у корня Лены.
 *
 * @param {string} archiveFolderRaw — URL или id папки архива (например «2025»)
 * @param {string} lenaUserRootRaw — URL или id **корневой** папки пользователя на Drive (внутри неё `_lena/…`)
 * @param {{
 *   maxDepth?: number,
 *   maxFiles?: number,
 *   dryRun?: boolean,
 *   localMarkdownPath?: string,
 *   onProgress?: (msg: string) => void,
 * }} [opts]
 */
export async function buildArchiveContextForLena(archiveFolderRaw, lenaUserRootRaw, opts) {
  const onProgress = opts?.onProgress ?? (() => {});
  const dryRun = opts?.dryRun === true;
  /** @type {string | undefined} */
  let sourcePath;
  const customerMarkers = markersFromEnv("LENA_ARCHIVE_CUSTOMER_MARKERS", DEFAULT_CUSTOMER_MARKERS);
  const submissionMarkers = markersFromEnv("LENA_ARCHIVE_SUBMISSION_MARKERS", DEFAULT_SUBMISSION_MARKERS);

  const userRootId = resolveDriveId(lenaUserRootRaw);
  let layout = await resolveLayoutIds(userRootId);
  if (!layout.contextId) {
    onProgress("нет _lena/context — создаю дерево workspace…");
    const ensured = await ensureLenaTree(userRootId);
    layout = ensured.layout;
  }
  if (!layout.contextId) {
    throw new Error("Не удалось получить папку _lena/context после ensureLenaTree");
  }

  onProgress("строю манифест архива (только метаданные)…");
  const manifest = await buildDriveFolderManifest(archiveFolderRaw, {
    maxDepth: opts?.maxDepth,
    maxFiles: opts?.maxFiles,
    onProgress: (m) => onProgress(m),
  });

  const md = buildMarkdown(manifest, customerMarkers, submissionMarkers);
  const safeRoot = (manifest.rootName ?? "archive").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
  const destName = `archive-context-${safeRoot}-${manifest.scannedAt.slice(0, 10)}.md`;

  const persistLocal = Boolean(opts?.localMarkdownPath?.trim());
  if (persistLocal) {
    sourcePath = /** @type {string} */ (opts.localMarkdownPath?.trim());
    await writeFile(sourcePath, md, "utf8");
    onProgress(`Markdown записан локально: ${sourcePath}`);
  } else {
    sourcePath = join(tmpdir(), `lena-archive-context-${process.pid}-${Date.now()}.md`);
    await writeFile(sourcePath, md, "utf8");
  }

  const byProject = new Set();
  for (const f of manifest.files) {
    if (f.path) byProject.add(splitProject(f.path).project);
  }

  /** @type {{ id: string, name?: string, webViewLink?: string, mimeType?: string } | null} */
  let uploadedFile = null;
  /** @type {string | null} */
  let uploadBlockedDetail = null;
  /** @type {string | null} */
  let localArtifactPath = persistLocal || dryRun ? sourcePath : null;

  try {
    if (!dryRun) {
      onProgress(`загружаю в _lena/context как «${destName}»…`);
      try {
        uploadedFile = await uploadFile(layout.contextId, sourcePath, destName);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!isServiceAccountMyDriveUploadBlocked(msg)) throw e;
        uploadBlockedDetail = msg.slice(0, 1200);
        onProgress(
          "загрузка на «Мой диск» отклонена (у сервисного аккаунта нет квоты). Сохраняю индекс локально в папку проекта…",
        );
        if (!persistLocal) {
          const fallbackPath = join(process.cwd(), destName);
          await writeFile(fallbackPath, md, "utf8");
          try {
            await unlink(/** @type {string} */ (sourcePath));
          } catch {
            /* ignore */
          }
          localArtifactPath = fallbackPath;
        } else {
          localArtifactPath = sourcePath;
        }
      }
    } else {
      onProgress("dry-run: загрузка на Drive пропущена");
    }

    const deleteTempAfterSuccessfulUpload = !persistLocal && !dryRun && uploadedFile != null;
    if (deleteTempAfterSuccessfulUpload) {
      await unlink(/** @type {string} */ (sourcePath));
      localArtifactPath = null;
    }

    /** @type {string | undefined} */
    let hint;
    if (dryRun) {
      hint =
        "Файл индекса на диске (см. localMarkdownPath), загрузите вручную или повторите без LENA_ARCHIVE_CONTEXT_DRY=1";
    } else if (uploadBlockedDetail) {
      hint =
        "Сервисный аккаунт не может создавать новые файлы в личном «Мой диск». Варианты: (1) перенести _lena в общий диск Google Workspace и дать аккаунту роль «Менеджер контента»; (2) вручную загрузить файл из localMarkdownPath в _lena/context; (3) OAuth под вашим пользователем вместо SA.";
    } else if (persistLocal) {
      hint = "Локальная копия сохранена по указанному пути; на Drive загружен тот же контент.";
    }

    return {
      ok: true,
      dryRun,
      destName,
      contextFolderId: layout.contextId,
      uploadedFile,
      uploadSkippedDueToServiceAccountQuota: Boolean(uploadBlockedDetail),
      uploadBlockedDetail: uploadBlockedDetail ?? undefined,
      localMarkdownPath: localArtifactPath,
      manifestSummary: {
        rootFolderId: manifest.rootFolderId,
        rootName: manifest.rootName,
        fileCount: manifest.fileCount,
        capped: manifest.capped,
        projectCount: byProject.size,
      },
      hint,
    };
  } catch (e) {
    if (sourcePath && !persistLocal) {
      try {
        await unlink(sourcePath);
      } catch {
        /* ignore */
      }
    }
    throw e;
  }
}
