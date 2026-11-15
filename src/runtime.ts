import { stat } from 'node:fs/promises';
import { canonical, loadTeam } from './config.js';
import { Core, coreMatches, coreStatusName } from './core.js';
import { Herdr, resolveProject } from './legacy.js';
import { readState, startupDirectory, startupPath, teamDigest } from './state.js';
import { agentList, paneList, agentMatches, paneMatches, text } from './validation.js';
import type { Agent, CoreTerminal, Env, LegacyClient, Pane, Startup } from './types.js';

export interface Runtime {
  backend: 'core' | 'herdr';
  project: string;
  workspace: string;
  file: string;
  core?: Core;
  client?: LegacyClient;
}
export async function openRuntime(
  backend: 'core' | 'herdr',
  project: string,
  env: Env,
  budget = 15_000,
): Promise<Runtime> {
  if (backend === 'core') {
    project = await canonical(project || '.');
    if (!(await stat(project)).isDirectory()) throw new Error('project path is not a directory');
    const core = new Core(env.HERDR_CORE_BIN_PATH || 'herdr-core', env);
    const server = await core.call<{ core: { id: string } }>(
      'server.status',
      {},
      AbortSignal.timeout(budget),
    );
    const workspace = `core:${text(server.core?.id, 'core.id')}`;
    return {
      backend,
      project,
      workspace,
      core,
      file: startupPath(startupDirectory(env), project, workspace),
    };
  }
  if (env.HERDR_ENV !== '1') throw new Error('Herdr commands require a Herdr workspace');
  const client = new Herdr(env.HERDR_BIN_PATH || 'herdr', env);
  const resolved = await resolveProject(env, client, project);
  return {
    backend,
    ...resolved,
    client,
    file: startupPath(startupDirectory(env), resolved.project, resolved.workspace, env),
  };
}
export async function runtimeState(runtime: Runtime): Promise<Startup | undefined> {
  const state = await readState(runtime.file);
  if (state && (state.project !== runtime.project || state.workspace_id !== runtime.workspace))
    throw new Error('startup record belongs to another project or backend');
  return state;
}
export interface Inventory {
  terminals: CoreTerminal[];
  agents: Agent[];
  panes: Pane[];
}
export async function inventory(runtime: Runtime): Promise<Inventory> {
  if (runtime.core) return { terminals: await runtime.core.terminals(), agents: [], panes: [] };
  return {
    terminals: [],
    agents: agentList(await runtime.client!.call(['agent', 'list'])),
    panes: paneList(await runtime.client!.call(['pane', 'list', '--workspace', runtime.workspace])),
  };
}
export function memberViews(runtime: Runtime, state: Startup, live: Inventory) {
  return state.members.map((member) => {
    if (runtime.backend === 'core') {
      const terminal = live.terminals.find(
        (t) => t.address === member.terminal_id || t.name === member.name,
      );
      const matches =
        !!terminal && coreMatches(terminal, member, runtime.project, state.leader_name);
      return {
        ...member,
        matches,
        current_status: terminal
          ? matches
            ? coreStatusName(terminal)
            : 'identity changed'
          : 'missing',
        interactive_ready: null,
      };
    }
    const agent = live.agents.find(
      (a) => a.name === member.name || a.terminal_id === member.terminal_id,
    );
    const pane = live.panes.find(
      (p) => p.pane_id === member.pane_id || p.terminal_id === member.terminal_id,
    );
    const matches =
      !!agent &&
      agentMatches(agent, member, runtime.workspace) &&
      !!pane &&
      paneMatches(pane, member);
    return {
      ...member,
      matches,
      current_status: agent
        ? matches
          ? agent.agent_status
          : 'identity changed'
        : pane
          ? 'pane only'
          : 'missing',
      interactive_ready: agent?.interactive_ready ?? null,
    };
  });
}
export async function statusSnapshot(runtime: Runtime) {
  const startup = await runtimeState(runtime);
  let config: { valid: boolean; changed: boolean | null; error?: string };
  try {
    const team = await loadTeam(runtime.project);
    config = {
      valid: true,
      changed: startup?.config_digest ? startup.config_digest !== teamDigest(team) : null,
    };
  } catch (error) {
    config = { valid: false, changed: null, error: (error as Error).message };
  }
  const live = await inventory(runtime);
  return {
    schema_version: 1,
    backend: runtime.backend,
    project: runtime.project,
    workspace_id: runtime.workspace,
    record_path: runtime.file,
    startup: startup ?? null,
    config,
    members: startup ? memberViews(runtime, startup, live) : [],
  };
}
