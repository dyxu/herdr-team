import fs from 'node:fs';
import path from 'node:path';
const project = process.env.COMM_PROJECT;
const directory = path.join(
  project,
  '.team',
  fs.readdirSync(path.join(project, '.team')).find((n) => n.startsWith('.communication-')),
);
const plan = JSON.parse(fs.readFileSync(path.join(directory, 'plan.json'), 'utf8'));
const args = process.argv.slice(2),
  core = args[0] === '--json';
const command = args[1],
  address = args[2];
const members = [plan.leader, ...plan.workers];
const member = members.find((m) => (core ? m.terminal_id : m.name) === address);
if (!member) process.exit(2);
if (command === 'get') {
  const result = core
    ? {
        address: member.terminal_id,
        name: member.name,
        cwd: project,
        labels: { 'herdr-team': plan.leader.name },
        state: 'live',
      }
    : { result: { agent: { ...member, workspace_id: 'core:test', agent: member.kind } } };
  if (process.env.COMM_BAD_ID)
    core ? (result.name = 'wrong') : (result.result.agent.name = 'wrong');
  console.log(JSON.stringify(result));
} else if (command === 'send' || command === 'prompt') {
  const match = /^COMMUNICATION_CHECK_RECEIPT ([a-z0-9_-]+) ([a-f0-9]+)\n/.exec(args[3]);
  if (!match || plan.challenges[match[1]] !== match[2]) process.exit(3);
  const file = path.join(directory, `${match[1]}.receipt`);
  const mode = process.env.COMM_RECEIPT_MODE;
  if (mode === 'symlink') fs.symlinkSync(path.join(directory, 'plan.json'), file);
  else if (mode !== 'missing') fs.writeFileSync(file, mode === 'stale' ? 'old-run' : match[2]);
  console.log('{}');
} else process.exit(4);
