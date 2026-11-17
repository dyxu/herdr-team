import type { TestContext } from 'node:test';
import type { CoreTerminal } from '../src/types.js';
import type { Runtime } from '../src/runtime.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import path from 'node:path';
import {
  run,
  openRuntime,
  stopTeam,
  loadTeam,
  initialize,
  startupPath,
  inspectLock,
  recoverLock,
  lock,
  memberViews,
  reportStatus,
  statusSnapshot,
} from '../bin/library.mjs';
import {
  coreFixture,
  coreCalls,
  count,
  readStartup,
  fixture,
  fakeHerdr,
  temporary,
} from './helpers.ts';
async function started(t: TestContext) {
  const f = await coreFixture(t);
  await run(['core', 'start', f.project], f.env, () => {});
  return f;
}
test('offline records inspect history and recover a dead lock without contacting the backend', async (t) => {
  const f = await started(t);
  const file = path.join(
    f.state,
    (await readdir(f.state)).find((n) => n.endsWith('.json'))!,
  );
  const env = {
    ...f.env,
    HERDR_CORE_BIN_PATH: '/does-not-exist',
    HERDR_ENV: '1',
    HERDR_BIN_PATH: '/does-not-exist',
  };
  const command = async (...args: string[]) => {
    let output = '';
    await run(['record', ...args], env, (s) => (output += s));
    return JSON.parse(output);
  };
  const before = await coreCalls(f.directory);
  assert.equal((await command('list', f.project)).records[0].file, file);
  assert.equal((await command('show', file)).live_status, 'unknown');
  assert.equal((await command('lock', 'inspect', file)).exists, false);
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  await mkdir(`${file}.lock.d`);
  await writeFile(
    path.join(`${file}.lock.d`, 'owner.json'),
    JSON.stringify({ pid, hostname: hostname(), created: new Date().toISOString(), token: 'dead' }),
  );
  assert.equal((await command('lock', 'recover', file)).recovered, true);
  assert.deepEqual(await coreCalls(f.directory), before);
  await assert.rejects(
    command('lock', 'recover', path.join(f.directory, 'missing.json')),
    /not found/,
  );
});
test('status json is a single read-only document with recorded and live states', async (t) => {
  const f = await started(t),
    before = await coreCalls(f.directory);
  let output = '';
  await run(['core', 'status', 'json', f.project], f.env, (text) => (output += text));
  const report = JSON.parse(output) as Awaited<ReturnType<typeof statusSnapshot>>;
  assert.equal(report.schema_version, 1);
  assert.ok(report.startup);
  assert.equal(report.startup.status, 'ready');
  assert.ok(report.members.every((m) => m.matches));
  const after = await coreCalls(f.directory);
  assert.equal(count(after, 'terminal.run'), count(before, 'terminal.run'));
  assert.equal(count(after, 'terminal.send'), count(before, 'terminal.send'));
});
test('status json reports corrupt records as JSON and refuses to fabricate an empty team', async (t) => {
  const f = await started(t),
    record = (await readdir(f.state)).find((n) => n.endsWith('.json'));
  await writeFile(path.join(f.state, record!), 'null');
  let output = '';
  await assert.rejects(
    run(['core', 'status', 'json', f.project], f.env, (text) => (output += text)),
    /invalid startup/,
  );
  assert.match(JSON.parse(output).error, /invalid startup/);
});
test('doctor does not start or prompt Agents and does not infer login from executable presence', async (t) => {
  const f = await started(t);
  await writeFile(path.join(f.directory, 'codex'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const env = { ...f.env, PATH: `${f.directory}${path.delimiter}${f.env.PATH}` },
    before = await coreCalls(f.directory);
  let output = '';
  await run(['core', 'doctor', f.project], env, (text) => (output += text));
  assert.match(output, /not verified/);
  assert.match(output, /login and tool permissions are not inferred/);
  const after = await coreCalls(f.directory);
  assert.equal(count(after, 'terminal.run'), count(before, 'terminal.run'));
  assert.equal(count(after, 'terminal.send'), count(before, 'terminal.send'));
});
test('doctor compares task ownership and pause metadata with live members', async (t) => {
  const f = await started(t),
    request = path.join(f.directory, 'request.md');
  await writeFile(request, 'fixture task');
  await writeFile(path.join(f.directory, 'codex'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const env = { ...f.env, PATH: `${f.directory}${path.delimiter}${f.env.PATH}` };
  await run(['task', 'create', 'T001', 'dev', request, f.project], env, () => {});
  await run(['task', 'pause', 'T001', '1', f.project], env, () => {});
  let output = '';
  await run(['doctor', f.project], env, (s) => (output += s));
  assert.match(output, /SKIP task:T001: waiting \(paused\).*compare the actual output/);
  const cardFile = path.join(f.project, '.team/tasks/active/T001.json');
  const card = JSON.parse(await readFile(cardFile, 'utf8'));
  card.worker = 'missing';
  await writeFile(cardFile, JSON.stringify(card));
  output = '';
  await assert.rejects(
    run(['doctor', f.project], env, (s) => (output += s)),
    /doctor found problems/,
  );
  assert.match(output, /FAIL task:T001:.*worker=missing/);
});
test('doctor prints local diagnostics even if the backend is unavailable', async (t) => {
  const f = await fixture(t);
  let output = '';
  await assert.rejects(
    run(
      ['core', 'doctor', f.project],
      { ...process.env, HERDR_CORE_BIN_PATH: '/does-not-exist' },
      (text) => (output += text),
    ),
    /doctor could not connect/,
  );
  assert.match(output, /OK configuration/);
  assert.match(output, /FAIL backend/);
});
test('core stop preserves unrelated terminals and can be repeated', async (t) => {
  const f = await started(t),
    file = path.join(f.directory, 'terminals'),
    terminals: CoreTerminal[] = JSON.parse(await readFile(file, 'utf8'));
  terminals.push({
    address: 't99',
    name: 'unrelated',
    cwd: f.project,
    labels: {},
    state: 'live',
    status: { state: 'working' },
  });
  await writeFile(file, JSON.stringify(terminals));
  await run(['core', 'stop', f.project], f.env, () => {});
  assert.equal((await readStartup(f.state)).status, 'stopped');
  assert.deepEqual(
    JSON.parse(await readFile(file, 'utf8')).map((t: CoreTerminal) => t.address),
    ['t99'],
  );
  await run(['core', 'stop', f.project], f.env, () => {});
  const calls = await coreCalls(f.directory);
  assert.equal(count(calls, 'terminal.kill'), 2);
  await run(['core', 'start', f.project], f.env, () => {});
  assert.equal((await readStartup(f.state)).status, 'ready');
});
test('core stop preflights all identities before killing the first terminal', async (t) => {
  const f = await started(t),
    file = path.join(f.directory, 'terminals'),
    terminals: CoreTerminal[] = JSON.parse(await readFile(file, 'utf8'));
  terminals[1]!.name = 'changed';
  await writeFile(file, JSON.stringify(terminals));
  await assert.rejects(
    run(['core', 'stop', f.project], f.env, () => {}),
    /identity-changed/,
  );
  assert.equal(count(await coreCalls(f.directory), 'terminal.kill'), 0);
  assert.equal((await readStartup(f.state)).status, 'ready');
});
test('core stop recovers only its planned labeled launch when the launch response was lost', async (t) => {
  const f = await coreFixture(t, 'lost-launch');
  await assert.rejects(run(['core', 'start', f.project], f.env, () => {}));
  await run(['core', 'stop', f.project], f.env, () => {});
  assert.equal((await readStartup(f.state)).status, 'stopped');
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, 'terminals'), 'utf8')), []);
});
test('uncertain stop saves stopping state and does not silently continue', async (t) => {
  const f = await started(t);
  await writeFile(path.join(f.directory, 'mode'), 'kill-failure');
  await assert.rejects(
    run(['core', 'stop', f.project], f.env, () => {}),
    /uncertain/,
  );
  const state = await readStartup(f.state);
  assert.equal(state.status, 'stopping');
  assert.match(state.error!, /uncertain/);
  assert.equal(count(await coreCalls(f.directory), 'terminal.rm'), 0);
});
test('legacy stop closes only recorded panes, preserving user-added panes', async (t) => {
  const f = await fixture(t),
    team = await loadTeam(f.project),
    client = fakeHerdr();
  await initialize(team, f.project, 'w1', f.state, {}, client, () => {});
  client.panes.push({ pane_id: 'user-pane', terminal_id: 'user-terminal' });
  const runtime: Runtime = {
    backend: 'herdr',
    project: f.project,
    workspace: 'w1',
    file: startupPath(f.state, f.project, 'w1'),
    client,
  };
  await stopTeam(runtime, () => {});
  assert.deepEqual(
    client.panes.map((p) => p.pane_id),
    ['user-pane'],
  );
  assert.equal((await readStartup(f.state)).status, 'stopped');
});
test('legacy stop refuses changed kind without closing any pane', async (t) => {
  const f = await fixture(t),
    team = await loadTeam(f.project),
    client = fakeHerdr();
  await initialize(team, f.project, 'w1', f.state, {}, client, () => {});
  client.agents[1]!.agent = 'changed';
  await assert.rejects(
    stopTeam(
      {
        backend: 'herdr',
        project: f.project,
        workspace: 'w1',
        file: startupPath(f.state, f.project, 'w1'),
        client,
      },
      () => {},
    ),
    /identity-changed/,
  );
  assert.equal(client.calls.filter((a) => a[1] === 'close').length, 0);
});
test('text and JSON member views both reject an agent whose pane identity changed', async (t) => {
  const f = await fixture(t),
    team = await loadTeam(f.project),
    client = fakeHerdr();
  await initialize(team, f.project, 'w1', f.state, {}, client, () => {});
  const state = await readStartup(f.state),
    member = state.members[0]!;
  client.panes.find((p) => p.pane_id === member.pane_id)!.terminal_id = 'replaced';
  const views = memberViews({ backend: 'herdr', project: f.project, workspace: 'w1' }, state, {
    terminals: [],
    agents: client.agents,
    panes: client.panes,
  });
  assert.equal(views[0]!.current_status, 'identity changed');
  let output = '';
  await reportStatus(
    client,
    startupPath(f.state, f.project, 'w1'),
    f.project,
    'w1',
    (s) => (output += s),
  );
  assert.match(output, /identity changed/);
});
test('lock diagnosis refuses live owners and only recovers a dead local owner', async (t) => {
  const dir = await temporary(t),
    file = path.join(dir, 'startup.lock'),
    unlock = await lock(file);
  assert.equal((await inspectLock(file)).process, 'alive');
  await assert.rejects(recoverLock(file), /refusing/);
  await unlock();
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  await mkdir(`${file}.d`);
  await writeFile(
    path.join(`${file}.d`, 'owner.json'),
    JSON.stringify({
      pid,
      hostname: hostname(),
      created: new Date().toISOString(),
      token: 'stale-token',
    }),
  );
  assert.equal((await inspectLock(file)).can_recover, true);
  assert.equal(await recoverLock(file), true);
  assert.equal((await inspectLock(file)).exists, false);
  assert.equal(await recoverLock(file), false);
});
test('foreign and malformed lock owners cannot be removed by recovery', async (t) => {
  const dir = await temporary(t),
    file = path.join(dir, 'startup.lock');
  await mkdir(`${file}.d`);
  for (const value of [
    { pid: 1, created: 'now' },
    { pid: 2147483647, hostname: 'another-host', created: 'now', token: 'x' },
  ]) {
    await writeFile(path.join(`${file}.d`, 'owner.json'), JSON.stringify(value));
    await assert.rejects(recoverLock(file), /refusing/);
    assert.equal((await inspectLock(file)).exists, true);
  }
});
test('communication diagnosis refuses busy members without sending probes', async (t) => {
  const f = await started(t),
    file = path.join(f.directory, 'terminals'),
    terminals: CoreTerminal[] = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(terminals[1]?.status);
  terminals[1].status.state = 'working';
  await writeFile(file, JSON.stringify(terminals));
  const before = await coreCalls(f.directory);
  await assert.rejects(
    run(['core', 'doctor', 'communication', f.project], f.env, () => {}),
    /settled/,
  );
  assert.equal(
    count(await coreCalls(f.directory), 'terminal.send'),
    count(before, 'terminal.send'),
  );
});

test('orphan locks and interrupted recovery guards produce explicit manual diagnostics', async (t) => {
  const dir = await temporary(t),
    file = path.join(dir, 'startup.lock');
  await mkdir(`${file}.d`);
  let report = await inspectLock(file);
  assert.equal(report.manual_recovery_required, true);
  assert.equal(report.can_recover, false);
  await assert.rejects(recoverLock(file), /refusing/);
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  await mkdir(`${file}.recover.d`);
  await writeFile(
    path.join(`${file}.recover.d`, 'owner.json'),
    JSON.stringify({
      pid,
      hostname: hostname(),
      created: new Date().toISOString(),
      token: 'guard',
    }),
  );
  report = await inspectLock(file);
  assert.equal(report.recovery_process, 'dead');
  assert.equal(report.recovery_owner!.token, 'guard');
  assert.equal(report.manual_recovery_required, true);
  await assert.rejects(lock(file), /recovery/);
  await assert.rejects(recoverLock(file), /another lock recovery/);
  await rm(path.join(`${file}.recover.d`, 'owner.json'));
  assert.match((await inspectLock(file)).recovery_error!, /ENOENT/);
});
