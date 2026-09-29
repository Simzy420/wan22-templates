import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { errorMessage } from "../server/gradioProxy.js";
import { IDLE_TIMEOUT_MESSAGE, publicErrorText } from "../server/gatewayError.js";

const PAGE = `<!DOCTYPE html><html><head><title>Inactivity Timeout</title></head><body>
<h1>Inactivity Timeout</h1>
<p>Description: Too much time has passed without sending any data for document.</p>
</body></html>`;

describe("gateway timeout pages", () => {
  it("replaces the Netlify inactivity HTML with a sentence", () => {
    const text = publicErrorText(PAGE);
    assert.equal(text, IDLE_TIMEOUT_MESSAGE);
    assert.doesNotMatch(text, /<|Inactivity Timeout/);
  });

  it("keeps a normal Space error", () => {
    const text = publicErrorText("ZeroGPU quota exceeded");
    assert.equal(text, "ZeroGPU quota exceeded");
  });

  it("json errors from the proxy use the same sentence", () => {
    assert.equal(errorMessage(new Error(PAGE)), IDLE_TIMEOUT_MESSAGE);
    assert.match(errorMessage(new Error("Upload a still photo of the person who should do this motion.")), /still photo/);
  });
});
