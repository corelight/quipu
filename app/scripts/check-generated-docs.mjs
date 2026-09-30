import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(appRoot, "generated", "docs");

const entries = {
  index: ["index.html"],
  quickStart: ["quick-start", "index.html"],
  workspaces: ["workspaces", "index.html"],
  writingRules: ["writing-rules", "index.html"],
  compilingAndScanning: ["compiling-and-scanning", "index.html"],
  resultsAndDiagnostics: ["results-and-diagnostics", "index.html"],
  preferencesAndCache: ["preferences-and-cache", "index.html"],
  reference: ["reference", "index.html"],
};
const loaded = await Promise.all(
  Object.entries(entries).map(async ([name, segments]) => [
    name,
    await readFile(path.join(output, ...segments), "utf8"),
  ]),
);
const pages = Object.fromEntries(loaded);
const stylesheet = await readFile(path.join(output, "site.css"), "utf8");

assert.doesNotMatch(pages.index, /Test documentation site|eventual guide/);
assert.match(pages.index, /href="\/docs\/quick-start\/index\.html"/);
assert.match(pages.index, /href="\/docs\/index\.html" aria-current="page"/);
assert.match(pages.quickStart, /Compiled ✓ — 2 rules/);
assert.match(
  pages.quickStart,
  /href="\/docs\/quick-start\/index\.html" aria-current="page"/,
);
assert.match(pages.workspaces, /schema = 1/);
assert.match(pages.writingRules, /embedded YARA-X language server/);
assert.match(pages.compilingAndScanning, /one target at a time/);
assert.match(pages.resultsAndDiagnostics, /Hex viewer/);
assert.match(pages.preferencesAndCache, /1 GiB maximum/);
assert.match(pages.reference, /Current limits/);
assert.match(stylesheet, /\.docs-layout/);

for (const [name, html] of Object.entries(pages)) {
  assert.doesNotMatch(
    html,
    /(?:href|src)="https:\/\/docs\.quipu\.invalid(?:\/|\")/,
    `${name} contains an absolute internal asset or navigation URL`,
  );
}

console.log("generated documentation: verified complete offline guide and root-relative links");
