import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || !process.argv[2]) {
  throw new Error('Usage on Linux x64/arm64: npm run build:appimage -- <binary>');
}
const root = path.resolve(import.meta.dirname, '..');
const binary = path.resolve(process.argv[2]);
const arch = process.arch === 'x64' ? 'x86_64' : 'aarch64';
const toolDir = path.join(root, '.tmp', 'release-tools');
await mkdir(toolDir, { recursive: true });
// Official GitHub release asset digests: appimagetool 1.9.1 and type2-runtime 20251108.
const digests = {
  x86_64: ['ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0', '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d'],
  aarch64: ['f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158', '00cbdfcf917cc6c0ff6d3347d59e0ca1f7f45a6df1a428a0d6d8a78664d87444'],
}[arch];
const downloadVerifiedFile = async (url: string, filename: string, digest: string): Promise<string> => {
  const target = path.join(toolDir, filename);
  let bytes: Buffer;
  try {
    bytes = await readFile(target);
  } catch {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Download failed: ${url} (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(target, bytes);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error(`Checksum mismatch: ${filename}`);
  return target;
};
const tool = await downloadVerifiedFile(
  `https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-${arch}.AppImage`,
  `appimagetool-${arch}.AppImage`, digests[0]!,
);
const runtime = await downloadVerifiedFile(
  `https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-${arch}`,
  `runtime-${arch}`, digests[1]!,
);
await chmod(tool, 0o755);
const appDir = await mkdtemp(path.join(root, '.tmp', 'gateway.AppDir-'));
await mkdir(path.join(appDir, 'usr', 'bin'), { recursive: true });
await copyFile(binary, path.join(appDir, 'usr', 'bin', 'agent-gateway'));
await chmod(path.join(appDir, 'usr', 'bin', 'agent-gateway'), 0o755);
await writeFile(path.join(appDir, 'AppRun'), '#!/bin/sh\nexec "$(dirname "$0")/usr/bin/agent-gateway" "$@"\n', { mode: 0o755 });
await writeFile(path.join(appDir, 'agent-gateway.desktop'), `[Desktop Entry]
Type=Application
Name=agent-gateway
Exec=agent-gateway
Icon=agent-gateway
Terminal=true
Categories=Development;
`);
await copyFile(path.join(root, 'assets', 'icon.png'), path.join(appDir, 'agent-gateway.png'));
const output = `${binary}.AppImage`;
execFileSync(tool, ['--appimage-extract-and-run', '--no-appstream', '--runtime-file', runtime, appDir, output], {
  stdio: 'inherit', env: { ...process.env, ARCH: arch },
});
await chmod(output, 0o755);
console.log(`AppImage: ${output}`);
