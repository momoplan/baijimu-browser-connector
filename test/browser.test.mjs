import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserController, discoverBrowserExecutable } from "../src/browser.mjs";

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

test("persistent Chromium opens authorized pages and rejects other origins", { timeout: 30_000 }, async (context) => {
  let executablePath;
  try {
    executablePath = discoverBrowserExecutable();
  } catch {
    context.skip("Chrome, Edge, or Chromium is not installed on this test host");
    return;
  }
  let deniedRequests = 0;
  const deniedServer = await listen((request, response) => {
    deniedRequests += 1;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Denied</title>");
  });
  const deniedOrigin = `http://127.0.0.1:${deniedServer.address().port}`;
  const allowedServer = await listen((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Authorized</title><main><button>Continue</button><a id="leave" href="${deniedOrigin}/blocked">Leave</a></main>`);
  });
  const allowedOrigin = `http://127.0.0.1:${allowedServer.address().port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-connector-playwright-"));
  const authorization = {
    allowedOrigins: [allowedOrigin],
    browserExecutablePath: executablePath,
    headless: true,
  };
  const controller = new BrowserController(
    { dataDir, profileDir: path.join(dataDir, "profile") },
    () => authorization,
  );
  context.after(async () => {
    await controller.stop();
    allowedServer.closeAllConnections();
    deniedServer.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => allowedServer.close(resolve)),
      new Promise((resolve) => deniedServer.close(resolve)),
    ]);
  });

  const opened = await controller.openPage(`${allowedOrigin}/home`);
  assert.equal(opened.title, "Authorized");
  assert.match((await controller.snapshot(opened.pageId)).snapshot, /Continue/);
  await assert.rejects(() => controller.navigate(opened.pageId, `${deniedOrigin}/blocked`), /not authorized/);
  await controller.click(opened.pageId, "#leave").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(deniedRequests, 0);
  assert.equal((await controller.listPages()).some((page) => page.url.startsWith(deniedOrigin)), false);
});
