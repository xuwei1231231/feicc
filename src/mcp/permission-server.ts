// Permission MCP Server
// ─────────────────────
// Exposes a single tool `ask_feishu` that Claude Code CLI calls when it
// needs tool-use approval (via `--permission-prompt-tool mcp__feicc__ask_feishu`).
//
// Flow:
//   claude CLI (remote, via SSH -R port-forward) →
//   HTTP POST /mcp → tool `ask_feishu(tool_name, input, tool_use_id)` →
//   register pending approval → notifier(approvalId, toolName, input) →
//   router sends a Feishu card → user clicks Allow/Deny →
//   resolveApproval(approvalId, decision) → tool returns JSON to claude.
//
// Return schema (stringified and wrapped in content[0].text):
//   { behavior: "allow", updatedInput: {...} }  | { behavior: "deny", message: "..." }

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export type ApprovalDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export interface PendingApproval {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  sessionId: string;
  createdAt: number;
  resolve: (d: ApprovalDecision) => void;
}

export interface PermissionServerOptions {
  port: number;
  /**
   * Called when a new approval request arrives. The handler should send a card
   * to the user. It must NOT block; it should return quickly after kicking off
   * the notification (which may be async fire-and-forget).
   */
  onRequest: (approval: PendingApproval) => void;
  /**
   * How long to wait before auto-denying if no user response arrives.
   * Default: 5 minutes. Set to 0 to disable.
   */
  timeoutMs?: number;
}

/**
 * PermissionHub — in-process registry that ties the MCP server side (which
 * blocks inside a tool call) to the Feishu side (router card actions).
 *
 * Indexed by `approvalId`. The `sessionId` field lets callers route decisions
 * back to the correct session when a user reuses a card from another context.
 */
export class PermissionHub {
  private pending = new Map<string, PendingApproval>();
  private timeoutMs: number;

  constructor(timeoutMs = 5 * 60_000) {
    this.timeoutMs = timeoutMs;
  }

  create(
    toolName: string,
    input: Record<string, unknown>,
    sessionId: string,
    toolUseId?: string,
  ): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const approval: PendingApproval = {
        id: randomUUID(),
        toolName,
        input,
        toolUseId,
        sessionId,
        createdAt: Date.now(),
        resolve,
      };
      this.pending.set(approval.id, approval);

      if (this.timeoutMs > 0) {
        setTimeout(() => {
          const still = this.pending.get(approval.id);
          if (!still) return;
          this.pending.delete(approval.id);
          console.log(`[mcp] approval ${approval.id} timed out (${this.timeoutMs}ms)`);
          still.resolve({ behavior: 'deny', message: `超时未响应（${Math.round(this.timeoutMs / 1000)}s）。已自动拒绝。` });
        }, this.timeoutMs).unref?.();
      }

      // Emit the notification side effect.
      try {
        this.onRequest?.(approval);
      } catch (err: any) {
        console.error('[mcp] onRequest handler threw:', err?.message ?? err);
      }
    });
  }

  /** Resolve a pending approval. Returns true if something was resolved. */
  resolve(approvalId: string, decision: ApprovalDecision): boolean {
    const a = this.pending.get(approvalId);
    if (!a) return false;
    this.pending.delete(approvalId);
    a.resolve(decision);
    return true;
  }

  /** Look up without resolving. */
  get(approvalId: string): PendingApproval | undefined {
    return this.pending.get(approvalId);
  }

  size(): number {
    return this.pending.size;
  }

  onRequest: ((approval: PendingApproval) => void) | undefined;
}

export interface PermissionServerHandle {
  hub: PermissionHub;
  server: Server;
  url: string;
  port: number;
  stop: () => Promise<void>;
}

/**
 * Start an HTTP MCP server. Returns a Promise of a handle with stop().
 * The server listens on 127.0.0.1:<port> and serves the Streamable HTTP MCP
 * endpoint at `/mcp`.
 *
 * Stateless mode (sessionIdGenerator: undefined). Each request gets a fresh
 * transport + McpServer instance. Fine here because the tool is stateless
 * (just forwards to the in-process PermissionHub).
 */
export function startPermissionServer(
  opts: PermissionServerOptions,
): Promise<PermissionServerHandle> {
  const hub = new PermissionHub(opts.timeoutMs);
  hub.onRequest = opts.onRequest;

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== '/mcp' && !req.url?.startsWith('/mcp?')) {
      res.writeHead(404).end('Not found');
      return;
    }

    try {
      // Only accept POST for the MCP endpoint. GET/DELETE are used for
      // session resume in stateful mode; we're stateless so reject them.
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null,
        }));
        return;
      }

      const body = await readJsonBody(req);
      const sessionId = String(req.headers['x-feicc-session'] ?? '').trim() || 'global';

      // Stateless: build fresh server + transport per request.
      const server = buildServer(hub, { sessionId });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true, // simpler: return JSON, no SSE
      });

      // Clean up when the response closes.
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err: any) {
      console.error('[mcp] request error:', err?.stack ?? err?.message ?? err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null,
        }));
      }
    }
  });

  return new Promise<PermissionServerHandle>((resolvePromise, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(opts.port, '127.0.0.1', () => {
      httpServer.off('error', onError);
      const addr = httpServer.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
      console.log(`[mcp] permission server listening on http://127.0.0.1:${actualPort}/mcp`);
      resolvePromise({
        hub,
        server: httpServer,
        url: `http://127.0.0.1:${actualPort}/mcp`,
        port: actualPort,
        stop: () => new Promise<void>((res) => httpServer.close(() => res())),
      });
    });
  });
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(undefined);
      try { resolve(JSON.parse(text)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function buildServer(hub: PermissionHub, ctx: { sessionId: string }): McpServer {
  const server = new McpServer(
    { name: 'feicc', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // The tool Claude Code calls when it needs permission.
  // Claude invokes `mcp__feicc__ask_feishu` with:
  //   { tool_name: string, input: object, tool_use_id?: string }
  // We must return text content that, when parsed as JSON, matches:
  //   { behavior: "allow", updatedInput: object } | { behavior: "deny", message: string }
  server.registerTool(
    'ask_feishu',
    {
      description: '向用户（飞书）发起权限确认，等待用户点击允许/拒绝按钮后返回决定。',
      inputSchema: {
        tool_name: z.string().describe('要执行的工具名（如 Bash、Write、Edit）'),
        input: z.record(z.string(), z.unknown()).describe('工具的原始输入参数'),
        tool_use_id: z.string().optional().describe('Claude 内部的 tool_use_id'),
      },
    },
    async ({ tool_name, input, tool_use_id }) => {
      console.log(`[mcp] ask_feishu called: tool=${tool_name} toolUseId=${tool_use_id ?? '?'}`);
      const decision = await hub.create(tool_name, input ?? {}, ctx.sessionId, tool_use_id);
      // Claude Code expects the JSON to be in the first text block.
      return {
        content: [
          { type: 'text', text: JSON.stringify(decision) },
        ],
      };
    },
  );

  return server;
}
