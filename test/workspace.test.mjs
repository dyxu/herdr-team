import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workspaceSnapshot, auditWorkspace, run } from '../bin/library.mjs';
import { fixture } from './helpers.mjs';
const exec = promisify(execFile);
test('Git audit distinguishes pre-existing, staged, deleted, untracked and unreported changes', async (t) => {
  const f = await fixture(t);
  const git = async (...args) =>
    exec('git', [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-C',
      f.project,
      ...args,
    ]);
  await git('init');
  await mkdir(path.join(f.project, 'src'));
  await writeFile(path.join(f.project, 'src/a.ts'), 'original');
  await writeFile(path.join(f.project, 'src/deleted.ts'), 'original');
  await writeFile(path.join(f.project, 'existing.txt'), 'original');
  await git('add', '.');
  await git('commit', '-m', 'baseline');
  await writeFile(path.join(f.project, 'existing.txt'), 'user edits');
  const baseline = await workspaceSnapshot(f.project);
  assert.equal(baseline.available, true);
  await writeFile(path.join(f.project, 'src/a.ts'), 'changed');
  await git('add', 'src/a.ts');
  await rm(path.join(f.project, 'src/deleted.ts'));
  await writeFile(path.join(f.project, 'src/new file.ts'), 'new');
  await symlink('a.ts', path.join(f.project, 'src/link'));
  await writeFile(path.join(f.project, 'unrelated.txt'), 'other worker');
  const audit = await auditWorkspace(f.project, baseline, ['src'], ['src/a.ts']);
  assert.equal(audit.head_changed, false);
  assert.deepEqual(audit.preexisting_changes, ['existing.txt']);
  assert.deepEqual(audit.outside_scope, ['unrelated.txt']);
  assert.deepEqual(audit.unreported_in_scope, ['src/deleted.ts', 'src/link', 'src/new file.ts']);
  assert.ok(!audit.changed_files.includes('existing.txt'));
  const request = path.join(f.directory, 'request.md');
  await writeFile(request, 'implement');
  let output = '';
  const command = async (...args) => {
    output = '';
    await run(['task', ...args, f.project], {}, (s) => (output += s));
    return JSON.parse(output);
  };
  await command('create', 'T001', 'dev', request);
  const scope = path.join(f.directory, 'scope.json');
  await writeFile(scope, JSON.stringify({ allowed_paths: ['src'] }));
  await command('scope', 'T001', '1', scope);
  await writeFile(path.join(f.project, 'src/a.ts'), 'changed again');
  assert.deepEqual((await command('audit', 'T001')).unreported_in_scope, ['src/a.ts']);
  const report = path.join(f.directory, 'report.json');
  await writeFile(
    report,
    JSON.stringify({
      status: 'ready',
      summary: 'done',
      changed_files: ['src/a.ts'],
      checks: [{ command: 'actual fixture assertion', result: 'passed' }],
      remaining: [],
    }),
  );
  await command('report', 'T001', '2', 'dev', report);
  const proof = path.join(f.directory, 'proof.json');
  await writeFile(
    proof,
    JSON.stringify({
      summary: 'reviewed',
      checks: [{ command: 'actual fixture assertion', result: 'passed' }],
      remaining: [],
    }),
  );
  const card = await command('finish', 'T001', '2', proof);
  const verification = JSON.parse(await readFile(path.join(f.project, card.verification), 'utf8'));
  assert.deepEqual(verification.workspace_audit.changed_files, ['src/a.ts']);
  assert.deepEqual(verification.workspace_audit.unreported_in_scope, []);
  await git('add', '.');
  await git('commit', '-m', 'another commit');
  assert.equal((await auditWorkspace(f.project, baseline, ['src'], [])).head_changed, true);
});
test('non-Git projects retain task support and report audit unavailable', async (t) => {
  const f = await fixture(t);
  const snapshot = await workspaceSnapshot(f.project);
  assert.equal(snapshot.available, false);
  assert.equal((await auditWorkspace(f.project, snapshot, [], [])).available, false);
});
