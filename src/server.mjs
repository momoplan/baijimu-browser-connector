import crypto from "node:crypto";
import http from "node:http";
import { BrowserController } from "./browser.mjs";
import {
  loadAuthorization,
  readLocalAppToken,
  requireRuntimeEnvironment,
  saveAuthorization,
} from "./config.mjs";

const MAX_BODY_BYTES = 256 * 1024;

function timingSafeTextEqual(left, right) {
  const leftBytes = Buffer.from(String(left));
  const rightBytes = Buffer.from(String(right));
  if (leftBytes.length !== rightBytes.length) return false;
  return crypto.timingSafeEqual(leftBytes, rightBytes);
}

function requireObject(value, label = "request") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`unsupported request fields: ${unknown.join(", ")}`);
}

function requireString(value, name, maximum = 10_000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`${name} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return requireObject(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

function sendJson(response, statusCode, document) {
  const body = Buffer.from(`${JSON.stringify(document)}\n`);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function invokeSuccess(data) {
  return { errorCode: "0", value: "成功", data };
}

function managementSuccess(data) {
  return { ok: true, data };
}

function failure(error) {
  const message = error instanceof Error ? error.message : String(error || "operation failed");
  return { message };
}

function parsePageRequest(input, extras = []) {
  const value = requireObject(input);
  rejectUnknownKeys(value, ["pageId", ...extras]);
  return { ...value, pageId: requireString(value.pageId, "pageId", 128) };
}

export function createBrowserConnectorService(runtime, options = {}) {
  let authorization = loadAuthorization(runtime);
  const controller =
    options.controller || new BrowserController(runtime, () => authorization);
  const token = options.token || readLocalAppToken(runtime);
  let server;
  let shutdownPromise;

  const methods = {
    async status(input) {
      const value = requireObject(input);
      rejectUnknownKeys(value, []);
      return controller.status();
    },
    async listPages(input) {
      const value = requireObject(input);
      rejectUnknownKeys(value, []);
      return { pages: await controller.listPages() };
    },
    async openPage(input) {
      const value = requireObject(input);
      rejectUnknownKeys(value, ["url"]);
      return controller.openPage(requireString(value.url, "url", 8_192));
    },
    async navigate(input) {
      const value = parsePageRequest(input, ["url"]);
      return controller.navigate(value.pageId, requireString(value.url, "url", 8_192));
    },
    async snapshot(input) {
      const value = parsePageRequest(input);
      return controller.snapshot(value.pageId);
    },
    async click(input) {
      const value = parsePageRequest(input, ["selector"]);
      return controller.click(value.pageId, requireString(value.selector, "selector"));
    },
    async fill(input) {
      const value = parsePageRequest(input, ["selector", "value"]);
      if (typeof value.value !== "string" || value.value.length > 100_000) {
        throw new Error("value must be a string of at most 100000 characters");
      }
      return controller.fill(
        value.pageId,
        requireString(value.selector, "selector"),
        value.value,
      );
    },
    async press(input) {
      const value = parsePageRequest(input, ["selector", "key"]);
      return controller.press(
        value.pageId,
        requireString(value.selector, "selector"),
        requireString(value.key, "key", 128),
      );
    },
    async screenshot(input) {
      const value = parsePageRequest(input, ["fullPage"]);
      if (value.fullPage != null && typeof value.fullPage !== "boolean") {
        throw new Error("fullPage must be a boolean");
      }
      return controller.screenshot(value.pageId, value.fullPage === true);
    },
    async closePage(input) {
      const value = parsePageRequest(input);
      return controller.closePage(value.pageId);
    },
  };

  async function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      await controller.stop().catch(() => {});
      if (server?.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
    })();
    return shutdownPromise;
  }

  async function handle(request, response) {
    const requestToken = String(request.headers.authorization || "").replace(/^Bearer\s+/, "");
    if (!timingSafeTextEqual(requestToken, token)) {
      sendJson(response, 401, { ok: false, error: { message: "unauthorized" } });
      return;
    }

    const url = new URL(request.url || "/", `http://127.0.0.1:${runtime.port}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, managementSuccess({ appId: runtime.appId, ...controller.status() }));
      return;
    }

    if (request.method === "POST" && url.pathname.startsWith("/invoke/")) {
      const method = decodeURIComponent(url.pathname.slice("/invoke/".length));
      if (!Object.hasOwn(methods, method)) {
        sendJson(response, 404, { errorCode: "METHOD_NOT_FOUND", value: "未知浏览器操作", data: null });
        return;
      }
      try {
        sendJson(response, 200, invokeSuccess(await methods[method](await readJsonBody(request))));
      } catch (error) {
        sendJson(response, 400, { errorCode: "BROWSER_OPERATION_FAILED", value: failure(error).message, data: null });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/management/v1/state") {
      sendJson(
        response,
        200,
        managementSuccess({ authorization, runtime: controller.status() }),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/management/v1/authorization") {
      try {
        const input = await readJsonBody(request);
        await controller.stop();
        authorization = saveAuthorization(runtime, input);
        sendJson(response, 200, managementSuccess({ authorization, runtime: controller.status() }));
      } catch (error) {
        sendJson(response, 400, { ok: false, error: failure(error) });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/management/v1/browser/launch") {
      try {
        sendJson(response, 200, managementSuccess(await controller.launch()));
      } catch (error) {
        sendJson(response, 400, { ok: false, error: failure(error) });
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/management/v1/browser/close") {
      sendJson(response, 200, managementSuccess(await controller.stop()));
      return;
    }

    if (request.method === "POST" && url.pathname === "/management/v1/runtime/stop") {
      sendJson(response, 200, managementSuccess({ stopping: true }));
      setImmediate(() => void shutdown());
      return;
    }

    sendJson(response, 404, { ok: false, error: { message: "not found" } });
  }

  server = http.createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: failure(error) });
      else response.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(runtime.port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    shutdown,
    address: () => server.address(),
  };
}

async function requestRuntimeStop(runtime) {
  const token = readLocalAppToken(runtime);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/management/v1/runtime/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`runtime stop returned HTTP ${response.status}`);
  } catch (error) {
    if (error?.cause?.code !== "ECONNREFUSED") throw error;
  }
}

export async function main(args, env = process.env) {
  const command = args[0] || "start";
  const runtime = requireRuntimeEnvironment(env);
  if (command === "stop") {
    await requestRuntimeStop(runtime);
    return;
  }
  if (command !== "start") throw new Error(`unsupported command: ${command}`);

  const service = createBrowserConnectorService(runtime);
  await service.listen();
  process.stdout.write(`Browser Connector listening on 127.0.0.1:${runtime.port}\n`);
  const shutdown = () => void service.shutdown();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
