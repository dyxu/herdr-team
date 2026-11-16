import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonical } from './config.js';
import { readState, startupDirectory } from './state.js';
import { inspectLock, recoverLock } from './locks.js';
import type { Env, Output } from './types.js';

export const recordUsage =
  'record list [project] | record show <record-file> | record lock <inspect|recover> <record-file>';
export function parseRecord(args: string[]) {
  if (args[0] === 'list' && args.length <= 2) return;
  if (args[0] === 'show' && args.length === 2) return;
  if (args[0] === 'lock' && ['inspect', 'recover'].includes(args[1] || '') && args.length === 3)
    return;
  throw new Error(`usage: herdr-team ${recordUsage}`);
}
export async function runRecord(args: string[], env: Env, out: Output): Promise<void> {
  parseRecord(args);
  if (args[0] === 'list') {
    const project = await canonical(args[1] || '.');
    const directory = startupDirectory(env);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      names = [];
    }
    const records = [];
    for (const name of names.sort().filter((name) => name.endsWith('.json'))) {
      const file = path.join(directory, name);
      try {
        const state = await readState(file);
        if (state?.project === project) records.push({ file, startup: state });
      } catch (error) {
        // A corrupt record cannot be safely attributed to a project. Show its
        // path and error so it is not silently lost from offline diagnostics.
        records.push({ file, error: (error as Error).message });
      }
    }
    out(`${JSON.stringify({ project, live_status: 'unknown', records }, null, 2)}\n`);
    return;
  }
  const file = path.resolve(args[args.length - 1]!);
  const startup = await readState(file);
  if (!startup) throw new Error(`startup record not found: ${file}`);
  if (args[0] === 'show') {
    out(`${JSON.stringify({ file, startup, live_status: 'unknown' }, null, 2)}\n`);
    return;
  }
  out(
    `${JSON.stringify(
      args[1] === 'recover'
        ? { recovered: await recoverLock(`${file}.lock`) }
        : await inspectLock(`${file}.lock`),
      null,
      2,
    )}\n`,
  );
}
