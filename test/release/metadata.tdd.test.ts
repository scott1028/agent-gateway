// Project-owned release policy; no upstream behavior is copied from references/**.
import { describe, expect, it } from 'vitest';
import { getReleaseMetadata } from '../../scripts/release/utils.js';

const input = {
  eventName: 'workflow_dispatch',
  ref: 'refs/heads/master',
  defaultBranch: 'master',
  version: '0.1.0',
  sha: '36b38c242c0668833628742f94870638afae35d5',
};

describe('release metadata', () => {
  it('allows a manual release without a version change and includes the source hash', () => {
    expect(getReleaseMetadata(input)).toEqual({
      shouldRelease: true,
      tag: 'v0.1.0-36b38c2',
      name: 'agent-gateway v0.1.0-36b38c2',
      version: '0.1.0',
      sha: input.sha,
    });
  });

  it.each([
    ['changed version', { eventName: 'push', previousVersion: '0.0.9' }, true],
    ['unchanged version', { eventName: 'push', previousVersion: '0.1.0' }, false],
    ['missing push baseline', { eventName: 'push' }, false],
    ['another branch', { eventName: 'push', ref: 'refs/heads/feature', previousVersion: '0.0.9' }, false],
    ['tag push', { eventName: 'push', ref: 'refs/tags/v0.1.0', previousVersion: '0.0.9' }, false],
    ['another event', { eventName: 'pull_request', previousVersion: '0.0.9' }, false],
    ['manual feature branch', { ref: 'refs/heads/feature' }, true],
    ['renamed default branch', { eventName: 'push', ref: 'refs/heads/main', defaultBranch: 'main', previousVersion: '0.0.9' }, true],
  ])('%s', (_label, changes, expected) => {
    expect(getReleaseMetadata({ ...input, ...changes }).shouldRelease).toBe(expected);
  });

  it.each(['../bad', '0.1.0\nextra=bad', ''])('rejects unsafe package versions: %s', (version) => {
    expect(() => getReleaseMetadata({ ...input, version })).toThrow('Invalid package version');
  });

  it('rejects an invalid source commit', () => {
    expect(() => getReleaseMetadata({ ...input, sha: 'not-a-commit' })).toThrow('Invalid commit SHA');
  });
});
