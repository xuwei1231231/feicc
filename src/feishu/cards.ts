// Feishu interactive card builders — rich interactive UI with buttons

// ─── Action value helpers ───

function actionValue(action: string, extra?: Record<string, any>): Record<string, any> {
  return { action, ...extra };
}

// ─── Progress / Status Cards ───

export function progressCard(serverId: string, tools: string[], text: string) {
  const toolLines = tools.length > 0
    ? tools.map(t => `${t}`).join('\n')
    : '⏳ 等待 Claude 响应...';

  const elements: any[] = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: toolLines },
    },
  ];

  if (text) {
    const displayText = text.length > 1500 ? text.slice(-1500) + '\n...(已截断)' : text;
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: displayText },
    });
  }

  // Stop button during execution
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '⏹ 中断任务' },
        type: 'danger',
        value: actionValue('stop'),
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `⚡ Claude 正在处理... [${serverId}]` },
      template: 'blue',
    },
    elements,
  };
}

export function doneCard(
  serverId: string,
  workspaceId: string,
  result: string,
  cost: number,
  usage: any,
  durationMs: number,
) {
  const durationStr = durationMs < 60000
    ? `${(durationMs / 1000).toFixed(0)}s`
    : `${(durationMs / 60000).toFixed(1)}m`;

  const inputTokens = usage?.input_tokens ?? usage?.inputTokens ?? '?';
  const outputTokens = usage?.output_tokens ?? usage?.outputTokens ?? '?';
  const cacheRead = usage?.cache_read_input_tokens ?? '';
  const cacheInfo = cacheRead ? ` 💾 cache ${cacheRead}` : '';

  const displayResult = result.length > 2000
    ? result.slice(0, 2000) + '\n...(已截断)'
    : result;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: `✅ 完成 [${serverId}/${workspaceId}] ⏱${durationStr}`,
      },
      template: 'green',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: displayResult },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `💰 $${cost.toFixed(4)}  📥 ${inputTokens}  📤 ${outputTokens}${cacheInfo}`,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 继续对话' },
            type: 'primary',
            value: actionValue('continue'),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🆕 新会话' },
            type: 'default',
            value: actionValue('new_session'),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📊 用量详情' },
            type: 'default',
            value: actionValue('usage'),
          },
        ],
      },
    ],
  };
}

export function errorCard(serverId: string, error: string) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `❌ 失败 [${serverId}]` },
      template: 'red',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: error.slice(0, 1000) },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 重试' },
            type: 'primary',
            value: actionValue('retry'),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔧 测试连接' },
            type: 'default',
            value: actionValue('test_server', { serverId }),
          },
        ],
      },
    ],
  };
}

export function authErrorCard(serverId: string, host: string, error: string) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🔑 登录失效 [${serverId}]` },
      template: 'orange',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `服务器 **${serverId}** (${host}) 上的 Claude Code 需要重新登录。\n\n` +
            `请 SSH 到服务器执行：\n\`\`\`\nclaude auth login\n\`\`\`\n\n` +
            `错误信息: ${error.slice(0, 300)}`,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔧 重新测试' },
            type: 'primary',
            value: actionValue('test_server', { serverId }),
          },
        ],
      },
    ],
  };
}

// ─── Server List Card (clickable) ───

export function serverListCard(
  servers: { id: string; name: string; status: string; host: string; workspaces: string[] }[],
  currentServerId?: string,
) {
  const elements: any[] = [];

  if (servers.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '⚠️ 没有配置服务器，请编辑 config.toml 添加。' },
    });
  } else {
    for (const s of servers) {
      const isCurrent = s.id === currentServerId;
      const statusIcon = s.status === 'online' ? '🟢' : (s.status === 'auth_error' ? '🟡' : '⚪');
      const currentBadge = isCurrent ? '  ✅ 当前' : '';
      const ws = s.workspaces.length > 0 ? s.workspaces.join(' / ') : '(无工作区)';

      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${statusIcon} **${s.id}** — ${s.name} (${s.host})${currentBadge}\n　　📁 ${ws}`,
        },
      });
    }

    elements.push({ tag: 'hr' });

    // Button row: each server is a clickable button
    const buttons = servers.map(s => ({
      tag: 'button',
      text: { tag: 'plain_text', content: s.id === currentServerId ? `✅ ${s.id}` : `🖥️ ${s.id}` },
      type: s.id === currentServerId ? 'primary' : 'default',
      value: actionValue('select_server', { serverId: s.id }),
    }));

    // Add test-all button
    buttons.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '🔧 测试全部' },
      type: 'default' as any,
      value: actionValue('test_all_servers'),
    });

    elements.push({ tag: 'action', actions: buttons });
  }

  // Add server button (always show)
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '➕ 添加服务器' },
        type: 'default',
        value: actionValue('show_add_server'),
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🖥️ 选择服务器' },
      template: 'purple',
    },
    elements,
  };
}

// ─── Workspace List Card (clickable) ───

export function workspaceListCard(
  serverId: string,
  workspaces: { id: string; name: string; cwd: string }[],
  currentWorkspaceId?: string,
) {
  const elements: any[] = [];

  if (workspaces.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '⚠️ 该服务器没有配置工作区。' },
    });
  } else {
    for (const ws of workspaces) {
      const isCurrent = ws.id === currentWorkspaceId;
      const badge = isCurrent ? '  ✅ 当前' : '';
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `📁 **${ws.id}** — ${ws.name}${badge}\n　　\`${ws.cwd}\``,
        },
      });
    }

    elements.push({ tag: 'hr' });

    const buttons = workspaces.map(ws => ({
      tag: 'button',
      text: { tag: 'plain_text', content: ws.id === currentWorkspaceId ? `✅ ${ws.id}` : `📁 ${ws.id}` },
      type: ws.id === currentWorkspaceId ? 'primary' : 'default',
      value: actionValue('select_workspace', { serverId, workspaceId: ws.id }),
    }));

    elements.push({ tag: 'action', actions: buttons });
  }

  // Add workspace button (always show)
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '➕ 添加工作区' },
        type: 'default',
        value: actionValue('show_add_workspace', { serverId }),
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📁 工作区 [${serverId}]` },
      template: 'turquoise',
    },
    elements,
  };
}

// ─── Permission Mode Card (clickable) ───

export function permissionModeCard(currentMode: string) {
  const modes = [
    { id: 'bypassPermissions', label: '🟢 全自动 (YOLO)', desc: '所有操作自动通过，最快' },
    { id: 'acceptEdits', label: '🟡 接受编辑', desc: '读操作自动通过，写/执行需审批' },
    { id: 'askFeishu', label: '🙋 飞书逐项审批', desc: '每个工具调用都发卡片到飞书，点按钮决定' },
    { id: 'plan', label: '🔴 仅规划', desc: '只看方案不执行，最安全' },
  ];

  const elements: any[] = modes.map(m => ({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `${m.id === currentMode ? '👉 ' : ''}**${m.label}**\n　　${m.desc}`,
    },
  }));

  elements.push({ tag: 'hr' });

  const buttons = modes.map(m => ({
    tag: 'button',
    text: { tag: 'plain_text', content: m.id === currentMode ? `✅ ${m.label}` : m.label },
    type: m.id === currentMode ? 'primary' : 'default',
    value: actionValue('set_permission', { mode: m.id }),
  }));

  elements.push({ tag: 'action', actions: buttons });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🛡️ 权限模式' },
      template: 'indigo',
    },
    elements,
  };
}

// ─── Main Menu Card ───

export function menuCard(
  currentServer?: string,
  currentWorkspace?: string,
  currentPermission?: string,
) {
  const statusLine = currentServer
    ? `当前: **${currentServer}** / ${currentWorkspace ?? '-'}  |  权限: ${currentPermission ?? '-'}`
    : '尚未开始对话';

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '⚡ Feicc 主菜单' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: statusLine },
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🖥️ 服务器' },
            type: 'default',
            value: actionValue('show_servers'),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📁 工作区' },
            type: 'default',
            value: actionValue('show_workspaces'),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🛡️ 权限模式' },
            type: 'default',
            value: actionValue('show_permissions'),
          },
        ],
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🆕 新会话' },
            type: 'primary',
            value: actionValue('new_session'),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔧 测试连接' },
            type: 'default',
            value: actionValue('test_current_server'),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📊 系统状态' },
            type: 'default',
            value: actionValue('show_status'),
          },
        ],
      },
    ],
  };
}

// ─── Help Card ───

export function helpCard() {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '❓ Feicc 使用帮助' },
      template: 'grey',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            '**直接发消息** → 与 Claude Code 对话\n' +
            '**回复消息** → 在同一 session 中继续\n\n' +
            '**快捷命令：**\n' +
            '`/menu` — 打开主菜单\n' +
            '`/server` — 选择服务器\n' +
            '`/ws` — 选择工作区\n' +
            '`/perm` — 权限模式\n' +
            '`/new` — 新建会话\n' +
            '`/stop` — 中断任务\n' +
            '`/test` — 测试连接\n' +
            '`/status` — 系统状态',
        },
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📋 打开菜单' },
            type: 'primary',
            value: actionValue('show_menu'),
          },
        ],
      },
    ],
  };
}

// ─── Status Card ───

export function statusCard(info: {
  serverCount: number;
  servers: string;
  currentServer?: string;
  currentWorkspace?: string;
  currentPermission?: string;
  uptime?: string;
}) {
  const lines = [
    `🖥️ 服务器: ${info.serverCount} 台 (${info.servers})`,
    info.currentServer
      ? `📍 当前: **${info.currentServer}** / ${info.currentWorkspace ?? '-'}`
      : '📍 无活跃 session',
    info.currentPermission ? `🛡️ 权限: ${info.currentPermission}` : '',
    info.uptime ? `⏱️ 运行时间: ${info.uptime}` : '',
  ].filter(Boolean).join('\n');

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📊 系统状态' },
      template: 'violet',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: lines },
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔧 测试全部服务器' },
            type: 'default',
            value: actionValue('test_all_servers'),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📋 主菜单' },
            type: 'default',
            value: actionValue('show_menu'),
          },
        ],
      },
    ],
  };
}

// ─── Test Result Card ───

export function testResultCard(serverId: string, ok: boolean, details: string) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${ok ? '✅' : '❌'} 测试 [${serverId}]` },
      template: ok ? 'green' : 'red',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: details },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 重新测试' },
            type: 'default',
            value: actionValue('test_server', { serverId }),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: ok ? '🖥️ 使用此服务器' : '📋 返回菜单' },
            type: 'primary',
            value: ok ? actionValue('select_server', { serverId }) : actionValue('show_menu'),
          },
        ],
      },
    ],
  };
}

// ─── Confirmation Card (generic) ───

export function confirmCard(title: string, message: string, confirmAction: string, extra?: Record<string, any>) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'orange',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: message },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 确认' },
            type: 'primary',
            value: actionValue(confirmAction, extra),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 取消' },
            type: 'danger',
            value: actionValue('dismiss'),
          },
        ],
      },
    ],
  };
}

// ─── Add Server Form Card ───

export function addServerFormCard() {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '➕ 添加服务器' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'form',
        name: 'add_server_form',
        elements: [
          {
            tag: 'input',
            name: 'server_id',
            required: true,
            placeholder: { tag: 'plain_text', content: '例如: gpu0' },
            label: { tag: 'plain_text', content: '服务器 ID（唯一标识）' },
            label_position: 'top',
            width: 'fill',
            max_length: 50,
          },
          {
            tag: 'input',
            name: 'server_name',
            required: true,
            placeholder: { tag: 'plain_text', content: '例如: GPU 实例' },
            label: { tag: 'plain_text', content: '名称' },
            label_position: 'top',
            width: 'fill',
            max_length: 100,
          },
          {
            tag: 'input',
            name: 'server_host',
            required: true,
            placeholder: { tag: 'plain_text', content: '例如: ec2-xx-xx.compute-1.amazonaws.com' },
            label: { tag: 'plain_text', content: 'SSH 主机地址' },
            label_position: 'top',
            width: 'fill',
            max_length: 200,
          },
          {
            tag: 'input',
            name: 'server_user',
            placeholder: { tag: 'plain_text', content: '默认: ubuntu' },
            default_value: 'ubuntu',
            label: { tag: 'plain_text', content: 'SSH 用户名' },
            label_position: 'top',
            width: 'fill',
            max_length: 50,
          },
          {
            tag: 'input',
            name: 'server_key',
            placeholder: { tag: 'plain_text', content: '留空则提交后上传 PEM 文件，或填本地路径' },
            label: { tag: 'plain_text', content: 'SSH 私钥（可选，提交后可上传 PEM 文件）' },
            label_position: 'top',
            width: 'fill',
            max_length: 300,
          },
          {
            tag: 'input',
            name: 'workspace_cwd',
            placeholder: { tag: 'plain_text', content: '默认: /home/ubuntu' },
            default_value: '/home/ubuntu',
            label: { tag: 'plain_text', content: '默认工作目录' },
            label_position: 'top',
            width: 'fill',
            max_length: 300,
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 添加服务器' },
            type: 'primary',
            action_type: 'form_submit',
            name: 'submit_add_server',
            value: actionValue('submit_add_server'),
          },
        ],
      },
    ],
  };
}

// ─── Add Workspace Form Card ───

export function addWorkspaceFormCard(serverId: string) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `➕ 添加工作区 [${serverId}]` },
      template: 'turquoise',
    },
    elements: [
      {
        tag: 'form',
        name: 'add_workspace_form',
        elements: [
          {
            tag: 'input',
            name: 'workspace_id',
            required: true,
            placeholder: { tag: 'plain_text', content: '例如: backend' },
            label: { tag: 'plain_text', content: '工作区 ID' },
            label_position: 'top',
            width: 'fill',
            max_length: 50,
          },
          {
            tag: 'input',
            name: 'workspace_name',
            required: true,
            placeholder: { tag: 'plain_text', content: '例如: 后端服务' },
            label: { tag: 'plain_text', content: '名称' },
            label_position: 'top',
            width: 'fill',
            max_length: 100,
          },
          {
            tag: 'input',
            name: 'workspace_cwd',
            required: true,
            placeholder: { tag: 'plain_text', content: '例如: /home/ubuntu/my-project' },
            label: { tag: 'plain_text', content: '工作目录' },
            label_position: 'top',
            width: 'fill',
            max_length: 300,
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 添加工作区' },
            type: 'primary',
            action_type: 'form_submit',
            name: 'submit_add_workspace',
            value: actionValue('submit_add_workspace', { serverId }),
          },
        ],
      },
    ],
  };
}

// ─── Usage Detail Card ───

export function usageCard(data: {
  period: string;
  taskCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
  recentTasks: { server_id: string; input_tokens: number; output_tokens: number; cost_usd: number; duration_ms: number; created_at: number }[];
}) {
  const durationMin = (data.totalDurationMs / 60000).toFixed(1);
  const cacheInfo = data.totalCacheReadTokens > 0 ? `\n💾 缓存读取: ${fmtTokens(data.totalCacheReadTokens)}` : '';

  const summaryLines = [
    `📊 **${data.period}**`,
    ``,
    `🔢 任务次数: **${data.taskCount}**`,
    `📥 输入 tokens: **${fmtTokens(data.totalInputTokens)}**`,
    `📤 输出 tokens: **${fmtTokens(data.totalOutputTokens)}**${cacheInfo}`,
    `💰 总费用: **$${data.totalCostUsd.toFixed(4)}**`,
    `⏱ 总耗时: **${durationMin} 分钟**`,
  ].join('\n');

  const elements: any[] = [
    { tag: 'div', text: { tag: 'lark_md', content: summaryLines } },
  ];

  // Recent tasks
  if (data.recentTasks.length > 0) {
    elements.push({ tag: 'hr' });
    const taskLines = data.recentTasks.map(t => {
      const time = new Date(t.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' });
      const dur = t.duration_ms < 60000 ? `${(t.duration_ms / 1000).toFixed(0)}s` : `${(t.duration_ms / 60000).toFixed(1)}m`;
      return `${time}  **${t.server_id}**  📥${fmtTokens(t.input_tokens)} 📤${fmtTokens(t.output_tokens)}  $${t.cost_usd.toFixed(4)}  ⏱${dur}`;
    }).join('\n');

    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**最近任务：**\n${taskLines}` },
    });
  }

  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '📊 最近 7 天' },
        type: 'default',
        value: actionValue('usage_period', { days: 7 }),
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '📊 最近 30 天' },
        type: 'default',
        value: actionValue('usage_period', { days: 30 }),
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '📋 返回菜单' },
        type: 'default',
        value: actionValue('show_menu'),
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📊 用量详情' },
      template: 'violet',
    },
    elements,
  };
}

function fmtTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

// ─── Upload Key Prompt Card ───

export function uploadKeyPromptCard(serverId: string) {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🔑 上传 SSH 密钥 [${serverId}]` },
      template: 'orange',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `服务器 **${serverId}** 需要 SSH 私钥文件。\n\n请直接在对话中发送 **.pem** 文件（拖拽或点击附件上传）。`,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '⏭ 跳过（稍后配置）' },
            type: 'default',
            value: actionValue('skip_key_upload', { serverId }),
          },
        ],
      },
    ],
  };
}

// ─── Toast / Quick Feedback Card ───

export function toastCard(message: string, template: string = 'green') {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: message },
      template,
    },
    elements: [],
  };
}

// ─── Permission Approval Card (MCP ask_feishu) ───

/**
 * Pretty-print tool input for the approval card.
 * Keeps it compact (truncates long strings) and highlights the common fields.
 */
function summarizeToolInput(toolName: string, input: Record<string, any>): string {
  const TRUNC = 400;
  const lines: string[] = [];

  const push = (label: string, val: unknown) => {
    if (val === undefined || val === null) return;
    let s = typeof val === 'string' ? val : JSON.stringify(val);
    if (s.length > TRUNC) s = s.slice(0, TRUNC) + '…';
    // Escape backticks for lark_md
    s = s.replace(/`/g, '\u200b`');
    lines.push(`**${label}:** \`${s}\``);
  };

  switch (toolName) {
    case 'Bash':
      push('command', input.command);
      if (input.description) push('desc', input.description);
      if (input.timeout) push('timeout', `${input.timeout}ms`);
      break;
    case 'Write':
      push('file', input.file_path);
      if (typeof input.content === 'string') {
        const preview = input.content.length > 600
          ? input.content.slice(0, 600) + '\n…(truncated)'
          : input.content;
        lines.push('**content:**');
        lines.push('```\n' + preview + '\n```');
      }
      break;
    case 'Edit':
    case 'MultiEdit':
      push('file', input.file_path);
      if (input.old_string) push('old_string', String(input.old_string).slice(0, 200));
      if (input.new_string) push('new_string', String(input.new_string).slice(0, 200));
      if (Array.isArray(input.edits)) push('edits', `${input.edits.length} chunk(s)`);
      break;
    case 'Read':
      push('file', input.file_path);
      if (input.offset || input.limit) push('range', `offset=${input.offset ?? 0} limit=${input.limit ?? 'all'}`);
      break;
    case 'WebFetch':
      push('url', input.url);
      if (input.prompt) push('prompt', input.prompt);
      break;
    case 'WebSearch':
      push('query', input.query);
      break;
    default: {
      // Generic: dump all fields as JSON
      for (const [k, v] of Object.entries(input)) push(k, v);
      break;
    }
  }

  return lines.join('\n');
}

export function approvalCard(
  approvalId: string,
  toolName: string,
  input: Record<string, any>,
): any {
  const summary = summarizeToolInput(toolName, input);

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `⚠️ Claude 请求使用工具: ${toolName}` },
      template: 'orange',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: summary || '(无参数)' },
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 允许' },
            type: 'primary',
            value: actionValue('approval_decide', { approvalId, decision: 'allow' }),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            value: actionValue('approval_decide', { approvalId, decision: 'deny' }),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: `🔓 本次会话全部允许 ${toolName}` },
            type: 'default',
            value: actionValue('approval_decide', { approvalId, decision: 'allow_tool_session' }),
          },
        ],
      },
    ],
  };
}

/** Card shown after a decision is made (replaces the interactive one). */
export function approvalResolvedCard(
  toolName: string,
  decision: 'allow' | 'deny' | 'allow_tool_session' | 'timeout',
  operator?: string,
): any {
  const headers: Record<string, { title: string; template: string }> = {
    allow:               { title: `✅ 已允许 ${toolName}`,              template: 'green' },
    allow_tool_session:  { title: `🔓 已允许本会话全部 ${toolName}`,     template: 'green' },
    deny:                { title: `❌ 已拒绝 ${toolName}`,              template: 'red' },
    timeout:             { title: `⏱️ 审批超时（已自动拒绝 ${toolName}）`, template: 'grey' },
  };
  const h = headers[decision] ?? headers.deny;
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: h.title },
      template: h.template,
    },
    elements: operator
      ? [{ tag: 'div', text: { tag: 'lark_md', content: `由 <at id=${operator}></at> 决定` } }]
      : [],
  };
}
