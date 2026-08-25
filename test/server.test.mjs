import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveAuthorization } from "../src/config.mjs";
import { createBrowserConnectorService } from "../src/server.mjs";

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-connector-server-"));
  const runtime = {
    appId: "server-app-id",
    dataDir,
    port: 0,
    profileDir: path.join(dataDir, "browser-profile"),
    authorizationPath: path.join(dataDir, "authorization.json"),
    tokenPath: path.join(dataDir, "management-token"),
  };
  saveAuthorization(runtime, { allowedOrigins: ["https://example.com"] });
  const calls = [];
  const controller = {
    status: () => ({ running: false, pageCount: 0, profilePersistence: "local" }),
    listPages: async () => [],
    openPage: async (url) => (calls.push(["openPage", url]), { pageId: "page-1", url }),
    navigate: async () => ({}),
    snapshot: async () => ({}),
    click: async () => ({}),
    fill: async () => ({}),
    press: async () => ({}),
    screenshot: async () => ({}),
    closePage: async () => ({}),
    launch: async () => ({ running: true }),
    stop: async () => (calls.push(["stop"]), { running: false }),
  };
  return { runtime, controller, calls };
}

test("all local endpoints require the host-issued bearer token", async (context) => {
  const { runtime, controller } = fixture();
  const token = "bjm_app_abcdefghijklmnopqrstuvwxyz0123456789";
  const service = createBrowserConnectorService(runtime, { controller, token });
  await service.listen();
  context.after(() => service.shutdown());
  const port = service.address().port;
  const unauthorized = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`http://127.0.0.1:${port}/healthz`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).data.appId, "server-app-id");
});

test("invoke routes validate strict payloads and use the CModel envelope", async (context) => {
  const { runtime, controller, calls } = fixture();
  const token = "bjm_app_abcdefghijklmnopqrstuvwxyz0123456789";
  const service = createBrowserConnectorService(runtime, { controller, token });
  await service.listen();
  context.after(() => service.shutdown());
  const port = service.address().port;
  const invoke = (body) => fetch(`http://127.0.0.1:${port}/invoke/openPage`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await invoke({ url: "https://example.com/path" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).errorCode, "0");
  assert.deepEqual(calls[0], ["openPage", "https://example.com/path"]);
  const rejected = await invoke({ url: "https://example.com", unexpected: true });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).errorCode, "BROWSER_OPERATION_FAILED");
});

test("saving authorization closes the browser before replacing local policy", async (context) => {
  const { runtime, controller, calls } = fixture();
  const token = "bjm_app_abcdefghijklmnopqrstuvwxyz0123456789";
  const service = createBrowserConnectorService(runtime, { controller, token });
  await service.listen();
  context.after(() => service.shutdown());
  const port = service.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/management/v1/authorization`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ allowedOrigins: ["https://new.example"], headless: true }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], ["stop"]);
  assert.deepEqual((await response.json()).data.authorization.allowedOrigins, ["https://new.example"]);
});
