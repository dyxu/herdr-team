import { access, mkdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { loadTeam } from './config.js';
import { checkCommunication } from './communication.js';
import { coreMatches } from './core.js';
import { initializePromptWithReadiness } from './legacy.js';
import { execute } from './process.js';
import { lock, save, teamDigest } from './state.js';
import { inventory, runtimeState, memberViews, statusSnapshot, openRuntime } from './runtime.js';
import {
  agentMatches,
  paneMatches,
  validateTerminal,
  validatePane,
  validateAgent,
} from './validation.js';
import type { Runtime, Inventory } from './runtime.js';
import type { CoreTerminal, Env, Output, StartedMember, Startup } from './types.js';

export async function executable(command: string, env: Env): Promise<string> {
  const candidates = command.includes('/')
    ? [path.resolve(command)]
    : (env.PATH || '')
        .split(path.delimiter)
        .map((directory) => path.resolve(directory || '.', command));
  for (const candidate of candidates)
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      /* Try the next PATH entry. */
    }
  throw new Error(`executable not found: ${command}`);
}
export async function doctor(runtime: Runtime, env: Env, out: Output): Promise<void> {
  const checks: { name: string; ok: boolean | null; detail: string }[] = [];
  try {
    const team = await loadTeam(runtime.project);
    checks.push({
      name: 'configuration',
      ok: true,
      detail: `${team.name}: ${team.members.length} members`,
    });
    for (const kind of new Set(team.members.map((m) => m.kind))) {
      try {
        checks.push({ name: `agent:${kind}`, ok: true, detail: await executable(kind, env) });
      } catch (error) {
        checks.push({ name: `agent:${kind}`, ok: false, detail: (error as Error).message });
      }
    }
    if (runtime.client) {
      await runtime.client.checkKinds(team);
      checks.push({ name: 'supported kinds', ok: true, detail: 'configured kinds are supported' });
    }
  } catch (error) {
    checks.push({ name: 'configuration', ok: false, detail: (error as Error).message });
  }
  try {
    const report = await statusSnapshot(runtime);
    checks.push({ name: 'backend', ok: true, detail: runtime.workspace });
    if (report.startup)
      checks.push({
        name: 'startup record',
        ok: ['ready', 'stopped'].includes(report.startup.status),
        detail: report.startup.status,
      });
    for (const m of report.startup?.status === 'stopped' ? [] : report.members)
      checks.push({
        name: `member:${m.id}`,
        ok: m.matches && ['idle', 'done', 'working'].includes(m.current_status),
        detail: m.current_status,
      });
    const comm = report.startup?.communication_check;
    checks.push({
      name: 'agent communication',
      ok: comm === 'verified' ? true : comm === 'failed' ? false : null,
      detail:
        comm === 'verified'
          ? 'verified for recorded sessions'
          : 'not verified; use doctor communication to run an explicit Agent probe',
    });
  } catch (error) {
    checks.push({ name: 'backend/state', ok: false, detail: (error as Error).message });
  }
  out(`Doctor: ${runtime.backend} ${runtime.project}\nNode: ${process.version}\n`);
  for (const c of checks)
    out(`${c.ok === null ? 'SKIP' : c.ok ? 'OK' : 'FAIL'} ${c.name}: ${c.detail}\n`);
  out(
    'Basic diagnosis did not start or prompt Agents. Agent login and tool permissions are not inferred from executable presence.\n',
  );
  if (checks.some((c) => c.ok === false)) throw new Error('doctor found problems');
}
export async function verifyCommunication(runtime: Runtime, out: Output): Promise<void> {
  const unlock = await lock(`${runtime.file}.lock`);
  try {
    const state = await runtimeState(runtime);
    if (!state || state.status !== 'ready')
      throw new Error('communication diagnosis requires an existing ready team');
    const team = await loadTeam(runtime.project);
    if (state.config_digest !== teamDigest(team))
      throw new Error('configuration changed; restart the team before communication diagnosis');
    const members = memberViews(runtime, state, await inventory(runtime));
    if (
      members.some(
        (m) =>
          !m.matches ||
          !['idle', 'done'].includes(m.current_status) ||
          (runtime.backend === 'herdr' && !m.interactive_ready),
      )
    )
      throw new Error(
        'all recorded members must have matching identities and be settled before communication diagnosis',
      );
    state.communication_check = 'pending';
    delete state.communication_error;
    await save(runtime.file, state);
    try {
      await checkCommunication(
        team,
        state,
        runtime.core?.bin || runtime.client!.bin,
        !!runtime.core,
        async (entry, prompt) => {
          if (runtime.core)
            await runtime.core.initializeRole(
              entry,
              runtime.project,
              state.leader_name,
              prompt,
              out,
            );
          else {
            await runtime.client!.call(['agent', 'wait', entry.name, '--timeout', '120000']);
            await initializePromptWithReadiness(runtime.client!, entry, runtime.workspace, prompt);
          }
        },
        out,
      );
      state.communication_check = 'verified';
    } catch (error) {
      state.communication_check = 'failed';
      state.communication_error = (error as Error).message;
      throw error;
    } finally {
      await save(runtime.file, state);
    }
  } finally {
    await unlock();
  }
}
function coreStopTargets(runtime: Runtime, state: Startup, live: Inventory): CoreTerminal[] {
  const targets: CoreTerminal[] = [];
  for (const member of state.members) {
    const candidates = live.terminals.filter(
      (t) => t.address === member.terminal_id || t.name === member.name,
    );
    for (const terminal of candidates) {
      // A lost run response has no recorded address; recover only its planned name,
      // project and exact team label, never an arbitrary similarly named terminal.
      const recorded = member.terminal_id ? member : { ...member, terminal_id: terminal.address };
      if (!coreMatches(terminal, recorded, runtime.project, state.leader_name))
        throw new Error(`refusing to stop identity-changed member ${member.id}`);
      targets.push(terminal);
    }
  }
  if (
    live.terminals.some(
      (t) =>
        t.labels['herdr-team'] === state.leader_name &&
        !targets.some((target) => target.address === t.address),
    )
  )
    throw new Error('unrecorded team terminal found; inspect before stopping');
  return targets;
}
function legacyStopTargets(runtime: Runtime, state: Startup, live: Inventory): StartedMember[] {
  return state.members.filter((member) => {
    const panes = live.panes.filter(
      (p) => p.pane_id === member.pane_id || p.terminal_id === member.terminal_id,
    );
    const agents = live.agents.filter(
      (a) =>
        a.name === member.name ||
        a.terminal_id === member.terminal_id ||
        a.pane_id === member.pane_id,
    );
    if (
      panes.some((p) => !paneMatches(p, member)) ||
      agents.some((a) => !agentMatches(a, member, runtime.workspace))
    )
      throw new Error(`refusing to stop identity-changed member ${member.id}`);
    if ((agents.length && !panes.length) || (member.started && panes.length && !agents.length))
      throw new Error(`cannot confirm live identity of ${member.id}; inspect its pane`);
    return panes.length > 0;
  });
}
export async function stopTeam(runtime: Runtime, out: Output): Promise<void> {
  await mkdir(path.dirname(runtime.file), { recursive: true, mode: 0o700 });
  const unlock = await lock(`${runtime.file}.lock`);
  try {
    const state = await runtimeState(runtime);
    if (!state) {
      out('No recorded team to stop.\n');
      return;
    }
    const live = await inventory(runtime);
    // Preflight every member before the first destructive call.
    const terminals = runtime.core ? coreStopTargets(runtime, state, live) : [];
    const panes = runtime.client ? legacyStopTargets(runtime, state, live) : [];
    state.status = 'stopping';
    state.stage = 'stopping team';
    delete state.error;
    await save(runtime.file, state);
    try {
      for (const terminal of terminals.reverse()) {
        const current = validateTerminal(
          await runtime.core!.call('terminal.get', { terminal: terminal.address }),
        );
        if (
          !coreMatches(
            current,
            {
              ...state.members.find((m) => m.name === terminal.name)!,
              terminal_id: terminal.address,
            },
            runtime.project,
            state.leader_name,
          )
        )
          throw new Error(`identity changed before stop: ${terminal.address}`);
        if (current.state === 'live')
          await runtime.core!.call('terminal.kill', { terminal: terminal.address });
        // Re-read by immutable address after kill, before removing the terminal.
        const ended = validateTerminal(
          await runtime.core!.call('terminal.get', { terminal: terminal.address }),
        );
        if (ended.state === 'live')
          throw new Error(`terminal still live after kill: ${terminal.address}`);
        if (
          ended.name !== terminal.name ||
          ended.cwd !== runtime.project ||
          ended.labels['herdr-team'] !== state.leader_name
        )
          throw new Error('terminal identity changed after kill');
        await runtime.core!.call('terminal.rm', { terminal: terminal.address });
      }
      for (const member of panes.reverse()) {
        const current = validatePane(
          (await runtime.client!.call(['pane', 'get', member.pane_id])).pane,
        );
        if (!paneMatches(current, member))
          throw new Error(`pane identity changed before stop: ${member.id}`);
        if (member.started) {
          const agent = validateAgent(
            (await runtime.client!.call(['agent', 'get', member.name])).agent,
          );
          if (!agentMatches(agent, member, runtime.workspace))
            throw new Error(`agent identity changed before stop: ${member.id}`);
        }
        await runtime.client!.call(['pane', 'close', member.pane_id]);
      }
      state.status = 'stopped';
      state.stage = 'stopped';
      await save(runtime.file, state);
      out('Recorded team stopped. Startup history preserved.\n');
    } catch (error) {
      state.error = (error as Error).message;
      await save(runtime.file, state);
      throw error;
    }
  } finally {
    await unlock();
  }
}

export async function runDoctor(
  backend: 'core' | 'herdr',
  project: string,
  env: Env,
  out: Output,
): Promise<void> {
  let runtime: Runtime;
  try {
    runtime = await openRuntime(backend, project, env, 5_000);
  } catch (error) {
    out(`Doctor: ${backend} ${project || '.'}\nNode: ${process.version}\n`);
    try {
      const team = await loadTeam(project || '.');
      out(`OK configuration: ${team.name}\n`);
    } catch (configError) {
      out(`FAIL configuration: ${(configError as Error).message}\n`);
    }
    out(`FAIL backend: ${(error as Error).message}\nNo Agents were started or prompted.\n`);
    throw new Error('doctor could not connect to the selected backend', { cause: error });
  }
  return doctor(runtime, env, out);
}
