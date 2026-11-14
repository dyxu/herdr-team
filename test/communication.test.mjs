import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkCommunication, loadTeam, run } from '../bin/library.mjs';
import { fixture, coreFixture, readStartup } from './helpers.mjs';
const exec = promisify(execFile);
for (const core of [true, false])
  for (const mode of ['success', 'missing', 'stale', 'symlink', 'wrong-identity'])
    test(`communication ${core ? 'core' : 'legacy'} ${mode}`, async (t) => {
      const f = await fixture(t),
        team = await loadTeam(f.project),
        bin = path.join(f.directory, "core with 'quote");
      await writeFile(
        bin,
        `#!/usr/bin/env node\nimport(${JSON.stringify(new URL('./fake-communication.mjs', import.meta.url).href)});\n`,
        { mode: 0o700 },
      );
      const state = {
        project: f.project,
        workspace_id: 'core:test',
        leader_name: 'team-leader',
        members: team.members.map((m, i) => ({
          id: m.id,
          name: `team-${m.id}`,
          kind: m.kind,
          pane_id: `p${i + 1}`,
          terminal_id: `t${i + 1}`,
          started: true,
          initialized: true,
        })),
      };
      const delivered = [];
      const deliver = async (entry, prompt) => {
        delivered.push(entry.id);
        assert.match(prompt, /separate post-initialization test/);
        const directory = path.join(
          f.project,
          '.team',
          (await readdir(path.join(f.project, '.team'))).find((n) =>
            n.startsWith('.communication-'),
          ),
        );
        await exec(
          '/bin/sh',
          [path.join(directory, entry.id === team.leader ? 'router.sh' : `${entry.id}.sh`)],
          {
            env: {
              ...process.env,
              COMM_PROJECT: f.project,
              COMM_RECEIPT_MODE: mode,
              COMM_BAD_ID: mode === 'wrong-identity' ? '1' : '',
            },
          },
        );
      };
      if (mode === 'success') {
        await checkCommunication(team, state, bin, core, deliver, () => {});
        assert.deepEqual(delivered, ['leader', 'dev']);
        assert.equal(
          (await readdir(path.join(f.project, '.team'))).some((n) =>
            n.startsWith('.communication-'),
          ),
          false,
        );
      } else {
        await assert.rejects(
          checkCommunication(team, state, bin, core, deliver, () => {}),
          /communication check failed.*preserved/,
        );
        assert.equal(
          (await readdir(path.join(f.project, '.team'))).some((n) =>
            n.startsWith('.communication-'),
          ),
          true,
        );
        if (mode === 'wrong-identity') assert.deepEqual(delivered, ['leader']);
      }
    });
test('opt-in workflow cannot reuse an old unverified ready team', async (t) => {
  const f = await coreFixture(t);
  await run(['--backend', 'core', '--project', f.project], f.env, () => {});
  const file = path.join(f.project, '.team/team.md');
  await writeFile(
    file,
    (await readFile(file, 'utf8')).replace(
      'name: development',
      'name: development\nworkflow: router-worker',
    ),
  );
  await assert.rejects(
    run(['--backend', 'core', '--project', f.project], f.env, () => {}),
    /has not passed/,
  );
  assert.equal((await readStartup(f.state)).status, 'ready');
});
test('failed post-initialization check preserves initialized members but never marks team ready', async (t) => {
  const f = await coreFixture(t),
    file = path.join(f.project, '.team/team.md');
  await writeFile(
    file,
    (await readFile(file, 'utf8')).replace(
      'name: development',
      'name: development\nworkflow: router-worker',
    ),
  );
  let output = '';
  await assert.rejects(
    run(['--backend', 'core', '--project', f.project], f.env, (text) => (output += text)),
    /communication check failed/,
  );
  const state = await readStartup(f.state);
  assert.equal(state.status, 'partial');
  assert.equal(state.communication_check, 'pending');
  assert.ok(state.members.every((m) => m.initialized));
  assert.equal(state.stage, 'checking communication');
  assert.doesNotMatch(output, /Team ready/);
  await assert.rejects(
    run(['--backend', 'core', '--project', f.project], f.env, () => {}),
    /incomplete/,
  );
});
