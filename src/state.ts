import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Env, Startup, Team, Output } from './types.js';

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
export async function readState(file: string): Promise<Startup | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Startup;
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}
export const startupDirectory = (env: Env): string =>
  env.HERDR_PLUGIN_STATE_DIR || path.join(homedir(), '.local/state/herdr-agent-team');
export function startupPath(
  directory: string,
  project: string,
  workspace: string,
  env: Env = {},
): string {
  const digest = createHash('sha256')
    .update([env.HERDR_SOCKET_PATH || '', env.HERDR_SESSION || '', workspace, project].join('\0'))
    .digest('hex')
    .slice(0, 24);
  return path.join(directory, `${digest}.json`);
}
// Preserve the Go encoder's field order and HTML escaping for existing records.
export function teamDigest(team: Team): string {
  const encoded = JSON.stringify({
    Name: team.name,
    ...(team.workflow ? { Workflow: team.workflow } : {}),
    Leader: team.leader,
    Paths: team.paths,
    Members: team.members.map((m) => ({
      ID: m.id,
      Kind: m.kind,
      Args: m.argsSpecified === false ? null : m.args,
      Instructions: m.instructions,
    })),
    Instructions: team.instructions,
  }).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return createHash('sha256').update(encoded).digest('hex');
}
export async function save(file: string, state: Startup): Promise<void> {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
// Portable directory lock, independent of a native flock addon. A crash leaves
// its owner record for deliberate recovery; never steal a potentially live lock.
export async function lock(file: string): Promise<() => Promise<void>> {
  const directory = `${file}.d`;
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `team initialization is already running or a lock needs inspection: ${directory}`,
      );
    throw error;
  }
  try {
    await writeFile(
      path.join(directory, 'owner.json'),
      JSON.stringify({ pid: process.pid, created: new Date().toISOString() }),
      { mode: 0o600 },
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return () => rm(directory, { recursive: true, force: true });
}
export function reportConfigChange(out: Output, state: Startup, team: Team): void {
  if (!state.config_digest)
    out(
      'Configuration comparison unavailable: this team was started without a configuration digest. Close the old team and start again to apply current configuration.\n',
    );
  else if (state.config_digest !== teamDigest(team))
    out(
      'Configuration changed: the existing team still uses its startup configuration. Close the old team panes and start again to apply current configuration.\n',
    );
}
export function newState(team: Team, project: string, workspace: string, prefix: string): Startup {
  return {
    project,
    workspace_id: workspace,
    status: 'starting',
    stage: '',
    config_digest: teamDigest(team),
    tab_id: '',
    leader_name: `${prefix}-${team.leader}`,
    members: [],
  };
}
export function recordedMembers(out: Output, state: Startup): void {
  for (const m of state.members)
    out(
      `${m.name} (${m.id}): started=${m.started} initialized=${m.initialized} pane=${m.pane_id}; live status unknown\n`,
    );
}
