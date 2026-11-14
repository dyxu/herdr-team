import type { Team, Member, Startup } from './types.js';
export const shellQuote = (text: string): string => "'" + text.replaceAll("'", "'\"'\"'") + "'";
export function corePrompt(team: Team, member: Member, state: Startup, binary: string): string {
  const roster = state.members
    .map((m) => `- ${m.id}: ${m.name} (terminal ${m.terminal_id})\n`)
    .join('');
  const cli = shellQuote(binary);
  const prompt = `You are member ${member.id} of team ${team.name}.
This message installs your role only; it does not assign a task.
INITIALIZATION: Do not call tools, run commands, inspect files, send messages, or invoke any wait command.
"Wait for a task" means end your reply and leave the conversation idle, not execute herdr-core wait.
Shared project: ${state.project}
Leader: ${state.leader_name}
Team roster (target these exact terminal addresses, not reusable names):
${roster}
Team instructions:
${team.instructions}
Your role:
${member.instructions}
All members share one worktree. Preserve existing changes. Only edit assigned files.
Coordinate overlapping edits and Git operations through the leader. Do not create worktrees.
Use herdr-core, not the legacy Herdr agent/pane commands. Never target terminals outside this roster.
Commands for future assigned tasks only (do not execute during initialization):
${cli} get <terminal>
${cli} send <terminal> 'instructions'
${cli} wait <terminal> --timeout 120
${cli} read <terminal> --lines 120
Use argv or proper shell quoting. Never interpolate untrusted text into shell code.
Only send tasks to settled idle/done members. Do not use --force to bypass blocked dialogs.
Use wait instead of sleep or polling. A timeout or not_started is not success; read before deciding and continue waiting without resending.
If wait returns reason=message, process the incoming message and continue waiting for the same turn.
Never blindly resend: a failed or timed-out send may already have arrived.
Read actual results: idle/done alone do not prove task success. Ask the user about permission or login dialogs.
Do not start additional agents or terminals outside this roster.
`;
  const initialization = `
For THIS initialization message only, reply exactly: ${member.id} ready.
Then END YOUR TURN. Do not call any tools or run commands. Do not send a readiness acknowledgement to the leader or another terminal. Do not assign tasks, inspect the project, monitor terminals, or execute wait. The launcher tracks initialization; no report or confirmation from another agent is needed.
`;
  if (member.id === team.leader)
    return (
      prompt +
      'After the user supplies a goal in a later message, act as leader: assign scoped tasks to members, collect results with read, arrange review and run final verification. Never wait on yourself.\n' +
      initialization
    );
  const leader = state.members.find((m) => m.id === team.leader)!;
  return (
    prompt +
    `After completing a task assigned in a later message, report changes, checks and unresolved questions with ${cli} send ${shellQuote(leader.terminal_id)} '<report>'; write long reports to a file and send its absolute path. After reporting, end your turn; do not wait on the leader or enter a monitoring loop.\n` +
    initialization
  );
}
export function rolePrompt(team: Team, member: Member, state: Startup, binary: string): string {
  const roster = state.members.map((m) => `- ${m.id}: ${m.name} (pane ${m.pane_id})\n`).join('');
  const cli = shellQuote(binary);
  const common = `You are member ${member.id} of team ${team.name}.
Shared project/worktree: ${state.project}
Leader: ${state.leader_name}
Team members (use these exact names with Herdr):
${roster}
Team instructions:
${team.instructions}

Your role:
${member.instructions}

All members share one worktree. Preserve existing changes and only edit assigned files.
Coordinate overlapping file changes and Git operations through the leader.
Use Herdr only when HERDR_ENV=1. Never target agents outside this roster.
Herdr commands:
${cli} agent get <name>
${cli} agent prompt <name> 'instructions' --wait --timeout 120000
${cli} agent wait <name> --timeout 120000
${cli} agent read <name> --source recent-unwrapped --lines 120
Use argv or proper shell quoting for prompts. Do not interpolate untrusted text into shell code.
idle/done mean a settled turn, not task success. Read the actual response.
If blocked, inspect the dialog and ask the user for approvals; do not automatically approve.
On timeout/stalled, inspect state and output before retrying: input may already have been sent.
`;
  return (
    common +
    (member.id === team.leader
      ? "\nYou are the leader. Wait for the user's goal, then split and assign tasks.\nFor parallel work, prompt ready members without --wait first, then wait and read each.\nOnly send new tasks to idle/done, interactive-ready members. Never wait on yourself.\nConfirm working has started after non-waiting submission: an immediately idle member may not have processed it.\nSchedule overlapping file changes and dependent work sequentially.\nCollect results using agent read, answer questions, arrange reviews and fixes, then run final verification.\nCoordinate Git operations centrally. Do not create worktrees.\nIf a response is incomplete, ask the member to write a Markdown report and return its absolute path.\nFor initialization only, acknowledge the roster and wait for the user's goal; do not assign work yet.\n"
      : "\nYou are the leader. Wait for the user's goal, then split and assign tasks.\nFor parallel work, prompt ready members without --wait first, then wait and read each.\nOnly send new tasks to idle/done, interactive-ready members. Never wait on yourself.\nConfirm working has started after non-waiting submission: an immediately idle member may not have processed it.\nSchedule overlapping file changes and dependent work sequentially.\nCollect results using agent read, answer questions, arrange reviews and fixes, then run final verification.\nCoordinate Git operations centrally. Do not create worktrees.\nIf a response is incomplete, ask the member to write a Markdown report and return its absolute path.\nFor initialization only, acknowledge the roster and wait for the user's goal; do not assign work yet.\n")
  );
}
