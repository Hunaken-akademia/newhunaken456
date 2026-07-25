import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const root = process.cwd();
const tempDir = join(root, '.vite-build');
const distDir = join(root, 'dist');
rmSync(tempDir, { recursive: true, force: true });
const run = spawnSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', tempDir, '--emptyOutDir'], {
  cwd: root,
  stdio: 'inherit',
});
if (run.status !== 0) process.exit(run.status ?? 1);
const html = readFileSync(join(tempDir, 'index.html'), 'utf8');
const scriptMatch = html.match(/<script[^>]+type="module"[^>]+src="([^"]+\.js)"/i)
  || html.match(/<script[^>]+src="([^"]+\.js)"[^>]+type="module"/i);
if (!scriptMatch) throw new Error('Vite bundle entry was not found');
const generatedSrc = scriptMatch[1].replace(/^\//, '');
const generatedName = basename(generatedSrc);
mkdirSync(join(distDir, 'assets'), { recursive: true });
cpSync(join(tempDir, 'assets'), join(distDir, 'assets'), { recursive: true });
const bootstrapPath = join(distDir, 'cloud-bootstrap-v3.js');
let bootstrap = readFileSync(bootstrapPath, 'utf8');
bootstrap = bootstrap.replace(/await import\("\/assets\/[^"\n]+\.js"\);/, `await import("/assets/${generatedName}");`);
writeFileSync(bootstrapPath, bootstrap);
console.log(`prebuilt entry updated: /assets/${generatedName}`);
