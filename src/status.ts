import { loadTeam } from './config.js';
import { reportConfigChange } from './state.js';
import type { Output, Startup } from './types.js';
import type { memberViews } from './member-views.js';

export async function statusHeader(state: Startup, file: string, project: string, out: Output) {
  out(
    `Project: ${project}\nTeam startup: ${state.status}\nLast startup stage: ${state.stage}\nStartup record: ${file}\n`,
  );
  if (state.communication_check) out(`Communication check: ${state.communication_check}\n`);
  if (state.communication_error) out(`Communication error: ${state.communication_error}\n`);
  if (state.error) out(`Startup error: ${state.error}\n`);
  try {
    reportConfigChange(out, state, await loadTeam(project));
  } catch (error) {
    out(`Current configuration is invalid: ${(error as Error).message}\n`);
  }
}
export function statusRows(members: ReturnType<typeof memberViews>, out: Output) {
  out('Member\tStarted\tInitialized\tCurrent status\tInteractive ready\tPane\tTerminal\n');
  for (const m of members)
    out(
      `${m.id} (${m.name})\t${m.started}\t${m.initialized}\t${m.current_status}\t${m.interactive_ready ?? '-'}\t${m.pane_id}\t${m.terminal_id}\n`,
    );
}
