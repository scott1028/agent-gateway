// Project-owned release lifecycle; references/** does not define gateway releases.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publishRelease } from '../../scripts/release/publish.js';
import { getReleaseAssetNames } from '../../scripts/release/utils.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }));
const tag = 'v0.1.0-36b38c2';
const sha = '36b38c242c0668833628742f94870638afae35d5';
let directory: string;
let release: { draft: boolean; target_commitish: string; assets: { name: string }[] } | undefined;
let tagSha: string | undefined;
let shouldFailUpload: boolean;
const options = () => ({ repo: 'owner/repo', tag, sha, name: `agent-gateway ${tag}`, assetDir: directory, notesPath: path.join(directory, 'notes.md') });
const getReleaseCommands = () => vi.mocked(execFileSync).mock.calls
  .filter(([, args]) => args![0] === 'release').map(([, args]) => args![1]);
const getReleaseLookupResponse = () => Buffer.from(JSON.stringify({
  data: { repository: { release: release ? { databaseId: 415599240 } : null } },
}));

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(os.tmpdir(), 'gateway-publish-'));
  for (const filename of getReleaseAssetNames(tag)) await writeFile(path.join(directory, filename), filename);
  release = undefined;
  tagSha = undefined;
  shouldFailUpload = false;
  vi.mocked(spawnSync).mockImplementation((_command, args) => {
    const endpoint = args![2] as string;
    const releaseRecord = release ? { id: 415599240, tag_name: tag, ...release } : undefined;
    const body = endpoint.includes('/git/ref/') ? (tagSha ? { object: { type: 'commit', sha: tagSha } } : undefined)
      : endpoint.includes('/releases?') ? (releaseRecord ? [releaseRecord] : [])
      : endpoint.endsWith('/releases/415599240') ? releaseRecord : undefined;
    return { status: body ? 0 : 1, stdout: `HTTP/2.0 ${body ? '200 OK' : '404 Not Found'}\r\n\r\n${JSON.stringify(body ?? {})}`, stderr: '', pid: 1, output: [], signal: null };
  });
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    if (args![0] === 'api') return getReleaseLookupResponse();
    const command = args![1];
    if (command === 'create') release = { draft: true, target_commitish: sha, assets: [] };
    if (command === 'upload') {
      if (shouldFailUpload) throw new Error('Upload failed');
      release!.assets = [...getReleaseAssetNames(tag), 'SHA256SUMS'].map((name) => ({ name }));
    }
    return Buffer.from('');
  });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it('publishes only after uploading every asset and writes matching SHA256SUMS', async () => {
  await publishRelease(options());
  expect(getReleaseCommands()).toEqual(['create', 'upload', 'edit']);
  const manifest = await readFile(path.join(directory, 'SHA256SUMS'), 'utf8');
  for (const filename of getReleaseAssetNames(tag)) {
    expect(manifest).toContain(`${createHash('sha256').update(filename).digest('hex')}  ${filename}\n`);
  }
  expect(await readFile(path.join(directory, 'notes.md'), 'utf8')).toContain(sha);
});

it('verifies draft uploads even when the published-release tag endpoint returns 404', async () => {
  vi.mocked(spawnSync).mockImplementation((_command, args) => {
    const endpoint = args![2] as string;
    const draft = release ? { id: 415599240, tag_name: tag, ...release } : undefined;
    const body = endpoint.includes('/releases?') ? (draft ? [draft] : [])
      : endpoint.endsWith('/releases/415599240') ? draft : undefined;
    return { status: body ? 0 : 1, stdout: `HTTP/2.0 ${body ? '200 OK' : '404 Not Found'}\r\n\r\n${JSON.stringify(body ?? {})}`, stderr: '', pid: 1, output: [], signal: null };
  });
  await expect(publishRelease(options())).resolves.toBeUndefined();
  expect(getReleaseCommands()).toEqual(['create', 'upload', 'edit']);
});

it('skips an already published tag without reading or replacing local assets', async () => {
  release = { draft: false, target_commitish: sha, assets: [] };
  tagSha = sha;
  await publishRelease({ ...options(), assetDir: path.join(directory, 'does-not-exist') });
  expect(getReleaseCommands()).toEqual([]);
});

it('resumes a partial draft and replaces its incomplete uploads', async () => {
  release = { draft: true, target_commitish: sha, assets: [{ name: 'partial' }] };
  await publishRelease(options());
  expect(getReleaseCommands()).toEqual(['upload', 'edit']);
});

it('resolves an existing draft by pending tag when REST release listings omit drafts', async () => {
  release = { draft: true, target_commitish: sha, assets: [] };
  const readGithub = vi.mocked(spawnSync).getMockImplementation()!;
  vi.mocked(spawnSync).mockImplementation((command, args, spawnOptions) => {
    const endpoint = args![2] as string;
    if (endpoint.includes('/releases?')) {
      return { status: 0, stdout: 'HTTP/2.0 200 OK\r\n\r\n[]', stderr: '', pid: 1, output: [], signal: null };
    }
    return readGithub(command, args!, spawnOptions!);
  });
  await expect(publishRelease(options())).resolves.toBeUndefined();
  expect(getReleaseCommands()).toEqual(['upload', 'edit']);
  expect(vi.mocked(spawnSync).mock.calls.some(([, args]) => args![2] === 'repos/owner/repo/releases/415599240')).toBe(true);
});

it('keeps a draft unpublished when an upload fails', async () => {
  shouldFailUpload = true;
  await expect(publishRelease(options())).rejects.toThrow('Upload failed');
  expect(release?.draft).toBe(true);
  expect(vi.mocked(execFileSync).mock.calls.some(([, args]) => args![1] === 'edit')).toBe(false);
});

it('does not publish if the remote attachment list is incomplete', async () => {
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    if (args![0] === 'api') return getReleaseLookupResponse();
    if (args![1] === 'create') release = { draft: true, target_commitish: sha, assets: [] };
    return Buffer.from('');
  });
  await expect(publishRelease(options())).rejects.toThrow('asset list is incomplete');
  expect(vi.mocked(execFileSync).mock.calls.some(([, args]) => args![1] === 'edit')).toBe(false);
});

it('rejects a tag or draft that belongs to a different commit', async () => {
  tagSha = 'a'.repeat(40);
  await expect(publishRelease(options())).rejects.toThrow('different commit');
  tagSha = undefined;
  release = { draft: true, target_commitish: 'a'.repeat(40), assets: [] };
  await expect(publishRelease(options())).rejects.toThrow('different commit');
  expect(getReleaseCommands()).toEqual([]);
});

it('fails on GitHub permission errors instead of treating them as a missing release', async () => {
  vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: 'HTTP/2.0 403 Forbidden\n\n{}', stderr: 'permission denied', pid: 1, output: [], signal: null });
  await expect(publishRelease(options())).rejects.toThrow('GitHub read failed');
  expect(getReleaseCommands()).toEqual([]);
});

it('rejects a missing platform or empty binary before creating a draft', async () => {
  const filename = getReleaseAssetNames(tag)[0]!;
  await writeFile(path.join(directory, filename), '');
  await expect(publishRelease(options())).rejects.toThrow('Empty release asset');
  await rm(path.join(directory, filename));
  await expect(publishRelease(options())).rejects.toThrow('exactly six binaries');
  expect(getReleaseCommands()).toEqual([]);
});
