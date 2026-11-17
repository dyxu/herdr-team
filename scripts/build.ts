import { build } from 'esbuild';
import type { Plugin, BuildOptions } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const templates: Record<string, Record<string, string>> = {};
async function collect(directory: string, prefix = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name,
      source = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await collect(source, `${relative}/`));
    else if (entry.isFile()) files[relative] = await readFile(source, 'utf8');
    else throw new Error(`Unsupported template entry: ${source}`);
  }
  return files;
}
for (const entry of await readdir(path.join(root, 'templates'), { withFileTypes: true })) {
  if (entry.isDirectory())
    templates[entry.name] = await collect(path.join(root, 'templates', entry.name));
}
const templatePlugin: Plugin = {
  name: 'builtin-templates',
  setup(builder) {
    builder.onResolve({ filter: /^builtin-templates$/ }, () => ({
      path: 'builtin-templates',
      namespace: 'embedded',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'embedded' }, () => ({
      contents: `export default ${JSON.stringify(templates)}`,
      loader: 'js',
    }));
  },
};
await mkdir(path.join(root, 'bin'), { recursive: true });
const runtime =
  "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";
const common: BuildOptions = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  plugins: [templatePlugin],
  banner: { js: runtime },
};
await build({
  ...common,
  entryPoints: ['src/main.ts'],
  outfile: 'bin/herdr-team',
  banner: { js: '#!/usr/bin/env node\n' + runtime },
});
await chmod(path.join(root, 'bin/herdr-team'), 0o755);
await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'bin/library.mjs' });
// Tests execute the bundle, while TypeScript checks its generated public API.
await promisify(execFile)(process.execPath, [
  path.join(root, 'node_modules/typescript/bin/tsc'),
  '-p',
  path.join(root, 'tsconfig.build.json'),
]);
await writeFile(path.join(root, 'bin/library.d.mts'), "export * from './types/index.js';\n");
