// Explicit opt-in: starts two real coding agents and may consume API credits.
import { mkdtemp, realpath, mkdir, readFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  Herdr,
  initFromTemplate,
  loadTeam,
  resolveProject,
  initialize,
  reportStatus,
  startupPath,
  readState,
} from '../bin/library.mjs';

if (process.env.HERDR_TEAM_INTEGRATION !== '1') {
  console.log('Skipped: set HERDR_TEAM_INTEGRATION=1 inside Herdr to launch a real minimal team.');
  process.exit(0);
}
if (process.env.HERDR_ENV !== '1')
  throw new Error('real integration verification must run inside Herdr');
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'herdr-team-integration-')));
const project = path.join(root, 'project'),
  directory = path.join(root, 'state');
await mkdir(project);
const env = { ...process.env },
  client = new Herdr(env.HERDR_BIN_PATH || 'herdr', env);
const { workspace } = await resolveProject(env, client, project);
const file = startupPath(directory, project, workspace, env);
const out = (text: string) => process.stdout.write(text);
let cleaned = false;
try {
  await initFromTemplate(project, 'minimal');
  const team = await loadTeam(project);
  await initialize(team, project, workspace, directory, env, client, out);
  let output = '';
  await reportStatus(client, file, project, workspace, (text) => {
    output += text;
    out(text);
  });
  assert.match(output, /Team startup: ready/);
  assert.doesNotMatch(output, /Configuration changed:|comparison unavailable/);
  const before = await readFile(file);
  output = '';
  await initialize(team, project, workspace, directory, env, client, (text) => {
    output += text;
    out(text);
  });
  assert.match(output, /Existing team focused:/);
  assert.deepEqual(await readFile(file), before);
  await appendFile(
    path.join(project, '.team', team.paths[0]!),
    '\nIntegration verification configuration change.\n',
  );
  output = '';
  await reportStatus(client, file, project, workspace, (text) => {
    output += text;
    out(text);
  });
  assert.match(output, /Configuration changed:/);
  console.log('PASS: real Herdr initialization, status, reuse and configuration change');
} finally {
  const state = await readState(file);
  if (state?.tab_id && state.project === project && state.workspace_id === workspace) {
    await client.call(['tab', 'close', state.tab_id]);
    cleaned = true;
  } else cleaned = !state;
  if (env.HERDR_TAB_ID) await client.call(['tab', 'focus', env.HERDR_TAB_ID]);
  if (cleaned) await rm(root, { recursive: true, force: true });
  else console.error(`Test artifacts preserved for inspection: ${root}`);
}
