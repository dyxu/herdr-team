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
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { Agent, Pane, LegacyClient, HerdrResult, Startup, Env } from '../src/types.js';
import { validateState } from '../bin/library.mjs';
export interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}
export interface FakeHerdr extends LegacyClient {
  calls: string[][];
  agents: Agent[];
  panes: Pane[];
  block: boolean;
  failStart: boolean;
  failFocus: boolean;
  getAgent?: (agent: Agent) => Agent;
  prompt?: (args: string[]) => Promise<HerdrResult>;
}
export const root = fileURLToPath(new URL('../', import.meta.url));
export async function temporary(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'herdr-team-ts-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
export async function fixture(t: TestContext) {
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
export async function readStartup(state: string): Promise<Startup> {
  const file = (await readdir(state)).find((name) => name.endsWith('.json'));
  assert.ok(file, 'startup record exists');
  return validateState(JSON.parse(await readFile(path.join(state, file), 'utf8')));
}
export async function coreFixture(t: TestContext, mode = 'idle') {
  const f = await fixture(t),
    bin = path.join(f.directory, 'herdr-core');
  // An argv-safe executable wrapper, independent of any installed core.
  await writeFile(
    bin,
    `#!/usr/bin/env -S node --experimental-strip-types\nimport(${JSON.stringify(new URL('./fake-core.ts', import.meta.url).href)});\n`,
  );
  await chmod(bin, 0o700);
  await writeFile(path.join(f.directory, 'mode'), mode);
  const env: Env = {
    ...process.env,
    FAKE_CORE_ROOT: f.directory,
    HERDR_CORE_BIN_PATH: bin,
    HERDR_PLUGIN_STATE_DIR: f.state,
    HC_TERMINAL_ID: '',
  };
  return { ...f, bin, env };
}
export async function coreCalls(directory: string): Promise<RecordedCall[]> {
  return (await readFile(path.join(directory, 'calls'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
export const count = (calls: RecordedCall[], method: string) =>
  calls.filter((call) => call.method === method).length;
export function fakeHerdr(): FakeHerdr {
  const client: FakeHerdr = {
    bin: '/path with spaces/herdr',
    calls: [],
    agents: [],
    panes: [],
    block: false,
    failStart: false,
    failFocus: false,
    async checkKinds() {},
    async call(args): Promise<HerdrResult> {
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
        assert.ok(agent, 'requested fixture agent exists');
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
        assert.ok(pane, 'fixture start pane exists');
        const name = args[2],
          kind = args[args.indexOf('--kind') + 1];
        assert.ok(name && kind, 'fixture start has a name and kind');
        client.agents.push({
          name,
          ...pane,
          workspace_id: 'w1',
          agent: kind,
          agent_status: 'idle',
          interactive_ready: true,
        });
        return {};
      }
      if (command === 'agent prompt') {
        if (client.prompt) return client.prompt(args);
        const agent = client.agents.find((agent) => agent.name === args[2]);
        assert.ok(agent, 'prompt target exists');
        return { agent: { ...agent, agent_status: client.block ? 'blocked' : 'done' } };
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
