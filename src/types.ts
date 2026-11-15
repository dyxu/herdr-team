export type Env = NodeJS.ProcessEnv;
export type Output = (text: string) => void;
export interface Member {
  id: string;
  kind: string;
  args: string[];
  argsSpecified?: boolean;
  instructions: string;
}
export interface Team {
  name: string;
  workflow?: string;
  leader: string;
  paths: string[];
  members: Member[];
  instructions: string;
}
export interface StartedMember {
  id: string;
  name: string;
  pane_id: string;
  terminal_id: string;
  kind: string;
  started: boolean;
  initialized: boolean;
}
export interface Startup {
  schema_version?: number;
  communication_error?: string;
  communication_check?: string;
  config_digest?: string;
  stage: string;
  project: string;
  workspace_id: string;
  status: string;
  tab_id: string;
  leader_name: string;
  members: StartedMember[];
  error?: string;
}
export interface CoreTerminal {
  address: string;
  name?: string | null;
  cwd: string;
  state: string;
  labels: Record<string, string>;
  status?: { state: string; kind?: string; msg?: string } | null;
}
export interface CoreWait {
  terminal: string;
  ended: boolean;
  reason: string;
  status: string;
  turn: number;
}
export interface Agent {
  name: string;
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  agent: string;
  agent_status: string;
  cwd?: string;
  interactive_ready: boolean;
}
export interface Pane {
  pane_id: string;
  terminal_id: string;
  cwd?: string;
}
export interface HerdrResult {
  agent?: Agent;
  agents?: Agent[];
  pane?: Pane;
  panes?: Pane[];
  root_pane?: Pane;
  tab?: { id: string };
}
export interface LegacyClient {
  bin: string;
  call(args: string[], signal?: AbortSignal): Promise<HerdrResult>;
  checkKinds(team: Team): Promise<void>;
}
