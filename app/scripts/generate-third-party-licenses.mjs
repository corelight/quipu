import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(appDir, "..");
const cargoDir = path.join(appDir, "src-tauri");
const noticesDir = path.join(repoDir, "THIRD_PARTY_LICENSES");

function canonicalNotice(text) {
  return `${text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd()}\n`;
}

const lock = JSON.parse(readFileSync(path.join(appDir, "package-lock.json"), "utf8"));
const packages = [];

for (const [installPath, locked] of Object.entries(lock.packages)) {
  if (!installPath || locked.dev === true) continue;

  const packageDir = path.join(appDir, installPath);
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const licenseFiles = readdirSync(packageDir)
    .filter((name) => /^(licen[cs]e|copying|notice)/i.test(name))
    .sort((left, right) => left.localeCompare(right));

  if (licenseFiles.length === 0) {
    throw new Error(`${manifest.name} ${manifest.version} has no packaged license or notice file`);
  }

  const repository =
    typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  packages.push({
    name: manifest.name,
    version: manifest.version,
    license: manifest.license ?? locked.license ?? "UNDECLARED",
    source: manifest.homepage ?? repository ?? "not declared",
    licenseFiles: licenseFiles.map((name) => ({
      name,
      text: readFileSync(path.join(packageDir, name), "utf8").trimEnd(),
    })),
  });
}

packages.sort((left, right) => left.name.localeCompare(right.name));

const npmLines = [
  "Quipu third-party JavaScript software notices",
  "================================================",
  "",
  "This file lists license notices for production JavaScript packages bundled",
  "into Quipu's frontend. It is generated from app/package-lock.json and the",
  "corresponding npm package contents. The notices below do not change the",
  "licensing terms of Quipu itself.",
  "",
];

for (const dependency of packages) {
  npmLines.push(
    "-------------------------------------------------------------------------------",
    `${dependency.name} ${dependency.version}`,
    `Declared license: ${dependency.license}`,
    `Source: ${dependency.source}`,
    "",
  );
  for (const licenseFile of dependency.licenseFiles) {
    npmLines.push(`[${licenseFile.name}]`, "", licenseFile.text, "");
  }
}

writeFileSync(path.join(noticesDir, "NPM.txt"), canonicalNotice(npmLines.join("\n")));

const cargoAbout = process.env.CARGO_ABOUT ?? "cargo-about";
const rustNotices = path.join(noticesDir, "RUST.txt");
const cargoResult = spawnSync(
  cargoAbout,
  [
    "generate",
    "--locked",
    "--offline",
    "--fail",
    "--config",
    path.join(cargoDir, "about.toml"),
    "--output-file",
    rustNotices,
    path.join(cargoDir, "about.hbs"),
  ],
  { cwd: cargoDir, encoding: "utf8" },
);

if (cargoResult.error) {
  throw new Error(`could not run ${cargoAbout}: ${cargoResult.error.message}`);
}
if (cargoResult.status !== 0) {
  process.stderr.write(cargoResult.stdout);
  process.stderr.write(cargoResult.stderr);
  process.exit(cargoResult.status ?? 1);
}

writeFileSync(rustNotices, canonicalNotice(readFileSync(rustNotices, "utf8")));

console.log(`generated ${packages.length} npm package notices and locked Rust notices`);
