import path from 'node:path';
import { run } from './cli.js';
run(process.argv.slice(2), {
  ...process.env,
  HERDR_TEAM_CLI_PATH: path.resolve(process.argv[1]!),
}).catch((error: unknown) => {
  process.stderr.write(`herdr-team: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
