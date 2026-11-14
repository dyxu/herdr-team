import {
  lstat,
  stat,
  readdir,
  readFile,
  mkdir,
  writeFile,
  mkdtemp,
  symlink,
  unlink,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises';
import path from 'node:path';
import builtins from 'builtin-templates';
import { canonical, loadTeam, within } from './config.js';
import { isMissing } from './state.js';

export const builtinTemplateNames = (): string[] => Object.keys(builtins).sort();
async function validateDirectory(directory: string): Promise<void> {
  if (directory && !(await stat(directory)).isDirectory())
    throw new Error(`templates directory ${JSON.stringify(directory)} is not a directory`);
}
export async function checkTemplateTree(root: string): Promise<void> {
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error(`template path is not a directory: ${root}`);
  for (const name of await readdir(root)) {
    const file = path.join(root, name),
      info = await lstat(file);
    if (info.isDirectory()) await checkTemplateTree(file);
    else if (!info.isFile())
      throw new Error(`template contains a symlink or special file: ${file}`);
  }
}
export async function availableTemplateNames(directory = ''): Promise<string[]> {
  await validateDirectory(directory);
  const names = new Set(builtinTemplateNames());
  if (directory)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = path.join(directory, entry.name);
      try {
        if (!(await lstat(path.join(root, 'team.md'))).isFile()) continue;
        await checkTemplateTree(root);
        names.add(entry.name);
      } catch {
        /* Invalid user templates are not advertised. */
      }
    }
  return [...names].sort();
}
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
export async function selectTemplate(
  name: string,
  directory = '',
): Promise<{ root?: string; files?: Record<string, string> }> {
  if (!name) throw new Error('template must be a name or directory');
  await validateDirectory(directory);
  let root: string | undefined;
  if (path.isAbsolute(name) || /[/\\]/.test(name) || name === '.' || name === '..') root = name;
  else if (directory && (await exists(path.join(directory, name))))
    root = path.join(directory, name);
  if (!root && builtins[name]) return { files: builtins[name] };
  if (!root && (await exists(name))) root = name;
  if (!root)
    throw new Error(
      `unknown template ${JSON.stringify(name)}; run herdr-team templates or specify a template directory`,
    );
  await checkTemplateTree(root);
  return { root: await canonical(root) };
}
async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(source)) {
    const file = path.join(source, name),
      info = await lstat(file),
      target = path.join(destination, name);
    if (info.isDirectory()) await copyTree(file, target);
    else if (info.isFile()) await writeFile(target, await readFile(file), { mode: 0o644 });
    else throw new Error(`template contains a symlink or special file: ${file}`);
  }
}
export async function initFromTemplate(
  project: string,
  name: string,
  directory = '',
): Promise<void> {
  project = await canonical(project);
  if (!(await stat(project)).isDirectory())
    throw new Error(`project path is not a directory: ${project}`);
  const target = path.join(project, '.team');
  if (await exists(target)) throw new Error(`refusing to overwrite existing ${target}`);
  const source = await selectTemplate(name, directory);
  if (source.root && within(source.root, project))
    throw new Error(
      `template directory ${JSON.stringify(source.root)} must not equal or contain project directory ${JSON.stringify(project)}`,
    );
  const staging = await mkdtemp(path.join(project, '.team-init-')),
    staged = path.join(staging, '.team');
  try {
    if (source.root) {
      await symlink(source.root, staged);
      await loadTeam(staging);
      await unlink(staged);
      await copyTree(source.root, staged);
    } else
      for (const [file, content] of Object.entries(source.files!)) {
        const output = path.join(staged, file);
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, content, { mode: 0o644 });
      }
    await loadTeam(staging);
    // Reserve exclusively, then replace only our empty reservation atomically.
    try {
      await mkdir(target);
    } catch (error) {
      throw new Error(`cannot create ${target} (refusing to overwrite)`, { cause: error });
    }
    try {
      await rename(staged, target);
    } catch (error) {
      await rmdir(target).catch(() => {});
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
