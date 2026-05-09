// SSH + Claude CLI executor
// Runs `claude -p <prompt> --output-format stream-json --verbose` on remote servers

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import type { ServerConfig } from '../config.js';

export interface ClaudeEvent {
  type: string;
  [key: string]: any;
}

export interface TaskHandle extends EventEmitter {
  abort(): void;
}

/**
 * Execute a Claude Code CLI task on a remote server via SSH.
 * Returns an EventEmitter that emits:
 *   'data'            (ClaudeEvent)  — parsed JSON line from CLI
 *   'raw'             (string)       — non-JSON stdout line
 *   'stderr'          (string)       — stderr text
 *   'session_expired' (oldSessionId) — resume failed, auto-retrying fresh
 *   'error'           (string)       — fatal error (emitted at most once; no 'close' follows)
 *   'close'           (code)         — process exit (only if no fatal 'error' was emitted)
 */
export function execClaudeTask(
  server: ServerConfig,
  prompt: string,
  cwd: string,
  options?: {
    sessionId?: string;       // -r <sessionId> to resume
    continueSession?: boolean; // -c to continue last session in cwd
    model?: string;
    permissionMode?: string;  // --permission-mode
    maxTurns?: number;
    /**
     * If set, enables remote MCP permission prompting.
     *   - SSH reverse-forwards `mcp.port` back to localhost on the remote host.
     *   - Passes `--mcp-config` (inline JSON) pointing at http://127.0.0.1:<port>/mcp.
     *   - Passes `--permission-prompt-tool mcp__feicc__ask_feishu`.
     *   - Sets `X-Feicc-Session` header so the hub can route approvals.
     */
    mcp?: {
      port: number;
      feiccSessionId: string;
    };
  },
): TaskHandle {
  const emitter = new EventEmitter() as TaskHandle;

  const claudePath = server.claude_path ?? 'claude';

  function buildRemoteCmd(useSessionId?: string): string {
    const args: string[] = [];

    if (options?.continueSession) {
      args.push('-c');
    } else if (useSessionId) {
      args.push('-r', JSON.stringify(useSessionId));
    }

    args.push('-p', JSON.stringify(prompt));
    args.push('--output-format', 'stream-json', '--verbose');

    if (options?.permissionMode) {
      args.push('--permission-mode', options.permissionMode);
    }
    if (options?.maxTurns) {
      args.push('--max-turns', String(options.maxTurns));
    }
    if (options?.model) {
      args.push('--model', options.model);
    }

    // MCP permission prompt flags
    if (options?.mcp) {
      const mcpConfig = {
        mcpServers: {
          feicc: {
            type: 'http',
            url: `http://127.0.0.1:${options.mcp.port}/mcp`,
            headers: {
              'X-Feicc-Session': options.mcp.feiccSessionId,
            },
          },
        },
      };
      args.push('--mcp-config', JSON.stringify(JSON.stringify(mcpConfig)));
      args.push('--permission-prompt-tool', 'mcp__feicc__ask_feishu');
    }

    return `cd ${JSON.stringify(cwd)} && export PATH=$HOME/.npm-global/bin:$HOME/.local/bin:$PATH && ${claudePath} ${args.join(' ')}`;
  }

  function spawnSsh(remoteCmd: string) {
    const sshArgs = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ExitOnForwardFailure=yes',
      '-i', server.key,
    ];
    if (options?.mcp) {
      // Reverse port forward: remote 127.0.0.1:<port> → local 127.0.0.1:<port>
      sshArgs.push('-R', `${options.mcp.port}:127.0.0.1:${options.mcp.port}`);
    }
    sshArgs.push(
      `${server.user}@${server.host}`,
      remoteCmd,
    );
    return spawn('ssh', sshArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  let hasRetried = false;
  let currentProc: ReturnType<typeof spawn> | null = null;
  let aborted = false;
  let fatalEmitted = false;
  let killTimer: NodeJS.Timeout | null = null;

  function emitFatalOnce(msg: string) {
    if (fatalEmitted) return;
    fatalEmitted = true;
    emitter.emit('error', msg);
  }

  function attachProc(proc: ReturnType<typeof spawn>) {
    currentProc = proc;
    let buffer = '';
    let gotSessionError = false;
    let stderrBuffer = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event: ClaudeEvent = JSON.parse(trimmed);
          if (
            event.type === 'result' &&
            event.subtype === 'error_during_execution' &&
            event.is_error
          ) {
            const errors: string[] = event.errors ?? [];
            if (errors.some((e: string) => e.includes('No conversation found'))) {
              gotSessionError = true;
            }
          }
          if (!gotSessionError) {
            emitter.emit('data', event);
          }
        } catch {
          emitter.emit('raw', trimmed);
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuffer += text;
      // Keep stderrBuffer bounded
      if (stderrBuffer.length > 4096) {
        stderrBuffer = stderrBuffer.slice(-4096);
      }
      const trimmed = text.trim();
      if (trimmed) emitter.emit('stderr', trimmed);
    });

    proc.on('close', (code) => {
      // Flush remaining stdout buffer
      if (buffer.trim()) {
        try {
          const event: ClaudeEvent = JSON.parse(buffer.trim());
          if (
            event.type === 'result' &&
            event.subtype === 'error_during_execution' &&
            event.is_error
          ) {
            const errors: string[] = event.errors ?? [];
            if (errors.some((e: string) => e.includes('No conversation found'))) {
              gotSessionError = true;
            }
          }
          if (!gotSessionError) {
            emitter.emit('data', event);
          }
        } catch { /* ignore */ }
      }
      buffer = '';

      // Session resume failed: retry without -r (only once)
      if (gotSessionError && !hasRetried && options?.sessionId && !aborted) {
        hasRetried = true;
        console.log(
          `[claude:${server.id}] session ${options.sessionId} not found, retrying as new session`,
        );
        emitter.emit('session_expired', options.sessionId);
        attachProc(spawnSsh(buildRemoteCmd(undefined)));
        return;
      }

      if (fatalEmitted) return; // error path already handled

      // SSH-level failure: exit code 255 with no valid JSON stream.
      // Surface stderr as a fatal error so the UI gets a clear message.
      if (code === 255) {
        emitFatalOnce(`SSH 连接失败 (exit 255): ${stderrBuffer.trim().slice(-500) || '未知'}`);
        return;
      }

      emitter.emit('close', code);
    });

    proc.on('error', (err) => {
      emitFatalOnce(err.message);
    });
  }

  // Start initial attempt (with session ID if provided)
  attachProc(spawnSsh(buildRemoteCmd(options?.sessionId)));

  emitter.abort = () => {
    aborted = true;
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    if (!currentProc) return;
    const proc = currentProc;
    try { proc.kill('SIGTERM'); } catch {}
    killTimer = setTimeout(() => {
      killTimer = null;
      if (proc && !proc.killed) {
        try { proc.kill('SIGKILL'); } catch {}
      }
    }, 3000);
    // Clear killTimer when proc exits naturally
    proc.once('close', () => {
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    });
  };

  return emitter;
}

/**
 * Test SSH connectivity + Claude CLI availability on a remote server.
 * Returns { ok, version?, error? }
 */
export async function testServer(server: ServerConfig): Promise<{
  ok: boolean;
  version?: string;
  auth?: string;
  error?: string;
}> {
  return new Promise((resolve) => {
    const claudePath = server.claude_path ?? 'claude';
    const remoteCmd = `export PATH=$HOME/.npm-global/bin:$HOME/.local/bin:$PATH && ${claudePath} --version 2>&1 && echo '---AUTH---' && ${claudePath} auth status --text 2>&1`;

    const proc = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      '-i', server.key,
      `${server.user}@${server.host}`,
      remoteCmd,
    ]);

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: { ok: boolean; version?: string; auth?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        done({ ok: false, error: (stderr || stdout || `exit code ${code}`).trim().slice(-500) });
        return;
      }
      const parts = stdout.split('---AUTH---');
      const version = parts[0]?.trim();
      const auth = (parts[1] ?? '').trim();

      // Precise auth-failed matching: look for known "not logged in" phrases
      // instead of substring 'No' (which matches "Node version" etc.)
      const authFailed = /not\s+logged\s+in|not\s+authenticated|please\s+log\s+in|unauthorized|no\s+credentials/i
        .test(auth);
      if (authFailed) {
        done({ ok: false, version, error: `Claude CLI 未登录: ${auth}` });
      } else {
        done({ ok: true, version, auth });
      }
    });

    proc.on('error', (err) => {
      done({ ok: false, error: err.message });
    });

    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
      done({ ok: false, error: 'SSH 连接超时' });
    }, 15000);
  });
}
