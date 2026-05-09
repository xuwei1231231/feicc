# feicc 部署指南

从零开始部署 feicc，大约需要 10 分钟。

## 前置条件

| 项目 | 要求 |
|---|---|
| Hub 机器 | 任意能联网的机器（无需公网 IP） |
| Node.js | >= 18 |
| 远程服务器 | 已安装 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 并完成登录 |
| SSH 访问 | Hub 机器能 SSH 到远程服务器（有私钥） |
| 飞书 | 企业自建应用（免费创建） |

## 第一步：创建飞书应用

1. 打开 [飞书开放平台](https://open.feishu.cn/)，登录后点击 **创建应用** → **企业自建应用**
2. 填写应用名称（如 `feicc`）和描述
3. 进入应用详情页，记录 **App ID** 和 **App Secret**

### 开启机器人能力

应用详情 → **添加应用能力** → 开启 **机器人**

### 添加权限

应用详情 → **权限管理** → 搜索并开通：

| 权限 | 说明 |
|---|---|
| `im:message` | 读取消息 |
| `im:message:send_as_bot` | 发送消息 |
| `im:resource` | 读取消息中的文件（用于上传 SSH 密钥） |

### 配置事件与回调

应用详情 → **事件与回调**：

1. **订阅方式**：选择 **使用长连接接收事件/回调**（重要！不需要配置回调 URL）
2. **添加事件**：搜索并添加 `im.message.receive_v1`（接收消息）
3. **添加回调**：搜索并添加 `card.action.trigger`（卡片按钮点击）

### 发布应用

配置完成后，在 **版本管理与发布** 中创建版本并发布。发布后应用才能使用。

## 第二步：安装 feicc

```bash
git clone https://github.com/user/feicc.git
cd feicc
npm install
```

## 第三步：配置

```bash
cp config.example.toml config.toml
```

编辑 `config.toml`，填入飞书应用信息：

```toml
[server]
data_dir = ".feicc-data"

[feishu]
app_id = "cli_your_app_id"       # ← 替换
app_secret = "your_app_secret"   # ← 替换
```

> **只需要配飞书连接信息。** 远程服务器可以启动后在飞书里添加。

如果你想直接在配置文件里添加服务器，也可以：

```toml
[[remote]]
id = "my-server"
name = "我的服务器"
host = "1.2.3.4"
user = "ubuntu"
key = "/path/to/key.pem"
default_workspace = "home"

  [[remote.workspace]]
  id = "home"
  name = "Home"
  cwd = "/home/ubuntu"
```

## 第四步：启动

```bash
# 前台运行（看日志）
npm run dev

# 或后台运行
screen -dmS feicc bash -c 'npm run dev'
```

看到以下输出说明启动成功：

```
[feicc] WebSocket connected ✅
[feicc] ready — interactive cards via WebSocket 🎯
```

## 第五步：添加远程服务器

### 方式一：在飞书里添加（推荐）

1. 在飞书中找到你的机器人，发送 `/server`
2. 点击 **➕ 添加服务器**
3. 填写表单：
   - **服务器 ID**：唯一标识，如 `gpu0`
   - **名称**：显示名称，如 `GPU 实例`
   - **SSH 主机地址**：如 `1.2.3.4` 或域名
   - **SSH 用户名**：如 `ubuntu`
   - **SSH 密钥**：留空
4. 提交后，直接在对话中拖拽上传 `.pem` 密钥文件
5. 完成！点击服务器名称即可切换

### 方式二：编辑配置文件

参考第三步中的 `[[remote]]` 配置块。

### 确认远程服务器就绪

无论哪种方式，远程服务器上需要：

```bash
# SSH 到远程服务器
ssh ubuntu@your-server

# 确认 Claude Code 已安装
claude --version

# 确认已登录
claude auth status
```

如果未安装，参考 [Claude Code 安装文档](https://docs.anthropic.com/en/docs/claude-code)。

## 第六步：开始使用

在飞书中：

- 发送 `/menu` — 打开主菜单
- 直接发送消息 — 与 Claude Code 对话
- 发送 `/help` — 查看所有命令

## 常见问题

### Q: 需要公网 IP 吗？

**不需要。** feicc 通过飞书 WebSocket 长连接通信，只要能访问外网即可。

### Q: 按钮点了没反应？

检查飞书开发者后台 → 事件与回调 → 是否添加了 `card.action.trigger` 回调。

### Q: 连接服务器失败？

1. 检查 SSH 密钥文件权限（需要 `chmod 600`）
2. 在飞书中发送 `/test` 测试连接
3. 手动 SSH 验证：`ssh -i key.pem user@host`

### Q: Claude CLI 报错？

SSH 到远程服务器检查：
```bash
claude --version     # 确认安装
claude auth status   # 确认登录
claude auth login    # 如需重新登录
```

### Q: 支持群聊吗？

支持。默认需要 @机器人 才会响应（`group_at_only = true`）。

### Q: 如何升级？

```bash
git pull
npm install
# 重启服务
```

`config.toml` 和 `.feicc-data/` 不受影响。
