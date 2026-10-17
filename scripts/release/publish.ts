import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getGithubJson, getGithubRelease } from './github.js';
import { getReleaseAssetNames } from './utils.js';

export const publishRelease = async ({ repo, tag, sha, name, assetDir, notesPath }: {
  repo: string; tag: string; sha: string; name: string; assetDir: string; notesPath: string;
}): Promise<void> => {
  const endpoint = `repos/${repo}`;
  let release = getGithubRelease(repo, tag);
  let tagObject = getGithubJson<{ object: { type: string; sha: string } }>(`${endpoint}/git/ref/tags/${encodeURIComponent(tag)}`)?.object;
  while (tagObject?.type === 'tag') {
    tagObject = getGithubJson<{ object: { type: string; sha: string } }>(`${endpoint}/git/tags/${tagObject.sha}`)?.object;
  }
  if (tagObject && (tagObject.type !== 'commit' || tagObject.sha !== sha)) {
    throw new Error(`Existing tag ${tag} points to a different commit`);
  }
  if (release && !release.draft) {
    if (!tagObject) throw new Error('Cannot verify the published release source commit');
    console.log(`${tag} is already published; keeping its assets unchanged.`);
    return;
  }
  if (release && release.target_commitish !== sha) throw new Error('Draft release targets a different commit');

  const filenames = getReleaseAssetNames(tag);
  const actual = (await readdir(assetDir)).filter((filename) => filename !== 'SHA256SUMS').sort();
  if (JSON.stringify(actual) !== JSON.stringify(filenames)) throw new Error('Release requires exactly six binaries and two AppImages');
  const checksums: string[] = [];
  for (const filename of filenames) {
    const bytes = await readFile(path.join(assetDir, filename));
    if (bytes.length === 0) throw new Error(`Empty release asset: ${filename}`);
    checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${filename}`);
  }
  await writeFile(path.join(assetDir, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
  await writeFile(notesPath, `Source commit: ${sha}
Node.js: ${process.version}

Standalone CLI binaries: Linux, macOS and Windows (x64 / arm64).
Linux also includes AppImages. Node.js does not need to be installed.
macOS uses ad-hoc signing; Windows binaries are unsigned.
See README for login and first-run instructions. Verify downloads with SHA256SUMS.
`);
  if (!release) {
    execFileSync('gh', ['release', 'create', tag, '--repo', repo, '--draft', '--target', sha, '--title', name, '--notes-file', notesPath], { stdio: 'inherit' });
    release = getGithubRelease(repo, tag);
  }
  if (!release) throw new Error('Cannot find the draft release after creation');
  execFileSync('gh', ['release', 'upload', tag, '--repo', repo, '--clobber', ...[...filenames, 'SHA256SUMS'].map((filename) => path.join(assetDir, filename))], { stdio: 'inherit' });
  const uploaded = getGithubJson<{ assets: { name: string }[] }>(`${endpoint}/releases/${release.id}`);
  if (JSON.stringify(uploaded?.assets.map((asset) => asset.name).sort()) !== JSON.stringify([...filenames, 'SHA256SUMS'].sort())) {
    throw new Error('Draft release asset list is incomplete or contains unexpected files');
  }
  execFileSync('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false', '--target', sha, '--title', name, '--notes-file', notesPath], { stdio: 'inherit' });
};
