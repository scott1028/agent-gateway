import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { getReleaseMetadata } from './release/utils.js';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const { tag } = getReleaseMetadata({ eventName: 'workflow_dispatch', ref: '', defaultBranch: '', version, sha });
const buildDir = path.join(root, '.tmp', 'binary');
const releaseDir = path.join(root, 'dist', 'release');
await mkdir(buildDir, { recursive: true });
await mkdir(releaseDir, { recursive: true });
const bundlePath = path.join(buildDir, 'gateway.cjs');
const blobPath = path.join(buildDir, 'gateway.blob');
const configPath = path.join(buildDir, 'sea.json');
const output = path.join(releaseDir, `agent-gateway-${tag.slice(1)}-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);

await build({
  entryPoints: [path.join(root, 'src', 'index.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
});
// Node.js v22 SEA requires the same runtime for blob generation and injection.
await writeFile(configPath, JSON.stringify({
  main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true,
  useSnapshot: false, useCodeCache: false,
}));
execFileSync(process.execPath, ['--experimental-sea-config', configPath], { stdio: 'inherit' });
await copyFile(process.execPath, output);
await chmod(output, 0o755);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', output], { stdio: 'inherit' });
// Follow Node.js v22's documented postject flags; Windows signing is optional.
execFileSync(process.execPath, [
  path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'), output, 'NODE_SEA_BLOB', blobPath,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
], { stdio: 'inherit' });
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', output], { stdio: 'inherit' });
console.log(`Binary: ${output}`);
