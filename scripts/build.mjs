import { build } from 'esbuild';
import { readdir, readFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const templates = {};
async function collect(directory, prefix = '') {
  const files = {};
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
const templatePlugin = {
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
const common = {
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
