import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  loadTeam,
  initialize,
  reportStatus,
  startupPath,
  parseAgentKindsHelp,
  resolveProject,
  initializePromptWithReadiness,
  Herdr,
} from '../bin/library.mjs';
import { fixture, fakeHerdr, readStartup, temporary } from './helpers.mjs';

test('legacy creates named panes, preserves args and cwd, initializes leader last and reuses', async (t) => {
  const f = await fixture(t),
    team = await loadTeam(f.project),
    client = fakeHerdr();
  let output = '';
  await initialize(team, f.project, 'w1', f.state, {}, client, (text) => (output += text));
  const state = await readStartup(f.state);
  assert.equal(state.status, 'ready');
  assert.ok(state.members.every((m) => m.initialized));
  const prompts = client.calls.filter((a) => a[0] === 'agent' && a[1] === 'prompt');
  assert.equal(prompts.length, 2);
  assert.match(prompts.at(-1)[2], /-leader$/);
  assert.ok(prompts[0][3].includes('Shared rules'));
  assert.ok(prompts[0][3].includes("'/path with spaces/herdr' agent"));
  for (const args of client.calls.filter(
    (a) => ['tab', 'pane'].includes(a[0]) && ['create', 'split'].includes(a[1]),
  ))
    assert.equal(args[args.indexOf('--cwd') + 1], f.project);
  const started = client.calls.filter((a) => a[1] === 'start').length;
  await initialize(team, f.project, 'w1', f.state, {}, client, () => {});
  assert.equal(client.calls.filter((a) => a[1] === 'start').length, started);
  assert.equal(client.calls.filter((a) => a[1] === 'prompt').length, 2);
  output = '';
  await reportStatus(
    client,
    startupPath(f.state, f.project, 'w1'),
    f.project,
    'w1',
    (text) => (output += text),
  );
  assert.match(output, /Team startup: ready/);
  assert.match(output, /idle/);
});
test('legacy preserves partial startup and never duplicates blocked members', async (t) => {
  const f = await fixture(t),
    team = await loadTeam(f.project),
    client = fakeHerdr();
  client.block = true;
  await assert.rejects(
    initialize(team, f.project, 'w1', f.state, {}, client, () => {}),
    /needs user input/,
  );
  const state = await readStartup(f.state);
  assert.equal(state.status, 'partial');
  assert.ok(state.members.every((m) => !m.initialized));
  const before = client.calls.filter((a) => a[1] === 'prompt').length;
  await assert.rejects(
    initialize(team, f.project, 'w1', f.state, {}, client, () => {}),
    /incomplete/,
  );
  assert.equal(client.calls.filter((a) => a[1] === 'prompt').length, before);
});
test('focus failure preserves ready state and retries only focus', async (t) => {
  const f = await fixture(t),
    team = await loadTeam(f.project),
    client = fakeHerdr();
  client.failFocus = true;
  await assert.rejects(
    initialize(team, f.project, 'w1', f.state, {}, client, () => {}),
    /focus failed/,
  );
  assert.equal((await readStartup(f.state)).status, 'ready');
  client.failFocus = false;
  await initialize(team, f.project, 'w1', f.state, {}, client, () => {});
  assert.equal(client.calls.filter((a) => a[1] === 'prompt').length, 2);
});
test('readiness refuses changed identities, working agents and blocked dialogs without prompting', async () => {
  const entry = { name: 'dev', pane_id: 'p1', terminal_id: 't1', kind: 'codex' };
  for (const changes of [
    { name: 'other' },
    { agent_status: 'working' },
    { agent_status: 'blocked' },
    { pane_id: 'other' },
  ]) {
    const client = fakeHerdr();
    client.agents = [
      {
        ...entry,
        agent: 'codex',
        workspace_id: 'w1',
        agent_status: 'idle',
        interactive_ready: true,
        ...changes,
      },
    ];
    await assert.rejects(initializePromptWithReadiness(client, entry, 'w1', 'role', 50, 1));
    assert.equal(client.calls.filter((a) => a[1] === 'prompt').length, 0);
  }
});
test('readiness is bounded even when the client returns a late idle response', async () => {
  let prompted = false;
  const entry = { name: 'dev', pane_id: 'p1', terminal_id: 't1', kind: 'codex' };
  const client = {
    bin: 'herdr',
    async call(args) {
      if (args[1] === 'prompt') prompted = true;
      await new Promise((r) => setTimeout(r, 30));
      return {
        agent: {
          ...entry,
          agent: 'codex',
          workspace_id: 'w1',
          agent_status: 'idle',
          interactive_ready: true,
        },
      };
    },
  };
  await assert.rejects(initializePromptWithReadiness(client, entry, 'w1', 'role', 10, 1));
  assert.equal(prompted, false);
});
test('kind capability discovery is scoped to the --kind help section', () => {
  assert.deepEqual(
    [
      ...parseAgentKindsHelp(
        '  --kind <KIND>\n [possible values: codex, custom-cli]\n --other X\n [possible values: bad]',
      ),
    ],
    ['codex', 'custom-cli'],
  );
  for (const help of [
    '',
    '--kind x\n --other y\n [possible values: codex]',
    '--kind x [possible values: Bad Kind]',
  ])
    assert.throws(() => parseAgentKindsHelp(help));
});
test('project context prefers explicit path then worktree, and validates workspace', async (t) => {
  const f = await fixture(t),
    other = await temporary(t),
    client = fakeHerdr();
  const env = {
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_id: 'w1',
      workspace_cwd: other,
      worktree: { checkout_path: f.project },
    }),
  };
  assert.equal((await resolveProject(env, client)).project, f.project);
  assert.equal((await resolveProject(env, client, other)).project, other);
  await assert.rejects(resolveProject({}, client, other), /workspace/);
  await assert.rejects(
    resolveProject({ HERDR_PLUGIN_CONTEXT_JSON: 'oops' }, client),
    /invalid plugin context/,
  );
});
test('structured legacy errors and argument boundaries survive subprocess execution', async (t) => {
  const dir = await temporary(t),
    bin = path.join(dir, 'herdr');
  await writeFile(
    bin,
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({error:{kind:"blocked",hint:"inspect pane"}}));\n',
    { mode: 0o700 },
  );
  await assert.rejects(
    new Herdr(bin, process.env).call([
      'agent',
      'prompt',
      'member',
      "quote '\\n ` do not execute",
      '--wait',
    ]),
    /blocked/,
  );
});
test('parallel initialization drains outstanding work, persists successes, and never initializes leader on failure', async (t) => {
  const f = await fixture(t),
    team = await loadTeam(f.project),
    client = fakeHerdr();
  team.members = [
    team.members[0],
    ...Array.from({ length: 7 }, (_, i) => ({ ...team.members[1], id: `dev${i}` })),
  ];
  team.paths = team.members.map((m) => `members/${m.id}.md`);
  let active = 0,
    maximum = 0,
    completed = 0;
  client.prompt = async (args) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((r) => setTimeout(r, args[2].endsWith('dev0') ? 5 : 25));
    active--;
    if (args[2].endsWith('dev0')) throw new Error('test failure');
    completed++;
    return { agent: { agent_status: 'done' } };
  };
  await assert.rejects(
    initialize(team, f.project, 'w1', f.state, {}, client, () => {}),
    /test failure/,
  );
  const state = await readStartup(f.state);
  assert.ok(maximum <= 4);
  assert.ok(completed >= 1);
  assert.equal(active, 0);
  assert.equal(state.members.filter((m) => m.initialized).length, completed);
  assert.equal(state.members.find((m) => m.id === 'leader').initialized, false);
  assert.equal(client.calls.filter((a) => a[1] === 'prompt').length, 4);
});
test('status can diagnose existing state even after team configuration becomes invalid', async (t) => {
  const f = await fixture(t),
    team = await loadTeam(f.project),
    client = fakeHerdr();
  await initialize(team, f.project, 'w1', f.state, {}, client, () => {});
  await writeFile(path.join(f.project, '.team/team.md'), 'broken');
  let output = '';
  await reportStatus(
    client,
    startupPath(f.state, f.project, 'w1'),
    f.project,
    'w1',
    (text) => (output += text),
  );
  assert.match(output, /Current configuration is invalid/);
  assert.match(output, /Team startup: ready/);
});
test('legacy Worker prompt cannot accidentally install the Leader role', async (t) => {
  const { rolePrompt } = await import('../bin/library.mjs');
  const f = await fixture(t),
    team = await loadTeam(f.project);
  const state = {
    project: f.project,
    leader_name: 'team-leader',
    members: [
      { id: 'leader', name: 'team-leader', pane_id: 'p1', terminal_id: 't1' },
      { id: 'dev', name: 'team-dev', pane_id: 'p2', terminal_id: 't2' },
    ],
  };
  const prompt = rolePrompt(
    team,
    team.members.find((m) => m.id === 'dev'),
    state,
    'herdr',
    '/path with spaces/herdr-team',
  );
  assert.doesNotMatch(prompt, /You are the leader/);
  assert.match(prompt, /leader reads your replies/);
  assert.match(prompt, /herdr-team/);
});
