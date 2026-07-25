import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const root = process.cwd();
const tempDir = join(root, ".vite-build");
const distDir = join(root, "dist");
const distAssetsDir = join(distDir, "assets");
const bootstrapPath = join(distDir, "cloud-bootstrap-v3.js");
const bootstrapTmpPath = `${bootstrapPath}.tmp`;

function fail(message) {
  throw new Error(`[build-prebuilt] ${message}`);
}

function runViteBuild() {
  const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) {
    fail("Vite is not installed. Run npm install before npm run build.");
  }

  const result = spawnSync(
    process.execPath,
    [viteBin, "build", "--outDir", tempDir, "--emptyOutDir"],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function findGeneratedEntry() {
  const htmlPath = join(tempDir, "index.html");
  if (!existsSync(htmlPath)) fail("Temporary Vite index.html was not generated.");

  const html = readFileSync(htmlPath, "utf8");
  const match =
    html.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+\.js)["']/i) ||
    html.match(/<script[^>]+src=["']([^"']+\.js)["'][^>]+type=["']module["']/i);
  if (!match) fail("Vite bundle entry was not found in temporary index.html.");

  const relativePath = match[1].replace(/^\//, "");
  const fullPath = join(tempDir, relativePath);
  if (!existsSync(fullPath) || statSync(fullPath).size === 0) {
    fail(`Generated entry is missing or empty: ${relativePath}`);
  }
  return { relativePath, fileName: basename(relativePath) };
}

function removeStaleGeneratedAssets(currentFileName) {
  mkdirSync(distAssetsDir, { recursive: true });
  const viteHashAsset = /^index-[A-Za-z0-9_-]{8,}\.(?:js|css|map)$/;
  for (const name of readdirSync(distAssetsDir)) {
    if (name === currentFileName) continue;
    if (!viteHashAsset.test(name)) continue;
    // 手動命名の index-v121-... は上の正規表現に一致しないため残る。
    rmSync(join(distAssetsDir, name), { force: true });
    console.log(`[build-prebuilt] removed stale generated asset: ${name}`);
  }
}

function updateBootstrap(fileName) {
  if (!existsSync(bootstrapPath)) fail("dist/cloud-bootstrap-v3.js was not found.");

  const before = readFileSync(bootstrapPath, "utf8");
  const importPattern = /await\s+import\(["']\/assets\/[^"'\n]+\.js["']\);/;
  if (!importPattern.test(before)) {
    fail("The bundle import in dist/cloud-bootstrap-v3.js could not be identified safely.");
  }

  const nextImport = `await import("/assets/${fileName}");`;
  const after = before.replace(importPattern, nextImport);
  if (!after.includes(nextImport)) fail("The new bundle reference was not written.");

  writeFileSync(bootstrapTmpPath, after, "utf8");
  renameSync(bootstrapTmpPath, bootstrapPath);
}

function verifyFinalOutput(fileName) {
  const entryPath = join(distAssetsDir, fileName);
  if (!existsSync(entryPath) || statSync(entryPath).size === 0) {
    fail(`Final bundle is missing or empty: dist/assets/${fileName}`);
  }

  const bootstrap = readFileSync(bootstrapPath, "utf8");
  const expected = `await import("/assets/${fileName}");`;
  if (!bootstrap.includes(expected)) {
    fail("cloud-bootstrap-v3.js does not reference the generated bundle.");
  }
  console.log(`[build-prebuilt] verified entry: /assets/${fileName}`);
}

rmSync(tempDir, { recursive: true, force: true });
rmSync(bootstrapTmpPath, { force: true });

try {
  // distを変更する前に、まず一時フォルダでビルドを最後まで成功させる。
  runViteBuild();
  const { fileName } = findGeneratedEntry();

  mkdirSync(distAssetsDir, { recursive: true });
  removeStaleGeneratedAssets(fileName);
  cpSync(join(tempDir, "assets"), distAssetsDir, { recursive: true });

  // 念のためentryを明示コピーし、途中コピーによる欠損を避ける。
  copyFileSync(join(tempDir, "assets", fileName), join(distAssetsDir, fileName));
  updateBootstrap(fileName);
  verifyFinalOutput(fileName);

  console.log(`[build-prebuilt] prebuilt entry updated: /assets/${fileName}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(bootstrapTmpPath, { force: true });
}
