import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { within } from './config.js';

const exec = promisify(execFile);
export interface WorkspaceSnapshot {
  available: boolean;
  reason?: string;
  head?: string;
  files?: Record<string, string | null>;
}
export async function workspaceSnapshot(project: string): Promise<WorkspaceSnapshot> {
  const git = async (...args: string[]) =>
    (
      await exec('git', ['-C', project, ...args], {
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      })
    ).stdout;
  try {
    const head = (await git('rev-parse', '--verify', 'HEAD')).trim();
    const names = new Set(
      [
        ...(await git('ls-files', '-m', '-d', '-o', '--exclude-standard', '-z')).split('\0'),
        ...(await git('diff', '--cached', '--name-only', '--no-renames', '--relative', '-z')).split(
          '\0',
        ),
      ].filter(Boolean),
    );
    const files: Record<string, string | null> = Object.create(null);
    if (names.size > 2000) throw new Error('too many dirty files for a bounded task baseline');
    for (const name of [...names].sort()) {
      if (name === '.team/tasks.md' || name.startsWith('.team/tasks/')) continue;
      const file = path.resolve(project, name);
      if (!within(project, file) || path.isAbsolute(name))
        throw new Error('Git returned a path outside the project');
      try {
        if (!within(project, await realpath(path.dirname(file))))
          throw new Error(`audit parent resolves outside project: ${name}`);
        const info = await lstat(file);
        if (info.size > 16 * 1024 * 1024) throw new Error(`file exceeds audit limit: ${name}`);
        if (!info.isFile() && !info.isSymbolicLink())
          throw new Error(`unsupported audit entry: ${name}`);
        const hash = createHash('sha256').update(String(info.mode));
        hash.update(info.isSymbolicLink() ? await readlink(file) : await readFile(file));
        files[name] = hash.digest('hex');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        files[name] = null;
      }
    }
    return { available: true, head, files };
  } catch (error) {
    return { available: false, reason: (error as Error).message };
  }
}
export async function auditWorkspace(
  project: string,
  baseline: WorkspaceSnapshot | undefined,
  allowed: string[],
  reported: string[],
) {
  const current = await workspaceSnapshot(project);
  if (!baseline?.available || !current.available)
    return {
      available: false,
      reason: baseline?.reason || current.reason || 'task has no Git baseline',
    };
  const before = baseline.files!,
    after = current.files!;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((file) => before[file] !== after[file])
    .sort();
  const inScope = (file: string) =>
    allowed.some((scope) => {
      const rel = path.relative(path.resolve(project, scope), path.resolve(project, file));
      return (
        rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
      );
    });
  return {
    available: true,
    head_changed: baseline.head !== current.head,
    changed_files: changed,
    outside_scope: changed.filter((file) => !inScope(file)),
    unreported_in_scope: changed.filter((file) => inScope(file) && !reported.includes(file)),
    preexisting_changes: Object.keys(before).sort(),
    note: 'Advisory shared-worktree evidence, not proof of authorship or test execution. Ignored files are not scanned. HEAD changes require manual diff review.',
  };
}
