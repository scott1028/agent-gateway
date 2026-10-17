// Refresh lock interoperability. The official release bundles proper-lockfile v4 (binary offset
// 215028300) and configures it in nGn at 217997780: the lock is a directory named
// `.oauth_refresh.lock` inside the home, stale after 60000ms, kept fresh every 5000ms, and pOs at
// 217998206 additionally holds `realpath(home) + ".lock"`.
import { mkdir, mkdtemp, rmdir, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { acquireClaudeRefreshLock, waitForClaudeRefreshLock } from '../../src/claude/refreshLock.js';
import { CLAUDE_REFRESH_LOCK_DIR } from '../../src/constants.js';

const makeHome = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-lock-'));

const ageLock = async (lockPath: string, ms: number): Promise<void> => {
  const old = new Date(Date.now() - ms);
  await utimes(lockPath, old, old);
};

describe('acquireClaudeRefreshLock', () => {
  it('creates the official lock directory and removes it on release', async () => {
    const home = await makeHome();
    const lock = await acquireClaudeRefreshLock(home);
    expect(lock).toBeDefined();
    const lockPath = path.join(home, CLAUDE_REFRESH_LOCK_DIR);
    expect((await stat(lockPath)).isDirectory()).toBe(true);
    await lock?.release();
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('release leaves a replacement holder that appeared before the heartbeat noticed alone', async () => {
    // Review round 1 / F: release must only remove the directory while we still own it.
    const home = await makeHome();
    const lock = await acquireClaudeRefreshLock(home);
    const lockPath = path.join(home, CLAUDE_REFRESH_LOCK_DIR);
    await rmdir(lockPath);
    await mkdir(lockPath);
    const replacement = await stat(lockPath);
    await lock?.release();
    const after = await stat(lockPath);
    expect(after.isDirectory()).toBe(true);
    expect(after.mtimeMs).toBe(replacement.mtimeMs);
  });

  it('also holds the legacy `<home>.lock` the official client takes', async () => {
    const home = await makeHome();
    const lock = await acquireClaudeRefreshLock(home);
    expect((await stat(`${home}.lock`)).isDirectory()).toBe(true);
    await lock?.release();
    await expect(stat(`${home}.lock`)).rejects.toThrow();
  });

  it('refuses a lock another process holds and leaves it alone', async () => {
    const home = await makeHome();
    const other = await acquireClaudeRefreshLock(home);
    const second = await acquireClaudeRefreshLock(home);
    expect(second).toBeUndefined();
    expect((await stat(path.join(home, CLAUDE_REFRESH_LOCK_DIR))).isDirectory()).toBe(true);
    await other?.release();
  });

  it('takes over a lock older than the stale window', async () => {
    const home = await makeHome();
    const lockPath = path.join(home, CLAUDE_REFRESH_LOCK_DIR);
    await mkdir(lockPath);
    await ageLock(lockPath, 60_001);
    const lock = await acquireClaudeRefreshLock(home);
    expect(lock).toBeDefined();
    expect(lock?.isCompromised()).toBe(false);
    await lock?.release();
  });

  it('does not take over a lock that is still fresh', async () => {
    const home = await makeHome();
    const lockPath = path.join(home, CLAUDE_REFRESH_LOCK_DIR);
    await mkdir(lockPath);
    await ageLock(lockPath, 1_000);
    expect(await acquireClaudeRefreshLock(home)).toBeUndefined();
  });

  it('reports the lock as compromised when another process replaces it and never removes it again', async () => {
    const home = await makeHome();
    const lockPath = path.join(home, CLAUDE_REFRESH_LOCK_DIR);
    // proper-lockfile clamps `update` into [1000, stale/2], so this test waits one update cycle.
    const lock = await acquireClaudeRefreshLock(home, { staleMs: 2_000, updateMs: 1_000 });
    await rmdir(lockPath);
    await mkdir(lockPath);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(lock?.isCompromised()).toBe(true);
    await lock?.release();
    // Release must not remove a directory we no longer own.
    expect((await stat(lockPath)).isDirectory()).toBe(true);
  });

  it('releases the first lock when only the legacy lock is contended', async () => {
    const home = await makeHome();
    await mkdir(`${home}.lock`);
    const warn = vi.fn();
    expect(await acquireClaudeRefreshLock(home, { onCompromised: warn })).toBeUndefined();
    await expect(stat(path.join(home, CLAUDE_REFRESH_LOCK_DIR))).rejects.toThrow();
  });
});

describe('waitForClaudeRefreshLock', () => {
  it('gives up after the official retry budget without taking the lock', async () => {
    const home = await makeHome();
    await mkdir(path.join(home, CLAUDE_REFRESH_LOCK_DIR));
    const started = Date.now();
    expect(await waitForClaudeRefreshLock(home, { retryLimit: 2, retryBaseMs: 5 })).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
    expect((await stat(path.join(home, CLAUDE_REFRESH_LOCK_DIR))).isDirectory()).toBe(true);
  });

  it('acquires the lock once the holder releases it', async () => {
    const home = await makeHome();
    const holder = await acquireClaudeRefreshLock(home);
    const waiter = waitForClaudeRefreshLock(home, { retryLimit: 20, retryBaseMs: 5 });
    setTimeout(() => void holder?.release(), 20);
    const lock = await waiter;
    expect(lock).toBeDefined();
    await lock?.release();
  });
});
