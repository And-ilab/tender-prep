import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * PDF → текст через `scripts/lena_pdf_ocr.py` (PyMuPDF + системный Tesseract).
 *
 * **LENA_PDF_OCR_PYTHON** — `0` отключает ветку Python (только Node tesseract.js).
 * **LENA_PYTHON** — команда интерпретатора (по умолчанию `python`, на Linux часто `python3`).
 */

function pythonDisabled() {
  const v = process.env.LENA_PDF_OCR_PYTHON?.trim().toLowerCase() ?? "";
  return v === "0" || v === "false" || v === "no" || v === "off";
}

function pythonCommand() {
  const p = process.env.LENA_PYTHON?.trim();
  return p || "python";
}

function scriptPath() {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return join(here, "..", "..", "scripts", "lena_pdf_ocr.py");
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<{ text: string, via?: string, error?: string }>}
 */
export async function ocrPdfBufferViaPython(buffer) {
  if (pythonDisabled()) {
    return { text: "", error: "Python-OCR отключён (LENA_PDF_OCR_PYTHON=0)" };
  }

  const pdfPath = join(tmpdir(), `lena-pdf-${process.pid}-${Date.now()}.pdf`);
  await writeFile(pdfPath, buffer);

  const py = pythonCommand();
  const script = scriptPath();

  try {
    const out = await new Promise((resolve, reject) => {
      const env = { ...process.env };
      const child = spawn(py, [script, pdfPath], {
        env,
        windowsHide: true,
      });
      /** @type {Buffer[]} */
      const chunks = [];
      /** @type {Buffer[]} */
      const errChunks = [];
      child.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
      child.stderr.on("data", (d) => errChunks.push(Buffer.from(d)));
      child.on("error", reject);
      child.on("close", (code) => {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        const errRaw = Buffer.concat(errChunks).toString("utf8").trim();
        resolve({ code: code ?? 1, raw, errRaw });
      });
    });

    if (out.errRaw && out.errRaw.length > 0) {
      /* Python пишет только JSON в stdout; stderr — предупреждения pymupdf и т.п. */
    }

    /** @type {{ text?: string; via?: string; error?: string | null }} */
    let parsed;
    try {
      parsed = JSON.parse(out.raw || "{}");
    } catch {
      return {
        text: "",
        error: `Python OCR: неверный JSON (код ${out.code}). ${(out.raw || "").slice(0, 200)}`,
      };
    }

    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    const via = typeof parsed.via === "string" ? parsed.via : undefined;
    const err = parsed.error != null && String(parsed.error).trim() ? String(parsed.error).trim() : null;

    if (out.code !== 0 && !text) {
      return {
        text: "",
        error: err || `Python OCR завершился с кодом ${out.code}`,
      };
    }

    return { text, via, error: err || undefined };
  } catch (e) {
    return {
      text: "",
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    await unlink(pdfPath).catch(() => {});
  }
}
