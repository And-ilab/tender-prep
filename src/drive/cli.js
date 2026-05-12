import { resolveDriveId } from "./ids.js";
import { updateFileName } from "./ops.js";
import {
  buildAgentDriveBundle,
  copyTemplateToTenderDrafts,
  ensureLenaTree,
  ensureTenderTree,
  listContextFiles,
  listTemplateFiles,
  pullContextToLocal,
  resolveLayoutIds,
} from "./workspace.js";
import { downloadFile, getMetadata, listChildren, uploadFile } from "./ops.js";

function usage() {
  console.error(
    [
      "lena drive — Google Drive для «Лены» (Node 20+, JSON сервисного аккаунта, без npm-зависимостей)",
      "",
      "Низкоуровневые:",
      "  drive list <folderUrlOrId>",
      "  drive meta <fileUrlOrId>",
      "  drive download <fileUrlOrId> <outPath>",
      "  drive upload <folderUrlOrId> <localPath> [имяНаДиске]",
      "",
      "Рабочее пространство (_lena/ внутри вашей корневой папки на Диске):",
      "  drive workspace-ensure <rootFolderUrlOrId>     — создать _lena/{templates,context,tenders}",
      "  drive workspace-layout <rootFolderUrlOrId>   — показать id папок (без создания)",
      "  drive workspace-tender <root> <tenderId>     — папка тендера + inputs/drafts/exports",
      "",
      "Шаблоны и контекст:",
      "  drive templates-list <root>                  — файлы в _lena/templates",
      "  drive context-list <root>                    — файлы в _lena/context (общий контекст)",
      "  drive context-pull <root> <localDir>         — скачать контекст локально (txt/csv/бинарники)",
      "  drive template-copy <root> <templateFileId> <tenderId> [новоеИмя]",
      "",
      "Прочее:",
      "  drive item-rename <fileOrFolderId> <новоеИмя>",
      "  drive agent-bundle <root> [tenderId]         — JSON для агента: папки, шаблоны, контекст",
      "",
      "Переменные: GOOGLE_DRIVE_CREDENTIALS или GOOGLE_APPLICATION_CREDENTIALS — путь к JSON ключу.",
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
  const [cmd, a, b, c, d] = args;
  if (!cmd) {
    usage();
    return;
  }

  try {
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
        const out = await ensureTenderTree(root, b);
        console.log(JSON.stringify({ ok: true, ...out }, null, 2));
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
        const out = await copyTemplateToTenderDrafts(root, templateId, c, d);
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
        const bundle = await buildAgentDriveBundle(root, b);
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
