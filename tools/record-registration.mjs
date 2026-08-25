import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const responsePath = process.argv[2];
if (!responsePath) throw new Error("usage: npm run record-registration -- <server-response.json>");
const response = JSON.parse(fs.readFileSync(path.resolve(responsePath), "utf8"));
const app = response.data?.app || response.data || response.app || response;
const appId = app.appId || app.id;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(appId || "")) {
  throw new Error("registration response does not contain a server-allocated UUID appId");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "release", "local-app.json");
if (fs.existsSync(catalogPath)) {
  const existing = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  if (existing.appId !== appId) throw new Error("refusing to replace the recorded appId");
}
fs.writeFileSync(catalogPath, `${JSON.stringify({ schemaVersion: "1.0.0", appId }, null, 2)}\n`);
await import("./materialize-manifest.mjs");
