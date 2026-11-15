import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

interface LockOwner {
  pid: number;
  hostname: string;
  created: string;
  token: string;
}
const absent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (absent(error)) return false;
    throw error;
  }
}
async function owner(directory: string): Promise<LockOwner> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('lock is not an ordinary directory');
  const file = path.join(directory, 'owner.json'),
    entry = await lstat(file);
  if (!entry.isFile() || entry.size > 4096) throw new Error('invalid lock owner file');
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (
    !value ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.hostname !== 'string' ||
    typeof value.created !== 'string' ||
    typeof value.token !== 'string' ||
    !value.token
  )
    throw new Error('lock owner metadata is incomplete; inspect manually');
  return value;
}
function alive(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
}
function newOwner(): LockOwner {
  return {
    pid: process.pid,
    hostname: hostname(),
    created: new Date().toISOString(),
    token: randomBytes(16).toString('hex'),
  };
}
export async function inspectLock(file: string) {
  const directory = `${file}.d`,
    recovery = `${file}.recover.d`;
  if (!(await exists(directory)))
    return {
      directory,
      exists: false,
      owner: null,
      process: 'unknown',
      can_recover: false,
      recovery_in_progress: await exists(recovery),
    };
  try {
    const value = await owner(directory),
      status = value.hostname === hostname() ? alive(value.pid) : 'unknown';
    return {
      directory,
      exists: true,
      owner: value,
      process: status,
      can_recover: status === 'dead',
      recovery_in_progress: await exists(recovery),
    };
  } catch (error) {
    return {
      directory,
      exists: true,
      owner: null,
      process: 'unknown',
      can_recover: false,
      recovery_in_progress: await exists(recovery),
      error: (error as Error).message,
    };
  }
}
export async function lock(file: string): Promise<() => Promise<void>> {
  const directory = `${file}.d`,
    recovery = `${file}.recover.d`,
    value = newOwner();
  if (await exists(recovery))
    throw new Error(`lock recovery is in progress or needs inspection: ${recovery}`);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `team initialization is already running or a lock needs inspection: ${directory}`,
      );
    throw error;
  }
  try {
    // Recovery reserves its guard before inspecting the stale owner. Recheck
    // after mkdir so an acquisition cannot slip through a concurrent recovery.
    if (await exists(recovery)) throw new Error('lock recovery started during acquisition');
    await writeFile(path.join(directory, 'owner.json'), JSON.stringify(value), { mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return async () => {
    const current = await owner(directory);
    if (current.token !== value.token)
      throw new Error(`refusing to release a lock owned by another operation: ${directory}`);
    await rm(directory, { recursive: true, force: true });
  };
}
export async function recoverLock(file: string): Promise<boolean> {
  const recovery = `${file}.recover.d`;
  try {
    await mkdir(recovery, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `another lock recovery is running or its guard needs inspection: ${recovery}`,
      );
    throw error;
  }
  try {
    await writeFile(path.join(recovery, 'owner.json'), JSON.stringify(newOwner()), { mode: 0o600 });
    const current = await inspectLock(file);
    if (!current.exists) return false;
    if (!current.can_recover || !current.owner)
      throw new Error(
        `refusing to recover a live, foreign-host or unverified lock: ${current.error || current.process}`,
      );
    const latest = await owner(current.directory);
    if (
      latest.token !== current.owner.token ||
      alive(latest.pid) !== 'dead' ||
      latest.hostname !== hostname()
    )
      throw new Error('lock ownership changed during recovery');
    const quarantine = `${current.directory}.recovered-${randomBytes(8).toString('hex')}`;
    await rename(current.directory, quarantine);
    await rm(quarantine, { recursive: true, force: true });
    return true;
  } finally {
    await rm(recovery, { recursive: true, force: true });
  }
}
