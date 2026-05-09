// Hub entry point — WebSocket long connection for both events & card callbacks

import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from './config.js';
import { Store } from './store/db.js';
import { FeishuClient } from './feishu/client.js';
import { Router } from './core/router.js';
import { startPermissionServer } from './mcp/permission-server.js';

const configPath = process.argv[2] ?? 'config.toml';
const config = loadConfig(configPath);

console.log('[feicc] Feishu × Claude Code IDE starting...');
console.log(`[feicc] feishu app: ${config.feishu.app_id}`);
console.log(`[feicc] servers: ${config.remotes.map(r => `${r.id}(${r.host})`).join(', ')}`);

// Initialize store
const store = new Store(config.server.data_dir);
console.log('[feicc] database ready');

// Initialize Feishu client (for sending messages)
const feishu = new FeishuClient(config.feishu);

// Initialize router
const router = new Router(feishu, store, config);

// Start MCP permission server (fails-open: if it can't bind, ask_feishu mode
// won't work but other modes are unaffected).
const mcpPort = Number(process.env.FEICC_MCP_PORT ?? 48808);
startPermissionServer({
  port: mcpPort,
  onRequest: () => { /* replaced by router.attachPermissionHub */ },
  timeoutMs: 5 * 60_000,
})
  .then((handle) => {
    router.attachPermissionHub(handle.hub, handle.port);
  })
  .catch((err) => {
    console.error(`[mcp] failed to start permission server on ${mcpPort}:`, err?.message ?? err);
    console.error('[mcp] 飞书逐项审批 (askFeishu) 模式将不可用');
  });

// ─── Event dispatcher: handles messages + card action callbacks ───

const eventDispatcher = new lark.EventDispatcher({
  encryptKey: config.feishu.encrypt_key || '',
  verificationToken: config.feishu.verification_token || '',
});

// Register message handler
eventDispatcher.register({
  'im.message.receive_v1': async (data: any) => {
    try {
      const message = data.message;
      const sender = data.sender;
      if (!message || !sender) return;

      const chatId = message.chat_id;
      const userId = sender.sender_id?.open_id;
      const messageId = message.message_id;
      const chatType = message.chat_type;
      const rootMsgId = message.root_id || undefined;
      const parentMsgId = message.parent_id || undefined;

      if (!chatId || !userId || !messageId) return;

      // Check user allowlist
      if (config.feishu.allow_users.length > 0 && !config.feishu.allow_users.includes(userId)) {
        return;
      }

      // Group chat: check @bot
      if (chatType === 'group' && config.feishu.group_at_only) {
        const mentions = Array.isArray(message.mentions) ? message.mentions : [];
        const botOpenId = config.feishu.bot_open_id;
        let isMentioned = false;
        if (botOpenId) {
          // Precise match when bot_open_id is configured
          isMentioned = mentions.some((m: any) => m?.id?.open_id === botOpenId);
        } else {
          // Fallback: any mention exists. Better to respond too much than
          // silently ignore. Operator should set feishu.bot_open_id for precision.
          isMentioned = mentions.length > 0;
        }
        if (!isMentioned) return;
      }

      // Extract content based on message type
      const msgType = message.message_type;
      let text = '';
      let fileKey = '';
      let fileName = '';

      try {
        const content = JSON.parse(message.content || '{}');
        if (msgType === 'file') {
          fileKey = content.file_key || '';
          fileName = content.file_name || '';
        } else {
          text = content.text || '';
        }
      } catch {
        return;
      }

      // Handle file message (e.g., PEM key upload)
      if (fileKey && fileName) {
        console.log(`[feicc] file from ${userId}: ${fileName} (${fileKey})`);
        await router.handleFileMessage(chatId, userId, messageId, fileKey, fileName);
        return;
      }

      // Remove @mentions
      text = text.replace(/@\S+/g, '').trim();
      if (!text) return;

      console.log(`[feicc] message from ${userId}: ${text.slice(0, 100)}`);

      await router.handleMessage(chatId, userId, messageId, text, rootMsgId, parentMsgId);
    } catch (err: any) {
      console.error('[feicc] error handling message:', err.message);
    }
  },
});

// Register card action callback
// In WebSocket mode, card actions come through as 'card.action.trigger' event type
eventDispatcher.register({
  'card.action.trigger': async (data: any) => {
    try {
      console.log('[feicc] card.action.trigger received:', JSON.stringify(data).slice(0, 800));

      // SDK v2 parse spreads header + event fields to top level
      // action.value is the button value (object), action.tag is 'button'
      // context.open_chat_id and context.open_message_id identify the card
      const action = data?.action;
      const operator = data?.operator;
      const context = data?.context ?? {};
      const openMessageId = context.open_message_id ?? data?.open_message_id;
      const openChatId = context.open_chat_id ?? data?.open_chat_id;

      if (!action?.value) {
        console.log('[feicc] card action has no value, skipping');
        return;
      }

      const userId = operator?.open_id;
      const chatId = openChatId;

      if (!userId || !chatId) {
        console.log('[feicc] card action missing userId or chatId:', { userId, chatId });
        return;
      }

      // Check user allowlist
      if (config.feishu.allow_users.length > 0 && !config.feishu.allow_users.includes(userId)) {
        return;
      }

      console.log(`[feicc] card action from ${userId}:`, action.value);

      // Feishu card.action.trigger has a ~3s response deadline.
      // If our handler blocks longer (SSH testServer, claude exec, etc),
      // Feishu shows "操作超时" to the user even though the work succeeds.
      // → fire-and-forget so the callback returns immediately.
      router.handleCardAction(action.value, chatId, userId, openMessageId, action)
        .catch((err: any) => {
          console.error('[feicc] card action handler failed:', err?.message ?? err);
        });
    } catch (err: any) {
      console.error('[feicc] error handling card action:', err.message);
    }
  },
});

// ─── WebSocket: connect to Feishu ───

const wsClient = new lark.WSClient({
  appId: config.feishu.app_id,
  appSecret: config.feishu.app_secret,
  loggerLevel: lark.LoggerLevel.info,
});

console.log('[feicc] connecting to Feishu via WebSocket...');
wsClient.start({ eventDispatcher }).then(() => {
  console.log('[feicc] WebSocket connected ✅');
  console.log('[feicc] ready — interactive cards via WebSocket 🎯');
}).catch((err: any) => {
  console.error('[feicc] WebSocket connection failed:', err);
});

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[feicc] received ${sig}, shutting down...`);
    process.exit(0);
  });
}
