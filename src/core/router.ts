// Core message router: Feishu message → find session → SSH exec claude CLI
// + card action handler for interactive buttons

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { FeishuClient } from '../feishu/client.js';
import type { Store, SessionRow } from '../store/db.js';
import type { HubConfig, ServerConfig } from '../config.js';
import { addServerToConfig, addWorkspaceToConfig, updateServerInConfig, removeServerFromConfig } from '../config.js';
import { execClaudeTask, testServer, type ClaudeEvent, type TaskHandle } from '../claude/executor.js';
import { OutputManager } from './output.js';
import { handleCommand } from './commands.js';
import type { PermissionHub, PendingApproval } from '../mcp/permission-server.js';
import {
  doneCard,
  errorCard,
  authErrorCard,
  serverListCard,
  workspaceListCard,
  permissionModeCard,
  menuCard,
  statusCard,
  testResultCard,
  toastCard,
  addServerFormCard,
  addWorkspaceFormCard,
  editServerFormCard,
  confirmDeleteServerCard,
  uploadKeyPromptCard,
  usageCard,
  approvalCard,
  approvalResolvedCard,
} from '../feishu/cards.js';

// Active tasks per session. Each session can have AT MOST one running task.
// When a new message arrives while one is running, we reject it politely.
const activeTasks = new Map<string, TaskHandle>();

// Pending key uploads: userId → serverId (waiting for PEM file)
const pendingKeyUploads = new Map<string, string>();

// Periodically sweep abandoned pending_server entries (24h+)
// Called once on module load; cheap and idempotent.
let sweepTimer: NodeJS.Timeout | null = null;
function startKvSweeper(store: Store) {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    try { store.sweepStaleKv(); } catch (err: any) {
      console.error('[store] sweepStaleKv error:', err?.message ?? err);
    }
  }, 3600 * 1000);
  // Allow process to exit even with timer pending
  sweepTimer.unref?.();
}

export class Router {
  private feishu: FeishuClient;
  private store: Store;
  private config: HubConfig;

  // Permission MCP wiring (only active when ask_feishu mode is used)
  private permissionHub: PermissionHub | undefined;
  private mcpPort: number | undefined;

  // approvalId → { sessionId, chatId, messageId, toolName } so we can
  // (a) replace the card after a decision, (b) enforce same-session routing.
  private approvalMeta = new Map<string, {
    sessionId: string;
    chatId: string;
    messageId?: string;
    toolName: string;
  }>();

  // sessionId → Set<toolName> auto-approved for the rest of this feicc session
  // (backs the "🔓 本次会话全部允许 Write" button).
  private sessionAllowedTools = new Map<string, Set<string>>();

  constructor(feishu: FeishuClient, store: Store, config: HubConfig) {
    this.feishu = feishu;
    this.store = store;
    this.config = config;
    startKvSweeper(store);
  }

  /**
   * Wire the MCP permission hub. Call once at startup when the HTTP MCP
   * server has been bound. After this, the router will:
   *   - register approval requests → send a Feishu card
   *   - resolve decisions coming in via handleCardAction('approval_decide', ...)
   */
  attachPermissionHub(hub: PermissionHub, mcpPort: number) {
    this.permissionHub = hub;
    this.mcpPort = mcpPort;
    hub.onRequest = (approval) => this.onApprovalRequest(approval);
    console.log(`[router] permission hub attached (mcpPort=${mcpPort})`);
  }

  private async onApprovalRequest(approval: PendingApproval) {
    const meta = this.approvalMeta; // capture
    const feiccSessionId = approval.sessionId;

    // Look up the feicc session to find the chat.
    let chatId: string | undefined;
    try {
      const sess = this.store.findSessionById(feiccSessionId);
      chatId = sess?.feishu_chat_id;
    } catch (err: any) {
      console.error('[router] lookup session for approval failed:', err?.message ?? err);
    }

    // Auto-approve if this tool is in the per-session allow list.
    const allowed = this.sessionAllowedTools.get(feiccSessionId);
    if (allowed?.has(approval.toolName)) {
      console.log(`[router] auto-allow ${approval.toolName} (session ${feiccSessionId})`);
      this.permissionHub?.resolve(approval.id, {
        behavior: 'allow',
        updatedInput: approval.input,
      });
      return;
    }

    if (!chatId) {
      console.warn(`[router] approval ${approval.id} has no chatId; auto-denying`);
      this.permissionHub?.resolve(approval.id, {
        behavior: 'deny',
        message: 'feicc session not found for this approval request.',
      });
      return;
    }

    meta.set(approval.id, {
      sessionId: feiccSessionId,
      chatId,
      toolName: approval.toolName,
    });

    try {
      const card = approvalCard(approval.id, approval.toolName, approval.input);
      const cardMsgId = await this.feishu.sendCard(chatId, card);
      const rec = meta.get(approval.id);
      if (rec) rec.messageId = cardMsgId ?? undefined;
    } catch (err: any) {
      console.error('[router] failed to send approval card:', err?.message ?? err);
      this.permissionHub?.resolve(approval.id, {
        behavior: 'deny',
        message: `飞书卡片发送失败: ${err?.message ?? err}`,
      });
      meta.delete(approval.id);
    }
  }

  private async finalizeApproval(
    approvalId: string,
    decision: 'allow' | 'deny' | 'allow_tool_session',
    operatorId: string,
  ) {
    const meta = this.approvalMeta.get(approvalId);
    if (!meta) {
      console.warn(`[router] finalizeApproval: unknown approvalId ${approvalId}`);
      return;
    }
    this.approvalMeta.delete(approvalId);

    const hub = this.permissionHub;
    if (!hub) return;

    // Look up the pending request for its original input (needed for updatedInput).
    const pending = hub.get(approvalId);

    if (decision === 'allow' || decision === 'allow_tool_session') {
      if (decision === 'allow_tool_session') {
        let set = this.sessionAllowedTools.get(meta.sessionId);
        if (!set) { set = new Set(); this.sessionAllowedTools.set(meta.sessionId, set); }
        set.add(meta.toolName);
      }
      hub.resolve(approvalId, {
        behavior: 'allow',
        updatedInput: (pending?.input ?? {}) as Record<string, unknown>,
      });
    } else {
      hub.resolve(approvalId, {
        behavior: 'deny',
        message: `用户在飞书拒绝了 ${meta.toolName}`,
      });
    }

    // Replace the card with a resolved state card (best-effort).
    try {
      const resolvedCard = approvalResolvedCard(meta.toolName, decision, operatorId);
      if (meta.messageId) {
        await this.feishu.updateCard(meta.messageId, resolvedCard);
      } else {
        await this.feishu.sendCard(meta.chatId, resolvedCard);
      }
    } catch (err: any) {
      console.error('[router] failed to update resolved card:', err?.message ?? err);
    }
  }

  getServer(id: string): ServerConfig | undefined {
    return this.config.remotes.find(r => r.id === id);
  }

  getServers(): ServerConfig[] {
    return this.config.remotes;
  }

  // ─── Handle file messages (PEM key upload) ───

  async handleFileMessage(
    chatId: string,
    userId: string,
    messageId: string,
    fileKey: string,
    fileName: string,
  ) {
    // Check if there's a pending key upload for this user
    const pendingServerId = pendingKeyUploads.get(userId);
    if (!pendingServerId) {
      // No pending upload, ignore file
      await this.feishu.replyText(messageId, '收到文件，但当前没有待上传的密钥。如需添加服务器请先点击「添加服务器」。');
      return;
    }

    // Get pending server info
    const pendingInfo = this.store.getPendingServer(userId);
    if (!pendingInfo) {
      pendingKeyUploads.delete(userId);
      await this.feishu.replyCard(messageId, toastCard('❌ 未找到待配置的服务器信息，请重新添加', 'red'));
      return;
    }

    let serverInfo: any;
    try {
      serverInfo = JSON.parse(pendingInfo);
    } catch {
      pendingKeyUploads.delete(userId);
      await this.feishu.replyCard(messageId, toastCard('❌ 服务器信息解析失败，请重新添加', 'red'));
      return;
    }

    try {
      // Download file from Feishu
      const keysDir = path.resolve(this.config.server.data_dir, 'keys');
      fs.mkdirSync(keysDir, { recursive: true });

      const keyFileName = `${serverInfo.serverId}.pem`;
      const keyPath = path.join(keysDir, keyFileName);

      const resp = await this.feishu.client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      });

      await resp.writeFile(keyPath);
      fs.chmodSync(keyPath, 0o600);

      console.log(`[feicc] saved key for ${serverInfo.serverId}: ${keyPath}`);

      // Now add server to config with the key path (or update if replacing)
      if (serverInfo.mode === 'replace' && this.getServer(serverInfo.serverId)) {
        updateServerInConfig(this.config, serverInfo.serverId, {
          name: serverInfo.serverName,
          host: serverInfo.serverHost,
          user: serverInfo.serverUser,
          key: keyPath,
          workspace_cwd: serverInfo.workspaceCwd,
        });
      } else {
        addServerToConfig(this.config, {
          id: serverInfo.serverId,
          name: serverInfo.serverName,
          host: serverInfo.serverHost,
          user: serverInfo.serverUser,
          key: keyPath,
          cwd: serverInfo.workspaceCwd,
        });
      }

      // Clean up pending state
      pendingKeyUploads.delete(userId);
      this.store.clearPendingServer(userId);

      await this.feishu.replyCard(messageId, toastCard(
        `✅ 密钥已保存，服务器 ${serverInfo.serverId} ${serverInfo.mode === 'replace' ? '密钥已替换' : '配置完成'}！`, 'green',
      ));

      // Show updated server list
      const servers = this.getServers().map(s => ({
        id: s.id, name: s.name, status: 'configured' as string,
        host: s.host, workspaces: s.workspaces.map(w => w.id),
      }));
      await this.feishu.sendCard(chatId, serverListCard(servers));
    } catch (err: any) {
      console.error('[feicc] file download error:', err.message);
      await this.feishu.replyCard(messageId, toastCard(`❌ 文件下载失败: ${err.message}`, 'red'));
    }
  }

  // ─── Handle text messages ───

  async handleMessage(
    chatId: string,
    userId: string,
    messageId: string,
    text: string,
    rootMsgId?: string,
    parentMsgId?: string,
  ) {
    // Try to find session from parent message
    let session = parentMsgId
      ? this.store.findSessionByMessage(parentMsgId)
      : undefined;

    if (!session) {
      session = this.store.findSession(chatId, userId, rootMsgId);
    }

    // Handle slash commands
    const cmdResult = await handleCommand(text, {
      feishu: this.feishu,
      router: this,
      store: this.store,
      chatId,
      userId,
      messageId,
      session,
    });
    if (cmdResult.handled) {
      if (cmdResult.card) {
        await this.feishu.replyCard(messageId, cmdResult.card);
      } else if (cmdResult.reply) {
        await this.feishu.replyText(messageId, cmdResult.reply);
      }
      return;
    }

    // Create session if needed
    if (!session) {
      const server = this.config.remotes[0];
      if (!server) {
        await this.feishu.replyCard(messageId, toastCard('❌ 没有配置服务器', 'red'));
        return;
      }
      const ws = server.workspaces[0];
      session = {
        id: randomUUID(),
        feishu_chat_id: chatId,
        feishu_user_id: userId,
        feishu_root_msg_id: rootMsgId ?? null,
        server_id: server.id,
        workspace_id: ws?.id ?? 'default',
        claude_session_id: null,
        permission_mode: this.store.getLastPermissionMode(userId, chatId) ?? 'bypassPermissions',
        created_at: Date.now(),
        last_active_at: Date.now(),
      };
      this.store.createSession(session);
    }

    // Concurrency guard: reject if this session is already running a task.
    // Prevents activeTasks map from being overwritten when the user double-sends.
    if (activeTasks.has(session.id)) {
      await this.feishu.replyCard(messageId, toastCard(
        '⏳ 当前会话已有任务在运行，请等待完成或点「中断」后再发。',
        'orange',
      ));
      return;
    }

    // Link message
    this.store.linkMessage(messageId, session.id);
    this.store.touchSession(session.id);

    // Find server config
    const server = this.getServer(session.server_id);
    if (!server) {
      await this.feishu.replyCard(messageId, toastCard(`❌ 服务器 ${session.server_id} 未配置`, 'red'));
      return;
    }

    // Find workspace cwd
    const workspace = server.workspaces.find(w => w.id === session!.workspace_id);
    const cwd = workspace?.cwd ?? '/home/' + server.user;

    // Pre-check: SSH key file exists (async, non-blocking)
    try {
      await fs.promises.access(server.key, fs.constants.R_OK);
    } catch {
      await this.feishu.replyCard(messageId, errorCard(
        server.id,
        `SSH 密钥文件不存在或无法读取: \`${server.key}\`\n\n` +
        `请通过 \`/server\` → 添加服务器重新上传密钥，或检查文件路径。`,
      ));
      return;
    }

    // Create output manager
    const output = new OutputManager(this.feishu, chatId, session.server_id, messageId);

    // Translate feicc's "askFeishu" pseudo-mode to claude's `default` +
    // `--permission-prompt-tool`. Other modes pass through unchanged.
    const isAskFeishu = session.permission_mode === 'askFeishu';
    const claudePermMode = isAskFeishu ? 'default' : session.permission_mode;

    // Execute Claude CLI via SSH
    const task = execClaudeTask(server, text, cwd, {
      sessionId: session.claude_session_id ?? undefined,
      permissionMode: claudePermMode,
      mcp: isAskFeishu && this.mcpPort
        ? { port: this.mcpPort, feiccSessionId: session.id }
        : undefined,
    });

    activeTasks.set(session.id, task);
    const sessionId = session.id;
    let authErrorSent = false;
    let finalCardSent = false;  // guards against double final card (error vs close)

    task.on('data', (event: ClaudeEvent) => {
      this.handleClaudeEvent(event, output, sessionId, (sent) => {
        if (sent) finalCardSent = true;
      });
    });

    task.on('session_expired', (oldClaudeSessionId: string) => {
      console.log(`[claude:${server.id}] clearing expired session ${oldClaudeSessionId}, will start fresh`);
      this.store.updateSessionClaudeId(sessionId, null);
    });

    task.on('stderr', (text: string) => {
      console.error(`[claude:${server.id}] stderr:`, text);
      if (
        !authErrorSent &&
        /not\s+logged\s+in|not\s+authenticated|please\s+log\s+in|unauthorized|no\s+credentials/i.test(text)
      ) {
        authErrorSent = true;
        this.handleAuthError(server, chatId, messageId, text).catch(err => {
          console.error('[router] handleAuthError failed:', err?.message ?? err);
        });
      }
    });

    task.on('error', async (err: string) => {
      console.error(`[claude:${server.id}] error:`, err);
      if (!finalCardSent) {
        finalCardSent = true;
        await output.replaceWithCard(errorCard(server.id, `SSH 错误: ${err}`));
      }
      activeTasks.delete(sessionId);
    });

    task.on('close', async (code: number) => {
      activeTasks.delete(sessionId);
      // If 'error' already ran (executor now guarantees error XOR close for
      // fatal conditions), nothing to do. Otherwise handle non-zero exit.
      if (finalCardSent) {
        await output.flush();
        return;
      }
      if (code !== 0 && code !== null) {
        console.log(`[claude:${server.id}] exited with code ${code}`);
        finalCardSent = true;
        await output.replaceWithCard(errorCard(
          server.id,
          `进程退出，exit code: ${code}\n\n可能原因：Claude CLI 未登录、权限不足、或被强制中断。\n\n请点「测试连接」检查服务器状态。`,
        ));
      } else {
        // Normal completion — handleClaudeEvent('result') should already have
        // replaced the card via doneCard. Flush just in case.
        await output.flush();
      }
    });
  }

  // ─── Handle card button actions ───

  async handleCardAction(
    actionValue: any,
    chatId: string,
    userId: string,
    messageId?: string,
    fullAction?: any,  // full action object including form_value
  ) {
    let parsed: any;
    try {
      parsed = typeof actionValue === 'string' ? JSON.parse(actionValue) : actionValue;
    } catch {
      console.error('[card-action] invalid value:', actionValue);
      return;
    }

    const action = parsed.action;
    console.log(`[card-action] ${action}`, parsed);

    // Find user's session
    const session = this.store.findSession(chatId, userId);

    switch (action) {
      // ── Server overflow menu (compact server list "···") ──
      case 'server_menu': {
        // Feishu overflow: container value carries `serverId`, selected option arrives as fullAction.option (or .options)
        const serverId = parsed.serverId;
        const opt = fullAction?.option ?? fullAction?.options?.[0] ?? '';
        if (!serverId || !opt) {
          console.warn('[card-action] server_menu missing serverId/option:', { serverId, opt, fullAction });
          break;
        }
        // Re-dispatch into the existing handlers by mutating parsed.action.
        const remap: Record<string, string> = {
          select: 'select_server',
          test: 'test_server',
          edit: 'show_edit_server',
          delete: 'confirm_delete_server',
        };
        const next = remap[opt];
        if (!next) {
          console.warn('[card-action] server_menu unknown option:', opt);
          break;
        }
        // Recurse with the mapped action. Reuse the same actionValue-shaped object.
        await this.handleCardAction(
          { action: next, serverId },
          chatId, userId, messageId, fullAction,
        );
        return;
      }

      // ── Server selection ──
      case 'select_server': {
        const serverId = parsed.serverId;
        const server = this.getServer(serverId);
        if (!server) return;

        // Pre-check: SSH key exists
        let keyOk = false;
        try {
          await fs.promises.access(server.key, fs.constants.R_OK);
          keyOk = true;
        } catch {}

        if (!keyOk) {
          await this.feishu.sendCard(chatId, errorCard(
            serverId,
            `SSH 密钥文件不存在: \`${server.key}\`\n\n请重新上传密钥文件。`,
          ));
          return;
        }

        // Quick SSH test
        await this.feishu.sendCard(chatId, toastCard(`🔧 正在连接 ${serverId}...`, 'blue'));
        const testResult = await this.testServerConnection(serverId);

        if (!testResult.ok) {
          await this.feishu.sendCard(chatId, testResultCard(
            serverId, false,
            `连接失败: ${testResult.error}\n\n请检查服务器地址、密钥和 Claude CLI 状态。`,
          ));
          return;
        }

        // Connection OK, switch
        const defaultWs = server.default_workspace ?? server.workspaces[0]?.id ?? 'default';
        if (session) {
          this.store.updateSessionServer(session.id, serverId, defaultWs);
        }
        await this.feishu.sendCard(
          chatId,
          toastCard(`✅ 已连接 ${serverId} (${server.name}) — Claude ${testResult.version ?? ''}`, 'green'),
        );
        break;
      }

      case 'show_servers': {
        const servers = this.getServers().map(s => ({
          id: s.id,
          name: s.name,
          status: 'configured' as string,
          host: s.host,
          workspaces: s.workspaces.map(w => w.id),
        }));
        await this.feishu.sendCard(chatId, serverListCard(servers, session?.server_id));
        break;
      }

      // ── Workspace selection ──
      case 'select_workspace': {
        const { serverId, workspaceId } = parsed;
        if (session) {
          this.store.updateSessionServer(session.id, serverId, workspaceId);
        }
        const server = this.getServer(serverId);
        const ws = server?.workspaces.find(w => w.id === workspaceId);
        await this.feishu.sendCard(
          chatId,
          toastCard(`✅ 已切换 workspace 到 ${ws?.name ?? workspaceId} (${ws?.cwd ?? ''})`, 'green'),
        );
        break;
      }

      case 'show_workspaces': {
        const serverId = session?.server_id ?? this.config.remotes[0]?.id;
        if (!serverId) return;
        const server = this.getServer(serverId);
        if (!server) return;
        await this.feishu.sendCard(
          chatId,
          workspaceListCard(serverId, server.workspaces, session?.workspace_id),
        );
        break;
      }

      // ── Permission mode ──
      case 'set_permission': {
        const mode = parsed.mode;
        if (session) {
          this.store.updateSessionPermission(session.id, mode);
        }
        const labels: Record<string, string> = {
          bypassPermissions: '🟢 全自动 (YOLO)',
          acceptEdits: '🟡 接受编辑',
          askFeishu: '🙋 飞书逐项审批',
          plan: '🔴 仅规划',
        };
        await this.feishu.sendCard(
          chatId,
          toastCard(`✅ 权限模式已切换到 ${labels[mode] ?? mode}`, 'green'),
        );
        break;
      }

      case 'show_permissions': {
        const mode = session?.permission_mode ?? 'bypassPermissions';
        await this.feishu.sendCard(chatId, permissionModeCard(mode));
        break;
      }

      // ── Session control ──
      case 'new_session': {
        if (session) {
          this.store.updateSessionClaudeId(session.id, null);
        }
        await this.feishu.sendCard(
          chatId,
          toastCard('✅ 下条消息将创建新的 Claude 会话', 'green'),
        );
        break;
      }

      case 'stop': {
        if (session) {
          const aborted = this.abortTask(session.id);
          await this.feishu.sendCard(
            chatId,
            toastCard(
              aborted ? '✅ 已中断任务' : '⚠️ 没有正在执行的任务',
              aborted ? 'green' : 'orange',
            ),
          );
        }
        break;
      }

      // ── Test server ──
      case 'test_server': {
        const serverId = parsed.serverId ?? session?.server_id;
        if (!serverId) return;
        await this.feishu.sendCard(chatId, toastCard(`🔧 正在测试 ${serverId}...`, 'blue'));
        const result = await this.testServerConnection(serverId);
        await this.feishu.sendCard(
          chatId,
          testResultCard(
            serverId,
            result.ok,
            result.ok
              ? `Claude: ${result.version}\n${result.auth}`
              : `错误: ${result.error}`,
          ),
        );
        break;
      }

      case 'test_current_server': {
        const serverId = session?.server_id ?? this.config.remotes[0]?.id;
        if (!serverId) return;
        await this.feishu.sendCard(chatId, toastCard(`🔧 正在测试 ${serverId}...`, 'blue'));
        const result = await this.testServerConnection(serverId);
        await this.feishu.sendCard(
          chatId,
          testResultCard(
            serverId,
            result.ok,
            result.ok
              ? `Claude: ${result.version}\n${result.auth}`
              : `错误: ${result.error}`,
          ),
        );
        break;
      }

      case 'test_all_servers': {
        const servers = this.getServers();
        await this.feishu.sendCard(chatId, toastCard(`🔧 正在测试 ${servers.length} 台服务器...`, 'blue'));
        const results: string[] = [];
        for (const s of servers) {
          const r = await this.testServerConnection(s.id);
          results.push(r.ok ? `✅ **${s.id}** — ${r.version}` : `❌ **${s.id}** — ${r.error}`);
        }
        await this.feishu.sendCard(chatId, {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: '🔧 测试结果' }, template: 'blue' },
          elements: [
            { tag: 'div', text: { tag: 'lark_md', content: results.join('\n') } },
            { tag: 'action', actions: [{
              tag: 'button', text: { tag: 'plain_text', content: '📋 返回菜单' },
              type: 'default', value: { action: 'show_menu' },
            }] },
          ],
        });
        break;
      }

      // ── Menu / Status ──
      case 'show_menu': {
        await this.feishu.sendCard(
          chatId,
          menuCard(session?.server_id, session?.workspace_id, session?.permission_mode),
        );
        break;
      }

      case 'show_status': {
        const servers = this.getServers();
        await this.feishu.sendCard(chatId, statusCard({
          serverCount: servers.length,
          servers: servers.map(s => s.id).join(', '),
          currentServer: session?.server_id,
          currentWorkspace: session?.workspace_id,
          currentPermission: session?.permission_mode,
        }));
        break;
      }

      case 'usage': {
        const stats = this.store.getUsageByUser(userId, 30);
        const recent = this.store.getRecentTasks(userId, 10);
        await this.feishu.sendCard(chatId, usageCard({
          period: '最近 30 天',
          ...stats,
          recentTasks: recent,
        }));
        break;
      }

      case 'usage_period': {
        const days = parsed.days ?? 30;
        const stats = this.store.getUsageByUser(userId, days);
        const recent = this.store.getRecentTasks(userId, 10);
        await this.feishu.sendCard(chatId, usageCard({
          period: `最近 ${days} 天`,
          ...stats,
          recentTasks: recent,
        }));
        break;
      }

      case 'continue': {
        // No-op, user will just send another message
        await this.feishu.sendCard(chatId, toastCard('💬 请发送消息继续对话', 'blue'));
        break;
      }

      case 'retry': {
        // We don't persist the last user prompt per session, so a true
        // server-side retry isn't possible without extra wiring. Prompt the
        // user to re-send. If you want real retry, save last prompt into
        // sessions table and re-execute here.
        await this.feishu.sendCard(chatId, toastCard('🔄 请重新发送消息重试', 'blue'));
        break;
      }

      case 'dismiss': {
        // Do nothing, card stays but action is acknowledged
        break;
      }

      // ── Add server / workspace forms ──
      case 'show_add_server': {
        await this.feishu.sendCard(chatId, addServerFormCard());
        break;
      }

      case 'show_add_workspace': {
        const serverId = parsed.serverId ?? session?.server_id ?? this.config.remotes[0]?.id;
        if (!serverId) {
          await this.feishu.sendCard(chatId, toastCard('❌ 没有服务器可添加工作区', 'red'));
          break;
        }
        await this.feishu.sendCard(chatId, addWorkspaceFormCard(serverId));
        break;
      }

      case 'submit_add_server': {
        // form_value contains fields from the form container
        const form = fullAction?.form_value ?? parsed.form_value ?? {};
        const serverId = form.server_id?.trim();
        const serverName = form.server_name?.trim();
        const serverHost = form.server_host?.trim();
        const serverUser = form.server_user?.trim() || 'ubuntu';
        const serverKey = form.server_key?.trim() || '';
        const workspaceCwd = form.workspace_cwd?.trim() || `/home/${serverUser}`;

        if (!serverId || !serverName || !serverHost) {
          await this.feishu.sendCard(chatId, toastCard('❌ 请填写服务器 ID、名称和主机地址', 'red'));
          break;
        }

        // Check duplicate
        if (this.getServer(serverId)) {
          await this.feishu.sendCard(chatId, toastCard(`❌ 服务器 ID "${serverId}" 已存在`, 'red'));
          break;
        }

        if (serverKey) {
          // Key path provided, add directly
          try {
            addServerToConfig(this.config, {
              id: serverId, name: serverName, host: serverHost,
              user: serverUser, key: serverKey, cwd: workspaceCwd,
            });
            await this.feishu.sendCard(chatId, toastCard(`✅ 已添加服务器 ${serverId} (${serverName})`, 'green'));

            const servers = this.getServers().map(s => ({
              id: s.id, name: s.name, status: 'configured' as string,
              host: s.host, workspaces: s.workspaces.map(w => w.id),
            }));
            await this.feishu.sendCard(chatId, serverListCard(servers, session?.server_id));
          } catch (err: any) {
            await this.feishu.sendCard(chatId, toastCard(`❌ 添加失败: ${err.message}`, 'red'));
          }
        } else {
          // No key, save pending info and ask for file upload
          const pendingInfo = JSON.stringify({ serverId, serverName, serverHost, serverUser, workspaceCwd });
          this.store.setPendingServer(userId, pendingInfo);
          pendingKeyUploads.set(userId, serverId);
          await this.feishu.sendCard(chatId, uploadKeyPromptCard(serverId));
        }
        break;
      }

      case 'submit_add_workspace': {
        const form = fullAction?.form_value ?? parsed.form_value ?? {};
        const serverId = parsed.serverId;
        const wsId = form.workspace_id?.trim();
        const wsName = form.workspace_name?.trim();
        const wsCwd = form.workspace_cwd?.trim();

        if (!serverId || !wsId || !wsName || !wsCwd) {
          await this.feishu.sendCard(chatId, toastCard('❌ 请填写所有必填字段', 'red'));
          break;
        }

        const server = this.getServer(serverId);
        if (!server) {
          await this.feishu.sendCard(chatId, toastCard(`❌ 服务器 ${serverId} 不存在`, 'red'));
          break;
        }

        if (server.workspaces.find(w => w.id === wsId)) {
          await this.feishu.sendCard(chatId, toastCard(`❌ 工作区 "${wsId}" 已存在`, 'red'));
          break;
        }

        try {
          addWorkspaceToConfig(this.config, serverId, { id: wsId, name: wsName, cwd: wsCwd });
          await this.feishu.sendCard(chatId, toastCard(`✅ 已添加工作区 ${wsName} (${wsCwd})`, 'green'));

          // Show updated workspace list
          await this.feishu.sendCard(chatId, workspaceListCard(serverId, server.workspaces, session?.workspace_id));
        } catch (err: any) {
          await this.feishu.sendCard(chatId, toastCard(`❌ 添加失败: ${err.message}`, 'red'));
        }
        break;
      }

      case 'skip_key_upload': {
        pendingKeyUploads.delete(userId);
        await this.feishu.sendCard(chatId, toastCard('⏭ 已跳过密钥上传，请稍后手动配置', 'grey'));
        break;
      }

      // ── Edit / delete server ──
      case 'show_edit_server': {
        const serverId = parsed.serverId;
        const server = this.getServer(serverId);
        if (!server) {
          await this.feishu.sendCard(chatId, toastCard(`❌ 服务器 ${serverId} 不存在`, 'red'));
          break;
        }
        await this.feishu.sendCard(chatId, editServerFormCard(server));
        break;
      }

      case 'submit_edit_server': {
        const form = fullAction?.form_value ?? parsed.form_value ?? {};
        const serverId = parsed.serverId;
        if (!serverId) {
          await this.feishu.sendCard(chatId, toastCard('❌ 缺少 serverId', 'red'));
          break;
        }
        const server = this.getServer(serverId);
        if (!server) {
          await this.feishu.sendCard(chatId, toastCard(`❌ 服务器 ${serverId} 不存在`, 'red'));
          break;
        }

        const patch: any = {};
        const trim = (v: any) => (typeof v === 'string' ? v.trim() : '');
        const name = trim(form.server_name);
        const host = trim(form.server_host);
        const user = trim(form.server_user);
        const key = trim(form.server_key);
        const cwd = trim(form.workspace_cwd);

        if (name && name !== server.name) patch.name = name;
        if (host && host !== server.host) patch.host = host;
        if (user && user !== server.user) patch.user = user;
        if (key && key !== server.key) patch.key = key;
        if (cwd) {
          const defWsId = server.default_workspace ?? server.workspaces[0]?.id;
          const defWs = server.workspaces.find(w => w.id === defWsId);
          if (defWs && cwd !== defWs.cwd) patch.workspace_cwd = cwd;
        }

        if (Object.keys(patch).length === 0) {
          await this.feishu.sendCard(chatId, toastCard('ℹ️ 没有变更可保存', 'grey'));
          break;
        }

        try {
          updateServerInConfig(this.config, serverId, patch);
          const fields = Object.keys(patch).join(', ');
          await this.feishu.sendCard(chatId, toastCard(`✅ 已更新 ${serverId}: ${fields}`, 'green'));

          const servers = this.getServers().map(s => ({
            id: s.id, name: s.name, status: 'configured' as string,
            host: s.host, workspaces: s.workspaces.map(w => w.id),
          }));
          await this.feishu.sendCard(chatId, serverListCard(servers, session?.server_id));
        } catch (err: any) {
          await this.feishu.sendCard(chatId, toastCard(`❌ 更新失败: ${err.message}`, 'red'));
        }
        break;
      }

      case 'reupload_key': {
        const serverId = parsed.serverId;
        const server = this.getServer(serverId);
        if (!server) {
          await this.feishu.sendCard(chatId, toastCard(`❌ 服务器 ${serverId} 不存在`, 'red'));
          break;
        }
        // Reuse the same upload flow as add-server: stash existing fields under pending_server.
        const pendingInfo = JSON.stringify({
          serverId: server.id,
          serverName: server.name,
          serverHost: server.host,
          serverUser: server.user,
          workspaceCwd: server.workspaces.find(w => w.id === (server.default_workspace ?? server.workspaces[0]?.id))?.cwd
            ?? `/home/${server.user}`,
          mode: 'replace',
        });
        this.store.setPendingServer(userId, pendingInfo);
        pendingKeyUploads.set(userId, server.id);
        await this.feishu.sendCard(chatId, uploadKeyPromptCard(server.id));
        break;
      }

      case 'confirm_delete_server': {
        const serverId = parsed.serverId;
        const server = this.getServer(serverId);
        if (!server) {
          await this.feishu.sendCard(chatId, toastCard(`❌ 服务器 ${serverId} 不存在`, 'red'));
          break;
        }
        await this.feishu.sendCard(chatId, confirmDeleteServerCard(server));
        break;
      }

      case 'delete_server': {
        const serverId = parsed.serverId;
        if (!serverId) {
          await this.feishu.sendCard(chatId, toastCard('❌ 缺少 serverId', 'red'));
          break;
        }
        const removed = removeServerFromConfig(this.config, serverId);
        if (!removed) {
          await this.feishu.sendCard(chatId, toastCard(`❌ 服务器 ${serverId} 不存在`, 'red'));
          break;
        }
        await this.feishu.sendCard(chatId, toastCard(`🗑 已删除服务器 ${serverId}`, 'orange'));

        const servers = this.getServers().map(s => ({
          id: s.id, name: s.name, status: 'configured' as string,
          host: s.host, workspaces: s.workspaces.map(w => w.id),
        }));
        await this.feishu.sendCard(chatId, serverListCard(servers, session?.server_id));
        break;
      }

      // ── Approval (from MCP permission server) ──
      case 'approval_decide': {
        const approvalId = parsed.approvalId as string;
        const decision = parsed.decision as 'allow' | 'deny' | 'allow_tool_session';
        if (!approvalId || !decision) {
          console.warn('[router] approval_decide missing fields:', parsed);
          break;
        }
        await this.finalizeApproval(approvalId, decision, userId);
        break;
      }

      // ── Legacy aliases (pre-MCP stubs; route into the real handler) ──
      case 'approve':
      case 'deny':
      case 'approve_all': {
        const approvalId = parsed.approvalId as string;
        if (!approvalId) {
          await this.feishu.sendCard(chatId, toastCard('⚠️ 审批卡片缺少 approvalId', 'orange'));
          break;
        }
        const mapping = {
          approve: 'allow',
          deny: 'deny',
          approve_all: 'allow_tool_session',
        } as const;
        await this.finalizeApproval(approvalId, mapping[action as keyof typeof mapping], userId);
        break;
      }

      default:
        console.log(`[card-action] unknown action: ${action}`);
    }
  }

  // ─── Claude event handler ───

  private handleClaudeEvent(
    event: ClaudeEvent,
    output: OutputManager,
    sessionId: string,
    onFinalCard?: (sent: boolean) => void,
  ) {
    switch (event.type) {
      case 'system':
        if (event.session_id) {
          this.store.updateSessionClaudeId(sessionId, event.session_id);
        }
        break;

      case 'assistant': {
        const content = event.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              output.updateText(block.text);
            }
            if (block.type === 'tool_use') {
              const desc = this.describeToolUse(block.name, block.input);
              output.addToolLog(desc);
            }
          }
        }
        break;
      }

      case 'result': {
        const session = this.store.findSessionById(sessionId);
        const usage = event.usage ?? {};
        const costUsd = event.total_cost_usd ?? 0;
        const durationMs = event.duration_ms ?? 0;

        const card = doneCard(
          session?.server_id ?? '?',
          session?.workspace_id ?? '?',
          event.result ?? '(无结果)',
          costUsd,
          usage,
          durationMs,
        );
        // Fire-and-forget the card replace, but signal that the final card
        // has been sent so the 'close' handler doesn't duplicate it.
        onFinalCard?.(true);
        output.replaceWithCard(card).catch(err => {
          console.error('[router] replaceWithCard failed:', err?.message ?? err);
        });

        // Record task usage
        if (session) {
          this.store.recordTask({
            id: randomUUID(),
            sessionId,
            serverId: session.server_id,
            userId: session.feishu_user_id,
            inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
            outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            costUsd,
            durationMs,
          });
        }

        if (event.session_id) {
          this.store.updateSessionClaudeId(sessionId, event.session_id);
        }
        break;
      }
    }
  }

  private describeToolUse(tool: string, input: any): string {
    switch (tool) {
      case 'Read': return `📁 读取 ${input?.file_path ?? '...'}`;
      case 'Write': return `✏️ 写入 ${input?.file_path ?? '...'}`;
      case 'Edit': return `✏️ 修改 ${input?.file_path ?? '...'}`;
      case 'Bash': return `🖥️ 执行 ${(input?.command ?? '').slice(0, 80)}`;
      case 'Glob': return `🔍 搜索文件 ${input?.pattern ?? '...'}`;
      case 'Grep': return `🔍 搜索 ${input?.pattern ?? '...'}`;
      case 'WebSearch': return `🌐 搜索 ${input?.query ?? '...'}`;
      case 'WebFetch': return `🌐 获取 ${input?.url ?? '...'}`;
      default: return `🔧 ${tool}`;
    }
  }

  private async handleAuthError(server: ServerConfig, chatId: string, replyTo: string, error: string) {
    const card = authErrorCard(server.id, server.host, error);
    await this.feishu.replyCard(replyTo, card);
  }

  handleApprovalAction(approvalId: string, action: string) {
    // Legacy shim — kept for callers that import it directly.
    // Real flow goes through finalizeApproval via handleCardAction('approval_decide').
    console.log(`[approval] legacy shim called: ${approvalId} / ${action} (no-op; use approval_decide)`);
  }

  abortTask(sessionId: string): boolean {
    const task = activeTasks.get(sessionId);
    if (task) {
      task.abort();
      activeTasks.delete(sessionId);
      return true;
    }
    return false;
  }

  async testServerConnection(serverId: string) {
    const server = this.getServer(serverId);
    if (!server) return { ok: false, error: '服务器未配置' };
    return testServer(server);
  }
}
