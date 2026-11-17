// Opt-in real Codex/core contract test. Never changes agent approval settings.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Core, run, openRuntime, runtimeState, TaskStore, shellQuote } from '../bin/library.mjs';
import type { Env } from '../src/types.js';

if (process.env.HERDR_TEAM_INTEGRATION !== '1') {
  console.log('SKIP: set HERDR_TEAM_INTEGRATION=1 to run real agents (uses provider quota).');
  process.exit(0);
}
const root = await realpath(await mkdtemp('/tmp/hta-'));
const project = path.join(root, 'project');
await mkdir(project);
const env: Env = {
  ...process.env,
  HC_SOCKET: path.join(root, 'core.sock'),
  HC_SESSION: 'agent-contract',
  HC_TERMINAL_ID: '',
  HERDR_ENV: '',
  HERDR_PLUGIN_STATE_DIR: path.join(root, 'state'),
  HERDR_TEAM_CLI_PATH: fileURLToPath(new URL('../bin/herdr-team', import.meta.url)),
};
for (const name of ['CONFIG', 'DATA', 'STATE', 'CACHE', 'RUNTIME']) {
  const directory = path.join(root, name.toLowerCase());
  await mkdir(directory);
  env[`XDG_${name}${name === 'RUNTIME' ? '_DIR' : '_HOME'}`] = directory;
}
const out = (text: string) => process.stdout.write(text);
const core = new Core(env.HERDR_CORE_BIN_PATH || 'herdr-core', env);
let started = false,
  passed = false;
const task = async (...args: string[]) => {
  let output = '';
  await run(['task', ...args, project], env, (text) => (output += text));
  return output;
};
const json = async (name: string, value: unknown) => {
  const file = path.join(root, name);
  await writeFile(file, JSON.stringify(value));
  return file;
};
try {
  await core.call('server.status', {});
  started = true;
  await run(['init', project, 'router-worker'], env, out);
  await writeFile(path.join(project, 'a.txt'), 'before\n');
  await writeFile(path.join(project, 'b.txt'), 'before\n');
  await run(['core', 'start', project], env, out);
  const runtime = await openRuntime('core', project, env),
    state = await runtimeState(runtime);
  assert.ok(state, 'ready startup record exists');
  const store = new TaskStore(project);
  const request = path.join(root, 'request.md');
  await writeFile(request, 'Implement the exact assigned text fixture and verify its bytes.');
  await task('create', 'T001', 'worker-a', request);
  await task('create', 'T002', 'worker-b', request);
  const a = await json('a.json', { allowed_paths: ['a.txt'] });
  const b = await json('b.json', { allowed_paths: ['b.txt'] });
  await task('scope', 'T001', '1', a);
  await assert.rejects(task('scope', 'T002', '1', a), /overlaps/);
  await task('scope', 'T002', '1', b);
  const feedback = path.join(root, 'feedback.md');
  await writeFile(feedback, 'Preserve a single trailing newline.');
  await task('feedback', 'T001', '2', feedback);
  await task('pause', 'T001', '2');
  const rejected = await json('rejected.json', {
    status: 'working',
    summary: 'must reject',
    changed_files: [],
    checks: [],
    remaining: [],
    seen_feedback: 1,
  });
  await assert.rejects(task('report', 'T001', '3', 'worker-a', rejected), /paused/);
  await task('resume', 'T001', '3');
  const cli = `${shellQuote(process.execPath)} ${shellQuote(env.HERDR_TEAM_CLI_PATH!)}`;
  const deliver = async (id: string, file: string, contents: string) => {
    const card = await store.read(id),
      member = state.members.find((m) => m.id === card.worker);
    assert.ok(member, 'assigned worker exists');
    const prompt = `Actual fixture task. Read the current task with ${cli} task show ${id} ${shellQuote(project)}.
Only modify ${file} plus report artifacts under .team/reports/. Write ${JSON.stringify(contents)} exactly to ${file}.
Submit a working report before editing; run a real Node assertion of the exact bytes, then submit a ready report using task report ${id} ${card.version} ${card.worker}.
The ready report must contain changed_files, actual checks, remaining=[], and seen_feedback=${card.feedback.length}.
Do not finish/archive or send completion prompts to other members. End your turn after the report is accepted.`;
    await core.initializeRole(member, project, state.leader_name, prompt, out);
    assert.equal(
      (await store.read(id)).status,
      'ready',
      `${id} agent did not submit a ready report`,
    );
    assert.equal(await readFile(path.join(project, file), 'utf8'), contents);
  };
  const workers = await Promise.allSettled([
    deliver('T001', 'a.txt', 'alpha\n'),
    deliver('T002', 'b.txt', 'beta\n'),
  ]);
  const failures = workers.filter((result) => result.status === 'rejected');
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Real worker task failed',
    );
  console.log('PASS: real workers, parallel tasks, conflict rejection, feedback and pause/resume');
  const handoff = await json('handoff.json', {
    summary: 'Worker A has ended its turn; transfer the settled ready task.',
    remaining: ['replace text with alpha-reviewed'],
    context_files: ['a.txt'],
    worker_released: true,
  });
  await task('assign', 'T001', '4', 'worker-b', handoff);
  await deliver('T001', 'a.txt', 'alpha-reviewed\n');
  const leader = state.members.find((m) => m.id === 'leader');
  assert.ok(leader, 'leader exists');
  await core.initializeRole(
    leader,
    project,
    state.leader_name,
    `Read-only final review of fixture files. Run Node assertions that a.txt is exactly "alpha-reviewed\\n" and b.txt exactly "beta\\n". Read T001/T002 with ${cli} task show. Do not change implementation or task state. Write .team/final-verification.json with summary, checks (actual commands and passed results), remaining=[] only if all assertions pass. End the turn.`,
    out,
  );
  const proof = path.join(project, '.team/final-verification.json');
  for (const id of ['T001', 'T002']) {
    const card = await store.read(id);
    await task('finish', id, String(card.version), proof);
    await task('archive', id, String(card.version));
    assert.equal((await store.readAny(id)).status, 'done');
  }
  assert.equal(await readFile(path.join(project, 'a.txt'), 'utf8'), 'alpha-reviewed\n');
  assert.equal(await readFile(path.join(project, 'b.txt'), 'utf8'), 'beta\n');
  console.log('PASS: real handoff, independent leader verification and archive');
  passed = true;
} finally {
  if (started) {
    // Every terminal on this private socket belongs to this fixture.
    const terminals = await core.terminals();
    for (const terminal of terminals) {
      try {
        await writeFile(
          path.join(root, `${terminal.address.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`),
          JSON.stringify(
            await core.call('terminal.read', { terminal: terminal.address, lines: 200 }),
            null,
            2,
          ),
        );
      } catch {
        /* Preserve other evidence even if a terminal has already gone. */
      }
      if (terminal.state === 'live')
        await core.call('terminal.kill', { terminal: terminal.address });
      await core.call('terminal.rm', { terminal: terminal.address });
    }
    await core.call('server.stop', {});
  }
  if (passed) await rm(root, { recursive: true, force: true });
  else
    console.error(
      `FAILED: evidence retained at ${root}; permission dialogs are never approved automatically.`,
    );
}
