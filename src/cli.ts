import path from 'node:path';
import { canonical, loadTeam } from './config.js';
import { availableTemplateNames, initFromTemplate } from './templates.js';
import { runCore } from './core.js';
import { Herdr, resolveProject, runLegacy } from './legacy.js';
import type { Env, Output } from './types.js';

type Backend = 'auto' | 'core' | 'herdr';
type Command = 'init' | 'start' | 'status' | 'check' | 'templates' | 'help';
const usages: Record<Command, string> = {
  init: 'init [project] [template] [templates-directory]',
  start: 'start [project]',
  status: 'status [project]',
  check: 'check [project]',
  templates: 'templates [directory]',
  help: 'help [command]',
};
const descriptions: Record<Command, string> = {
  init: 'Create .team without starting agents (default template: development).',
  start: 'Start or reuse the team defined in .team.',
  status: 'Show recorded startup and current member status.',
  check: 'Validate team configuration without starting agents.',
  templates: 'List embedded and configured templates offline.',
  help: 'Show help for all commands or one command.',
};
export const help = `Usage: herdr-team [auto|core|herdr] <command> [arguments]

Commands:
  init [project] [template] [templates-directory]
  start [project]
  status [project]
  check [project]
  templates [directory]
  help [command]

Project defaults to the current directory or the Herdr project context.
Template defaults to development. Use . for the current project.
Backend defaults to auto: Herdr inside HERDR_ENV=1, otherwise herdr-core.
Template directory defaults to HERDR_TEAM_TEMPLATES_DIR when set.

Examples:
  herdr-team init . router-worker
  herdr-team core start /absolute/project/path
  herdr-team core status /absolute/project/path
  herdr-team templates
`;
export interface ParsedCommand {
  backend: Backend;
  command: Command;
  project: string;
  template: string;
  directory?: string;
  helpCommand?: Command;
}
export function parseCommand(args: string[]): ParsedCommand {
  if (args.some((arg) => arg.startsWith('-')))
    throw new Error('use subcommands instead of flags; run herdr-team help');
  const remaining = [...args];
  const backend: Backend = ['auto', 'core', 'herdr'].includes(remaining[0] || '')
    ? (remaining.shift() as Backend)
    : 'auto';
  const command = remaining.shift() || 'help';
  if (!Object.hasOwn(usages, command))
    throw new Error(`unknown command ${JSON.stringify(command)}; run herdr-team help`);
  const name = command as Command;
  const maximum = name === 'init' ? 3 : 1;
  if (remaining.length > maximum)
    throw new Error(`too many arguments; usage: herdr-team ${usages[name]}`);
  const parsed: ParsedCommand = { backend, command: name, project: '', template: 'development' };
  if (name === 'help') {
    const target = remaining[0];
    if (target !== undefined) {
      if (!Object.hasOwn(usages, target))
        throw new Error(`unknown command ${JSON.stringify(target)}; run herdr-team help`);
      parsed.helpCommand = target as Command;
    }
  } else if (name === 'templates') parsed.directory = remaining[0];
  else {
    parsed.project = remaining[0] ?? '';
    if (name === 'init') {
      parsed.template = remaining[1] ?? 'development';
      parsed.directory = remaining[2];
    }
  }
  return parsed;
}
export async function run(
  args: string[],
  env: Env = process.env,
  out: Output = (text) => {
    process.stdout.write(text);
  },
): Promise<void> {
  const parsed = parseCommand(args);
  const { command, backend } = parsed;
  if (command === 'help') {
    const target = parsed.helpCommand;
    out(
      target
        ? `Usage: herdr-team [auto|core|herdr] ${usages[target]}\n${descriptions[target]}\n`
        : help,
    );
    return;
  }
  const useCore = backend === 'core' || (backend === 'auto' && env.HERDR_ENV !== '1');
  const directory = parsed.directory ?? env.HERDR_TEAM_TEMPLATES_DIR ?? '';
  if (command === 'templates') {
    for (const name of await availableTemplateNames(directory)) out(`${name}\n`);
    return;
  }
  let project = parsed.project;
  if (command === 'init' || command === 'check') {
    if (!project && !useCore && env.HERDR_ENV === '1')
      project = (await resolveProject(env, new Herdr(env.HERDR_BIN_PATH || 'herdr', env))).project;
    project = await canonical(project || '.');
    if (command === 'check') {
      const team = await loadTeam(project);
      out(`Valid team: ${team.name}; leader=${team.leader}; members=${team.members.length}\n`);
      return;
    }
    await initFromTemplate(project, parsed.template, directory);
    out(
      `Created ${path.join(project, '.team')} from template ${parsed.template}. Edit team.md and members/*.md to configure roles, kind and args.\n`,
    );
    return;
  }
  if (useCore) return runCore(project, command === 'status', env, out);
  return runLegacy(project, command === 'status', env, out);
}
