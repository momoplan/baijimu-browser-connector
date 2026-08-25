import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const marketPublisher = await readFile(
  new URL("../tools/release/publish-market.sh", import.meta.url),
  "utf8",
);
const manifest = JSON.parse(
  await readFile(new URL("../connector.template.json", import.meta.url), "utf8"),
);

test("release identity uses the registered official repository", () => {
  assert.equal(manifest.source.repo, "momoplan/baijimu-browser-connector");
});

test("market publication consumes immutable Baijimu OSS bytes", () => {
  assert.match(workflow, /public_base=https:\/\/download\.baijimu\.com/);
  assert.match(workflow, /local-app-artifacts\/browser-connector\/releases/);
  assert.match(workflow, /steps\.oss\.outputs\.artifact_url/);
  assert.doesNotMatch(workflow, /artifact_url="https:\/\/github\.com/);
  assert.doesNotMatch(workflow, /gh release upload[^\n]*--clobber/);
});

test("market publication normalizes the GitHub source to the API HTTPS contract", () => {
  assert.match(marketPublisher, /source_repo_url="https:\/\/github\.com\/\$source_repo"/);
  assert.match(marketPublisher, /--arg repo "\$source_repo_url"/);
});
