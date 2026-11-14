import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  run,
  Core,
  coreCall,
  corePrompt,
  loadTeam,
  startupSendWasNotTyped,
  CoreRPCError,
} from '../bin/library.mjs';
import { coreFixture, coreCalls, count, readStartup, root } from './helpers.mjs';

async function checkContract(calls) {
  const schema = JSON.parse(
    await readFile(path.join(root, 'testdata/herdr-core/released.openrpc.json'), 'utf8'),
  );
  const check = (rule, value) => {
    if (rule.$ref) {
      let target = schema;
      for (const part of rule.$ref.replace('#/', '').split('/')) target = target[part];
      return check(target, value);
    }
    if (rule.anyOf) return rule.anyOf.some((candidate) => check(candidate, value));
    if (rule.enum && !rule.enum.includes(value)) return false;
    const type = (kind) =>
      kind === 'null'
        ? value === null
        : kind === 'array'
          ? Array.isArray(value)
          : kind === 'integer'
            ? Number.isInteger(value)
            : kind === 'number'
              ? typeof value === 'number'
              : kind === 'object'
                ? !!value && !Array.isArray(value) && typeof value === 'object'
                : typeof value === kind;
    if (rule.type && !(Array.isArray(rule.type) ? rule.type.some(type) : type(rule.type)))
      return false;
    if (rule.items && !value.every((item) => check(rule.items, item))) return false;
    if (
      typeof rule.additionalProperties === 'object' &&
      !Object.values(value).every((item) => check(rule.additionalProperties, item))
    )
      return false;
    return true;
  };
  for (const req of calls) {
    const method = schema.methods.find((method) => method.name === req.method);
    assert.ok(method, req.method);
    for (const p of method.params)
      if (p.required) assert.ok(p.name in req.params, `${req.method}.${p.name} required`);
    for (const [name, value] of Object.entries(req.params)) {
      const param = method.params.find((p) => p.name === name);
      assert.ok(param, `${req.method}.${name}`);
      assert.ok(check(param.schema, value), `${req.method}.${name} official schema violation`);
    }
  }
}
for (const mode of ['idle', 'done', 'message', 'check-in', 'settle-once', 'notification'])
  test(`core ${mode}: initialize, observe, reuse without resending`, async (t) => {
    const f = await coreFixture(t, mode);
    let output = '';
    await run(['--backend', 'core', '--project', f.project], f.env, (text) => (output += text));
    assert.match(output, /Team ready/);
    const state = await readStartup(f.state);
    assert.equal(state.status, 'ready');
    assert.ok(state.members.every((m) => m.initialized));
    const calls = await coreCalls(f.directory);
    await checkContract(calls);
    const sends = calls.filter((req) => req.method === 'terminal.send');
    assert.equal(sends.length, mode === 'settle-once' ? 4 : 2);
    const callers = new Set(
      calls
        .filter((req) => ['terminal.send', 'terminal.wait'].includes(req.method))
        .map((req) => req.params.caller),
    );
    assert.equal(callers.size, 1);
    for (const req of sends) {
      assert.equal(req.params.force, false);
      if (mode === 'done') assert.ok(!('if' in req.params));
      else assert.equal(req.params.if, 'idle');
    }
    for (const req of calls.filter((req) => req.method === 'terminal.run')) {
      assert.deepEqual(req.params.argv, ['/usr/bin/env', 'codex', '--no-daemon']);
      assert.equal(req.params.wait, false);
      assert.equal(req.params.no_parent, true);
    }
    const roles = sends.filter((req) => req.params.text.includes('member dev'));
    assert.ok(roles.length);
    assert.ok(sends.at(-1).params.text.includes('member leader'));
    if (mode === 'message') assert.match(output, /continuing the same turn/);
    output = '';
    await run(
      ['--backend', 'core', '--status', '--project', f.project],
      f.env,
      (text) => (output += text),
    );
    assert.match(output, /Team startup: ready/);
    await writeFile(
      path.join(f.project, '.team/members/dev.md'),
      '---\nid: dev\nkind: codex\n---\nChanged',
    );
    output = '';
    await run(['--backend', 'core', '--project', f.project], f.env, (text) => (output += text));
    assert.match(output, /Configuration changed/);
    const after = await coreCalls(f.directory);
    assert.equal(count(after, 'terminal.send'), sends.length);
    assert.equal(count(after, 'terminal.run'), 2);
  });
for (const mode of [
  'blocked',
  'lost-launch',
  'send-failure',
  'generic-unavailable',
  'lost-send-response',
  'missing-turn',
  'settle-blocked',
  'settle-identity',
  'permission-after-send',
])
  test(`core ${mode}: preserve partial state and never blindly resend`, async (t) => {
    const f = await coreFixture(t, mode),
      args = ['--backend', 'core', '--project', f.project];
    await assert.rejects(run(args, f.env, () => {}));
    assert.equal((await readStartup(f.state)).status, 'partial');
    const before = await coreCalls(f.directory);
    await assert.rejects(
      run(args, f.env, () => {}),
      /incomplete/,
    );
    const after = await coreCalls(f.directory);
    assert.equal(count(after, 'terminal.send'), count(before, 'terminal.send'));
    assert.equal(count(after, 'terminal.run'), count(before, 'terminal.run'));
    assert.ok(
      after
        .filter((req) => req.method === 'terminal.send')
        .every((req) => req.params.force === false),
    );
  });
for (const mode of [
  'malformed',
  'wrong-id',
  'wrong-version',
  'null-result',
  'valid-response-failed-process',
])
  test(`RPC rejects ${mode}`, async (t) => {
    const f = await coreFixture(t, mode);
    await assert.rejects(coreCall(f.bin, f.env, 'server.status', {}));
  });
test('missing terminal list is not treated as proof that a previous team is gone', async (t) => {
  const f = await coreFixture(t, 'missing-terminals');
  await assert.rejects(new Core(f.bin, f.env).terminals(), /missing terminals/);
});
test('bounded waits stop on deadline and use the explicit caller', async (t) => {
  const f = await coreFixture(t, 'timeout');
  await writeFile(path.join(f.directory, 'sent-t1'), '');
  const c = new Core(f.bin, { ...f.env, HC_TERMINAL_ID: 'tcaller' });
  await assert.rejects(c.waitSettled('t1', () => {}, AbortSignal.timeout(1000)));
  const calls = await coreCalls(f.directory);
  assert.ok(calls.every((req) => req.params.caller === 'tcaller'));
});
test('initialization prompts retain no-tool guard and never start real work', async (t) => {
  const f = await coreFixture(t),
    team = await loadTeam(f.project),
    state = {
      project: f.project,
      leader_name: 'team-leader',
      members: [
        { id: 'leader', name: 'team-leader', terminal_id: 't1' },
        { id: 'dev', name: 'team-dev', terminal_id: 't2' },
      ],
    };
  for (const m of team.members) {
    const prompt = corePrompt(team, m, state, 'herdr-core');
    assert.match(prompt, /INITIALIZATION: Do not call tools/);
    assert.ok(prompt.includes(`reply exactly: ${m.id} ready.`));
    assert.match(prompt, /Then END YOUR TURN/);
    if (m.id !== 'leader') assert.match(prompt, /do not wait on the leader/);
  }
});
test('only exact structured settle rejection is retryable', () => {
  const exact = new CoreRPCError(
    -32000,
    'unavailable',
    't1 is still starting: its output has not settled',
    'nothing was typed; check hc read t1, then retry',
  );
  assert.equal(startupSendWasNotTyped(exact, 't1'), true);
  assert.equal(startupSendWasNotTyped(exact, 't2'), false);
  assert.equal(startupSendWasNotTyped(new Error(exact.message), 't1'), false);
});
test('repeated settle rejections stay inside the startup budget and never type a prompt', async (t) => {
  const f = await coreFixture(t, 'settle-forever'),
    c = new Core(f.bin, f.env);
  const entry = {
    id: 'dev',
    name: 'team-dev',
    terminal_id: 't1',
    pane_id: '',
    kind: 'codex',
    started: true,
    initialized: false,
  };
  await c.call('terminal.run', {
    argv: ['codex'],
    cwd: f.project,
    name: entry.name,
    labels: { 'herdr-team': 'team-leader' },
    no_parent: true,
    no_notify: true,
    wait: false,
  });
  await assert.rejects(c.initializeRole(entry, f.project, 'team-leader', 'role', () => {}, 700));
  const calls = await coreCalls(f.directory);
  assert.ok(count(calls, 'terminal.send') > 0);
  const { stat } = await import('node:fs/promises');
  await assert.rejects(stat(path.join(f.directory, 'sent-t1')), /ENOENT/);
});

test('RPC deadline remains bounded when a descendant holds the transport pipes', async (t) => {
  const f = await coreFixture(t, 'held-pipes');
  const started = Date.now();
  await assert.rejects(
    coreCall(f.bin, f.env, 'server.status', {}, AbortSignal.timeout(800)),
    /timed out|canceled/,
  );
  assert.ok(Date.now() - started < 2000);
});
