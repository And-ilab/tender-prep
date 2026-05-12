import { resolveDriveId } from "./ids.js";
import { downloadFile, getMetadata, listChildren, uploadFile } from "./ops.js";

function usage() {
  console.error(
    [
      "lena drive — Google Drive (нужен npm install и JSON сервисного аккаунта)",
      "",
      "  node src/cli.js drive list <folderUrlOrId>              — список файлов в папке",
      "  node src/cli.js drive meta <fileUrlOrId>                — метаданные файла/папки (JSON)",
      "  node src/cli.js drive download <fileUrlOrId> <outPath>  — скачать бинарник/экспорт",
      "  node src/cli.js drive upload <folderUrlOrId> <localPath> [имяНаДиске]",
      "",
      "Переменные: GOOGLE_DRIVE_CREDENTIALS или GOOGLE_APPLICATION_CREDENTIALS — путь к JSON ключу.",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}

/**
 * @param {string[]} args — аргументы после слова `drive`
 */
export async function runDrive(args) {
  const [sub, a, b, c] = args;
  if (!sub) {
    usage();
    return;
  }

  try {
    if (sub === "list") {
      if (!a) usage();
      else {
        const id = resolveDriveId(a);
        const files = await listChildren(id);
        console.log(JSON.stringify({ folderId: id, count: files.length, files }, null, 2));
      }
      return;
    }

    if (sub === "meta") {
      if (!a) usage();
      else {
        const id = resolveDriveId(a);
        const meta = await getMetadata(id);
        console.log(JSON.stringify(meta, null, 2));
      }
      return;
    }

    if (sub === "download") {
      if (!a || !b) usage();
      else {
        const id = resolveDriveId(a);
        await downloadFile(id, b);
        console.error(`Скачано: ${b} (id=${id})`);
      }
      return;
    }

    if (sub === "upload") {
      if (!a || !b) usage();
      else {
        const folderId = resolveDriveId(a);
        const data = await uploadFile(folderId, b, c);
        console.log(JSON.stringify({ ok: true, file: data }, null, 2));
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
