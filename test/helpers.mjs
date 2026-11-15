import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  chmod,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export async function temporary(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'herdr-team-ts-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
export async function fixture(t) {
  const directory = await temporary(t),
    project = path.join(directory, 'project with spaces'),
    state = path.join(directory, 'state');
  await mkdir(path.join(project, '.team/members'), { recursive: true });
  await writeFile(
    path.join(project, '.team/team.md'),
    '---\nname: development\nleader: leader\nmembers: [members/leader.md, members/dev.md]\n---\nShared rules',
  );
  for (const id of ['leader', 'dev'])
    await writeFile(
      path.join(project, `.team/members/${id}.md`),
      `---\nid: ${id}\nkind: codex\nargs: []\n---\nRole for ${id}`,
    );
  return { directory, project, state };
}
export async function readStartup(state) {
  const file = (await readdir(state)).find((name) => name.endsWith('.json'));
  return JSON.parse(await readFile(path.join(state, file), 'utf8'));
}
export async function coreFixture(t, mode = 'idle') {
  const f = await fixture(t),
    bin = path.join(f.directory, 'herdr-core');
  // An argv-safe executable wrapper, independent of any installed core.
  await writeFile(
    bin,
    `#!/usr/bin/env node\nimport(${JSON.stringify(new URL('./fake-core.mjs', import.meta.url).href)});\n`,
  );
  await chmod(bin, 0o700);
  await writeFile(path.join(f.directory, 'mode'), mode);
  return {
    ...f,
    bin,
    env: {
      ...process.env,
      FAKE_CORE_ROOT: f.directory,
      HERDR_CORE_BIN_PATH: bin,
      HERDR_PLUGIN_STATE_DIR: f.state,
      HC_TERMINAL_ID: '',
    },
  };
}
export async function coreCalls(directory) {
  return (await readFile(path.join(directory, 'calls'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
export const count = (calls, method) => calls.filter((call) => call.method === method).length;
export function fakeHerdr() {
  const client = {
    bin: '/path with spaces/herdr',
    calls: [],
    agents: [],
    panes: [],
    block: false,
    failStart: false,
    failFocus: false,
    async checkKinds() {},
    async call(args) {
      client.calls.push(args);
      const command = args.slice(0, 2).join(' ');
      if (command === 'agent list') return { agents: client.agents };
      if (command === 'pane list') return { panes: client.panes };
      if (command === 'pane get') return { pane: client.panes.find((p) => p.pane_id === args[2]) };
      if (command === 'pane close') {
        const pane = client.panes.find((p) => p.pane_id === args[2]);
        client.panes = client.panes.filter((p) => p !== pane);
        client.agents = client.agents.filter((a) => a.terminal_id !== pane?.terminal_id);
        return {};
      }

      if (command === 'agent get') {
        const agent = client.agents.find((agent) => agent.name === args[2]);
        return { agent: client.getAgent ? client.getAgent(agent) : agent };
      }
      if (command === 'tab create' || command === 'pane split') {
        const i = client.panes.length + 1,
          pane = { pane_id: `w1:p${i}`, terminal_id: `term-${i}` };
        client.panes.push(pane);
        return { pane, root_pane: pane, tab: { id: 'w1:t2' } };
      }
      if (command === 'pane rename') return {};
      if (command === 'agent start') {
        if (client.failStart) throw new Error('start failed; delivery unknown');
        const pane = client.panes.find((p) => p.pane_id === args[args.indexOf('--pane') + 1]);
        client.agents.push({
          name: args[2],
          ...pane,
          workspace_id: 'w1',
          agent: args[args.indexOf('--kind') + 1],
          agent_status: 'idle',
          interactive_ready: true,
        });
        return {};
      }
      if (command === 'agent prompt') {
        if (client.prompt) return client.prompt(args);
        return { agent: { agent_status: client.block ? 'blocked' : 'done' } };
      }
      if (command === 'agent focus') {
        if (client.failFocus) throw new Error('focus failed');
        return {};
      }
      throw new Error(`unexpected ${command}`);
    },
  };
  return client;
}
