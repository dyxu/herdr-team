import { agentMatches, paneMatches, agentList, paneList } from './validation.js';
import type { Agent, CoreTerminal, Pane, Startup, StartedMember, LegacyClient } from './types.js';

export const coreStatusName = (t: CoreTerminal): string =>
  t.state !== 'live' ? t.state : t.status?.state || 'starting (no status report)';
export const coreMatches = (
  t: CoreTerminal,
  m: StartedMember,
  project: string,
  token: string,
): boolean =>
  t.address === m.terminal_id &&
  t.name === m.name &&
  t.cwd === project &&
  t.labels?.['herdr-team'] === token;
export interface Inventory {
  terminals: CoreTerminal[];
  agents: Agent[];
  panes: Pane[];
}
export async function legacyInventory(client: LegacyClient, workspace: string): Promise<Inventory> {
  return {
    terminals: [],
    agents: agentList(await client.call(['agent', 'list'])),
    panes: paneList(await client.call(['pane', 'list', '--workspace', workspace])),
  };
}
export function memberViews(
  runtime: { backend: 'core' | 'herdr'; project: string; workspace: string },
  state: Startup,
  live: Inventory,
) {
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
