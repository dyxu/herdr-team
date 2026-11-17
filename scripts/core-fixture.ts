// A real PTY program for core regression, with no model or provider credentials.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [mode, receipts, core, caller] = process.argv.slice(2);
assert.ok(
  mode && receipts && core !== undefined && caller !== undefined,
  'fixture arguments are required',
);
assert.ok(process.stdin.isTTY, 'fixture requires a PTY');
process.stdin.setRawMode(true);
const report = (state: string, kind = '') =>
  process.stdout.write(
    `\x1b]7501;state=${state}:app=team-verification${kind ? `:kind=${kind}` : ''}\x1b\\`,
  );
process.stdout.write('\x1b[?2004h');
report(['message', 'settling', 'permission'].includes(mode) ? 'idle' : mode);
if (mode === 'settling') {
  const until = Date.now() + 6500;
  const timer = setInterval(() => {
    if (Date.now() >= until) clearInterval(timer);
    else process.stdout.write('booting...\r\n');
  }, 50);
}
let data = '';
process.stdin.on('data', (chunk: Buffer) => {
  data += chunk.toString('utf8');
  if (!data.endsWith('\r')) return;
  report('working');
  appendFileSync(receipts, 'delivered\n');
  if (mode === 'message')
    execFileSync(core, ['send', caller, 'Isolated verification message'], {
      stdio: 'ignore',
      timeout: 20_000,
    });
  process.stdout.write('role acknowledged\r\n');
  mode === 'permission' ? report('blocked', 'permission') : report('done');
  data = '';
});
