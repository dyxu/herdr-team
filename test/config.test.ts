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
  parseCommand,
  markdown,
} from '../bin/library.mjs';
import { temporary, fixture, root } from './helpers.ts';
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
  const listed = await exec(process.execPath, [binary, 'templates'], { cwd: dir });
  assert.equal(listed.stdout, `${Object.keys(expected).sort().join('\n')}\n`);
  await exec(process.execPath, [binary, 'init', dir, 'router-worker'], { cwd: dir });
  const checked = await exec(process.execPath, [binary, 'check', dir], { cwd: dir });
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
test('subcommands reject invalid syntax before connecting and preserve empty directory overrides', async () => {
  for (const args of [
    ['unknown'],
    ['start', '.', 'core'],
    ['check', '.', 'extra'],
    ['init', '.', 'minimal', '.', 'extra'],
    ['templates', '.', 'extra'],
    ['help', 'unknown'],
    ['core', 'unknown'],
    ['--init'],
    ['start', '--project', '.'],
  ])
    await assert.rejects(run(args, {}));
  let output = '';
  await run(
    ['templates', ''],
    { HERDR_TEAM_TEMPLATES_DIR: '/does-not-exist' },
    (text) => (output += text),
  );
  assert.equal(output, `${builtinTemplateNames().join('\n')}\n`);
  assert.deepEqual(parseCommand(['core', 'start', 'project with spaces']), {
    backend: 'core',
    command: 'start',
    project: 'project with spaces',
    template: 'development',
  });
  assert.equal(parseCommand(['init', '.', 'router-worker']).template, 'router-worker');
  assert.equal(parseCommand(['init']).template, 'development');
  assert.equal(parseCommand([]).command, 'help');
});
test('bare invocation and help never start a backend or read a project', async () => {
  for (const args of [[], ['help'], ['core'], ['herdr', 'help']]) {
    let output = '';
    await run(args, {}, (text) => (output += text));
    assert.match(output, /Usage: herdr-team/);
    assert.doesNotMatch(output, /--project|--init|--backend/);
  }
  let output = '';
  await run(['help', 'init'], {}, (text) => (output += text));
  assert.match(output, /init \[project\] \[template\]/);
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
  team.members[0]!.instructions += 'changed';
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
    (await loadTeam(f.project)).members.find((m) => m.id === 'dev')!.argsSpecified,
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
test('plugin-style init preserves Herdr project context when the project argument is empty', async (t) => {
  const project = await temporary(t);
  const env = {
    HERDR_ENV: '1',
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: 'w1', workspace_cwd: project }),
  };
  await run(['init', '', 'fullstack'], env, () => {});
  assert.equal((await loadTeam(project)).name, 'fullstack-team');
});
test('init and templates accept a positional custom template directory', async (t) => {
  const templates = await temporary(t);
  const named = path.join(templates, 'custom');
  await mkdir(named);
  await initFromTemplate(named, 'minimal');
  const { rename } = await import('node:fs/promises');
  const directory = await temporary(t);
  await rename(path.join(named, '.team'), path.join(directory, 'custom'));
  const project = await temporary(t);
  await run(['init', project, 'custom', directory], {}, () => {});
  assert.equal((await loadTeam(project)).name, 'minimal-team');
  let output = '';
  await run(['templates', directory], {}, (text) => (output += text));
  assert.match(output, /^custom$/m);
});
