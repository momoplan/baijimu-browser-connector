import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { isAuthorizedUrl } from "./config.mjs";

const EXECUTABLE_CANDIDATES = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  win32: [
    ["LOCALAPPDATA", "Google/Chrome/Application/chrome.exe"],
    ["PROGRAMFILES", "Google/Chrome/Application/chrome.exe"],
    ["PROGRAMFILES(X86)", "Microsoft/Edge/Application/msedge.exe"],
  ],
  linux: ["google-chrome", "microsoft-edge", "chromium", "chromium-browser"],
};

function resolveFromPath(name, env = process.env) {
  for (const directory of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function discoverBrowserExecutable(override, env = process.env, platform = process.platform) {
  if (override) {
    const absolute = path.resolve(override);
    if (!fs.existsSync(absolute)) throw new Error("configured browser executable does not exist");
    return absolute;
  }
  const candidates = EXECUTABLE_CANDIDATES[platform] || [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const root = env[candidate[0]];
      if (!root) continue;
      const absolute = path.join(root, candidate[1]);
      if (fs.existsSync(absolute)) return absolute;
    } else if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
    } else {
      const resolved = resolveFromPath(candidate, env);
      if (resolved) return resolved;
    }
  }
  throw new Error("no supported Chrome, Edge, or Chromium executable was found");
}

export class BrowserController {
  constructor(runtime, readAuthorization) {
    this.runtime = runtime;
    this.readAuthorization = readAuthorization;
    this.context = null;
    this.pages = new Map();
    this.nextPageId = 1;
  }

  async launch() {
    if (this.context) return this.status();
    const authorization = this.readAuthorization();
    fs.mkdirSync(this.runtime.profileDir, { recursive: true, mode: 0o700 });
    const executablePath = discoverBrowserExecutable(authorization.browserExecutablePath);
    this.context = await chromium.launchPersistentContext(this.runtime.profileDir, {
      executablePath,
      headless: authorization.headless,
      acceptDownloads: false,
      viewport: null,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    await this.context.route("**/*", async (route) => {
      const request = route.request();
      if (
        request.isNavigationRequest() &&
        request.frame().parentFrame() === null &&
        !isAuthorizedUrl(request.url(), this.readAuthorization())
      ) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    this.context.on("download", (download) => void download.cancel());
    for (const page of this.context.pages()) this.registerPage(page);
    this.context.on("page", (page) => this.registerPage(page));
    return this.status();
  }

  registerPage(page) {
    const existing = [...this.pages.entries()].find(([, candidate]) => candidate === page)?.[0];
    if (existing) return existing;
    const pageId = `page-${this.nextPageId++}`;
    this.pages.set(pageId, page);
    page.on("close", () => this.pages.delete(pageId));
    page.on("framenavigated", async (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = page.url();
      if (url !== "about:blank" && !isAuthorizedUrl(url, this.readAuthorization())) {
        await page.close().catch(() => {});
      }
    });
    return pageId;
  }

  requirePage(pageId) {
    const page = this.pages.get(String(pageId || ""));
    if (!page || page.isClosed()) throw new Error("pageId does not identify an open page");
    const url = page.url();
    if (url !== "about:blank" && !isAuthorizedUrl(url, this.readAuthorization())) {
      throw new Error("page origin is not authorized");
    }
    return page;
  }

  assertTarget(url) {
    const absolute = new URL(String(url || "")).toString();
    if (!isAuthorizedUrl(absolute, this.readAuthorization())) {
      throw new Error("target origin is not authorized");
    }
    return absolute;
  }

  status() {
    return {
      running: Boolean(this.context),
      pageCount: [...this.pages.values()].filter((page) => !page.isClosed()).length,
      profilePersistence: "local",
    };
  }

  async listPages() {
    const pages = [...this.pages.entries()].filter(([, page]) => !page.isClosed());
    return Promise.all(
      pages.map(async ([pageId, page]) => ({
        pageId,
        url: page.url(),
        title: await page.title().catch(() => ""),
      })),
    );
  }

  async openPage(url) {
    await this.launch();
    const page = await this.context.newPage();
    const pageId = this.registerPage(page);
    await page.goto(this.assertTarget(url), { waitUntil: "domcontentloaded" });
    return { pageId, url: page.url(), title: await page.title() };
  }

  async navigate(pageId, url) {
    const page = this.requirePage(pageId);
    await page.goto(this.assertTarget(url), { waitUntil: "domcontentloaded" });
    return { pageId, url: page.url(), title: await page.title() };
  }

  async snapshot(pageId) {
    const page = this.requirePage(pageId);
    const snapshot = await page.locator("body").ariaSnapshot({ timeout: 10_000 });
    return { pageId, url: page.url(), title: await page.title(), snapshot: snapshot.slice(0, 200_000) };
  }

  async click(pageId, selector) {
    const page = this.requirePage(pageId);
    await page.locator(String(selector || "")).click({ timeout: 15_000 });
    if (!page.isClosed() && !isAuthorizedUrl(page.url(), this.readAuthorization())) {
      throw new Error("click navigated outside the authorized origins");
    }
    return { pageId, url: page.url() };
  }

  async fill(pageId, selector, value) {
    const page = this.requirePage(pageId);
    await page.locator(String(selector || "")).fill(String(value ?? ""), { timeout: 15_000 });
    return { pageId, url: page.url() };
  }

  async press(pageId, selector, key) {
    const page = this.requirePage(pageId);
    await page.locator(String(selector || "")).press(String(key || ""), { timeout: 15_000 });
    if (!page.isClosed() && !isAuthorizedUrl(page.url(), this.readAuthorization())) {
      throw new Error("key press navigated outside the authorized origins");
    }
    return { pageId, url: page.url() };
  }

  async screenshot(pageId, fullPage = false) {
    const page = this.requirePage(pageId);
    const bytes = await page.screenshot({ type: "png", fullPage: fullPage === true });
    if (bytes.length > 8 * 1024 * 1024) throw new Error("screenshot exceeds 8 MiB");
    return { pageId, mediaType: "image/png", data: bytes.toString("base64") };
  }

  async closePage(pageId) {
    const page = this.requirePage(pageId);
    await page.close();
    return { pageId, closed: true };
  }

  async stop() {
    if (this.context) await this.context.close();
    this.context = null;
    this.pages.clear();
    return this.status();
  }
}
