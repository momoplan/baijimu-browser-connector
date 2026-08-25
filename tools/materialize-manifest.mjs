import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(root, "release", "local-app.json");
if (!fs.existsSync(catalogPath)) {
  throw new Error("release/local-app.json is missing; register the application with the server first");
}
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(catalog.appId || "")) {
  throw new Error("release/local-app.json does not contain a server-allocated UUID appId");
}
const template = JSON.parse(fs.readFileSync(path.join(root, "connector.template.json"), "utf8"));
template.appId = catalog.appId;
fs.writeFileSync(path.join(root, "connector.json"), `${JSON.stringify(template, null, 2)}\n`);
process.stdout.write(`${catalog.appId}\n`);
