import { spawn } from 'node:child_process';
import type { Env } from './types.js';

export function commandTarget(args: string[]): string {
  const command = args.slice(0, 2).join(' ');
  return args[2] &&
    !args[2].startsWith('--') &&
    [
      'agent start',
      'agent get',
      'agent prompt',
      'agent focus',
      'agent wait',
      'pane get',
      'pane rename',
      'pane split',
    ].includes(command)
    ? `${command} ${args[2]}`
    : command;
}
export async function execute(
  bin: string,
  args: string[],
  env: Env,
  timeout = 45_000,
  signal?: AbortSignal,
): Promise<string> {
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '',
      failed = false;
    const onAbort = () => {
      failed = true;
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    };
    combined.addEventListener('abort', onAbort, { once: true });
    if (combined.aborted) onAbort();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 16 * 1024 * 1024) {
        failed = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-64 * 1024);
    });
    child.on('error', (error) => {
      combined.removeEventListener('abort', onAbort);
      reject(new Error(`Herdr ${commandTarget(args)}: ${error.message}`));
    });
    child.on('close', (code) => {
      combined.removeEventListener('abort', onAbort);
      if (code === 0 && !failed) return resolve(stdout);
      let structured = '';
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) structured = `stdout error: ${JSON.stringify(parsed.error)}; `;
      } catch {
        /* CLI may emit text. */
      }
      reject(
        new Error(
          `Herdr ${commandTarget(args)}: ${structured}${stderr.trim()}${combined.aborted ? '; operation timed out or canceled' : `; exit code ${code}`}`,
        ),
      );
    });
  });
}
export class CoreRPCError extends Error {
  constructor(
    readonly code: number,
    readonly kind: string,
    message: string,
    readonly hint: string,
  ) {
    super(`RPC ${code} ${kind}: ${message}; ${hint}`);
    this.rpcMessage = message;
  }
  readonly rpcMessage: string;
}
export async function coreCall<T>(
  bin: string,
  env: Env,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(200_000)])
    : AbortSignal.timeout(200_000);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['connect'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '',
      stderr = '',
      complete = false,
      result: T,
      failure: unknown;
    let cleanupTimer: NodeJS.Timeout | undefined;
    const stop = (error?: unknown, value?: T) => {
      if (complete) return;
      complete = true;
      failure = error;
      result = value as T;
      child.stdin.end();
      if (error) {
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      }
      // stdin EOF should close connect; bound misbehaving transports too.
      cleanupTimer = setTimeout(() => {
        failure ??= new Error('connect did not close after stdin EOF');
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1000);
      cleanupTimer.unref();
    };
    const onAbort = () => stop(new Error('operation timed out or canceled'));
    combined.addEventListener('abort', onAbort, { once: true });
    child.stdin.on('error', (error) => {
      if (!complete) stop(error);
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-64 * 1024);
    });
    const parseLine = (line: string) => {
      if (!line.trim() || complete) return;
      try {
        const response = JSON.parse(line);
        if (response.jsonrpc !== '2.0') throw new Error('invalid JSON-RPC version');
        if (response.id === undefined && typeof response.method === 'string') return;
        if (response.id !== 1) throw new Error('unexpected JSON-RPC response ID');
        if (response.error) {
          const e = response.error;
          throw new CoreRPCError(e.code, e.data?.kind || '', e.message || '', e.data?.hint || '');
        }
        if (response.result === undefined || response.result === null)
          throw new Error('JSON-RPC response is missing result');
        stop(undefined, response.result as T);
      } catch (error) {
        stop(error);
      }
    };
    child.stdout.on('data', (chunk) => {
      if (complete) return;
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024)
        return stop(new Error('JSON-RPC response exceeds output limit'));
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        parseLine(line);
      }
    });
    child.on('error', (error) => {
      complete = true;
      failure = error;
    });
    child.on('close', (code, exitSignal) => {
      if (!complete && buffer.trim()) parseLine(buffer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      combined.removeEventListener('abort', onAbort);
      if (!complete) failure = new Error('connect closed before its JSON-RPC response');
      if (!failure && (code !== 0 || exitSignal))
        failure = new Error(`connect exited unsuccessfully (${exitSignal || code})`);
      if (failure) {
        if (failure instanceof CoreRPCError) return reject(failure);
        reject(
          new Error(
            `herdr-core ${method}: ${failure instanceof Error ? failure.message : String(failure)}${stderr.trim() ? `; stderr: ${stderr.trim()}` : ''}`,
          ),
        );
      } else resolve(result);
    });
    if (combined.aborted) onAbort();
    else child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
  });
}
