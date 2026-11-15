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
} from '../bin/library.mjs';
import {
  coreFixture,
  coreCalls,
  count,
  readStartup,
  fixture,
  fakeHerdr,
  temporary,
} from './helpers.mjs';
async function started(t) {
  const f = await coreFixture(t);
  await run(['core', 'start', f.project], f.env, () => {});
  return f;
}
test('status json is a single read-only document with recorded and live states', async (t) => {
  const f = await started(t),
    before = await coreCalls(f.directory);
  let output = '';
  await run(['core', 'status', 'json', f.project], f.env, (text) => (output += text));
  const report = JSON.parse(output);
  assert.equal(report.schema_version, 1);
  assert.equal(report.startup.status, 'ready');
  assert.ok(report.members.every((m) => m.matches));
  const after = await coreCalls(f.directory);
  assert.equal(count(after, 'terminal.run'), count(before, 'terminal.run'));
  assert.equal(count(after, 'terminal.send'), count(before, 'terminal.send'));
});
test('status json reports corrupt records as JSON and refuses to fabricate an empty team', async (t) => {
  const f = await started(t),
    record = (await readdir(f.state)).find((n) => n.endsWith('.json'));
  await writeFile(path.join(f.state, record), 'null');
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
    terminals = JSON.parse(await readFile(file, 'utf8'));
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
    JSON.parse(await readFile(file, 'utf8')).map((t) => t.address),
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
    terminals = JSON.parse(await readFile(file, 'utf8'));
  terminals[1].name = 'changed';
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
  assert.match(state.error, /uncertain/);
  assert.equal(count(await coreCalls(f.directory), 'terminal.rm'), 0);
});
test('legacy stop closes only recorded panes, preserving user-added panes', async (t) => {
  const f = await fixture(t),
    team = await loadTeam(f.project),
    client = fakeHerdr();
  await initialize(team, f.project, 'w1', f.state, {}, client, () => {});
  client.panes.push({ pane_id: 'user-pane', terminal_id: 'user-terminal' });
  const runtime = {
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
  client.agents[1].agent = 'changed';
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
    terminals = JSON.parse(await readFile(file, 'utf8'));
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
