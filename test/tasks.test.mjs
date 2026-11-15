import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { run, TaskStore, loadTeam } from '../bin/library.mjs';
import { fixture } from './helpers.mjs';
async function setup(t) {
  const f = await fixture(t);
  const request = path.join(f.directory, 'request.md');
  await writeFile(request, '原始请求：修复名字规范化。\n约束：保留 Unicode。');
  const file = async (name, value) => {
    const p = path.join(f.directory, name);
    await writeFile(p, typeof value === 'string' ? value : JSON.stringify(value));
    return p;
  };
  const command = async (...args) => {
    let output = '';
    await run(['task', ...args, f.project], {}, (s) => (output += s));
    return output;
  };
  return { ...f, request, file, command, store: new TaskStore(f.project) };
}
async function create(f, id = 'T001') {
  await f.command('create', id, 'dev', f.request);
  const scope = await f.file(`${id}-scope.json`, { allowed_paths: ['helpers.py'] });
  await f.command('scope', id, '1', scope);
  return f.store.read(id);
}
const ready = {
  status: 'ready',
  summary: 'implemented',
  changed_files: ['helpers.py'],
  checks: [{ command: 'unit tests', result: 'passed' }],
  remaining: [],
};
test('task lifecycle preserves source, validates reports and archives detailed history', async (t) => {
  const f = await setup(t),
    card = await create(f);
  assert.equal(card.version, 2);
  assert.match(card.original_request, /Unicode/);
  const report = await f.file('report.json', ready);
  await f.command('report', 'T001', '2', 'dev', report);
  const proof = await f.file('proof.json', {
    summary: 'integration verified',
    checks: [{ command: 'integration', result: 'passed' }],
    remaining: [],
  });
  await f.command('finish', 'T001', '2', proof);
  await f.command('archive', 'T001', '2');
  assert.deepEqual(JSON.parse(await f.command('list')), []);
  assert.equal(JSON.parse(await f.command('show', 'T001')).status, 'done');
  assert.equal((await readdir(path.join(f.project, '.team/tasks/reports/T001'))).length, 2);
  assert.doesNotMatch(await readFile(path.join(f.project, '.team/tasks.md'), 'utf8'), /\| T001 \|/);
  await assert.rejects(f.command('create', 'T001', 'dev', f.request), /already exists/);
});
test('stale and wrong-worker reports cannot change the task', async (t) => {
  const f = await setup(t);
  await create(f);
  const report = await f.file('report.json', ready);
  await assert.rejects(f.command('report', 'T001', '1', 'dev', report), /stale/);
  await assert.rejects(f.command('report', 'T001', '2', 'leader', report), /does not own/);
  assert.equal((await f.store.read('T001')).status, 'queued');
});
test('reassignment increments version and includes an explicit release handoff', async (t) => {
  const f = await setup(t);
  await create(f);
  const h = await f.file('handoff.json', {
    summary: 'no edits yet',
    remaining: ['implement'],
    context_files: ['helpers.py'],
    worker_released: true,
  });
  await f.command('assign', 'T001', '2', 'dev', h);
  const card = JSON.parse(await f.command('show', 'T001'));
  assert.equal(card.version, 3);
  assert.equal(card.handoff.worker_released, true);
  const report = await f.file('old.json', ready);
  await assert.rejects(f.command('report', 'T001', '2', 'dev', report), /stale/);
});
test('active workers and overlapping scopes cannot be double-booked', async (t) => {
  const f = await setup(t);
  await create(f);
  await assert.rejects(f.command('create', 'T002', 'dev', f.request), /unhanded/);
  const member = path.join(f.project, '.team/members/other.md');
  await writeFile(member, '---\nid: other\nkind: codex\nargs: []\n---\n');
  const teamfile = path.join(f.project, '.team/team.md');
  await writeFile(
    teamfile,
    (await readFile(teamfile, 'utf8')).replace(
      'members/dev.md]',
      'members/dev.md, members/other.md]',
    ),
  );
  await f.command('create', 'T002', 'other', f.request);
  const overlap = await f.file('overlap.json', { allowed_paths: ['helpers.py'] });
  await assert.rejects(f.command('scope', 'T002', '1', overlap), /overlaps/);
});
test('scope enforcement rejects outside changes and symlinks escaping the project', async (t) => {
  const f = await setup(t);
  await create(f);
  const bad = await f.file('bad.json', { ...ready, changed_files: ['other.py'] });
  await assert.rejects(f.command('report', 'T001', '2', 'dev', bad), /outside granted/);
  await writeFile(path.join(f.directory, 'outside.py'), 'outside');
  await symlink(path.join(f.directory, 'outside.py'), path.join(f.project, 'helpers.py'));
  const report = await f.file('report.json', ready);
  await assert.rejects(f.command('report', 'T001', '2', 'dev', report), /outside project/);
});
test('pause cannot be undone by feedback or an automatic ready report', async (t) => {
  const f = await setup(t);
  await create(f);
  await f.command('pause', 'T001', '2');
  const feedback = await f.file('feedback.md', '还需要支持空字符串');
  await f.command('feedback', 'T001', '3', feedback);
  const report = await f.file('ready.json', { ...ready, seen_feedback: 1 });
  await assert.rejects(f.command('report', 'T001', '3', 'dev', report), /paused/);
  assert.equal((await f.store.read('T001')).paused, true);
  await f.command('resume', 'T001', '3');
  assert.equal((await f.store.read('T001')).version, 4);
});
test('ready reports must acknowledge feedback and pass relevant checks', async (t) => {
  const f = await setup(t);
  await create(f);
  await f.command('feedback', 'T001', '2', await f.file('feedback.md', '追加明确约束'));
  await assert.rejects(
    f.command('report', 'T001', '2', 'dev', await f.file('old.json', ready)),
    /acknowledge/,
  );
  await assert.rejects(
    f.command(
      'report',
      'T001',
      '2',
      'dev',
      await f.file('unrun.json', {
        ...ready,
        seen_feedback: 1,
        checks: [{ command: 'tests', result: 'not_run' }],
      }),
    ),
    /not ready/,
  );
  await f.command(
    'report',
    'T001',
    '2',
    'dev',
    await f.file('current.json', { ...ready, seen_feedback: 1 }),
  );
});
test('working tasks require a handoff before reassignment or scope changes', async (t) => {
  const f = await setup(t);
  await create(f);
  await f.command(
    'report',
    'T001',
    '2',
    'dev',
    await f.file('working.json', {
      status: 'working',
      summary: 'started',
      changed_files: [],
      checks: [],
      remaining: ['implement'],
    }),
  );
  const scope = await f.file('scope.json', { allowed_paths: ['other.py'] });
  await assert.rejects(f.command('scope', 'T001', '2', scope), /hand off/);
  const h = await f.file('handoff.json', {
    summary: 'release',
    remaining: [],
    context_files: [],
    worker_released: true,
  });
  await assert.rejects(f.command('assign', 'T001', '2', 'dev', h), /handoff/);
});
test('legacy manual task index is preserved before generating the active summary', async (t) => {
  const f = await setup(t);
  await writeFile(path.join(f.project, '.team/tasks.md'), 'previous notes');
  await create(f);
  const backup = (await readdir(path.join(f.project, '.team/tasks'))).find((n) =>
    n.startsWith('legacy-index-'),
  );
  assert.equal(
    await readFile(path.join(f.project, '.team/tasks', backup), 'utf8'),
    'previous notes',
  );
});
test('new feedback after ready invalidates final acceptance until acknowledged', async (t) => {
  const f = await setup(t);
  await create(f);
  await f.command('report', 'T001', '2', 'dev', await f.file('ready.json', ready));
  await f.command('feedback', 'T001', '2', await f.file('feedback.md', '新增明确要求'));
  await assert.rejects(
    f.command(
      'finish',
      'T001',
      '2',
      await f.file('proof.json', {
        summary: 'checked',
        checks: [{ command: 'test', result: 'passed' }],
        remaining: [],
      }),
    ),
    /latest feedback/,
  );
});
test('ready task keeps its scope frozen for review until final acceptance', async (t) => {
  const f = await setup(t);
  await create(f);
  await f.command('report', 'T001', '2', 'dev', await f.file('ready.json', ready));
  await f.command('create', 'T002', 'dev', f.request);
  await assert.rejects(
    f.command('scope', 'T002', '1', await f.file('scope.json', { allowed_paths: ['helpers.py'] })),
    /overlaps/,
  );
});
test('dependency cycles are rejected and archived completed dependencies remain usable', async (t) => {
  const f = await setup(t);
  await create(f);
  await f.command('report', 'T001', '2', 'dev', await f.file('ready.json', ready));
  await writeFile(
    path.join(f.project, '.team/members/other.md'),
    '---\nid: other\nkind: codex\nargs: []\n---\n',
  );
  const teamfile = path.join(f.project, '.team/team.md');
  await writeFile(
    teamfile,
    (await readFile(teamfile, 'utf8')).replace(
      'members/dev.md]',
      'members/dev.md, members/other.md]',
    ),
  );
  await f.command('create', 'T002', 'other', f.request);
  await f.command(
    'scope',
    'T002',
    '1',
    await f.file('b.json', { allowed_paths: ['other.py'], dependencies: ['T001'] }),
  );
  await assert.rejects(
    f.command(
      'scope',
      'T001',
      '2',
      await f.file('a.json', { allowed_paths: ['helpers.py'], dependencies: ['T002'] }),
    ),
    /cycle/,
  );
  await f.command(
    'finish',
    'T001',
    '2',
    await f.file('proof.json', {
      summary: 'verified',
      checks: [{ command: 'tests', result: 'passed' }],
      remaining: [],
    }),
  );
  await f.command('archive', 'T001', '2');
  await f.command(
    'report',
    'T002',
    '2',
    'other',
    await f.file('working.json', {
      status: 'working',
      summary: 'dependency done',
      changed_files: [],
      checks: [],
      remaining: ['implement'],
    }),
  );
  assert.equal((await f.store.read('T002')).status, 'working');
});
