# Feishu × Claude Code — 飞书上的 AI 编程 IDE

## 一、目标

在飞书里通过对话指挥 Claude Code 在远程服务器上写代码，实现一个轻量级的"聊天式 IDE"。

核心体验：
- 发一条飞书消息 → Claude Code 在服务器上读文件、改代码、跑命令
- 在同一个飞书 thread 里多轮交互，保持上下文
- 需要审批时（执行命令、写文件）弹飞书卡片，点击即确认
- 支持多 workspace、多 session 并行

---

## 二、架构

```
┌──────────┐      HTTP/WS       ┌─────────────────┐     Claude Agent SDK     ┌────────────────┐
│  飞书客户端 │ ───────────────▶ │   feishu-claude   │ ─────────────────────▶ │  Claude Code    │
│  (用户)    │ ◀─────────────── │   (中间层服务)     │ ◀───────────────────── │  Agent Runtime  │
└──────────┘   消息/卡片回调     └─────────────────┘    streaming messages    └────────────────┘
                                        │                                          │
                                        │ 状态存储                                  │ 文件系统
                                        ▼                                          ▼
                                  ┌──────────┐                              ┌──────────────┐
                                  │ SQLite /  │                              │  项目代码目录   │
                                  │ 本地文件   │                              │  (workspace)   │
                                  └──────────┘                              └──────────────┘
```

### 三层：

1. **飞书接入层** — 接收消息、发送卡片、处理回调
2. **会话管理层** — session/thread 映射、审批状态、workspace 管理
3. **Claude Agent SDK 层** — 调用 SDK 执行任务，流式接收结果

---

## 三、技术选型

| 组件 | 选择 | 理由 |
|---|---|---|
| 语言 | **TypeScript** | Claude Agent SDK 原生支持；飞书 SDK 有 Node 版；开发效率高 |
| Claude 接入 | **@anthropic-ai/claude-agent-sdk** | 官方 SDK，内置 Read/Write/Edit/Bash/Grep/Glob 等工具，支持 session resume/fork，有 canUseTool 回调 |
| 飞书接入 | **@larksuiteoapi/node-sdk** | 官方 Node SDK，事件订阅 + 消息发送 + 卡片交互 |
| 存储 | **SQLite (better-sqlite3)** | 轻量，单文件，适合 session/message 映射 |
| 运行 | **Node.js 18+, systemd** | 后台常驻，配合 daemon 管理 |
| 认证 | **Anthropic API Key** 或 **Bedrock/Vertex** | SDK 原生支持多种后端 |

---

## 四、核心设计

### 4.1 消息流

```
用户发消息 → 飞书 webhook → feishu-claude 收到
  ↓
判断 session：
  - 单聊：chat_id + user_id → session
  - 群聊：chat_id + root_message_id → session（同一 thread 共享 session）
  ↓
调用 Claude Agent SDK query()：
  - 新 session → 新建 query
  - 已有 session → resume: sessionId（多轮对话）
  ↓
流式接收 SDK 消息，逐条处理：
  - AssistantMessage (文本) → 发飞书消息/更新卡片
  - ToolUse (工具调用) → 显示正在执行
  - canUseTool 回调 → 发审批卡片，等待用户点击
  - ResultMessage → 发最终结果 + token usage
```

### 4.2 Session 管理

```typescript
interface Session {
  id: string;                    // 内部 session ID
  claudeSessionId: string;       // Claude Agent SDK 的 session_id
  chatId: string;                // 飞书 chat_id
  userId: string;                // 飞书 user_id
  rootMessageId?: string;        // 群聊时的根消息 ID
  workspaceId: string;           // 关联的 workspace
  createdAt: number;
  lastActiveAt: number;
}
```

映射规则：
- **单聊**：`chatId + userId` → 唯一 session（最近活跃的）
- **群聊**：`chatId + rootMessageId` → 唯一 session（一个 thread 一个 session）
- 用户发 `/new` → 新建 session
- 用户回复旧消息 → resume 对应 session

### 4.3 审批流程（canUseTool）

Claude Agent SDK 的 `canUseTool` 回调是关键——当 Claude 要执行有风险的操作时触发。

```typescript
async function canUseTool(toolName: string, input: any, options: any) {
  // 1. 构造飞书审批卡片
  const card = buildApprovalCard(toolName, input);
  
  // 2. 发送卡片到飞书
  const messageId = await sendFeishuCard(session.chatId, card);
  
  // 3. 等待用户点击（Promise + 超时）
  const decision = await waitForApproval(messageId, timeout: 300_000);
  
  // 4. 返回结果给 SDK
  if (decision === 'allow') {
    return { type: 'allow', updatedInput: input };
  } else {
    return { type: 'deny', message: '用户拒绝了此操作' };
  }
}
```

审批卡片示例：
```
┌─────────────────────────────────────┐
│ 🔧 命令审批                          │
│                                     │
│ Claude 想要执行：                     │
│ ┌─────────────────────────────────┐ │
│ │ npm install express             │ │
│ └─────────────────────────────────┘ │
│                                     │
│ 工作目录: /home/user/my-project     │
│                                     │
│  [✅ 允许]  [❌ 拒绝]  [✅ 本次全部允许] │
└─────────────────────────────────────┘
```

### 4.4 输出策略

Claude Code 执行过程可能很长，需要合理控制飞书消息推送：

1. **任务开始** → 发一条"正在处理..."的卡片
2. **过程中** → 每 N 秒更新卡片（防抖），显示当前正在做什么
3. **工具调用** → 简要显示（"正在读取 src/auth.ts..."、"正在执行 npm test..."）
4. **最终结果** → 发最终结果卡片，包含：
   - Claude 的总结文本
   - 变更的文件列表
   - Token 用量 & 耗时
   - 操作按钮（继续对话 / 查看 diff / 下载文件）

### 4.5 Workspace 管理

```typescript
interface Workspace {
  id: string;
  name: string;
  cwd: string;                     // 工作目录路径
  model?: string;                  // 默认模型
  allowedTools?: string[];         // 允许的工具列表
  permissionMode?: string;         // 权限模式
  systemPrompt?: string;           // 附加 system prompt
}
```

配置示例：
```toml
[[workspace]]
id = "backend"
name = "后端服务"
cwd = "/home/user/backend"
model = "claude-sonnet-4-20250514"
allowed_tools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]

[[workspace]]
id = "frontend"
name = "前端项目"
cwd = "/home/user/frontend"
model = "claude-sonnet-4-20250514"
allowed_tools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
```

---

## 五、飞书 Slash 命令

| 命令 | 功能 |
|---|---|
| `/new` | 新建 session（新对话） |
| `/fork` | 分支当前 session |
| `/workspace` | 切换/列出工作区 |
| `/workspace new <name> <path>` | 新建工作区 |
| `/history` | 查看当前 session 历史 |
| `/usage` | 查看 token 用量 |
| `/stop` | 中断当前任务 |
| `/model` | 切换模型 |
| `/menu` | 打开主菜单卡片 |
| `/download <path>` | 下载工作区内文件 |
| `/status` | 查看服务状态 |
| `/help` | 命令帮助 |

---

## 六、项目结构

```
feishu-claude/
├── src/
│   ├── index.ts                 # 入口
│   ├── config.ts                # 配置加载
│   ├── feishu/
│   │   ├── client.ts            # 飞书 API 客户端
│   │   ├── events.ts            # 事件订阅处理（消息、卡片回调）
│   │   ├── cards.ts             # 卡片模板构造
│   │   └── middleware.ts        # 签名验证、去重
│   ├── claude/
│   │   ├── agent.ts             # Claude Agent SDK 封装
│   │   ├── session.ts           # Session 生命周期管理
│   │   └── tools.ts             # 工具权限 & canUseTool 处理
│   ├── core/
│   │   ├── router.ts            # 消息路由（判断 session、分发）
│   │   ├── workspace.ts         # Workspace 管理
│   │   ├── commands.ts          # Slash 命令解析 & 执行
│   │   └── output.ts            # 输出格式化 & 推送策略
│   ├── store/
│   │   ├── db.ts                # SQLite 初始化
│   │   ├── sessions.ts          # Session CRUD
│   │   ├── messages.ts          # 消息映射（飞书 msg_id ↔ session）
│   │   └── approvals.ts         # 待审批状态
│   └── utils/
│       ├── logger.ts
│       └── config-schema.ts
├── config.example.toml
├── package.json
├── tsconfig.json
└── README.md
```

---

## 七、配置文件

```toml
# config.toml

[server]
port = 9800
data_dir = ".feishu-claude-data"

[feishu]
app_id = "cli_xxx"
app_secret = "sec_xxx"
verification_token = "xxx"        # 事件订阅验证
encrypt_key = ""                  # 可选加密
allow_users = []                  # 空 = 不限制
group_at_only = true              # 群聊仅 @bot 时响应
reply_in_thread = true            # 群聊在 thread 内回复
card_enabled = true

[claude]
api_key = "sk-ant-xxx"            # Anthropic API Key
# 或者用 Bedrock/Vertex：
# use_bedrock = true
# use_vertex = true
default_model = "claude-sonnet-4-20250514"
max_turns = 50                    # 单次最大轮数
max_budget_usd = 1.0              # 单次最大花费

[[workspace]]
id = "default"
name = "Default"
cwd = "."
allowed_tools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch"]
```

---

## 八、关键实现细节

### 8.1 流式输出与卡片更新

```typescript
// claude/agent.ts
async function* runTask(session: Session, prompt: string) {
  const options: Options = {
    allowedTools: session.workspace.allowedTools,
    cwd: session.workspace.cwd,
    canUseTool: (toolName, input, opts) => handleApproval(session, toolName, input),
    ...(session.claudeSessionId 
      ? { resume: session.claudeSessionId }
      : {}),
  };

  for await (const message of query({ prompt, options })) {
    yield message;  // 转发给输出层处理
    
    // 捕获 session ID
    if (message.type === 'system' && message.subtype === 'init') {
      session.claudeSessionId = message.session_id;
      await saveSession(session);
    }
  }
}
```

### 8.2 卡片防抖更新

飞书更新卡片有频率限制，需要防抖：

```typescript
// core/output.ts
class OutputManager {
  private pendingUpdate: string = '';
  private timer: NodeJS.Timeout | null = null;
  private cardMessageId: string | null = null;
  
  async update(content: string) {
    this.pendingUpdate = content;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 2000); // 2秒防抖
    }
  }
  
  private async flush() {
    this.timer = null;
    if (this.cardMessageId) {
      await updateFeishuCard(this.cardMessageId, this.pendingUpdate);
    }
  }
}
```

### 8.3 权限模式

三种模式供用户选择：

| 模式 | 行为 |
|---|---|
| `ask-every` | 每次工具调用都弹审批（最安全） |
| `accept-edits` | 读操作自动通过，写/执行需审批 |
| `yolo` | 全部自动通过（仅限信任环境） |

```typescript
// 实现：在 canUseTool 中根据模式判断
const readOnlyTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

if (permissionMode === 'accept-edits' && readOnlyTools.includes(toolName)) {
  return { type: 'allow', updatedInput: input };
}
if (permissionMode === 'yolo') {
  return { type: 'allow', updatedInput: input };
}
// 否则弹审批卡片
```

---

## 九、与 Feidex 的对比

| 方面 | Feidex (Codex) | 本项目 (Claude Code) |
|---|---|---|
| 底层引擎 | OpenAI Codex App Server | Claude Agent SDK |
| 接入方式 | stdio / WebSocket RPC | SDK 函数调用（进程内） |
| 语言 | Go | TypeScript |
| Session 管理 | 自己维护 thread/turn | SDK 内置 session resume/fork |
| 审批 | 自己解析 Codex 请求 | SDK canUseTool 回调 |
| 优势 | 成熟、功能全 | SDK 原生集成更深、代码量更少 |

最大的区别：Claude Agent SDK 把 agent loop、工具执行、session 管理全包了，我们只需要做"飞书 ↔ SDK"的桥接。比 Feidex 需要自己实现 RPC 客户端简单得多。

---

## 十、开发计划

### Phase 1 — MVP（~1 周）
- [ ] 飞书 Bot 接入（消息收发）
- [ ] Claude Agent SDK 基础调用（单轮）
- [ ] Session 管理（单聊多轮）
- [ ] 基础审批卡片（Bash / Write / Edit）
- [ ] 基础输出（结果文本发送）

### Phase 2 — 可用（~1 周）
- [ ] 群聊支持（thread 内 session）
- [ ] Workspace 管理
- [ ] Slash 命令（/new /stop /workspace /usage）
- [ ] 流式输出 + 卡片更新
- [ ] Token 用量统计

### Phase 3 — 好用（~1 周）
- [ ] 菜单卡片（导航式 UI）
- [ ] 文件下载分享
- [ ] 权限模式选择
- [ ] Session fork
- [ ] daemon 模式 + 自动重启

### Phase 4 — 锦上添花
- [ ] 多模型切换
- [ ] MCP Server 集成
- [ ] 图片/截图输入
- [ ] diff 可视化卡片
- [ ] 自升级机制

---

## 十一、快速开始（开发）

```bash
# 1. 初始化项目
mkdir feishu-claude && cd feishu-claude
npm init -y
npm install @anthropic-ai/claude-agent-sdk @larksuiteoapi/node-sdk better-sqlite3 toml
npm install -D typescript @types/node @types/better-sqlite3 tsx

# 2. 配置
cp config.example.toml config.toml
# 填入飞书 app_id/app_secret 和 Anthropic API key

# 3. 开发运行
npx tsx src/index.ts

# 4. 部署
npx tsc
node dist/index.js serve --config config.toml
```
