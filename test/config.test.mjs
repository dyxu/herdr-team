import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  symlink,
  mkdtemp,
  copyFile,
  chmod,
} from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  run,
  builtinTemplateNames,
  availableTemplateNames,
  initFromTemplate,
  loadTeam,
  teamDigest,
  startupPath,
  lock,
  parseFlags,
  markdown,
} from '../bin/library.mjs';
import { temporary, fixture, root } from './helpers.mjs';
const exec = promisify(execFile);
const expected = {
  development: ['leader', 'developer', 'reviewer'],
  minimal: ['leader', 'developer'],
  product: ['leader', 'product-manager', 'architect', 'developer', 'qa'],
  fullstack: ['leader', 'designer', 'frontend', 'backend', 'reviewer'],
  research: ['leader', 'researcher', 'analyst', 'reviewer'],
  content: ['leader', 'researcher', 'writer', 'editor'],
  'data-analysis': ['leader', 'data-engineer', 'analyst', 'reviewer'],
  security: ['leader', 'auditor', 'developer', 'reviewer'],
  'router-worker': ['leader', 'worker-a', 'worker-b'],
};
test('embedded templates initialize with the expected roster and reject overwrites', async (t) => {
  assert.deepEqual(builtinTemplateNames(), Object.keys(expected).sort());
  for (const [name, ids] of Object.entries(expected)) {
    const project = await temporary(t);
    await initFromTemplate(project, name);
    const team = await loadTeam(project);
    assert.deepEqual(
      team.members.map((m) => m.id),
      ids,
    );
    assert.ok(team.instructions.trim());
    assert.ok(
      team.members.every((m) => m.kind === 'codex' && !m.args.length && m.instructions.trim()),
    );
    await assert.rejects(initFromTemplate(project, name), /refusing to overwrite/);
  }
});
test('bundle is standalone, with templates independent of cwd and repository', async (t) => {
  const dir = await temporary(t),
    binary = path.join(dir, 'herdr-team');
  await copyFile(path.join(root, 'bin/herdr-team'), binary);
  await chmod(binary, 0o755);
  const listed = await exec(process.execPath, [binary, '--list-templates'], { cwd: dir });
  assert.equal(listed.stdout, `${Object.keys(expected).sort().join('\n')}\n`);
  await exec(
    process.execPath,
    [binary, '--init', '--template', 'router-worker', '--project', dir],
    { cwd: dir },
  );
  const checked = await exec(process.execPath, [binary, '--check', '--project', dir], { cwd: dir });
  assert.match(checked.stdout, /members=3/);
});
test('custom templates override builtins, aliases preserve contents, source containment is rejected', async (t) => {
  const source = await temporary(t),
    dest = await temporary(t);
  await mkdir(path.join(source, 'minimal'));
  await initFromTemplate(path.join(source, 'minimal'), 'router-worker');
  // Template root is the generated .team itself.
  await initFromTemplate(dest, path.join(source, 'minimal/.team'));
  assert.equal((await loadTeam(dest)).name, 'router-worker-team');
  const named = await temporary(t);
  await symlink(path.join(source, 'minimal/.team'), path.join(named, 'minimal'));
  await assert.rejects(
    initFromTemplate(await temporary(t), 'minimal', named),
    /not a directory|symlink/,
  );
  assert.deepEqual(await availableTemplateNames(named), builtinTemplateNames());
  const sourceRoot = path.join(source, 'minimal/.team');
  await mkdir(path.join(sourceRoot, 'nested'));
  await assert.rejects(
    initFromTemplate(path.join(sourceRoot, 'nested'), sourceRoot),
    /must not equal or contain/,
  );
});
test('rejects symlinks and special files in external template trees without leaking staging', async (t) => {
  const source = await temporary(t);
  await initFromTemplate(source, 'minimal');
  await symlink('/etc/hosts', path.join(source, '.team/leak'));
  const dest = await temporary(t);
  await assert.rejects(
    initFromTemplate(dest, path.join(source, '.team')),
    /symlink or special file/,
  );
  assert.deepEqual(await readdir(dest), []);
});
test('strict frontmatter rejects unknown fields, duplicate keys, coercion and multiple documents', async (t) => {
  const { project } = await fixture(t),
    file = path.join(project, '.team/team.md');
  for (const text of [
    '---\nleader: leader\nleader: other\n---\n',
    '---\nleader: 42\n---\n',
    '---\nleader: leader\nunknown: x\n---\n',
    '---\nleader: leader\nmembers: [true]\n---\n',
    'leader: leader',
    '---\n- leader\n---\n',
  ]) {
    await writeFile(file, text);
    await assert.rejects(loadTeam(project));
  }
});
test('member validation rejects duplicate identities, escaping paths and NUL args', async (t) => {
  const f = await fixture(t),
    member = path.join(f.project, '.team/members/dev.md');
  for (const front of [
    'id: leader\nkind: codex',
    'id: Bad\nkind: codex',
    'id: dev\nkind: invalid kind',
    'id: dev\nkind: codex\nargs: ["\\0"]',
  ]) {
    await writeFile(member, `---\n${front}\n---\nRole`);
    await assert.rejects(loadTeam(f.project));
  }
  const external = path.join(f.directory, 'external.md');
  await writeFile(external, '---\nid: dev\nkind: codex\n---\n');
  await symlink(external, path.join(f.project, '.team/members/escape.md'));
  await writeFile(
    path.join(f.project, '.team/team.md'),
    '---\nleader: dev\nmembers: [members/escape.md]\n---\n',
  );
  await assert.rejects(loadTeam(f.project), /inside .team/);
});
test('CLI rejects incompatible options before starting a backend and honors explicit empty template directory', async (t) => {
  for (const args of [
    ['--init', '--check'],
    ['--status', '--list-templates'],
    ['--template', 'minimal'],
    ['--templates-dir', 'x'],
    ['--backend', 'invalid'],
    ['positional'],
    ['--oops'],
  ])
    await assert.rejects(run(args, {}));
  let output = '';
  await run(
    ['--list-templates', '--templates-dir='],
    { HERDR_TEAM_TEMPLATES_DIR: '/does-not-exist' },
    (text) => (output += text),
  );
  assert.equal(output, `${builtinTemplateNames().join('\n')}\n`);
  assert.equal(parseFlags(['-init=false', '--project=a=b']).values.project, 'a=b');
  assert.equal(parseFlags(['-init=false']).values.init, false);
});
test('startup identities and Go-compatible config digests remain deterministic', async (t) => {
  const { project } = await fixture(t),
    team = await loadTeam(project);
  assert.equal(
    startupPath('/state', '/project', 'core:test'),
    '/state/0669398a40cef2226eb1fa42.json',
  );
  assert.equal(
    teamDigest(team),
    'f9b96cf2b22acd7742bbc85de06f8be746d73b73cdbbab99dbbea40aa056b821',
  );
  const first = teamDigest(team);
  team.members[0].instructions += 'changed';
  assert.notEqual(first, teamDigest(team));
  assert.match(first, /^[a-f0-9]{64}$/);
});
test('initialization lock excludes competing processes and releases cleanly', async (t) => {
  const dir = await temporary(t),
    file = path.join(dir, 'startup.lock');
  const unlock = await lock(file);
  await assert.rejects(lock(file), /already running/);
  await unlock();
  await (
    await lock(file)
  )();
  assert.deepEqual(await readdir(dir), []);
});
test('configured template wins over embedded names and explicit directory selects local content', async (t) => {
  const source = await temporary(t),
    named = path.join(source, 'development');
  await mkdir(named);
  await initFromTemplate(named, 'minimal');
  const { rename } = await import('node:fs/promises');
  const templates = await temporary(t);
  await rename(path.join(named, '.team'), path.join(templates, 'development'));
  const dest = await temporary(t);
  await initFromTemplate(dest, 'development', templates);
  assert.equal((await loadTeam(dest)).name, 'minimal-team');
  assert.ok((await availableTemplateNames(templates)).includes('development'));
});
test('invalid external template fails before publication and cleans staging', async (t) => {
  const source = await temporary(t),
    dest = await temporary(t);
  await writeFile(path.join(source, 'team.md'), '---\nleader: absent\nmembers: []\n---\n');
  await assert.rejects(initFromTemplate(dest, source));
  assert.deepEqual(await readdir(dest), []);
});
test('missing args retain the original Go null representation in the digest', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.project, '.team/members/dev.md');
  const original = teamDigest(await loadTeam(f.project));
  await writeFile(file, '---\nid: dev\nkind: codex\n---\nRole for dev');
  assert.notEqual(teamDigest(await loadTeam(f.project)), original);
  assert.equal(
    (await loadTeam(f.project)).members.find((m) => m.id === 'dev').argsSpecified,
    false,
  );
});

test('custom YAML tags cannot silently become valid string fields', async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.project, '.team/members/dev.md'),
    '---\nid: dev\nkind: !custom codex\nargs: []\n---\nRole',
  );
  await assert.rejects(loadTeam(f.project), /Unresolved tag/);
});
