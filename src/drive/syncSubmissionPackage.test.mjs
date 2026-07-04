import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { driveFolderWebLink } from "./ops.js";

describe("syncSubmissionPackage helpers", () => {
  it("driveFolderWebLink builds submission folder URL", () => {
    const link = driveFolderWebLink("abc123submission");
    assert.match(link, /abc123submission/);
    assert.match(link, /^https:\/\/drive\.google\.com/);
  });
});
