import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { shellQuote } from './prompts.js';
import type { CoreTerminal, HerdrResult, Output, StartedMember, Startup, Team } from './types.js';

async function evidence(file: string): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.size > 64 * 1024)
    throw new Error(`invalid communication evidence file: ${file}`);
  return readFile(file);
}
async function verifyGet(
  file: string,
  member: StartedMember,
  state: Startup,
  core: boolean,
): Promise<void> {
  const data = JSON.parse((await evidence(file)).toString('utf8'));
  if (core) {
    const t = data as CoreTerminal;
    if (
      t.address === member.terminal_id &&
      t.name === member.name &&
      t.cwd === state.project &&
      t.labels?.['herdr-team'] === state.leader_name &&
      t.state === 'live'
    )
      return;
  } else {
    const agent = (data as { result?: HerdrResult }).result?.agent;
    if (
      !data.error &&
      agent?.name === member.name &&
      agent.pane_id === member.pane_id &&
      agent.terminal_id === member.terminal_id &&
      agent.workspace_id === state.workspace_id &&
      agent.agent === member.kind
    )
      return;
  }
  throw new Error(`communication query returned wrong identity for ${member.id}`);
}
// Opt-in post-initialization check. Receipt files prove that the Router processed
// the challenge rather than merely echoing a role prompt or an old receipt.
export async function checkCommunication(
  team: Team,
  state: Startup,
  binary: string,
  core: boolean,
  deliver: (entry: StartedMember, prompt: string) => Promise<void>,
  out: Output,
): Promise<void> {
  const directory = await mkdtemp(path.join(state.project, '.team/.communication-'));
  const leader = state.members.find((m) => m.id === team.leader),
    workers = state.members.filter((m) => m.id !== team.leader);
  const challenges = Object.fromEntries(
    workers.map((m) => [m.id, randomBytes(16).toString('hex')]),
  );
  const file = (name: string) => path.join(directory, name);
  const address = (m: StartedMember) => (core ? m.terminal_id : m.name);
  const get = (m: StartedMember) =>
    core
      ? `${shellQuote(binary)} --json get ${shellQuote(address(m))}`
      : `${shellQuote(binary)} agent get ${shellQuote(address(m))}`;
  const receipt = (id: string) =>
    `printf '%s' ${shellQuote(challenges[id]!)} > ${shellQuote(file(`${id}.receipt`))}`;
  try {
    if (!leader || !workers.length)
      throw new Error('router-worker communication check needs a Leader and at least one Worker');
    await writeFile(
      file('plan.json'),
      JSON.stringify({ directory, core, leader, workers, challenges }),
      { mode: 0o600 },
    );
    let router = '#!/bin/sh\nset -eu\n';
    for (const worker of workers) {
      router += `${get(worker)} > ${shellQuote(file(`router-get-${worker.id}.json`))}\n`;
      const message = `COMMUNICATION_CHECK_RECEIPT ${worker.id} ${challenges[worker.id]}\nFor this communication check only, run exactly: ${receipt(worker.id)}\nThen end this turn. Do not assign tasks, send a reply, or change project files.`;
      const send = core
        ? `${shellQuote(binary)} --json send ${shellQuote(address(leader))} ${shellQuote(message)} --wait --timeout 45`
        : `${shellQuote(binary)} agent prompt ${shellQuote(address(leader))} ${shellQuote(message)} --wait --timeout 45000`;
      await writeFile(
        file(`${worker.id}.sh`),
        `#!/bin/sh\nset -eu\n${get(leader)} > ${shellQuote(file(`${worker.id}-get-router.json`))}\n${send}\n`,
        { mode: 0o600 },
      );
    }
    await writeFile(file('router.sh'), router, { mode: 0o600 });
    out('Checking Router/Worker communication (separate from role initialization)…\n');
    const allowed = workers
      .map(
        (w) =>
          `- ${w.id}: challenge ${challenges[w.id]}; permitted receipt command: ${receipt(w.id)}\n`,
      )
      .join('');
    await deliver(
      leader,
      `COMMUNICATION CHECK: a separate post-initialization test, not a user development task.
Run exactly: /bin/sh ${shellQuote(file('router.sh'))}
It queries the actual Workers using the current backend. If it fails or requests permission, report the blocker; do not approve, change permissions, bypass the sandbox, or create success receipts.
For subsequent COMMUNICATION_CHECK_RECEIPT messages matching a Worker and challenge below, execute only that Worker's receipt command, then END YOUR TURN without messaging another member. Do not create a receipt before its message arrives.
${allowed}
After the initial script succeeds, reply "communication listener ready" and END YOUR TURN. Do not assign tasks, inspect project code, wait on another member, or change task records. These receipt rules apply only to this check.`,
    );
    for (const worker of workers)
      await verifyGet(file(`router-get-${worker.id}.json`), worker, state, core);
    for (const worker of workers) {
      await deliver(
        worker,
        `COMMUNICATION CHECK: a separate post-initialization test. Run exactly: /bin/sh ${shellQuote(file(`${worker.id}.sh`))}
The script queries the Router and sends it a single challenge receipt, waiting only for that receipt turn. Do not resend. If blocked by permissions or login, report it without approving or bypassing restrictions. After the script returns, END YOUR TURN without the normal task report; the Router already received the check message. Do not inspect project code or modify task records.`,
      );
      await verifyGet(file(`${worker.id}-get-router.json`), leader, state, core);
      if ((await evidence(file(`${worker.id}.receipt`))).toString('utf8') !== challenges[worker.id])
        throw new Error(
          `missing or invalid Router receipt for ${worker.id}: cross-agent message was not confirmed`,
        );
    }
    out(
      'Communication verified: Router queried Workers; each Worker queried and reported to Router.\n',
    );
  } catch (error) {
    throw new Error(
      `communication check failed: ${(error as Error).message}; evidence and probe scripts preserved at ${directory}; inspect member terminals for permissions or login; no automatic approval or probe resend`,
      { cause: error },
    );
  }
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
