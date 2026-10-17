import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { publishRelease } from './publish.js';
import { getReleaseMetadata } from './utils.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: root }).trim();
if (sha !== process.env.GITHUB_SHA) throw new Error('Checkout does not match the workflow source commit');
if (!process.env.GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY is required');
const metadata = getReleaseMetadata({ eventName: 'workflow_dispatch', ref: '', defaultBranch: '', version, sha });
await mkdir(path.join(root, '.tmp'), { recursive: true });
await publishRelease({
  repo: process.env.GITHUB_REPOSITORY, ...metadata,
  assetDir: path.join(root, 'dist', 'release'),
  notesPath: path.join(root, '.tmp', 'release-notes.md'),
});
