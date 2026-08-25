import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isAuthorizedUrl,
  normalizeAuthorization,
  normalizeOrigin,
  requireRuntimeEnvironment,
  saveAuthorization,
} from "../src/config.mjs";

test("runtime identity and private paths come from the host environment", () => {
  const runtime = requireRuntimeEnvironment({
    BAIJIMU_LOCAL_APP_ID: "server-app-id",
    BAIJIMU_LOCAL_APP_DATA_DIR: "/tmp/browser-connector-test",
    BAIJIMU_LOCAL_APP_TOKEN_FILE: "/tmp/browser-connector-test/private-token",
    BAIJIMU_BROWSER_CONNECTOR_PORT: "18440",
  });
  assert.equal(runtime.appId, "server-app-id");
  assert.equal(runtime.tokenPath, "/tmp/browser-connector-test/private-token");
});

test("origin authorization is exact and only permits loopback plain HTTP", () => {
  assert.equal(normalizeOrigin("https://Example.com"), "https://example.com");
  assert.equal(normalizeOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.throws(() => normalizeOrigin("http://example.com"), /loopback/);
  assert.throws(() => normalizeOrigin("https://example.com/path"), /exact origins/);
  const authorization = normalizeAuthorization({ allowedOrigins: ["https://example.com"] });
  assert.equal(isAuthorizedUrl("https://example.com/a", authorization), true);
  assert.equal(isAuthorizedUrl("https://other.example.com/a", authorization), false);
});

test("authorization is stored atomically in the private data directory", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-connector-config-"));
  const runtime = { dataDir, authorizationPath: path.join(dataDir, "authorization.json") };
  const result = saveAuthorization(runtime, {
    allowedOrigins: ["https://b.example", "https://a.example", "https://a.example"],
    browserExecutablePath: null,
    headless: true,
  });
  assert.deepEqual(result.allowedOrigins, ["https://a.example", "https://b.example"]);
  assert.equal(fs.statSync(runtime.authorizationPath).mode & 0o077, 0);
});
