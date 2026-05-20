# feicc

[![CI](https://github.com/xuwei1231231/feicc/actions/workflows/ci.yml/badge.svg)](https://github.com/xuwei1231231/feicc/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

飞书 × Claude Code — 在飞书对话中操控远程服务器上的 Claude Code。

> feicc = **Fei**shu + **C**laude **C**ode
>
> ⚠️ **状态**：早期项目（v0.1.x），核心功能可用，欢迎试用反馈。

## 它是什么

feicc 是一个飞书机器人，让你在飞书聊天中直接与远程服务器上的 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 交互。发一句话，Claude 就在远程服务器上读代码、改文件、跑命令——结果实时显示在飞书卡片里。

**适合的场景：**
- 手机/平板上随时写代码、排查问题
- 团队共享 Claude Code 开发环境
- 用飞书作为 IDE 的交互入口

## 功能

- 🖥️ **多服务器管理** — 配置多台远程服务器，随时切换
- 📁 **工作区切换** — 每台服务器多个工作目录
- 🛡️ **权限模式** — YOLO（全自动）/ 接受编辑 / 仅规划 三档
- 💬 **飞书交互卡片** — 所有操作按钮可点击，表单可填写
- 🔑 **PEM 密钥上传** — 直接在飞书拖文件上传 SSH 密钥
- ⚡ **实时进度** — Claude 执行过程中实时更新卡片
- 📊 **用量统计** — 每次任务显示 token 消耗和费用
- 🔄 **Session 管理** — 自动关联对话上下文，支持续聊

## 架构

```
飞书客户端 ──WebSocket──▶ feicc Hub ──SSH──▶ 远程服务器 (claude CLI)
                                              └── 操作项目文件
```

feicc 通过飞书 WebSocket 长连接接收消息和卡片回调（不需要公网 IP），然后通过 SSH 连接远程服务器执行 `claude` CLI 命令。

## 快速开始

> 📖 详细的分步部署指南请看 [docs/deploy.md](docs/deploy.md)

### 前置条件

- Node.js >= 18
- 远程服务器已安装 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- 远程服务器可通过 SSH 访问
- 飞书开放平台应用（见下方配置）

### 1. 安装

```bash
git clone https://github.com/xuwei1231231/feicc.git
cd feicc
npm install
```

### 2. 配置飞书应用

1. 登录 [飞书开放平台](https://open.feishu.cn/)，创建一个**企业自建应用**
2. 开启 **机器人** 能力
3. 添加权限：
   - `im:message` — 读取消息
   - `im:message:send_as_bot` — 以机器人身份发消息
   - `im:resource` — 读取消息中的文件（用于 PEM 上传）
4. 进入 **事件与回调**：
   - 订阅方式选择 **使用长连接接收事件/回调**
   - 添加事件：`im.message.receive_v1`
   - 添加回调：`card.action.trigger`
5. 发布应用

### 3. 配置飞书连接

```bash
cp config.example.toml config.toml
```

编辑 `config.toml`，只需填飞书应用信息：

```toml
[feishu]
app_id = "cli_your_app_id"
app_secret = "your_app_secret"
```

> **远程服务器不用在这里配。** 启动后可以在飞书里通过 `/server` → 「添加服务器」表单添加，并直接上传 SSH 密钥文件。
> 当然你也可以直接在 `config.toml` 里配置 `[[remote]]` 块，见 `config.example.toml`。

### 4. 启动

```bash
# 开发模式
npm run dev

# 或后台运行
screen -dmS feicc bash -c 'npm run dev'
```

看到以下输出即为成功：
```
[feicc] WebSocket connected ✅
[feicc] ready — interactive cards via WebSocket 🎯
```

### 5. 添加远程服务器

确保远程服务器上已安装并登录 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)：

```bash
ssh ubuntu@your-server.com
claude --version   # 确认已安装
claude auth status # 确认已登录
```

然后在飞书中：
1. 发送 `/server` → 点击 **➕ 添加服务器**
2. 填写服务器信息（ID、名称、主机地址、用户名）
3. 提交后上传 SSH 密钥文件（直接拖 `.pem` 文件到对话框）

也可以直接编辑 `config.toml` 添加 `[[remote]]` 块。

### 6. 使用

在飞书中找到你的机器人，发送 `/menu` 打开主菜单，或直接发消息开始对话。

## 飞书命令

| 命令 | 功能 |
|---|---|
| `/menu` | 主菜单（推荐入口） |
| `/server` | 查看/切换/添加服务器 |
| `/ws` | 查看/切换/添加工作区 |
| `/perm` | 切换权限模式 |
| `/new` | 新建 Claude 会话 |
| `/stop` | 中断当前任务 |
| `/test [id]` | 测试服务器连接 |
| `/status` | 系统状态 |
| `/help` | 帮助 |

也可以通过卡片上的按钮操作，不用记命令。

## 权限模式

| 模式 | 说明 |
|---|---|
| 🟢 全自动 (YOLO) | 所有操作自动通过，最快 |
| 🟡 接受编辑 | 读操作自动通过，写/执行需审批 |
| 🔴 仅规划 | 只看方案不执行，最安全 |

## 动态添加服务器

除了编辑 `config.toml`，你还可以直接在飞书中添加：

1. 发送 `/server` → 点击 **➕ 添加服务器**
2. 填写表单（ID、名称、主机、用户名）
3. 提交后上传 SSH 密钥文件（直接拖 `.pem` 文件到对话框）
4. 自动保存配置，立即可用

## 项目结构

```
feicc/
├── src/
│   ├── index.ts           # 入口，WebSocket 连接
│   ├── config.ts          # 配置加载与动态写入
│   ├── feishu/
│   │   ├── client.ts      # 飞书 API 封装
│   │   └── cards.ts       # 交互卡片构建
│   ├── core/
│   │   ├── router.ts      # 消息路由 + 按钮动作处理
│   │   ├── commands.ts    # 斜杠命令解析
│   │   └── output.ts      # 防抖卡片更新
│   ├── claude/
│   │   └── executor.ts    # SSH 远程执行 claude CLI
│   ├── mcp/
│   │   └── permission-server.ts  # MCP 权限服务（飞书逐项审批）
│   └── store/
│       └── db.ts          # SQLite 存储
├── test/
│   ├── cards.test.ts      # 卡片构建测试
│   └── fixes.test.ts      # 修复回归测试
├── docs/
│   ├── deploy.md          # 部署指南
│   └── design.md          # 设计文档
├── config.example.toml    # 配置模板
├── package.json
├── tsconfig.json
├── LICENSE
└── README.md
```

## 开发

```bash
# 安装依赖
npm install

# 开发运行
npm run dev

# 类型检查
npx tsc --noEmit

# 运行测试
npm test

# 构建
npm run build
```

## 常见问题

### 飞书里看不到机器人

确认应用已发布，并且你在应用的可用范围内。

### 按钮点击没反应

确认在飞书开发者后台 → 事件与回调 → 已添加 `card.action.trigger` 回调。

### Claude CLI 报错

SSH 到远程服务器检查：
```bash
claude --version   # 确认安装
claude auth status # 确认登录状态
```

### SSH 连接失败

确认密钥权限（需要 600）和服务器地址/用户名是否正确。feicc 会自动设置上传密钥的权限。

## License

[MIT](LICENSE)
