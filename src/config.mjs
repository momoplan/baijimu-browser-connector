import fs from "node:fs";
import path from "node:path";

const CONFIG_FILE = "authorization.json";

export function requireRuntimeEnvironment(env = process.env) {
  const appId = String(env.BAIJIMU_LOCAL_APP_ID || "").trim();
  const dataDir = String(env.BAIJIMU_LOCAL_APP_DATA_DIR || "").trim();
  const port = Number.parseInt(String(env.BAIJIMU_BROWSER_CONNECTOR_PORT || ""), 10);
  if (!appId) throw new Error("BAIJIMU_LOCAL_APP_ID is required");
  if (!dataDir || !path.isAbsolute(dataDir)) {
    throw new Error("BAIJIMU_LOCAL_APP_DATA_DIR must be an absolute path");
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("BAIJIMU_BROWSER_CONNECTOR_PORT must be an integer from 1024 to 65535");
  }
  const configuredTokenPath = String(env.BAIJIMU_LOCAL_APP_TOKEN_FILE || "").trim();
  const tokenPath = configuredTokenPath || path.join(dataDir, "management-token");
  if (!path.isAbsolute(tokenPath)) {
    throw new Error("BAIJIMU_LOCAL_APP_TOKEN_FILE must be an absolute path");
  }
  return {
    appId,
    dataDir,
    port,
    profileDir: path.join(dataDir, "browser-profile"),
    authorizationPath: path.join(dataDir, CONFIG_FILE),
    tokenPath,
  };
}

export function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("origin must be a valid absolute URL");
  }
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("only http and https origins are supported");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("plain HTTP is allowed only for loopback origins");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("authorization entries must be exact origins without credentials, paths, query, or hash");
  }
  return url.origin;
}

export function normalizeAuthorization(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("authorization must be an object");
  }
  const allowedOrigins = Array.isArray(input.allowedOrigins)
    ? [...new Set(input.allowedOrigins.map(normalizeOrigin))].sort()
    : [];
  const browserExecutablePath =
    input.browserExecutablePath == null ? null : String(input.browserExecutablePath).trim() || null;
  const headless = input.headless === true;
  return { schemaVersion: "1.0.0", allowedOrigins, browserExecutablePath, headless };
}

export function readLocalAppToken(runtime) {
  const token = fs.readFileSync(runtime.tokenPath, "utf8").trim();
  if (token.length < 32) throw new Error("local app token is invalid");
  return token;
}

export function loadAuthorization(runtime) {
  if (!fs.existsSync(runtime.authorizationPath)) {
    return normalizeAuthorization({ allowedOrigins: [], browserExecutablePath: null, headless: false });
  }
  return normalizeAuthorization(JSON.parse(fs.readFileSync(runtime.authorizationPath, "utf8")));
}

export function saveAuthorization(runtime, input) {
  const authorization = normalizeAuthorization(input);
  fs.mkdirSync(runtime.dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${runtime.authorizationPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(authorization, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, runtime.authorizationPath);
  return authorization;
}

export function isAuthorizedUrl(value, authorization) {
  try {
    return authorization.allowedOrigins.includes(new URL(value).origin);
  } catch {
    return false;
  }
}
