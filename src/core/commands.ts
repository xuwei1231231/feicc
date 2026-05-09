// Slash command parser & executor — all responses use interactive cards

import type { FeishuClient } from '../feishu/client.js';
import type { Router } from './router.js';
import type { Store, SessionRow } from '../store/db.js';
import {
  serverListCard,
  workspaceListCard,
  permissionModeCard,
  menuCard,
  helpCard,
  statusCard,
  testResultCard,
  toastCard,
} from '../feishu/cards.js';

export interface CommandContext {
  feishu: FeishuClient;
  router: Router;
  store: Store;
  chatId: string;
  userId: string;
  messageId: string;
  session: SessionRow | undefined;
}

export interface CommandResult {
  handled: boolean;
  card?: any;    // Reply with interactive card
  reply?: string; // Fallback text reply (avoid using)
}

export async function handleCommand(text: string, ctx: CommandContext): Promise<CommandResult> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { handled: false };

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0]!.toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case '/server':
    case '/servers':
      return handleServerCmd(args, ctx);
    case '/workspace':
    case '/ws':
      return handleWorkspaceCmd(args, ctx);
    case '/perm':
    case '/permission':
      return handlePermissionCmd(ctx);
    case '/new':
      return handleNewCmd(ctx);
    case '/stop':
      return handleStopCmd(ctx);
    case '/test':
      return await handleTestCmd(args, ctx);
    case '/status':
      return handleStatusCmd(ctx);
    case '/menu':
      return handleMenuCmd(ctx);
    case '/help':
      return handleHelpCmd();
    default:
      return { handled: false };
  }
}

function handleServerCmd(args: string[], ctx: CommandContext): CommandResult {
  // Direct "use" still supported as shortcut
  if (args[0] === 'use' && args[1]) {
    const serverId = args[1];
    const server = ctx.router.getServer(serverId);
    if (!server) return { handled: true, card: toastCard(`❌ 未找到服务器 ${serverId}`, 'red') };

    const defaultWs = server.default_workspace ?? server.workspaces[0]?.id ?? 'default';
    if (ctx.session) {
      ctx.store.updateSessionServer(ctx.session.id, serverId, defaultWs);
    }
    return {
      handled: true,
      card: toastCard(`✅ 已切换到 ${serverId} (${server.name})，workspace: ${defaultWs}`, 'green'),
    };
  }

  // Show server list with clickable buttons
  const servers = ctx.router.getServers().map(s => ({
    id: s.id,
    name: s.name,
    status: 'configured' as string,
    host: s.host,
    workspaces: s.workspaces.map(w => w.id),
  }));

  return {
    handled: true,
    card: serverListCard(servers, ctx.session?.server_id),
  };
}

function handleWorkspaceCmd(args: string[], ctx: CommandContext): CommandResult {
  if (!ctx.session) {
    return { handled: true, card: toastCard('⚠️ 先发条消息开始对话', 'orange') };
  }
  const server = ctx.router.getServer(ctx.session.server_id);
  if (!server) {
    return { handled: true, card: toastCard('❌ 服务器未配置', 'red') };
  }

  // Direct "use" shortcut
  if (args[0] === 'use' && args[1]) {
    const ws = server.workspaces.find(w => w.id === args[1]);
    if (!ws) return { handled: true, card: toastCard(`❌ 未找到 workspace: ${args[1]}`, 'red') };
    ctx.store.updateSessionServer(ctx.session.id, ctx.session.server_id, ws.id);
    return {
      handled: true,
      card: toastCard(`✅ 已切换到 ${ws.name} (${ws.cwd})`, 'green'),
    };
  }

  // Show workspace list with clickable buttons
  return {
    handled: true,
    card: workspaceListCard(ctx.session.server_id, server.workspaces, ctx.session.workspace_id),
  };
}

function handlePermissionCmd(ctx: CommandContext): CommandResult {
  const mode = ctx.session?.permission_mode ?? 'bypassPermissions';
  return {
    handled: true,
    card: permissionModeCard(mode),
  };
}

function handleNewCmd(ctx: CommandContext): CommandResult {
  if (ctx.session) {
    ctx.store.updateSessionClaudeId(ctx.session.id, '');
  }
  return {
    handled: true,
    card: toastCard('✅ 下条消息将创建新的 Claude 会话', 'green'),
  };
}

function handleStopCmd(ctx: CommandContext): CommandResult {
  if (!ctx.session) {
    return { handled: true, card: toastCard('⚠️ 没有活跃 session', 'orange') };
  }
  const aborted = ctx.router.abortTask(ctx.session.id);
  return {
    handled: true,
    card: toastCard(aborted ? '✅ 已发送中断' : '⚠️ 当前没有在执行的任务', aborted ? 'green' : 'orange'),
  };
}

async function handleTestCmd(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const serverId = args[0] ?? ctx.session?.server_id;
  if (!serverId) {
    return { handled: true, card: toastCard('⚠️ 请指定服务器: /test <server_id>', 'orange') };
  }

  // Send "testing..." card first
  await ctx.feishu.replyCard(ctx.messageId, toastCard(`🔧 正在测试 ${serverId}...`, 'blue'));

  const result = await ctx.router.testServerConnection(serverId);
  if (result.ok) {
    return {
      handled: true,
      card: testResultCard(serverId, true, `Claude: ${result.version}\n${result.auth}`),
    };
  } else {
    return {
      handled: true,
      card: testResultCard(serverId, false, `错误: ${result.error}`),
    };
  }
}

function handleStatusCmd(ctx: CommandContext): CommandResult {
  const servers = ctx.router.getServers();
  return {
    handled: true,
    card: statusCard({
      serverCount: servers.length,
      servers: servers.map(s => s.id).join(', '),
      currentServer: ctx.session?.server_id,
      currentWorkspace: ctx.session?.workspace_id,
      currentPermission: ctx.session?.permission_mode,
    }),
  };
}

function handleMenuCmd(ctx: CommandContext): CommandResult {
  return {
    handled: true,
    card: menuCard(
      ctx.session?.server_id,
      ctx.session?.workspace_id,
      ctx.session?.permission_mode,
    ),
  };
}

function handleHelpCmd(): CommandResult {
  return {
    handled: true,
    card: helpCard(),
  };
}
