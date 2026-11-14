import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type { Team, Member } from './types.js';

export const validID = /^[a-z][a-z0-9_-]{0,19}$/;
export const validKind = /^[a-z][a-z0-9_-]*$/;
export const canonical = (value: string): Promise<string> => realpath(value);
export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}
export async function markdown(
  file: string,
  allowed: string[],
): Promise<{ fields: Record<string, unknown>; body: string }> {
  if (!(await stat(file)).isFile()) throw new Error(`${file}: expected an ordinary Markdown file`);
  const lines = (await readFile(file, 'utf8'))
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  if (lines[0]?.trim() !== '---') throw new Error(`${file}: expected YAML frontmatter`);
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) throw new Error(`${file}: frontmatter is not closed`);
  const document = parseDocument(lines.slice(1, end).join('\n'), { uniqueKeys: true });
  const issues = [...document.errors, ...document.warnings];
  if (issues.length) throw new Error(`${file}: ${issues.map((e) => e.message).join('; ')}`);
  const fields: unknown = document.toJS({ maxAliasCount: 100 });
  if (!fields || typeof fields !== 'object' || Array.isArray(fields))
    throw new Error(`${file}: frontmatter must be a mapping`);
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) throw new Error(`${file}: unknown field ${key}`);
    if (key === 'args' || key === 'members') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
        throw new Error(`${file}: ${key} must be a list of strings`);
    } else if (typeof value !== 'string') throw new Error(`${file}: ${key} must be a string`);
  }
  return {
    fields: fields as Record<string, unknown>,
    body: lines
      .slice(end + 1)
      .join('\n')
      .trim(),
  };
}
export async function loadTeam(project: string): Promise<Team> {
  const directory = await canonical(path.join(project, '.team'));
  const { fields, body } = await markdown(path.join(directory, 'team.md'), [
    'name',
    'workflow',
    'leader',
    'members',
  ]);
  const name = (fields.name as string | undefined) || 'team';
  if (!name.trim() || /[\0\r\n]/.test(name))
    throw new Error('team name must be a nonempty single-line string');
  const leader = (fields.leader as string | undefined) ?? '';
  if (!validID.test(leader))
    throw new Error(
      'leader must be a member ID: 1–20 lowercase letters, digits, underscores or hyphens, beginning with a letter',
    );
  const workflow = fields.workflow as string | undefined;
  if (workflow && workflow !== 'router-worker')
    throw new Error(`unknown workflow ${JSON.stringify(workflow)} (supported: router-worker)`);
  const paths = (fields.members as string[] | undefined) ?? [];
  if (!paths.length) throw new Error('members must be a nonempty list of Markdown paths');
  const members: Member[] = [];
  for (const relative of paths) {
    if (path.isAbsolute(relative))
      throw new Error(`member path must be relative to .team: ${relative}`);
    const file = await canonical(path.join(directory, relative));
    if (!within(directory, file) || path.extname(file) !== '.md')
      throw new Error(`member path must be a Markdown file inside .team: ${relative}`);
    const parsed = await markdown(file, ['id', 'kind', 'args']);
    const id = (parsed.fields.id as string | undefined) ?? '';
    const kind = (parsed.fields.kind as string | undefined) ?? '';
    const args = (parsed.fields.args as string[] | undefined) ?? [];
    if (!validID.test(id))
      throw new Error(
        `${file}: invalid member ID (1–20 lowercase letters/digits/_/-, beginning with a letter)`,
      );
    if (members.some((member) => member.id === id)) throw new Error(`duplicate member ID: ${id}`);
    if (!validKind.test(kind)) throw new Error(`${file}: kind must name a Herdr agent kind`);
    if (args.some((arg) => arg.includes('\0'))) throw new Error(`${file}: args cannot contain NUL`);
    members.push({
      id,
      kind,
      args,
      argsSpecified: parsed.fields.args !== undefined,
      instructions: parsed.body,
    });
  }
  if (!members.some((member) => member.id === leader))
    throw new Error(`leader ${JSON.stringify(leader)} is not a team member`);
  return { name, workflow, leader, paths, members, instructions: body };
}
