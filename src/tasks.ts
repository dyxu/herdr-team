import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonical, loadTeam, within, validID } from './config.js';
import { lock, inspectLock, recoverLock } from './locks.js';
import { object, text, array } from './validation.js';
import type { Output } from './types.js';

const statuses = [
  'queued',
  'working',
  'waiting',
  'ready',
  'blocked',
  'failed',
  'dropped',
  'done',
] as const;
type TaskStatus = (typeof statuses)[number];
interface Check {
  command: string;
  result: 'passed' | 'failed' | 'not_run';
  details?: string;
}
interface Report {
  status: TaskStatus;
  summary: string;
  changed_files: string[];
  checks: Check[];
  remaining: string[];
  version: number;
  worker: string;
  seen_feedback: number;
}
export interface TaskCard {
  schema_version: 1;
  id: string;
  version: number;
  worker: string;
  status: TaskStatus;
  original_request: string;
  allowed_paths: string[];
  dependencies: string[];
  paused: boolean;
  feedback: { text: string; at: string }[];
  handoff: {
    summary: string;
    remaining: string[];
    context_files: string[];
    worker_released: boolean;
  } | null;
  created: string;
  updated: string;
  last_report: string | null;
  verification: string | null;
}
const active = (card: TaskCard) =>
  !card.paused && !['ready', 'dropped', 'done'].includes(card.status);
const taskID = (id: string) => {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(id)) throw new Error('invalid task ID');
  return id;
};
const version = (value: string) => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error('version must be a positive integer');
  return Number(value);
};
const strings = (value: unknown, label: string) =>
  array(value, label).map((v, i) => text(v, `${label}[${i}]`, true));
function relative(value: string): string {
  if (!value || value.includes('\0') || path.isAbsolute(value))
    throw new Error('scope and changed files must be project-relative paths');
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`))
    throw new Error('path escapes project');
  if (normalized === '.team' || normalized.startsWith(`.team${path.sep}tasks`))
    throw new Error('task control files are reserved');
  return normalized;
}
async function physical(project: string, value: string): Promise<string> {
  let current = path.join(project, relative(value));
  const missing: string[] = [];
  while (true) {
    try {
      const resolved = path.join(await realpath(current), ...missing.reverse());
      if (!within(project, resolved)) throw new Error('scope path resolves outside project');
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
async function readData(file: string): Promise<unknown> {
  const info = await lstat(file);
  if (!info.isFile() || info.size > 1024 * 1024)
    throw new Error(`expected an ordinary file of at most 1 MiB: ${file}`);
  return JSON.parse(await readFile(file, 'utf8'));
}
function validateCard(value: unknown): TaskCard {
  const card = object(value, 'task card');
  if (card.schema_version !== 1) throw new Error('unsupported task schema');
  taskID(text(card.id, 'task.id'));
  if (typeof card.version !== 'number') throw new Error('task version must be numeric');
  version(String(card.version));
  text(card.worker, 'task.worker');
  text(card.original_request, 'task.original_request');
  if (!statuses.includes(card.status as TaskStatus) || typeof card.paused !== 'boolean')
    throw new Error('invalid task state');
  strings(card.allowed_paths, 'task.allowed_paths').forEach(relative);
  strings(card.dependencies, 'task.dependencies').forEach(taskID);
  for (const key of ['created', 'updated']) text(card[key], `task.${key}`);
  for (const key of ['last_report', 'verification'])
    if (card[key] !== null) {
      const pointer = text(card[key], `task.${key}`);
      if (path.isAbsolute(pointer) || path.normalize(pointer).startsWith('..'))
        throw new Error('invalid report pointer');
    }
  for (const item of array(card.feedback, 'task.feedback')) {
    const f = object(item, 'feedback');
    text(f.text, 'feedback.text');
    text(f.at, 'feedback.at');
  }
  if (card.handoff !== null) {
    const h = object(card.handoff, 'handoff');
    text(h.summary, 'handoff.summary');
    strings(h.remaining, 'handoff.remaining');
    strings(h.context_files, 'handoff.context_files');
    if (h.worker_released !== true) throw new Error('handoff must confirm worker_released');
  }
  return card as unknown as TaskCard;
}
async function ordinaryDirectory(directory: string) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink())
    throw new Error(`task directory must not be a symlink: ${directory}`);
}
export class TaskStore {
  readonly root: string;
  constructor(readonly project: string) {
    this.root = path.join(project, '.team/tasks');
  }
  async prepare() {
    await ordinaryDirectory(this.root);
    for (const dir of ['active', 'archive', 'reports'])
      await ordinaryDirectory(path.join(this.root, dir));
  }
  file(id: string, archived = false) {
    return path.join(this.root, archived ? 'archive' : 'active', `${taskID(id)}.json`);
  }
  async readAny(id: string): Promise<TaskCard> {
    try {
      return await this.read(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const card = validateCard(await readData(this.file(id, true)));
    if (card.id !== id) throw new Error('archived task identity does not match filename');
    return card;
  }
  async read(id: string): Promise<TaskCard> {
    const card = validateCard(await readData(this.file(id)));
    if (card.id !== id) throw new Error('task identity does not match filename');
    for (const pointer of [card.last_report, card.verification])
      if (
        pointer &&
        !within(path.join(this.root, 'reports', card.id), path.resolve(this.project, pointer))
      )
        throw new Error('report pointer escapes task reports');
    return card;
  }
  async all(): Promise<TaskCard[]> {
    try {
      const names = await readdir(path.join(this.root, 'active'));
      const cards = [];
      for (const name of names.sort())
        if (name.endsWith('.json')) cards.push(await this.read(name.slice(0, -5)));
      return cards;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async write(card: TaskCard) {
    card.updated = new Date().toISOString();
    validateCard(card);
    const file = this.file(card.id),
      temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    const encoded = `${JSON.stringify(card, null, 2)}\n`;
    if (Buffer.byteLength(encoded) > 1024 * 1024)
      throw new Error('task card exceeds 1 MiB; split the task or reduce inline context');
    await writeFile(temp, encoded, { mode: 0o600 });
    await rename(temp, file);
  }
  async worker(id: string) {
    const team = await loadTeam(this.project);
    if (!validID.test(id) || id === team.leader || !team.members.some((m) => m.id === id))
      throw new Error(`worker is not a non-leader member: ${id}`);
  }
  async free(worker: string, except = '') {
    if ((await this.all()).some((c) => c.id !== except && c.worker === worker && active(c)))
      throw new Error(`worker ${worker} already has an unhanded task`);
  }
  async scope(card: TaskCard, paths: string[]) {
    const proposed = await Promise.all(paths.map((p) => physical(this.project, p)));
    for (const other of await this.all())
      if (other.id !== card.id && !['done', 'dropped'].includes(other.status))
        for (const assigned of other.allowed_paths) {
          const existing = await physical(this.project, assigned);
          if (proposed.some((p) => within(p, existing) || within(existing, p)))
            throw new Error(`scope overlaps active task ${other.id}: ${assigned}`);
        }
  }
  async index() {
    const cards = await this.all(),
      index = path.join(this.project, '.team/tasks.md'),
      marker = '<!-- herdr-team task index v1 -->';
    try {
      const info = await lstat(index);
      if (!info.isFile()) throw new Error('task index is not an ordinary file');
      const old = await readFile(index, 'utf8');
      if (!old.startsWith(marker))
        await writeFile(
          path.join(this.root, `legacy-index-${randomBytes(6).toString('hex')}.md`),
          old,
          { flag: 'wx', mode: 0o600 },
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const content = `${marker}\n# Active tasks\n\n| Task | Version | Worker | State | Paused | Scope |\n| --- | --- | --- | --- | --- | --- |\n${cards.map((c) => `| ${c.id} | ${c.version} | ${c.worker} | ${c.status} | ${c.paused} | ${c.allowed_paths.map((p) => p.replaceAll('|', '\\|').replace(/[\r\n]/g, ' ')).join(', ')} |`).join('\n')}\n\nTask cards and reports: .team/tasks/. Completed tasks are archived explicitly.\n`;
    const temp = `${index}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, index);
  }
  check(card: TaskCard, expected: string) {
    if (card.version !== version(expected))
      throw new Error(`stale task version: expected ${card.version}, received ${expected}`);
  }
  async reportFile(card: TaskCard, value: unknown): Promise<string> {
    const directory = path.join(this.root, 'reports', card.id);
    await ordinaryDirectory(directory);
    const file = path.join(directory, `${card.version}-${randomBytes(8).toString('hex')}.json`);
    const encoded = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('task report exceeds 1 MiB');
    await writeFile(file, encoded, { flag: 'wx', mode: 0o600 });
    return path.relative(this.project, file);
  }
}
export const taskUsages: Record<string, string> = {
  list: 'task list [project]',
  show: 'task show <id> [project]',
  create: 'task create <id> <worker> <request-file> [project]',
  scope: 'task scope <id> <version> <scope-file> [project]',
  assign: 'task assign <id> <version> <worker> <handoff-file> [project]',
  report: 'task report <id> <version> <worker> <report-file> [project]',
  finish: 'task finish <id> <version> <verification-file> [project]',
  archive: 'task archive <id> <version> [project]',
  pause: 'task pause <id> <version> [project]',
  resume: 'task resume <id> <version> [project]',
  feedback: 'task feedback <id> <version> <feedback-file> [project]',
  lock: 'task lock <inspect|recover> [project]',
};
const arity: Record<string, number> = {
  list: 0,
  show: 1,
  create: 3,
  scope: 3,
  assign: 4,
  report: 4,
  finish: 3,
  archive: 2,
  pause: 2,
  resume: 2,
  feedback: 3,
  lock: 1,
};
export function parseTask(args: string[]) {
  const action = args[0] || '';
  if (!Object.hasOwn(taskUsages, action))
    throw new Error(`unknown task action; ${Object.values(taskUsages).join('\n')}`);
  const values = args.slice(1),
    count = arity[action]!;
  if (values.length < count || values.length > count + 1)
    throw new Error(`usage: herdr-team ${taskUsages[action]}`);
  if (action === 'lock' && !['inspect', 'recover'].includes(values[0]!))
    throw new Error('task lock expects inspect or recover');
  return { action, args: values.slice(0, count), project: values[count] ?? '' };
}
function checks(value: unknown): Check[] {
  return array(value, 'checks').map((item) => {
    const check = object(item, 'check');
    text(check.command, 'check.command');
    if (!['passed', 'failed', 'not_run'].includes(check.result as string))
      throw new Error('invalid check result');
    if (check.details !== undefined) text(check.details, 'check.details', true);
    return check as unknown as Check;
  });
}
export async function runTask(
  action: string,
  args: string[],
  project: string,
  out: Output,
): Promise<void> {
  project = await canonical(project || '.');
  const store = new TaskStore(project);
  if (action === 'list') {
    out(
      `${JSON.stringify(
        (await store.all()).map((c) => ({
          id: c.id,
          version: c.version,
          worker: c.worker,
          status: c.status,
          paused: c.paused,
          allowed_paths: c.allowed_paths,
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (action === 'show') {
    const card = await store.readAny(args[0]!);
    let last_report: unknown = null;
    if (card.last_report) {
      const target = path.join(project, card.last_report);
      if (!within(path.join(store.root, 'reports', card.id), await canonical(target)))
        throw new Error('report pointer escapes task reports');
      last_report = await readData(target);
    }
    out(
      `${JSON.stringify({ ...card, last_report_path: card.last_report, last_report }, null, 2)}\n`,
    );
    return;
  }
  await store.prepare();
  if (action === 'lock') {
    out(
      `${JSON.stringify(args[0] === 'recover' ? { recovered: await recoverLock(path.join(store.root, '.lock')) } : await inspectLock(path.join(store.root, '.lock')), null, 2)}\n`,
    );
    return;
  }
  const release = await lock(path.join(store.root, '.lock'));
  try {
    const id = taskID(args[0]!);
    let card: TaskCard;
    if (action === 'create') {
      await store.worker(args[1]!);
      await store.free(args[1]!);
      for (const archived of [false, true])
        try {
          await lstat(store.file(id, archived));
          throw new Error('task ID already exists, including archived tasks');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      const source = args[2]!,
        info = await lstat(source);
      if (!info.isFile() || info.size > 1024 * 1024)
        throw new Error('request must be an ordinary file of at most 1 MiB');
      const request = text(await readFile(source, 'utf8'), 'original request');
      const now = new Date().toISOString();
      card = {
        schema_version: 1,
        id,
        version: 1,
        worker: args[1]!,
        status: 'queued',
        original_request: request,
        allowed_paths: [],
        dependencies: [],
        paused: false,
        feedback: [],
        handoff: null,
        created: now,
        updated: now,
        last_report: null,
        verification: null,
      };
    } else {
      card = await store.read(id);
      store.check(card, args[1]!);
      if (['done', 'dropped'].includes(card.status) && !['archive', 'feedback'].includes(action))
        throw new Error('completed task must not be silently reopened; create a new task');
      if (action === 'scope') {
        if (card.paused) throw new Error('task is paused');
        if (card.status === 'working')
          throw new Error('working task must hand off before scope changes');
        await store.free(card.worker, id);
        const value = object(await readData(args[2]!), 'scope');
        const allowed = strings(value.allowed_paths, 'scope.allowed_paths').map(relative);
        const dependencies = strings(value.dependencies ?? [], 'scope.dependencies').map(taskID);
        if (dependencies.includes(id)) throw new Error('task cannot depend on itself');
        const visited = new Set<string>();
        const visit = async (dep: string): Promise<void> => {
          if (dep === id) throw new Error('task dependency cycle');
          if (visited.has(dep)) return;
          visited.add(dep);
          for (const nested of (await store.readAny(dep)).dependencies) await visit(nested);
        };
        for (const dep of dependencies) await visit(dep);
        await store.scope(card, allowed);
        card.allowed_paths = allowed;
        card.dependencies = dependencies;
        card.version++;
        card.status = 'queued';
      } else if (action === 'assign') {
        if (card.status === 'working')
          throw new Error('working task must report a handoff before reassignment');
        await store.worker(args[2]!);
        await store.free(args[2]!, id);
        const h = object(await readData(args[3]!), 'handoff');
        text(h.summary, 'handoff.summary');
        strings(h.remaining, 'handoff.remaining');
        strings(h.context_files, 'handoff.context_files');
        if (h.worker_released !== true) throw new Error('handoff must confirm worker_released');
        card.handoff = h as unknown as TaskCard['handoff'];
        card.worker = args[2]!;
        card.version++;
        card.status = 'queued';
        await store.scope(card, card.allowed_paths);
      } else if (action === 'pause') {
        card.paused = true;
        card.version++;
        card.status = 'waiting';
      } else if (action === 'resume') {
        if (!card.paused) throw new Error('task is not paused');
        await store.free(card.worker, id);
        await store.scope(card, card.allowed_paths);
        card.paused = false;
        card.version++;
        card.status = 'queued';
      } else if (action === 'feedback') {
        const file = args[2]!,
          info = await lstat(file);
        if (!info.isFile() || info.size > 1024 * 1024)
          throw new Error('feedback must be an ordinary file of at most 1 MiB');
        card.feedback.push({
          text: text(await readFile(file, 'utf8'), 'feedback'),
          at: new Date().toISOString(),
        });
      } else if (action === 'report') {
        if (args[2] !== card.worker)
          throw new Error('report worker does not own the current assignment');
        const value = object(await readData(args[3]!), 'report');
        const report: Report = {
          status: value.status as TaskStatus,
          summary: text(value.summary, 'report.summary'),
          changed_files: strings(value.changed_files, 'report.changed_files').map(relative),
          checks: checks(value.checks),
          remaining: strings(value.remaining, 'report.remaining'),
          version: card.version,
          worker: card.worker,
          seen_feedback: (value.seen_feedback ?? 0) as number,
        };
        if (
          !['working', 'waiting', 'ready', 'blocked', 'failed', 'dropped'].includes(report.status)
        )
          throw new Error('invalid report status');
        if (card.paused && !['waiting', 'blocked', 'failed'].includes(report.status))
          throw new Error('paused task cannot resume through a report');
        if (
          !Number.isSafeInteger(report.seen_feedback) ||
          report.seen_feedback !== card.feedback.length
        )
          throw new Error('report must acknowledge all pending feedback');
        const allowed = await Promise.all(card.allowed_paths.map((p) => physical(project, p)));
        for (const file of report.changed_files) {
          const target = await physical(project, file);
          if (!allowed.some((scope) => within(scope, target)))
            throw new Error(`reported change outside granted scope: ${file}`);
        }
        if (
          report.status === 'ready' &&
          (report.remaining.length ||
            !report.checks.length ||
            report.checks.some((c) => c.result !== 'passed'))
        )
          throw new Error('unfinished or failed work is not ready');
        if (['working', 'ready'].includes(report.status))
          for (const dependency of card.dependencies)
            if ((await store.readAny(dependency)).status !== 'done')
              throw new Error(`dependency not done: ${dependency}`);
        if (!card.paused && ['working', 'waiting', 'blocked', 'failed'].includes(report.status))
          await store.free(card.worker, id);
        card.last_report = await store.reportFile(card, report);
        card.status = report.status;
      } else if (action === 'finish') {
        if (card.paused || card.status !== 'ready' || !card.last_report)
          throw new Error('only an unpaused ready task can finish');
        const previous = object(await readData(path.join(project, card.last_report)), 'report');
        if (previous.seen_feedback !== card.feedback.length)
          throw new Error('ready report has not acknowledged the latest feedback');
        if (previous.version !== card.version)
          throw new Error('ready report is from a stale assignment');
        const proof = object(await readData(args[2]!), 'verification');
        text(proof.summary, 'verification.summary');
        const results = checks(proof.checks);
        if (
          !results.length ||
          results.some((c) => c.result !== 'passed') ||
          strings(proof.remaining, 'verification.remaining').length
        )
          throw new Error('final verification must pass without remaining work');
        card.verification = await store.reportFile(card, {
          ...proof,
          version: card.version,
          kind: 'final-verification',
        });
        card.status = 'done';
      } else if (action === 'archive') {
        if (!['done', 'dropped'].includes(card.status))
          throw new Error('only completed tasks can be archived');
        try {
          await lstat(store.file(id, true));
          throw new Error('archive already exists');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await rename(store.file(id), store.file(id, true));
        await store.index();
        out(`Archived ${id}.\n`);
        return;
      }
    }
    await store.write(card);
    await store.index();
    out(`${JSON.stringify(card, null, 2)}\n`);
  } finally {
    await release();
  }
}
