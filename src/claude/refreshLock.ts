// Refresh lock that interoperates with the official Claude release.
// The release bundles proper-lockfile v4 (binary offset 215028300) and configures it in nGn at
// 217997780: lockfilePath `<home>/.oauth_refresh.lock`, realpath:false, stale:60000, update:5000.
// pOs at 217998206 additionally holds the legacy lock `realpath(home) + ".lock"` (xE at 217997900).
// A lock is a directory; ownership is the directory mtime that proper-lockfile stamps after mkdir
// (probe at 215028400) and re-stamps every `update` ms, comparing the previous value first
// (update at 215029900) so a takeover shows up as ECOMPROMISED instead of a lost refresh.
import { mkdir, realpath, rmdir, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import {
  CLAUDE_REFRESH_LOCK_DIR,
  CLAUDE_REFRESH_LOCK_STALE_MS,
  CLAUDE_REFRESH_LOCK_UPDATE_MS,
} from '../constants.js';

export type ClaudeRefreshLock = {
  isCompromised: () => boolean;
  release: () => Promise<void>;
};

export type ClaudeRefreshLockOptions = {
  staleMs?: number;
  updateMs?: number;
  onCompromised?: (reason: string) => void;
};

type Precision = 's' | 'ms';

// Ze.getMtime at 215028900: the next whole second for a second-resolution filesystem, otherwise now.
const getStamp = (precision: Precision): Date => {
  const now = Date.now();
  return new Date(precision === 's' ? Math.ceil(now / 1000) * 1000 : now);
};

// Ze.probe at 215028400: stamp a whole-second mtime a few ms into the future, then read it back so
// the value can be compared later, and learn the filesystem's mtime resolution on the way.
const probeLock = async (lockPath: string): Promise<{ mtimeMs: number; precision: Precision }> => {
  const target = new Date(Math.ceil(Date.now() / 1000) * 1000 + 5);
  await utimes(lockPath, target, target);
  const info = await stat(lockPath);
  return { mtimeMs: info.mtimeMs, precision: info.mtimeMs % 1000 === 0 ? 's' : 'ms' };
};

// De at 215029100: mkdir, and on EEXIST steal only when the holder is older than `staleMs`.
const acquireOnce = async (lockPath: string, staleMs: number): Promise<{ mtimeMs: number; precision: Precision } | undefined> => {
  let remainingStale = staleMs;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await mkdir(lockPath);
      return await probeLock(lockPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      if (remainingStale <= 0) return undefined;
      try {
        const info = await stat(lockPath);
        if (info.mtimeMs >= Date.now() - remainingStale) return undefined;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        remainingStale = 0;
        continue;
      }
      await rmdir(lockPath).catch(() => undefined);
      remainingStale = 0;
    }
  }
  return undefined;
};

const acquireSingleLock = async (
  lockPath: string,
  options: { staleMs: number; updateMs: number; onCompromised?: (reason: string) => void },
): Promise<ClaudeRefreshLock | undefined> => {
  const owned = await acquireOnce(lockPath, options.staleMs);
  if (owned === undefined) return undefined;

  let mtimeMs = owned.mtimeMs;
  let lastUpdateMs = Date.now();
  let isCompromised = false;
  let isReleased = false;
  let timer: NodeJS.Timeout | undefined;

  const compromise = (reason: string): void => {
    if (isCompromised) return;
    isCompromised = true;
    isReleased = true;
    if (timer) clearTimeout(timer);
    options.onCompromised?.(reason);
  };

  // pe at 215029900: re-stat first, then re-stamp; a mismatched mtime means someone else owns it.
  const scheduleUpdate = (): void => {
    timer = setTimeout(() => {
      void (async () => {
        if (isReleased) return;
        const info = await stat(lockPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT' || lastUpdateMs + options.staleMs < Date.now()) compromise('lock directory is gone');
          else compromise(`cannot update the lock (${error.code ?? 'error'})`);
          return undefined;
        });
        if (info === undefined || isReleased) return;
        if (info.mtimeMs !== mtimeMs) {
          compromise('lock mtime changed');
          return;
        }
        const stamp = getStamp(owned.precision);
        try {
          await utimes(lockPath, stamp, stamp);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || lastUpdateMs + options.staleMs < Date.now()) compromise('lock directory is gone');
          else compromise(`cannot update the lock (${code ?? 'error'})`);
          return;
        }
        if (isReleased) return;
        mtimeMs = stamp.getTime();
        lastUpdateMs = Date.now();
        scheduleUpdate();
      })();
    }, options.updateMs);
    timer.unref?.();
  };
  scheduleUpdate();

  // it at 215031597: release clears the timer and removes the directory, but only while we still
  // own it; a compromised lock was already handed over to whoever took it. The mtime check also
  // covers a replacement holder that appeared before this heartbeat noticed: their stamp differs,
  // so release leaves their lock alone.
  const release = async (): Promise<void> => {
    if (isReleased) return;
    isReleased = true;
    if (timer) clearTimeout(timer);
    const info = await stat(lockPath).catch(() => undefined);
    if (info !== undefined && info.mtimeMs === mtimeMs) await rmdir(lockPath).catch(() => undefined);
  };

  return { isCompromised: () => isCompromised, release };
};

// Holds the official lock and the legacy lock the way pOs does; the first lock is released again
// when only the legacy one is contended.
export const acquireClaudeRefreshLock = async (
  homeDir: string,
  options: ClaudeRefreshLockOptions = {},
): Promise<ClaudeRefreshLock | undefined> => {
  // proper-lockfile clamps stale to at least 2000ms and update into [1000, stale/2].
  const staleMs = Math.max(options.staleMs ?? CLAUDE_REFRESH_LOCK_STALE_MS, 2_000);
  const requestedUpdate = options.updateMs ?? CLAUDE_REFRESH_LOCK_UPDATE_MS;
  const updateMs = Math.max(Math.min(requestedUpdate, staleMs / 2), 1_000);
  const lockPath = path.join(homeDir, CLAUDE_REFRESH_LOCK_DIR);
  const current = await acquireSingleLock(lockPath, { staleMs, updateMs, onCompromised: options.onCompromised });
  if (current === undefined) return undefined;

  const legacyPath = `${await realpath(homeDir).catch(() => homeDir)}.lock`;
  let legacy: ClaudeRefreshLock | undefined;
  try {
    legacy = await acquireSingleLock(legacyPath, { staleMs, updateMs, onCompromised: options.onCompromised });
  } catch (error) {
    // pOs treats a legacy-lock error other than contention as a logged warning and carries on with
    // the official lock; only a contended legacy lock fails the acquisition.
    options.onCompromised?.(`legacy refresh lock failed: ${String(error)}`);
    legacy = undefined;
  }
  if (legacy === undefined) {
    await current.release();
    return undefined;
  }
  return {
    isCompromised: () => current.isCompromised() || legacy.isCompromised(),
    release: async () => {
      await legacy.release();
      await current.release();
    },
  };
};

// Za at 218001100 retries five times with `1000 + Math.random() * 1000` between attempts and then
// gives up without posting a refresh.
export const waitForClaudeRefreshLock = async (
  homeDir: string,
  options: ClaudeRefreshLockOptions & { retryLimit: number; retryBaseMs: number },
): Promise<ClaudeRefreshLock | undefined> => {
  for (let attempt = 0; attempt <= options.retryLimit; attempt += 1) {
    const lock = await acquireClaudeRefreshLock(homeDir, options);
    if (lock !== undefined) return lock;
    if (attempt === options.retryLimit) break;
    await new Promise((resolve) => setTimeout(resolve, options.retryBaseMs + Math.random() * options.retryBaseMs));
  }
  return undefined;
};
