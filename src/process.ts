import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

export interface ProcessOptions {
  cwd: string;
  input?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  label?: string;
  env?: NodeJS.ProcessEnv;
}

export class ProcessError extends Error {
  constructor(message: string, readonly exitCode?: number) {
    super(message);
    this.name = 'ProcessError';
  }
}

function abortError(): Error {
  return Object.assign(new Error('Generation cancelled.'), { name: 'AbortError' });
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) { return; }
  if (process.platform === 'win32') {
    // Node's child.kill terminates only the parent on Windows. Ask the OS to stop the tree first.
    await new Promise<void>(resolve => {
      const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { shell: false, windowsHide: true, stdio: 'ignore', timeout: 2000, killSignal: 'SIGKILL' });
      const stopParent = (): void => { try { child.kill('SIGKILL'); } catch { /* Already stopped. */ } };
      killer.once('error', stopParent);
      killer.once('close', code => { if (code !== 0) { stopParent(); } resolve(); });
    });
    return;
  }
  const pid = child.pid;
  try { process.kill(-pid, 'SIGTERM'); }
  catch { return; }
  // A parent may exit while a descendant ignores SIGTERM. Wait for the forced group cleanup.
  await new Promise<void>(resolve => setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* The group has already exited. */ }
    resolve();
  }, 500));
}

export function runProcess(executable: string, args: readonly string[], options: ProcessOptions): Promise<string> {
  const label = options.label ?? 'Command';
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(abortError()); return; }
    if (/\.(cmd|bat)$/i.test(executable)) {
      reject(new Error('Use a native executable (.exe on Windows), not a .cmd or .bat shim. Set the executable path in the extension settings.'));
      return;
    }

    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    function finish(error?: Error, terminate = false): void {
      if (settled) { return; }
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', cancel);
      if (terminate) {
        // Await bounded cleanup so a provider's temporary directory is not removed while in use.
        void terminateProcessTree(child).then(() => reject(error), () => reject(error));
        return;
      }
      if (error) { reject(error); }
      else { resolve(Buffer.concat(chunks, size).toString('utf8')); }
    }

    const cancel = (): void => finish(abortError(), true);
    const timeout = setTimeout(() => finish(new Error(`${label} timed out. Check the command in a terminal and try again.`), true), options.timeoutMs);
    options.signal?.addEventListener('abort', cancel, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) { return; }
      if (size + chunk.length > options.maxBytes) {
        finish(new Error(`${label} output is too large (limit ${options.maxBytes} bytes).`), true);
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    // Drain progress output without logging or retaining potentially sensitive code.
    child.stderr.resume();
    child.on('error', (error: NodeJS.ErrnoException) => {
      const message = error.code === 'ENOENT'
        ? `${label} executable not found. Check its installation and executable path, then restart VS Code.`
        : `Could not start ${label} (${error.code ?? 'unknown error'}). Check its path and permissions.`;
      finish(new ProcessError(message));
    });
    child.on('close', (code, signal) => {
      finish(code === 0 ? undefined : new ProcessError(
        `${label} failed with exit code ${code ?? signal}. Run the command in a terminal for details.`, code ?? undefined));
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      // A fast exit can close stdin before the prompt is written; let close report its exit code.
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
        finish(new ProcessError('Could not send input to the command.'), true);
      }
    });
    child.stdin.end(options.input ?? '');
  });
}
