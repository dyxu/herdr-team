import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  run,
  loadTeam,
  initialize,
  readState,
  agentList,
  paneList,
  validateState,
} from '../bin/library.mjs';
import { coreFixture, coreCalls, count, fixture, fakeHerdr, readStartup } from './helpers.mjs';
for (const value of [null, false, 0, [], {}, { project: '/p', members: [] }])
  test(`invalid state ${JSON.stringify(value)} cannot launch another team`, async (t) => {
    const f = await coreFixture(t);
    await run(['core', 'start', f.project], f.env, () => {});
    const record = (await readdir(f.state)).find((n) => n.endsWith('.json'));
    const before = await coreCalls(f.directory);
    await writeFile(path.join(f.state, record), JSON.stringify(value));
    await assert.rejects(
      run(['core', 'start', f.project], f.env, () => {}),
      /invalid startup record/,
    );
    assert.equal(
      count(await coreCalls(f.directory), 'terminal.run'),
      count(before, 'terminal.run'),
    );
  });
for (const field of ['agents', 'panes'])
  test(`missing legacy ${field} refuses duplicate startup`, async (t) => {
    const f = await fixture(t),
      team = await loadTeam(f.project),
      client = fakeHerdr();
    await initialize(team, f.project, 'w1', f.state, {}, client, () => {});
    const call = client.call.bind(client),
      before = client.calls.filter((a) => a[1] === 'start').length;
    client.call = async (args) =>
      args[1] === 'list' && (field === 'agents' ? args[0] === 'agent' : args[0] === 'pane')
        ? {}
        : call(args);
    if (field === 'panes') client.agents = [];
    await assert.rejects(
      initialize(team, f.project, 'w1', f.state, {}, client, () => {}),
      /expected an array/,
    );
    assert.equal(client.calls.filter((a) => a[1] === 'start').length, before);
  });
for (const field of ['agent', 'pane_id'])
  test(`legacy changed ${field} cannot reuse team`, async (t) => {
    const f = await fixture(t),
      team = await loadTeam(f.project),
      client = fakeHerdr();
    await initialize(team, f.project, 'w1', f.state, {}, client, () => {});
    client.agents[1][field] = 'changed';
    const before = client.calls.filter((a) => a[1] === 'start').length;
    await assert.rejects(
      initialize(team, f.project, 'w1', f.state, {}, client, () => {}),
      /incomplete/,
    );
    assert.equal(client.calls.filter((a) => a[1] === 'start').length, before);
  });
test('old records remain readable; future schemas and duplicate identities are rejected', async (t) => {
  const f = await fixture(t),
    team = await loadTeam(f.project),
    client = fakeHerdr();
  await initialize(team, f.project, 'w1', f.state, {}, client, () => {});
  const state = await readStartup(f.state);
  delete state.schema_version;
  assert.equal(validateState(state).status, 'ready');
  assert.throws(() => validateState({ ...state, schema_version: 999 }), /unsupported/);
  assert.throws(
    () => validateState({ ...state, members: [state.members[0], state.members[0]] }),
    /duplicate/,
  );
  for (const list of [agentList, paneList]) assert.throws(() => list({}), /expected an array/);
});
