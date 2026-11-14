import { run } from './cli.js';
run(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`herdr-team: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
