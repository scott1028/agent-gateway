import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { getGithubJson } from './github.js';
import { getReleaseMetadata } from './utils.js';

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, 'utf8'));
const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (sha !== process.env.GITHUB_SHA) throw new Error('Checkout does not match the workflow source commit');

let previousVersion: string | undefined;
if (process.env.GITHUB_EVENT_NAME === 'push' && /^[a-f0-9]{40}$/.test(event.before ?? '') && !/^0+$/.test(event.before)) {
  try {
    // Compare the whole push, including multi-commit pushes, rather than HEAD^.
    previousVersion = JSON.parse(execFileSync('git', ['show', `${event.before}:package.json`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })).version;
  } catch {
    console.log('No readable package version at the push baseline; use a manual release.');
  }
}

const metadata = getReleaseMetadata({
  eventName: process.env.GITHUB_EVENT_NAME!,
  ref: process.env.GITHUB_REF!,
  defaultBranch: event.repository.default_branch,
  version,
  previousVersion,
  sha,
});
if (metadata.shouldRelease) {
  const release = getGithubJson<{ draft: boolean; target_commitish: string }>(`repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${encodeURIComponent(metadata.tag)}`);
  if (release && !release.draft) {
    if (release.target_commitish !== sha) throw new Error('Existing release targets a different commit');
    metadata.shouldRelease = false;
    console.log(`${metadata.tag} is already published; skipping the build.`);
  }
}
console.log(JSON.stringify(metadata, null, 2));
for (const [key, content] of Object.entries(metadata)) {
  appendFileSync(process.env.GITHUB_OUTPUT!, `${key}=${content}\n`);
}
