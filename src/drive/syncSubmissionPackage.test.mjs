import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { driveFolderWebLink } from "./ops.js";
import { resolveSharedDocShortcutTarget } from "./syncSubmissionPackage.js";

describe("syncSubmissionPackage helpers", () => {
  it("driveFolderWebLink builds submission folder URL", () => {
    const link = driveFolderWebLink("abc123submission");
    assert.match(link, /abc123submission/);
    assert.match(link, /^https:\/\/drive\.google\.com/);
  });

  it("resolveSharedDocShortcutTarget uses verify fallback when index empty", () => {
    const doc = {
      id: "state_registration_certificate",
      title: "Свидетельство о государственной регистрации",
      storage: "founding",
    };
    const target = resolveSharedDocShortcutTarget(
      doc,
      { company: "gs-retail", updatedAt: "", files: [] },
      {
        doc,
        verify: { status: "found_founding", canonicalId: doc.id, title: doc.title },
      },
      {
        foundingFiles: [{ id: "cert-1", name: "Свидетельство о гос регистрации.pdf" }],
        orgFiles: [],
        foundingIndex: new Map(),
        orgIndex: new Map(),
      },
    );
    assert.equal(target?.fileId, "cert-1");
  });

  it("resolveSharedDocShortcutTarget skips missing verify status", () => {
    const doc = {
      id: "state_registration_certificate",
      title: "Свидетельство о государственной регистрации",
      storage: "founding",
    };
    const target = resolveSharedDocShortcutTarget(
      doc,
      { company: "gs-retail", updatedAt: "", files: [] },
      {
        doc,
        verify: { status: "missing", canonicalId: doc.id, title: doc.title, note: "нет файла" },
      },
      {
        foundingFiles: [{ id: "cert-1", name: "Свидетельство.pdf" }],
        orgFiles: [],
        foundingIndex: new Map(),
        orgIndex: new Map(),
      },
    );
    assert.equal(target, null);
  });
});
