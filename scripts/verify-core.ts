// Test the built CLI against an isolated real core, without coding agents.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoreTerminal, Env } from '../src/types.js';

if (process.argv.length > 4) throw new Error('usage: verify-core.ts [core-path] [CLI-path]');
const core = process.argv[2] || process.env.HERDR_CORE_BIN_PATH || 'herdr-core';
const plugin = path.resolve(process.argv[3] || 'bin/herdr-team');
const fixture = fileURLToPath(new URL('./core-fixture.ts', import.meta.url));
const exec = promisify(execFile);
// Short paths fit macOS socket limits. No inherited socket/session is used.
const root = await realpath(await mkdtemp('/tmp/ht-'));
const env: Env = {
  ...process.env,
  HC_SESSION: 'verify',
  HC_SOCKET: path.join(root, 'core.sock'),
  HC_TERMINAL_ID: '',
  HERDR_CORE_BIN_PATH: core,
  HERDR_PLUGIN_STATE_DIR: path.join(root, 'team-state'),
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
};
for (const name of ['CONFIG', 'DATA', 'STATE', 'CACHE', 'RUNTIME']) {
  const directory = path.join(root, name.toLowerCase());
  await mkdir(directory, { mode: 0o700 });
  env[`XDG_${name}${name === 'RUNTIME' ? '_DIR' : '_HOME'}`] = directory;
}
const call = async <T>(...args: string[]): Promise<T> => {
  const { stdout } = await exec(core, ['--json', ...args], {
    env,
    timeout: 45_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
};
const terminals = async () => {
  const list = await call<{ terminals: { address: string }[] }>('ls', '--all');
  return Promise.all(list.terminals.map((row) => call<CoreTerminal>('get', row.address)));
};
const invoke = async (project: string, command = 'start', ...args: string[]) =>
  (
    await exec(process.execPath, [plugin, 'core', command, ...args, project], {
      env,
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout;
const receipts = async () => {
  const result: Record<string, number> = {};
  for (const name of (await readdir(root)).filter((name) => name.startsWith('receipt-')))
    result[name] = (await readFile(path.join(root, name), 'utf8')).split('delivered\n').length - 1;
  return result;
};
interface Snapshot {
  startup: { status: string; leader_name: string };
  members: { matches: boolean }[];
}
let started = false,
  passed = false;
try {
  await call('server', 'status');
  started = true;
  const { address: caller } = await call<CoreTerminal>(
    'run',
    '--bg',
    '--no-parent',
    '--no-notify',
    '--name',
    'verification-caller',
    '--cwd',
    root,
    '--',
    process.execPath,
    '--experimental-strip-types',
    fixture,
    'working',
    path.join(root, 'caller-receipts'),
    '',
    '',
  );
  for (const mode of ['idle', 'done', 'message', 'settling', 'permission']) {
    const project = path.join(root, mode);
    await mkdir(path.join(project, '.team/members'), { recursive: true });
    await writeFile(
      path.join(project, '.team/team.md'),
      '---\nname: verification\nleader: leader\nmembers: [members/leader.md, members/dev.md]\n---\nVerification only\n',
    );
    for (const member of ['leader', 'dev']) {
      const args = [
        '--experimental-strip-types',
        fixture,
        mode,
        path.join(root, `receipt-${mode}-${member}`),
        core,
        caller,
      ];
      await writeFile(
        path.join(project, `.team/members/${member}.md`),
        `---\nid: ${member}\nkind: node\nargs: ${JSON.stringify(args)}\n---\nFixture only\n`,
      );
    }
    env.HC_TERMINAL_ID = mode === 'message' ? caller : '';
    if (mode === 'permission') {
      await assert.rejects(invoke(project), (error: unknown) => {
        assert.ok(error && typeof error === 'object' && 'stderr' in error);
        assert.match(String(error.stderr), /blocked: permission/);
        assert.match(String(error.stderr), /attach/);
        return true;
      });
      const before = await receipts();
      assert.equal(
        ['leader', 'dev'].reduce(
          (sum, member) => sum + (before[`receipt-${mode}-${member}`] || 0),
          0,
        ),
        1,
      );
      const status = await invoke(project, 'status');
      assert.match(status, /Team startup: partial/);
      assert.match(status, /blocked/);
      assert.deepEqual(await receipts(), before, 'status answered a permission dialog');
      assert.equal(
        (JSON.parse(await invoke(project, 'status', 'json')) as Snapshot).startup.status,
        'partial',
      );
      await invoke(project, 'stop');
      assert.equal(
        (JSON.parse(await invoke(project, 'status', 'json')) as Snapshot).startup.status,
        'stopped',
      );
      assert.deepEqual(await receipts(), before, 'stop typed into a permission dialog');
      console.log(
        'PASS: permission blockage preserved, attach diagnostic, no automatic input, safe stop',
      );
      continue;
    }
    const output = await invoke(project);
    assert.match(output, /Team ready/);
    if (mode === 'message') assert.match(output, /continuing the same turn/);
    if (mode === 'settling') assert.match(output, /nothing was typed, retrying/);
    const live = await terminals(),
      before = await receipts();
    for (const member of ['leader', 'dev']) assert.equal(before[`receipt-${mode}-${member}`], 1);
    const status = await invoke(project, 'status');
    assert.match(status, /Team startup: ready/);
    assert.match(status, /done/);
    assert.match(await invoke(project), /Team ready/);
    assert.equal((await terminals()).length, live.length, 'reuse created terminals');
    assert.deepEqual(await receipts(), before, 'reuse or status resent a role');
    console.log(`PASS: ${mode} initialization, status, reuse, one delivery per member`);
    const snapshot = JSON.parse(await invoke(project, 'status', 'json')) as Snapshot;
    assert.equal(snapshot.startup.status, 'ready');
    assert.ok(snapshot.members.every((member) => member.matches));
    const owned = new Set(
      live
        .filter((terminal) => terminal.labels['herdr-team'] === snapshot.startup.leader_name)
        .map((terminal) => terminal.address),
    );
    await invoke(project, 'stop');
    assert.ok((await terminals()).every((terminal) => !owned.has(terminal.address)));
    assert.equal(
      (await call<CoreTerminal>('get', caller)).state,
      'live',
      'stop closed the unrelated caller',
    );
    assert.deepEqual(await receipts(), before, 'stop or JSON status resent a role');
    console.log(`PASS: ${mode} JSON status and identity-scoped stop preserve unrelated caller`);
  }
  passed = true;
} finally {
  if (started) {
    env.HC_TERMINAL_ID = '';
    try {
      for (const terminal of await terminals()) {
        if (terminal.state === 'live') await call('kill', terminal.address);
        await call('rm', terminal.address);
      }
      await call('server', 'stop');
      console.log('Cleaned up the isolated verification core and terminals');
    } catch (error) {
      passed = false;
      process.exitCode = 1;
      console.error('Verification cleanup failed:', error);
    }
  }
  if (passed) await rm(root, { recursive: true, force: true });
  else console.error(`Verification artifacts preserved: ${root}`);
}
