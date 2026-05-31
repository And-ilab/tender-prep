import { resolve } from "node:path";
import { runOAuthLoginInteractive } from "./userOAuth.js";
import { resolveDriveId } from "./ids.js";
import { updateFileName } from "./ops.js";
import {
  buildAgentDriveBundle,
  buildDriveFolderManifest,
  copyTemplateToTenderDrafts,
  ensureLenaTree,
  ensureTenderTree,
  inventoryTendersOnDrive,
  listContextFiles,
  listLibraryFiles,
  listFoundingDocsFiles,
  listOrgDocsFiles,
  listTemplateFiles,
  pullContextToLocal,
  pullDriveFolderTreeToLocal,
  resolveLayoutIds,
} from "./workspace.js";
import { downloadFile, getMetadata, listChildren, uploadFile } from "./ops.js";

function usage() {
  console.error(
    [
      "lena drive — Google Drive для «Лены» (Node 20+; сервисный аккаунт **или** OAuth личного аккаунта)",
      "",
      "OAuth (личный Google, без Workspace):",
      "  drive oauth-login <client_secret.json> <token_out.json>",
      "    — браузер, один раз; token_out.json не коммитить. Переменные: GOOGLE_DRIVE_OAUTH_CLIENT, GOOGLE_DRIVE_OAUTH_TOKEN.",
      "    — см. docs/GOOGLE_DRIVE_OAUTH.md",
      "",
      "Низкоуровневые:",
      "  drive list <folderUrlOrId>",
      "  drive meta <fileUrlOrId>",
      "  drive download <fileUrlOrId> <outPath>",
      "  drive upload <folderUrlOrId> <localPath> [имяНаДиске]",
      "",
      "Рабочее пространство (_lena/ внутри вашей корневой папки на Диске):",
      "  drive workspace-ensure <rootFolderUrlOrId>     — создать _lena и подпапки компаний gs-retail, finselvat в templates, org-docs, founding-docs",
      "  drive workspace-layout <rootFolderUrlOrId>   — показать id папок (без создания)",
      "  drive workspace-tender <root> <tenderId> [ГГГГ|flat] — по умолчанию год = текущий (или LENA_DEFAULT_TENDER_YEAR); flat — путь без года",
      "  drive tenders-inventory <root>               — сводка всех папок тендеров: год, имя, число файлов в inputs/drafts/…",
      "  drive corpus-manifest <folderUrlOrId> [maxDepth] [maxFiles] — рекурсивно все файлы под папкой (только метаданные; для архива 2025 и т.д.)",
      "  drive corpus-pull <folderUrlOrId> <локальнаяПапка> [maxDepth] [maxFiles] — рекурсивная выгрузка файлов (архив → диск; Docs→txt, Sheets→csv)",
      "  drive corpus-jsonl <folderUrlOrId> [maxDepth] [maxFiles] — все файлы в stdout по одному JSON на строку (очередь для parserit / массового парсинга)",
      "  drive archive-context-build <archiveFolderUrl> <lenaRootUrl> [maxDepth] [maxFiles] — скан архива → Markdown-индекс → загрузка в _lena/context (при 403 квоты SA файл пишется в cwd см. JSON)",
      "",
      "Шаблоны, справочники, контекст:",
      "  drive templates-list <root>                  — файлы в _lena/templates",
      "  drive library-list <root>                    — файлы в _lena/library (регламенты, справочники)",
      "  drive org-docs-list <root>                   — файлы в _lena/org-docs (универсальные документы на все тендеры)",
      "  drive founding-docs-list <root>              — файлы в _lena/founding-docs (учредительные и редко меняющиеся)",
      "  drive context-list <root>                    — файлы в _lena/context",
      "  drive context-pull <root> <localDir>         — скачать контекст локально (txt/csv/бинарники)",
      "  drive template-copy <root> <templateFileId> <tenderId> [flat|ГГГГ|новоеИмя] [новоеИмя]",
      "",
      "Прочее:",
      "  drive item-rename <fileOrFolderId> <новоеИмя>",
      "  drive agent-bundle <root> [tenderId] [ГГГГ|flat]   — JSON для агента",
      "",
      "Переменные: GOOGLE_DRIVE_CREDENTIALS (SA) **или** GOOGLE_DRIVE_OAUTH_CLIENT + GOOGLE_DRIVE_OAUTH_TOKEN (личный аккаунт); опционально LENA_DEFAULT_TENDER_YEAR, LENA_EXTRA_CONTEXT_FOLDERS.",
      "Для archive-context-build: LENA_ARCHIVE_CONTEXT_DRY=1 (без загрузки), LENA_ARCHIVE_CONTEXT_OUT=путь\\к\\файлу.md (сохранить копию локально), LENA_ARCHIVE_CUSTOMER_MARKERS / LENA_ARCHIVE_SUBMISSION_MARKERS — подстроки для классификации путей (через запятую).",
      "См. docs/GOOGLE_DRIVE.md",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}

/**
 * @param {string[]} args — аргументы после слова `drive`
 */
export async function runDrive(args) {
  const [cmd, a, b, c, d, e] = args;
  if (!cmd) {
    usage();
    return;
  }

  try {
    if (cmd === "oauth-login") {
      const client =
        a?.trim() ||
        process.env.GOOGLE_DRIVE_OAUTH_CLIENT?.trim() ||
        "";
      const token =
        b?.trim() ||
        process.env.GOOGLE_DRIVE_OAUTH_TOKEN?.trim() ||
        "";
      if (!client || !token) {
        console.error(
          [
            "Нужны пути к JSON OAuth-клиента и к выходному файлу токена:",
            "  node src/cli.js drive oauth-login C:\\secrets\\client.json C:\\secrets\\user-token.json",
            "или задайте GOOGLE_DRIVE_OAUTH_CLIENT и GOOGLE_DRIVE_OAUTH_TOKEN.",
            "См. docs/GOOGLE_DRIVE_OAUTH.md",
          ].join("\n"),
        );
        process.exitCode = 1;
        return;
      }
      await runOAuthLoginInteractive(resolve(client), resolve(token));
      return;
    }

    if (cmd === "list") {
      if (!a) usage();
      else {
        const id = resolveDriveId(a);
        const files = await listChildren(id);
        console.log(JSON.stringify({ folderId: id, count: files.length, files }, null, 2));
      }
      return;
    }

    if (cmd === "meta") {
      if (!a) usage();
      else {
        const id = resolveDriveId(a);
        const meta = await getMetadata(id);
        console.log(JSON.stringify(meta, null, 2));
      }
      return;
    }

    if (cmd === "download") {
      if (!a || !b) usage();
      else {
        const id = resolveDriveId(a);
        await downloadFile(id, b);
        console.error(`Скачано: ${b} (id=${id})`);
      }
      return;
    }

    if (cmd === "upload") {
      if (!a || !b) usage();
      else {
        const folderId = resolveDriveId(a);
        const data = await uploadFile(folderId, b, c);
        console.log(JSON.stringify({ ok: true, file: data }, null, 2));
      }
      return;
    }

    if (cmd === "workspace-ensure") {
      if (!a) usage();
      else {
        const root = resolveDriveId(a);
        const { layout, created } = await ensureLenaTree(root);
        console.log(JSON.stringify({ ok: true, layout, createdFolders: created }, null, 2));
      }
      return;
    }

    if (cmd === "workspace-layout") {
      if (!a) usage();
      else {
        const root = resolveDriveId(a);
        const layout = await resolveLayoutIds(root);
        console.log(JSON.stringify({ ok: true, layout }, null, 2));
      }
      return;
    }

    if (cmd === "workspace-tender") {
      if (!a || !b) usage();
      else {
        const root = resolveDriveId(a);
        const flat = c && c.trim().toLowerCase() === "flat";
        const year = !flat && c && /^\d{4}$/.test(c.trim()) ? c.trim() : undefined;
        const out = await ensureTenderTree(root, b, { flat, year });
        console.log(JSON.stringify({ ok: true, ...out }, null, 2));
      }
      return;
    }

    if (cmd === "tenders-inventory") {
      if (!a) usage();
      else {
        const root = resolveDriveId(a);
        const inv = await inventoryTendersOnDrive(root);
        console.log(JSON.stringify({ ok: true, ...inv, tenderCount: inv.entries.length }, null, 2));
      }
      return;
    }

    if (cmd === "corpus-manifest") {
      if (!a) usage();
      else {
        const maxDepth = b && /^\d+$/.test(b.trim()) ? Number.parseInt(b.trim(), 10) : undefined;
        const maxFiles = c && /^\d+$/.test(c.trim()) ? Number.parseInt(c.trim(), 10) : undefined;
        const onProgress = (msg) => console.error(`[corpus] ${msg}`);
        const m = await buildDriveFolderManifest(a, {
          maxDepth: maxDepth !== undefined && !Number.isNaN(maxDepth) ? maxDepth : undefined,
          maxFiles: maxFiles !== undefined && !Number.isNaN(maxFiles) ? maxFiles : undefined,
          onProgress,
        });
        console.log(JSON.stringify({ ok: true, ...m }, null, 2));
      }
      return;
    }

    if (cmd === "corpus-pull") {
      if (!a || !b) usage();
      else {
        const maxDepth = c && /^\d+$/.test(c.trim()) ? Number.parseInt(c.trim(), 10) : undefined;
        const maxFiles = d && /^\d+$/.test(d.trim()) ? Number.parseInt(d.trim(), 10) : undefined;
        const onProgress = (msg) => console.error(`[corpus] ${msg}`);
        const out = await pullDriveFolderTreeToLocal(a, b, {
          maxDepth: maxDepth !== undefined && !Number.isNaN(maxDepth) ? maxDepth : undefined,
          maxFiles: maxFiles !== undefined && !Number.isNaN(maxFiles) ? maxFiles : undefined,
          onProgress,
        });
        console.log(JSON.stringify(out, null, 2));
      }
      return;
    }

    if (cmd === "corpus-jsonl") {
      if (!a) usage();
      else {
        const maxDepth = b && /^\d+$/.test(b.trim()) ? Number.parseInt(b.trim(), 10) : undefined;
        const maxFiles = c && /^\d+$/.test(c.trim()) ? Number.parseInt(c.trim(), 10) : undefined;
        const onProgress = (msg) => console.error(`[corpus] ${msg}`);
        const m = await buildDriveFolderManifest(a, {
          maxDepth: maxDepth !== undefined && !Number.isNaN(maxDepth) ? maxDepth : undefined,
          maxFiles: maxFiles !== undefined && !Number.isNaN(maxFiles) ? maxFiles : undefined,
          onProgress,
        });
        for (const f of m.files) {
          const line = {
            driveFileId: f.id,
            mimeType: f.mimeType,
            path: f.path,
            webViewLink: f.webViewLink ?? null,
            documentUrl: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
          };
          console.log(JSON.stringify(line));
        }
        console.error(`[corpus] jsonl: строк ${m.files.length}${m.capped ? " (достигнут maxFiles)" : ""}`);
      }
      return;
    }

    if (cmd === "archive-context-build") {
      if (!a || !b) usage();
      else {
        const maxDepth = c && /^\d+$/.test(c.trim()) ? Number.parseInt(c.trim(), 10) : undefined;
        const maxFiles = d && /^\d+$/.test(d.trim()) ? Number.parseInt(d.trim(), 10) : undefined;
        const dryRun = process.env.LENA_ARCHIVE_CONTEXT_DRY === "1";
        const localOut = process.env.LENA_ARCHIVE_CONTEXT_OUT?.trim() || undefined;
        const onProgress = (msg) => console.error(`[archive-context] ${msg}`);
        const { buildArchiveContextForLena } = await import("./archiveContext.js");
        const out = await buildArchiveContextForLena(a, b, {
          maxDepth: maxDepth !== undefined && !Number.isNaN(maxDepth) ? maxDepth : undefined,
          maxFiles: maxFiles !== undefined && !Number.isNaN(maxFiles) ? maxFiles : undefined,
          dryRun,
          localMarkdownPath: localOut,
          onProgress,
        });
        console.log(JSON.stringify(out, null, 2));
      }
      return;
    }

    if (cmd === "templates-list") {
      if (!a) usage();
      else {
        const root = resolveDriveId(a);
        const data = await listTemplateFiles(root);
        console.log(JSON.stringify({ ok: true, ...data }, null, 2));
      }
      return;
    }

    if (cmd === "library-list") {
      if (!a) usage();
      else {
        const root = resolveDriveId(a);
        const data = await listLibraryFiles(root);
        console.log(JSON.stringify({ ok: true, ...data }, null, 2));
      }
      return;
    }

    if (cmd === "org-docs-list") {
      if (!a) usage();
      else {
        const root = resolveDriveId(a);
        const data = await listOrgDocsFiles(root);
        console.log(JSON.stringify({ ok: true, ...data }, null, 2));
      }
      return;
    }

    if (cmd === "founding-docs-list") {
      if (!a) usage();
      else {
        const root = resolveDriveId(a);
        const data = await listFoundingDocsFiles(root);
        console.log(JSON.stringify({ ok: true, ...data }, null, 2));
      }
      return;
    }

    if (cmd === "context-list") {
      if (!a) usage();
      else {
        const root = resolveDriveId(a);
        const data = await listContextFiles(root);
        console.log(JSON.stringify({ ok: true, ...data }, null, 2));
      }
      return;
    }

    if (cmd === "context-pull") {
      if (!a || !b) usage();
      else {
        const root = resolveDriveId(a);
        const data = await pullContextToLocal(root, b);
        console.log(JSON.stringify({ ok: true, ...data }, null, 2));
      }
      return;
    }

    if (cmd === "template-copy") {
      if (!a || !b || !c) usage();
      else {
        const root = resolveDriveId(a);
        const templateId = resolveDriveId(b);
        const tenderId = c;
        let flat = false;
        /** @type {string | undefined} */
        let year;
        /** @type {string | undefined} */
        let newName;
        if (d) {
          if (d.trim().toLowerCase() === "flat") {
            flat = true;
            newName = e?.trim() || undefined;
          } else if (/^\d{4}$/.test(d.trim())) {
            year = d.trim();
            newName = e?.trim() || undefined;
          } else {
            newName = d.trim();
          }
        }
        const out = await copyTemplateToTenderDrafts(root, templateId, tenderId, { flat, year, newName });
        console.log(JSON.stringify({ ok: true, ...out }, null, 2));
      }
      return;
    }

    if (cmd === "item-rename") {
      if (!a || !b) usage();
      else {
        const id = resolveDriveId(a);
        const meta = await updateFileName(id, b);
        console.log(JSON.stringify({ ok: true, file: meta }, null, 2));
      }
      return;
    }

    if (cmd === "agent-bundle") {
      if (!a) usage();
      else {
        const root = resolveDriveId(a);
        const flat = c && c.trim().toLowerCase() === "flat";
        const year = !flat && c && /^\d{4}$/.test(c.trim()) ? c.trim() : undefined;
        const bundle = await buildAgentDriveBundle(root, b, { flat, year });
        console.log(JSON.stringify({ ok: true, bundle }, null, 2));
      }
      return;
    }

    usage();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    process.exitCode = 1;
  }
}
