import { coreStatusName, coreMatches, memberViews } from './member-views.js';
import { statusHeader, statusRows } from './status.js';
import { mkdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical, loadTeam } from './config.js';
import { checkCommunication } from './communication.js';
import { validateTerminal, object, text, flag } from './validation.js';
import { coreCall, CoreRPCError } from './process.js';
import { corePrompt, shellQuote } from './prompts.js';
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
import type { Env, Output, Team, Startup, StartedMember, CoreTerminal, CoreWait } from './types.js';

export { coreStatusName, coreMatches } from './member-views.js';
export function startupSendWasNotTyped(error: unknown, terminal: string): boolean {
  return (
    error instanceof CoreRPCError &&
    error.code === -32000 &&
    error.kind === 'unavailable' &&
    error.rpcMessage === `${terminal} is still starting: its output has not settled` &&
    error.hint === `nothing was typed; check hc read ${terminal}, then retry`
  );
}
export class Core {
  readonly caller: string;
  constructor(
    readonly bin: string,
    readonly env: Env,
  ) {
    this.caller = env.HC_TERMINAL_ID || `ppid:${process.pid}`;
  }
  async call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const result = await coreCall<unknown>(this.bin, this.env, method, params, signal);
    if (['terminal.get', 'terminal.run', 'terminal.kill'].includes(method))
      validateTerminal(result);
    if (method === 'server.status')
      text(object(object(result, 'server.status').core, 'core').id, 'core.id');
    if (method === 'terminal.wait') {
      const value = object(result, 'terminal.wait');
      text(value.terminal, 'wait.terminal');
      text(value.status, 'wait.status', true);
      text(value.reason, 'wait.reason');
      flag(value.ended, 'wait.ended');
      if (!Number.isSafeInteger(value.turn) || Number(value.turn) < 0)
        throw new Error('terminal.wait has invalid turn');
    }
    if (method === 'terminal.send') {
      const value = object(result, 'terminal.send');
      if (!Number.isSafeInteger(value.turn) || Number(value.turn) < 0)
        throw new Error(
          'terminal.send response is missing or has invalid turn; delivery may have occurred',
        );
    }
    return result as T;
  }
  async terminals(): Promise<CoreTerminal[]> {
    const result = await this.call<{ terminals: CoreTerminal[] }>('terminal.list', { all: true });
    if (!Array.isArray(result.terminals))
      throw new Error(
        'terminal.list response is missing terminals; refusing to infer that the previous team is gone',
      );
    return result.terminals.map(validateTerminal);
  }
  async blockedError(terminal: string, signal?: AbortSignal): Promise<Error> {
    let kind = '',
      detail = '';
    try {
      const current = await this.call<CoreTerminal>('terminal.get', { terminal }, signal);
      if (current.address === terminal) kind = current.status?.kind || '';
    } catch (error) {
      detail = `; ${String(error)}`;
    }
    return new Error(
      `${terminal} needs user input (blocked${kind ? `: ${kind}` : ''}); open ${shellQuote(this.bin)} attach ${shellQuote(terminal)} and handle the prompt manually; no automatic approval or role resend was attempted${detail}`,
    );
  }
  async waitSettled(terminal: string, out: Output, signal: AbortSignal): Promise<void> {
    while (true) {
      signal.throwIfAborted();
      const result = await this.call<CoreWait>(
        'terminal.wait',
        { terminal, caller: this.caller, timeout: 30 },
        signal,
      );
      if (result.terminal !== terminal)
        throw new Error('terminal.wait returned a different terminal identity');
      if (result.reason === 'message') {
        out(`${terminal}: core message interrupted waiting; continuing the same turn…\n`);
        continue;
      }
      if (result.reason === 'timeout') continue;
      if (result.reason === 'status') {
        if (result.ended && ['idle', 'done'].includes(result.status)) return;
        if (result.status === 'blocked') throw await this.blockedError(terminal, signal);
        throw new Error(
          `${terminal} did not settle (status ${result.status}); inspect get/read for login, permission or agent errors`,
        );
      }
      throw new Error(
        `${terminal} wait ended with ${result.reason} (status ${result.status}); inspect get/read before retrying`,
      );
    }
  }
  async initializeRole(
    entry: StartedMember,
    project: string,
    token: string,
    prompt: string,
    out: Output,
    startupBudget = 60_000,
  ): Promise<void> {
    const signal = AbortSignal.timeout(startupBudget);
    let sent: { turn?: number };
    while (true) {
      await this.waitSettled(entry.terminal_id, out, signal);
      const current = await this.call<CoreTerminal>(
        'terminal.get',
        { terminal: entry.terminal_id },
        signal,
      );
      if (
        !coreMatches(current, entry, project, token) ||
        current.state !== 'live' ||
        !['idle', 'done'].includes(coreStatusName(current))
      )
        throw new Error(
          `${entry.name} is not settled or its identity changed (status ${coreStatusName(current)}); inspect get/read before retrying`,
        );
      const params: Record<string, unknown> = {
        terminal: entry.terminal_id,
        caller: this.caller,
        text: prompt,
        force: false,
        wait: false,
      };
      if (coreStatusName(current) === 'idle') params.if = 'idle';
      try {
        sent = await this.call('terminal.send', params, signal);
        break;
      } catch (error) {
        if (!startupSendWasNotTyped(error, entry.terminal_id) || signal.aborted) throw error;
        out(`${entry.name}: startup output is still settling; nothing was typed, retrying…\n`);
        await delay(100, undefined, { signal });
      }
    }
    if (typeof sent.turn !== 'number')
      throw new Error('terminal.send response is missing turn; delivery may have occurred');
    try {
      await this.waitSettled(entry.terminal_id, out, AbortSignal.timeout(120_000));
    } catch (error) {
      throw new Error(
        `role initialization: ${(error as Error).message}; delivery may have occurred`,
        { cause: error },
      );
    }
  }
}
function coreReady(out: Output, c: Core, state: Startup): void {
  out(
    `Team ready. Attach to the leader: ${shellQuote(c.bin)} attach ${shellQuote(state.leader_name)}\n`,
  );
}
export async function coreStatus(
  c: Core,
  file: string,
  project: string,
  workspace: string,
  out: Output,
): Promise<void> {
  const state = await readState(file);
  if (!state) {
    out(`No core team startup record. Project: ${project}\n`);
    return;
  }
  if (state.project !== project || state.workspace_id !== workspace)
    throw new Error('core startup record belongs to another project or core');
  await statusHeader(state, file, project, out);
  let terminals: CoreTerminal[];
  try {
    terminals = await c.terminals();
  } catch (error) {
    recordedMembers(out, state);
    throw error;
  }
  statusRows(
    memberViews({ backend: 'core', project, workspace }, state, {
      terminals,
      agents: [],
      panes: [],
    }),
    out,
  );
  out(
    `Inspect members with ${shellQuote(c.bin)} get/read <terminal>; resolve dialogs before retrying.\n`,
  );
}
export async function startCore(
  c: Core,
  team: Team,
  project: string,
  workspace: string,
  file: string,
  out: Output,
): Promise<void> {
  const terminals = await c.terminals(),
    previous = await readState(file);
  if (previous) {
    if (previous.project !== project || previous.workspace_id !== workspace)
      throw new Error('core startup record belongs to another project or core');
    const live = terminals.filter(
      (t) =>
        t.state === 'live' &&
        (t.labels?.['herdr-team'] === previous.leader_name ||
          previous.members.some(
            (m) => t.name === m.name || (m.terminal_id && t.address === m.terminal_id),
          )),
    );
    const matched = live.filter((t) =>
      previous.members.some((m) => coreMatches(t, m, project, previous.leader_name)),
    );
    if (
      previous.status === 'ready' &&
      previous.members.length > 0 &&
      matched.length === previous.members.length &&
      live.length === matched.length
    ) {
      if (team.workflow === 'router-worker' && previous.communication_check !== 'verified')
        throw new Error(
          "existing team has not passed the router-worker communication check; close only this team's terminals and start again",
        );
      reportConfigChange(out, previous, team);
      coreReady(out, c, previous);
      return;
    }
    if (live.length)
      throw new Error(
        `previous core team is incomplete; inspect ${file} and its labeled terminals, then close only that team's terminals before restarting; no prompts were resent`,
      );
  }
  const prefix = `t${randomBytes(4).toString('hex')}`,
    state = newState(team, project, workspace, prefix);
  state.stage = 'starting terminals';
  state.members = team.members.map((m) => ({
    id: m.id,
    name: `${prefix}-${m.id}`,
    kind: m.kind,
    pane_id: '',
    terminal_id: '',
    started: false,
    initialized: false,
  }));
  await save(file, state);
  try {
    for (let i = 0; i < team.members.length; i++) {
      const m = team.members[i]!,
        entry = state.members[i]!;
      const argv = [
        '/usr/bin/env',
        m.kind,
        ...(m.kind === 'codex' ? ['--no-daemon'] : []),
        ...m.args,
      ];
      out(`Starting ${entry.name} (${m.kind})…\n`);
      const terminal = await c.call<CoreTerminal>('terminal.run', {
        argv,
        cwd: project,
        name: entry.name,
        labels: { 'herdr-team': state.leader_name },
        no_parent: true,
        no_notify: true,
        wait: false,
      });
      if (!terminal.address || terminal.name !== entry.name || terminal.state !== 'live')
        throw new Error(
          `invalid core launch identity for ${entry.name}; inspect by name before retrying`,
        );
      entry.terminal_id = terminal.address;
      entry.started = true;
      await save(file, state);
    }
    state.stage = 'initializing roles';
    await save(file, state);
    const order = [
      ...team.members.filter((m) => m.id !== team.leader),
      team.members.find((m) => m.id === team.leader)!,
    ];
    for (const m of order) {
      const entry = state.members.find((entry) => entry.id === m.id)!;
      out(`${entry.name}: waiting for readiness…\n`);
      await c.initializeRole(
        entry,
        project,
        state.leader_name,
        corePrompt(team, m, state, c.bin, c.env.HERDR_TEAM_CLI_PATH),
        out,
      );
      entry.initialized = true;
      await save(file, state);
      out(`${entry.name}: initialized\n`);
    }
    if (team.workflow === 'router-worker') {
      state.stage = 'checking communication';
      state.communication_check = 'pending';
      await save(file, state);
      await checkCommunication(
        team,
        state,
        c.bin,
        true,
        (entry, prompt) => c.initializeRole(entry, project, state.leader_name, prompt, out),
        out,
      );
      state.communication_check = 'verified';
    }
    state.status = 'ready';
    state.stage = 'ready';
    await save(file, state);
    coreReady(out, c, state);
  } catch (error) {
    state.status = 'partial';
    state.error = (error as Error).message;
    try {
      await save(file, state);
    } catch (saveError) {
      throw new AggregateError(
        [error, saveError],
        'startup failed and partial record could not be saved',
      );
    }
    out(`Initialization stopped; terminals preserved. Startup record: ${file}\n`);
    throw error;
  }
}
export async function runCore(
  project: string,
  status: boolean,
  env: Env,
  out: Output,
): Promise<void> {
  project = await canonical(project || '.');
  if (!(await stat(project)).isDirectory()) throw new Error('project path is not a directory');
  const c = new Core(env.HERDR_CORE_BIN_PATH || 'herdr-core', env);
  const server = await c.call<{ core: { id: string } }>('server.status', {});
  if (!server.core?.id) throw new Error('herdr-core server status is missing core identity');
  const directory = startupDirectory(env),
    workspace = `core:${server.core.id}`,
    file = startupPath(directory, project, workspace);
  if (status) return coreStatus(c, file, project, workspace, out);
  const team = await loadTeam(project);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const unlock = await lock(`${file}.lock`);
  try {
    await startCore(c, team, project, workspace, file, out);
  } finally {
    await unlock();
  }
}
