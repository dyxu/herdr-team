import path from 'node:path';
import { canonical, loadTeam } from './config.js';
import { availableTemplateNames, initFromTemplate } from './templates.js';
import { runCore } from './core.js';
import { Herdr, resolveProject, runLegacy } from './legacy.js';
import type { Env, Output } from './types.js';

export const help = `Usage: herdr-team [options]
  --project PATH          override the current project directory
  --backend MODE          auto (default), core or herdr
  --init                  create .team from a template; do not start agents
  --template NAME|PATH    template for --init (default: development)
  --templates-dir PATH    named template directory
  --list-templates        list templates offline
  --check                 validate team files only
  --status                show recorded startup and current member status
  --help                  show this help
`;
export function parseFlags(args: string[]): {
  values: Record<string, string | boolean>;
  visited: Set<string>;
} {
  const strings = new Set(['project', 'backend', 'template', 'templates-dir']);
  const booleans = new Set(['status', 'check', 'init', 'list-templates']);
  const values: Record<string, string | boolean> = {
      project: '',
      backend: 'auto',
      template: 'development',
      'templates-dir': '',
    },
    visited = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]!;
    if (['-h', '--help', '-help'].includes(argument)) {
      values.help = true;
      continue;
    }
    if (argument === '--' && i === args.length - 1) break;
    if (!argument.startsWith('-') || argument === '--')
      throw new Error('unexpected positional arguments');
    const parts = argument.replace(/^--?/, '').split('='),
      name = parts.shift()!,
      inline = parts.length ? parts.join('=') : undefined;
    if (booleans.has(name)) {
      if (inline !== undefined && !['true', 'false'].includes(inline))
        throw new Error(`invalid value for --${name}: expected true or false`);
      values[name] = inline !== 'false';
    } else if (strings.has(name)) {
      const value = inline ?? args[++i];
      if (value === undefined) throw new Error(`flag needs an argument: --${name}`);
      values[name] = value;
    } else throw new Error(`unknown flag: --${name}`);
    visited.add(name);
  }
  return { values, visited };
}
export async function run(
  args: string[],
  env: Env = process.env,
  out: Output = (text) => {
    process.stdout.write(text);
  },
): Promise<void> {
  const { values: flags, visited } = parseFlags(args);
  if (flags.help) {
    out(help);
    return;
  }
  if (['init', 'check', 'list-templates', 'status'].filter((name) => flags[name]).length > 1)
    throw new Error('--init, --check, --list-templates and --status are mutually exclusive');
  if (visited.has('template') && !flags.init) throw new Error('--template requires --init');
  if (visited.has('templates-dir') && !flags.init && !flags['list-templates'])
    throw new Error('--templates-dir requires --init or --list-templates');
  if (!['auto', 'herdr', 'core'].includes(flags.backend as string))
    throw new Error('--backend must be auto, herdr or core');
  const useCore = flags.backend === 'core' || (flags.backend === 'auto' && env.HERDR_ENV !== '1');
  const directory = visited.has('templates-dir')
    ? (flags['templates-dir'] as string)
    : env.HERDR_TEAM_TEMPLATES_DIR || '';
  if (flags['list-templates']) {
    for (const name of await availableTemplateNames(directory)) out(`${name}\n`);
    return;
  }
  let project = flags.project as string;
  if (flags.init || flags.check) {
    if (!project && !useCore && env.HERDR_ENV === '1')
      project = (await resolveProject(env, new Herdr(env.HERDR_BIN_PATH || 'herdr', env))).project;
    project = await canonical(project || '.');
    if (flags.check) {
      const team = await loadTeam(project);
      out(`Valid team: ${team.name}; leader=${team.leader}; members=${team.members.length}\n`);
      return;
    }
    await initFromTemplate(project, flags.template as string, directory);
    out(
      `Created ${path.join(project, '.team')} from template ${flags.template}. Edit team.md and members/*.md to configure roles, kind and args.\n`,
    );
    return;
  }
  if (useCore) return runCore(project, !!flags.status, env, out);
  return runLegacy(project, !!flags.status, env, out);
}
