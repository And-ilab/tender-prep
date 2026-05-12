/**
 * Возвращает сырой id или извлекает из URL Диска/Docs/Sheets.
 * @param {string} input
 * @returns {string}
 */
export function resolveDriveId(input) {
  const s = input.trim();
  if (!/[:/]/.test(s) && /^[-A-Za-z0-9_]+$/.test(s) && s.length >= 10) {
    return s;
  }
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./, "");

    if (host === "drive.google.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0] === "drive" && parts[1] === "folders" && parts[2]) {
        return parts[2];
      }
      if (parts[0] === "file" && parts[1] === "d" && parts[2]) {
        return parts[2];
      }
      const id = u.searchParams.get("id");
      if (id) return id;
    }

    if (host === "docs.google.com" || host === "spreadsheets.google.com" || host === "presentation.google.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      const d = parts.indexOf("d");
      if (d >= 0 && parts[d + 1]) {
        return parts[d + 1];
      }
    }
  } catch {
    // not a URL
  }

  throw new Error(
    `Не удалось распознать id Диска: ${input}. Укажите id из ссылки или полный https://…`,
  );
}
