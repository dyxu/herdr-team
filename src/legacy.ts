import { mkdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical, loadTeam, validKind } from './config.js';
import { checkCommunication } from './communication.js';
import { execute } from './process.js';
import { rolePrompt } from './prompts.js';
import {
  lock,
  newState,
  readState,
  recordedMembers,
  reportConfigChange,
  save,
  startupDirectory,
  startupPath,
} from './state.js';
import type {
  Agent,
  Env,
  HerdrResult,
  LegacyClient,
  Output,
  Pane,
  StartedMember,
  Startup,
  Team,
} from './types.js';

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
export function parseAgentKindsHelp(help: string): Set<string> {
  help = stripAnsi(help.replace(/\r\n/g, '\n'));
  const option = /^\s*--kind(?:[= \t]|$)/m.exec(help);
  if (!option) throw new Error('--kind option is missing from help');
  let section = help.slice(option.index + option[0].length);
  const next = /^\s*(?:-[a-zA-Z],?\s+)?--[a-zA-Z][a-zA-Z0-9-]*(?:[= \t]|$)/m.exec(section);
  if (next) section = section.slice(0, next.index);
  const match = /\[\s*possible\s+values\s*:\s*([^\]]+)\]/is.exec(section);
  if (!match) throw new Error('--kind choices are missing or use an unrecognized help format');
  const kinds = match[1]!.split(',').map((item) => item.trim());
  if (kinds.some((kind) => !validKind.test(kind)))
    throw new Error('--kind choices contain an invalid agent kind');
  return new Set(kinds);
}
export class Herdr implements LegacyClient {
  constructor(
    readonly bin: string,
    readonly env: Env,
  ) {}
  async call(args: string[], signal?: AbortSignal): Promise<HerdrResult> {
    const data = await execute(
      this.bin,
      args,
      this.env,
      args[0] === 'agent' && args[1] === 'prompt' ? 130_000 : 45_000,
      signal,
    );
    let envelope;
    try {
      envelope = JSON.parse(data);
    } catch {
      throw new Error(`invalid Herdr ${args.slice(0, 2).join(' ')} response`);
    }
    if (envelope.error !== undefined && envelope.error !== null)
      throw new Error(
        `Herdr ${args.slice(0, 2).join(' ')} error: ${JSON.stringify(envelope.error)}`,
      );
    if (!envelope.result || typeof envelope.result !== 'object')
      throw new Error(`Herdr ${args.slice(0, 2).join(' ')} response is missing result`);
    return envelope.result as HerdrResult;
  }
  async checkKinds(team: Team): Promise<void> {
    let supported: Set<string>;
    try {
      supported = parseAgentKindsHelp(
        await execute(this.bin, ['agent', 'start', '--help'], this.env),
      );
    } catch (error) {
      let label = 'Herdr (version unavailable)';
      try {
        const version = stripAnsi(await execute(this.bin, ['--version'], this.env))
          .trim()
          .replace(/\s+/g, ' ');
        if (version && version.length <= 120) label = version;
      } catch {
        /* Diagnostics only. */
      }
      throw new Error(
        `cannot read supported agent kinds from ${label}: ${(error as Error).message}; run ${this.bin} agent start --help and check Herdr compatibility (requires 0.9.3+)`,
      );
    }
    for (const m of team.members)
      if (!supported.has(m.kind))
        throw new Error(
          `Herdr does not support agent kind ${JSON.stringify(m.kind)} for member ${JSON.stringify(m.id)}; supported kinds: ${[...supported].sort().join(', ')}`,
        );
  }
}
export async function resolveProject(
  env: Env,
  client: LegacyClient,
  explicit = '',
): Promise<{ project: string; workspace: string }> {
  let invocation: {
    workspace_id?: string;
    workspace_cwd?: string;
    focused_pane_id?: string;
    focused_pane_cwd?: string;
    worktree?: { checkout_path?: string };
  } = {};
  if (env.HERDR_PLUGIN_CONTEXT_JSON) {
    try {
      invocation = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON);
    } catch (error) {
      throw new Error(`invalid plugin context: ${(error as Error).message}`);
    }
    if (!invocation || typeof invocation !== 'object')
      throw new Error('invalid plugin context: expected an object');
  }
  const workspace = invocation.workspace_id || env.HERDR_WORKSPACE_ID;
  if (!workspace)
    throw new Error('no current Herdr workspace; invoke the action from a project workspace');
  let candidate =
    explicit ||
    invocation.worktree?.checkout_path ||
    invocation.workspace_cwd ||
    invocation.focused_pane_cwd;
  if (!candidate) {
    const pane = invocation.focused_pane_id || env.HERDR_PANE_ID;
    if (pane) candidate = (await client.call(['pane', 'get', pane])).pane?.cwd;
  }
  if (!candidate)
    throw new Error('cannot determine project directory; pass --project /absolute/project/path');
  const project = await canonical(candidate);
  if (!(await stat(project)).isDirectory()) throw new Error('project path is not a directory');
  return { project, workspace };
}
export async function initializePromptWithReadiness(
  client: LegacyClient,
  entry: StartedMember,
  workspace: string,
  prompt: string,
  timeout = 30_000,
  interval = 250,
  progress: Output = () => {},
): Promise<void> {
  const signal = AbortSignal.timeout(timeout);
  let waiting = false;
  while (true) {
    signal.throwIfAborted();
    const agent = (await client.call(['agent', 'get', entry.name], signal)).agent;
    signal.throwIfAborted();
    if (
      !agent ||
      agent.name !== entry.name ||
      agent.pane_id !== entry.pane_id ||
      agent.terminal_id !== entry.terminal_id ||
      agent.workspace_id !== workspace ||
      agent.agent !== entry.kind
    )
      throw new Error(`${entry.name} identity changed before initialization`);
    if (['idle', 'done'].includes(agent.agent_status) && agent.interactive_ready) break;
    if (agent.agent_status === 'blocked')
      throw new Error(
        `${entry.name} needs user input before initialization; open its pane and check login or permission prompts`,
      );
    if (!['starting', 'initializing', 'idle', 'done'].includes(agent.agent_status))
      throw new Error(
        `${entry.name} is not ready for initialization (status ${agent.agent_status}, interactive_ready ${agent.interactive_ready})`,
      );
    if (!waiting) progress('waiting for readiness');
    waiting = true;
    await delay(interval, undefined, { signal });
  }
  progress('initializing role');
  signal.throwIfAborted();
  const result = await client.call([
    'agent',
    'prompt',
    entry.name,
    prompt,
    '--wait',
    '--timeout',
    '120000',
  ]);
  if (!result.agent || !['idle', 'done'].includes(result.agent.agent_status))
    throw new Error(
      `${entry.name} needs user input during initialization; open its pane and check login or permission prompts`,
    );
}
async function focusReadyTeam(
  client: LegacyClient,
  state: Startup,
  file: string,
  out: Output,
): Promise<void> {
  try {
    await client.call(['agent', 'focus', state.leader_name]);
  } catch (error) {
    out(
      `Team ready, but focusing ${state.leader_name} failed. Startup record: ${file}\nRun initialization again to retry focusing the ready team.\n`,
    );
    throw error;
  }
}
export async function reuse(
  client: LegacyClient,
  file: string,
  workspace: string,
  out: Output,
  team: Team,
): Promise<boolean> {
  const state = await readState(file);
  if (!state) return false;
  if (!state.members.length)
    throw new Error(
      `previous initialization did not return pane IDs; inspect the workspace before removing record ${file} and retrying`,
    );
  const result = await client.call(['agent', 'list']);
  const matched = new Map<string, Agent>();
  for (const m of state.members)
    for (const agent of result.agents || []) {
      if (
        agent.name === m.name &&
        agent.terminal_id === m.terminal_id &&
        agent.workspace_id === workspace &&
        agent.agent
      )
        matched.set(m.name, agent);
    }
  if (state.status === 'ready' && matched.size === state.members.length) {
    if (team.workflow === 'router-worker' && state.communication_check !== 'verified')
      throw new Error(
        "existing team has not passed the router-worker communication check; close only this team's panes and start again",
      );
    if (!matched.has(state.leader_name)) throw new Error('startup record has no matching leader');
    reportConfigChange(out, state, team);
    await focusReadyTeam(client, state, file, out);
    out(`Existing team focused: ${state.leader_name}\n`);
    return true;
  }
  const panes = (await client.call(['pane', 'list', '--workspace', workspace])).panes || [];
  if (state.members.some((m) => panes.some((pane) => pane.terminal_id === m.terminal_id)))
    throw new Error(
      `an incomplete or changed team still has live panes; inspect ${file} and close those team panes before restarting; no duplicate team was created`,
    );
  return false;
}
export async function initializeMembers(
  team: Team,
  state: Startup,
  file: string,
  client: LegacyClient,
  out: Output,
): Promise<void> {
  const jobs = team.members.filter((m) => m.id !== team.leader);
  let next = 0,
    failure: unknown;
  let saves = Promise.resolve();
  // At most four in flight; drain them after failure, and leave unsent jobs alone.
  await Promise.all(
    Array.from({ length: Math.min(4, jobs.length) }, async () => {
      while (!failure && next < jobs.length) {
        const member = jobs[next++]!,
          entry = state.members.find((m) => m.id === member.id)!;
        out(`${entry.name}: checking readiness…\n`);
        try {
          await initializePromptWithReadiness(
            client,
            entry,
            state.workspace_id,
            rolePrompt(team, member, state, client.bin),
            30_000,
            250,
            (stage) => out(`${entry.name}: ${stage}…\n`),
          );
          entry.initialized = true;
          saves = saves.then(() => save(file, state));
          await saves;
          out(`${entry.name}: initialized\n`);
        } catch (error) {
          failure = failure ? new AggregateError([failure, error]) : error;
          out(`${entry.name}: initialization failed: ${(error as Error).message}\n`);
        }
      }
    }),
  );
  // Save after all in-flight jobs finish, avoiding concurrent atomic writes.
  await save(file, state);
  if (failure) throw failure;
  const member = team.members.find((m) => m.id === team.leader)!,
    entry = state.members.find((m) => m.id === team.leader)!;
  out(`${entry.name}: checking readiness…\n`);
  await initializePromptWithReadiness(
    client,
    entry,
    state.workspace_id,
    rolePrompt(team, member, state, client.bin),
    30_000,
    250,
    (stage) => out(`${entry.name}: ${stage}…\n`),
  );
  entry.initialized = true;
  await save(file, state);
  out(`${entry.name}: initialized\n`);
}
export async function initialize(
  team: Team,
  project: string,
  workspace: string,
  directory: string,
  env: Env,
  client: LegacyClient,
  out: Output,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = startupPath(directory, project, workspace, env),
    unlock = await lock(`${file}.lock`);
  try {
    if (await reuse(client, file, workspace, out, team)) return;
    await client.checkKinds(team);
    const prefix = `t${randomBytes(4).toString('hex')}`,
      state = newState(team, project, workspace, prefix);
    state.stage = 'creating panes';
    await save(file, state);
    let readySaved = false;
    try {
      const created = await client.call([
        'tab',
        'create',
        '--workspace',
        workspace,
        '--cwd',
        project,
        '--label',
        team.name,
        '--no-focus',
      ]);
      state.tab_id = created.tab?.id || '';
      let pane: Pane | undefined = created.root_pane;
      for (let i = 0; i < team.members.length; i++) {
        const member = team.members[i]!;
        if (i > 0)
          pane = (
            await client.call([
              'pane',
              'split',
              pane!.pane_id,
              '--direction',
              i % 2 === 0 ? 'down' : 'right',
              '--cwd',
              project,
              '--no-focus',
            ])
          ).pane;
        if (!pane?.pane_id || !pane.terminal_id)
          throw new Error('Herdr creation response is missing pane identity');
        state.members.push({
          id: member.id,
          name: `${prefix}-${member.id}`,
          pane_id: pane.pane_id,
          terminal_id: pane.terminal_id,
          kind: member.kind,
          started: false,
          initialized: false,
        });
        await save(file, state);
        await client.call(['pane', 'rename', pane.pane_id, member.id]);
      }
      state.stage = 'starting agents';
      await save(file, state);
      for (let i = 0; i < team.members.length; i++) {
        const member = team.members[i]!,
          entry = state.members[i]!;
        out(`Starting ${entry.name} (${member.kind})…\n`);
        try {
          await client.call([
            'agent',
            'start',
            entry.name,
            '--kind',
            member.kind,
            '--pane',
            entry.pane_id,
            '--',
            ...member.args,
          ]);
        } catch (error) {
          throw new Error(
            `starting ${entry.name} (${member.kind}) in pane ${entry.pane_id} failed: ${(error as Error).message}; open that pane and check login, permissions and CLI startup; launch delivery may be uncertain, so no automatic restart was attempted`,
          );
        }
        entry.started = true;
        await save(file, state);
      }
      state.stage = 'initializing roles';
      await save(file, state);
      await initializeMembers(team, state, file, client, out);
      if (team.workflow === 'router-worker') {
        state.stage = 'checking communication';
        state.communication_check = 'pending';
        await save(file, state);
        await checkCommunication(
          team,
          state,
          client.bin,
          false,
          async (entry, prompt) => {
            await client.call(['agent', 'wait', entry.name, '--timeout', '120000']);
            await initializePromptWithReadiness(client, entry, workspace, prompt);
          },
          out,
        );
        state.communication_check = 'verified';
      }
      state.status = 'ready';
      state.stage = 'ready';
      await save(file, state);
      readySaved = true;
      await focusReadyTeam(client, state, file, out);
      out(`Team ready. Send your goal to ${state.leader_name}. Startup record: ${file}\n`);
    } catch (error) {
      if (!readySaved) {
        state.status = 'partial';
        state.error = (error as Error).message;
        await save(file, state);
        out(`Initialization stopped; panes were preserved. Startup record: ${file}\n`);
      }
      throw error;
    }
  } finally {
    await unlock();
  }
}
export async function reportStatus(
  client: LegacyClient,
  file: string,
  project: string,
  workspace: string,
  out: Output,
): Promise<void> {
  const state = await readState(file);
  if (!state) {
    out(
      `No startup record for this project in the current Herdr session. Project: ${project}\nUse start-team to start a team.\n`,
    );
    return;
  }
  if (state.project !== project || state.workspace_id !== workspace)
    throw new Error(`startup record ${file} belongs to a different project or workspace`);
  out(`Project: ${project}\nTeam startup: ${state.status}\nStartup record: ${file}\n`);
  if (state.stage) out(`Last startup stage: ${state.stage}\n`);
  if (state.communication_check) out(`Communication check: ${state.communication_check}\n`);
  if (state.error) out(`Startup error: ${state.error}\n`);
  try {
    reportConfigChange(out, state, await loadTeam(project));
  } catch (error) {
    out(`Current configuration is invalid: ${(error as Error).message}\n`);
  }
  if (!state.members.length) {
    out(
      'No member pane identities were recorded. Inspect the workspace for panes created before the failure; resolve them before removing the startup record and retrying.\n',
    );
    return;
  }
  let agents: Agent[], panes: Pane[];
  try {
    agents = (await client.call(['agent', 'list'])).agents || [];
    panes = (await client.call(['pane', 'list', '--workspace', workspace])).panes || [];
  } catch (error) {
    recordedMembers(out, state);
    throw new Error(
      `cannot query live members; recorded startup details shown above: ${(error as Error).message}`,
    );
  }
  out('Member\tStarted\tInitialized\tCurrent status\tInteractive ready\tPane\n');
  for (const m of state.members) {
    let current = panes.some((p) => p.pane_id === m.pane_id && p.terminal_id === m.terminal_id)
        ? 'pane only'
        : 'missing',
      ready = '-';
    for (const agent of agents) {
      if (agent.name !== m.name || agent.workspace_id !== workspace) continue;
      if (
        agent.pane_id !== m.pane_id ||
        agent.terminal_id !== m.terminal_id ||
        agent.agent !== m.kind
      ) {
        current = 'identity changed';
        continue;
      }
      current = agent.agent_status;
      ready = String(agent.interactive_ready);
      break;
    }
    out(
      `${m.id} (${m.name})\t${m.started}\t${m.initialized}\t${current}\t${ready}\t${m.pane_id}\n`,
    );
  }
  out(
    state.status !== 'ready'
      ? 'Next: inspect member panes for login, permission prompts or errors. Partial teams are not resumed automatically; close their panes after inspection, then run start-team again. Never resend uncertain initialization prompts blindly.\n'
      : 'Next: send work to the leader. For blocked members, inspect their panes for questions or login prompts. If members are missing or replaced, close the remaining old team panes before starting again.\n',
  );
}
export async function runLegacy(
  project: string,
  status: boolean,
  env: Env,
  out: Output,
): Promise<void> {
  if (env.HERDR_ENV !== '1')
    throw new Error(
      'not running inside Herdr; invoke start-team or status-team from a Herdr project',
    );
  const client = new Herdr(env.HERDR_BIN_PATH || 'herdr', env),
    resolved = await resolveProject(env, client, project),
    directory = startupDirectory(env);
  if (status)
    return reportStatus(
      client,
      startupPath(directory, resolved.project, resolved.workspace, env),
      resolved.project,
      resolved.workspace,
      out,
    );
  return initialize(
    await loadTeam(resolved.project),
    resolved.project,
    resolved.workspace,
    directory,
    env,
    client,
    out,
  );
}
