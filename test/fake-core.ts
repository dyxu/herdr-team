import fs from 'node:fs';
import assert from 'node:assert/strict';
import type { CoreTerminal } from '../src/types.js';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
const root = process.env.FAKE_CORE_ROOT;
assert.ok(root, 'FAKE_CORE_ROOT is required');
if (process.argv.at(-1) !== 'connect') process.exit(2);
const lines = readline.createInterface({ input: process.stdin });
lines.once('line', (line) => {
  const req: {
      method: string;
      params: { terminal: string; name: string; cwd: string; labels: Record<string, string> };
    } = JSON.parse(line),
    terminal = req.params.terminal;
  fs.appendFileSync(path.join(root, 'calls'), `${line}\n`);
  const file = path.join(root, 'terminals');
  const mode = fs.readFileSync(path.join(root, 'mode'), 'utf8');
  const terminals: CoreTerminal[] = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : [];
  const emit = (result: unknown) => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n`);
  };
  const fail = (kind: string, message: string, hint = 'read before retrying') => {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message, data: { kind, hint } } })}\n`,
    );
  };
  if (mode === 'held-pipes') {
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: ['ignore', 1, 2] });
    return;
  }
  if (mode === 'malformed') return process.stdout.write('bad JSON\n');
  if (mode === 'wrong-id') return process.stdout.write('{"jsonrpc":"2.0","id":"1","result":{}}\n');
  if (mode === 'wrong-version')
    return process.stdout.write('{"jsonrpc":"1.0","id":1,"result":{}}\n');
  if (mode === 'valid-response-failed-process') {
    emit({ core: { id: 'test' } });
    process.exitCode = 7;
    return;
  }
  if (mode === 'null-result') return emit(null);
  if (mode === 'notification')
    process.stdout.write('{"jsonrpc":"2.0","method":"notice","params":{}}\n');
  if (req.method === 'server.status') return emit({ core: { id: 'test-core' } });
  if (req.method === 'terminal.list')
    return emit(mode === 'missing-terminals' ? {} : { terminals });
  if (req.method === 'terminal.run') {
    const entry = {
      address: `t${terminals.length + 1}`,
      name: req.params.name,
      cwd: req.params.cwd,
      labels: req.params.labels,
      state: 'live',
      status: { state: mode === 'done' ? 'done' : 'idle' },
    };
    terminals.push(entry);
    fs.writeFileSync(file, JSON.stringify(terminals));
    if (mode === 'lost-launch') return fail('unavailable', 'launch response lost');
    return emit(entry);
  }
  const sent = fs.existsSync(path.join(root, `sent-${terminal}`)),
    settled = fs.existsSync(path.join(root, `settle-${terminal}`));
  if (req.method === 'terminal.get') {
    const entry = terminals.find((t) => t.address === terminal);
    if (!entry) return fail('not_found', 'unknown terminal');
    if (
      mode === 'blocked' ||
      (mode === 'permission-after-send' && sent) ||
      (mode === 'settle-blocked' && settled)
    )
      entry.status = { state: 'blocked', kind: 'permission' };
    if (mode === 'settle-identity' && settled) entry.name = 'different-agent';
    return emit(entry);
  }
  if (req.method === 'terminal.wait') {
    let status = mode === 'done' || sent ? 'done' : 'idle',
      reason = 'status',
      ended = true;
    if (mode === 'blocked' || (mode === 'permission-after-send' && sent)) status = 'blocked';
    if (
      (mode === 'message' || mode === 'check-in') &&
      sent &&
      !fs.existsSync(path.join(root, `interrupted-${terminal}`))
    ) {
      fs.writeFileSync(path.join(root, `interrupted-${terminal}`), '');
      ended = false;
      reason = mode === 'message' ? 'message' : 'timeout';
    }
    if (mode === 'timeout' && sent) {
      ended = false;
      reason = 'timeout';
    }
    return emit({ terminal, ended, reason, status, turn: 1 });
  }
  if (req.method === 'terminal.kill') {
    if (mode === 'kill-failure') return fail('unavailable', 'kill response uncertain');
    const entry = terminals.find((t) => t.address === terminal);
    if (!entry) return fail('not_found', 'unknown terminal');
    entry.state = 'finished';
    entry.status = null;
    fs.writeFileSync(file, JSON.stringify(terminals));
    return emit(entry);
  }
  if (req.method === 'terminal.rm') {
    const i = terminals.findIndex((t) => t.address === terminal);
    if (i >= 0) terminals.splice(i, 1);
    fs.writeFileSync(file, JSON.stringify(terminals));
    return emit({ removed: true });
  }
  if (req.method === 'terminal.send') {
    if (mode.startsWith('settle-') && (!settled || mode === 'settle-forever')) {
      fs.writeFileSync(path.join(root, `settle-${terminal}`), '');
      return fail(
        'unavailable',
        `${terminal} is still starting: its output has not settled`,
        `nothing was typed; check hc read ${terminal}, then retry`,
      );
    }
    if (['send-failure', 'generic-unavailable'].includes(mode))
      return fail('unavailable', 'delivery uncertain');
    fs.writeFileSync(path.join(root, `sent-${terminal}`), '');
    if (mode === 'lost-send-response') return process.exit(0);
    return emit(mode === 'missing-turn' ? { started: true } : { turn: 0, started: false });
  }
  process.exit(2);
});
