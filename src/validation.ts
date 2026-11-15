import type { Agent, CoreTerminal, Pane, StartedMember, Startup } from './types.js';

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label}: expected an object`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value) || value.includes('\0'))
    throw new Error(`${label}: expected ${empty ? 'a' : 'a nonempty'} string`);
  return value;
}
export function flag(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}: expected a boolean`);
  return value;
}
export function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value))
    throw new Error(`${label}: expected an array; missing data is not an empty list`);
  return value;
}
export function validateState(value: unknown): Startup {
  const state = object(value, 'startup record');
  if (state.schema_version !== undefined && state.schema_version !== 1)
    throw new Error('unsupported startup schema_version');
  for (const key of ['project', 'workspace_id', 'leader_name', 'status'])
    text(state[key], `startup.${key}`);
  if (!['starting', 'ready', 'partial', 'stopping', 'stopped'].includes(state.status as string))
    throw new Error('startup.status is invalid');
  for (const key of ['stage', 'tab_id', 'config_digest', 'error', 'communication_error'])
    if (state[key] !== undefined) text(state[key], `startup.${key}`, true);
  if (
    state.communication_check !== undefined &&
    !['pending', 'verified', 'failed'].includes(state.communication_check as string)
  )
    throw new Error('startup.communication_check is invalid');
  const ids = new Set(),
    names = new Set(),
    terminals = new Set();
  const members = array(state.members, 'startup.members').map((value, i) => {
    const member = object(value, `startup.members[${i}]`);
    for (const key of ['id', 'name', 'kind']) text(member[key], `member.${key}`);
    for (const key of ['pane_id', 'terminal_id'])
      if (member[key] !== undefined) text(member[key], `member.${key}`, true);
    for (const key of ['started', 'initialized']) flag(member[key], `member.${key}`);
    if (
      ids.has(member.id) ||
      names.has(member.name) ||
      (member.terminal_id && terminals.has(member.terminal_id))
    )
      throw new Error('startup record has duplicate member identities');
    if ((member.initialized && !member.started) || (member.started && !member.terminal_id))
      throw new Error('startup record has inconsistent member lifecycle');
    ids.add(member.id);
    names.add(member.name);
    if (member.terminal_id) terminals.add(member.terminal_id);
    return {
      ...member,
      pane_id: member.pane_id ?? '',
      terminal_id: member.terminal_id ?? '',
    } as unknown as StartedMember;
  });
  if (
    state.status === 'ready' &&
    (!members.length ||
      members.some((m) => !m.started || !m.initialized) ||
      !members.some((m) => m.name === state.leader_name))
  )
    throw new Error('ready startup record is incomplete');
  return {
    ...state,
    stage: state.stage ?? '',
    tab_id: state.tab_id ?? '',
    members,
  } as unknown as Startup;
}
export function validateAgent(value: unknown): Agent {
  const agent = object(value, 'Herdr agent');
  for (const key of ['name', 'pane_id', 'terminal_id', 'workspace_id', 'agent', 'agent_status'])
    text(agent[key], `agent.${key}`);
  flag(agent.interactive_ready, 'agent.interactive_ready');
  if (agent.cwd !== undefined) text(agent.cwd, 'agent.cwd');
  return agent as unknown as Agent;
}
export function validatePane(value: unknown): Pane {
  const pane = object(value, 'Herdr pane');
  text(pane.pane_id, 'pane.pane_id');
  text(pane.terminal_id, 'pane.terminal_id');
  if (pane.cwd !== undefined) text(pane.cwd, 'pane.cwd');
  return pane as unknown as Pane;
}
export function agentList(value: unknown): Agent[] {
  return array(object(value, 'Herdr result').agents, 'Herdr agents').map(validateAgent);
}
export function paneList(value: unknown): Pane[] {
  return array(object(value, 'Herdr result').panes, 'Herdr panes').map(validatePane);
}
export function agentMatches(agent: Agent, member: StartedMember, workspace: string): boolean {
  return (
    agent.name === member.name &&
    agent.pane_id === member.pane_id &&
    agent.terminal_id === member.terminal_id &&
    agent.workspace_id === workspace &&
    agent.agent === member.kind
  );
}
export function paneMatches(pane: Pane, member: StartedMember): boolean {
  return pane.pane_id === member.pane_id && pane.terminal_id === member.terminal_id;
}
export function validateTerminal(value: unknown): CoreTerminal {
  const terminal = object(value, 'core terminal');
  for (const key of ['address', 'cwd', 'state']) text(terminal[key], `terminal.${key}`);
  if (terminal.name !== undefined && terminal.name !== null)
    text(terminal.name, 'terminal.name', true);
  const labels = object(terminal.labels, 'terminal.labels');
  for (const [key, value] of Object.entries(labels)) text(value, `label.${key}`, true);
  if (terminal.status !== undefined && terminal.status !== null) {
    const status = object(terminal.status, 'terminal.status');
    text(status.state, 'terminal.status.state');
  }
  return terminal as unknown as CoreTerminal;
}
