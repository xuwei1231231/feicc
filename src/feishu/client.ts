import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuConfig } from '../config.js';

/**
 * Retry helper for Feishu API calls — handles 429/rate limit with backoff.
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 3,
): Promise<T | undefined> {
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const msg = err?.message ?? String(err);
      const code = err?.response?.data?.code ?? err?.code;
      const isRateLimit =
        code === 11232 || // feishu: too many requests
        code === 99991400 || // generic rate limit
        /rate.?limit|too many requests|429/i.test(msg);
      if (!isRateLimit || attempt === maxAttempts) {
        console.error(`[feishu] ${label} error (attempt ${attempt}):`, msg);
        return undefined;
      }
      const backoff = 500 * Math.pow(2, attempt - 1); // 500ms, 1s, 2s
      console.warn(`[feishu] ${label} rate-limited, retry in ${backoff}ms`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  console.error(`[feishu] ${label} gave up:`, lastErr?.message ?? lastErr);
  return undefined;
}

export class FeishuClient {
  public client: lark.Client;
  private config: FeishuConfig;

  constructor(config: FeishuConfig) {
    this.config = config;
    this.client = new lark.Client({
      appId: config.app_id,
      appSecret: config.app_secret,
    });
  }

  /**
   * Send plain text. If replyTo is provided, reply to that message;
   * otherwise, create a new message to chatId.
   */
  async sendText(chatId: string, text: string, replyTo?: string): Promise<string | undefined> {
    if (replyTo) {
      return this.replyText(replyTo, text);
    }
    return withRetry('sendText', async () => {
      const body: any = {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      };
      const params: any = {
        receive_id_type: chatId.startsWith('ou_') ? 'open_id' : 'chat_id',
      };
      const res = await this.client.im.message.create({ data: body, params });
      return res?.data?.message_id;
    });
  }

  /**
   * Send interactive card. If replyTo is provided, reply to that message;
   * otherwise, create a new message to chatId.
   */
  async sendCard(chatId: string, card: any, replyTo?: string): Promise<string | undefined> {
    if (replyTo) {
      return this.replyCard(replyTo, card);
    }
    return withRetry('sendCard', async () => {
      const body: any = {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      };
      const params: any = {
        receive_id_type: chatId.startsWith('ou_') ? 'open_id' : 'chat_id',
      };
      const res = await this.client.im.message.create({ data: body, params });
      return res?.data?.message_id;
    });
  }

  async updateCard(messageId: string, card: any): Promise<void> {
    await withRetry('updateCard', async () => {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
    });
  }

  async replyText(messageId: string, text: string): Promise<string | undefined> {
    return withRetry('replyText', async () => {
      const res = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
          reply_in_thread: this.config.reply_in_thread,
        },
      });
      return res?.data?.message_id;
    });
  }

  async replyCard(messageId: string, card: any): Promise<string | undefined> {
    return withRetry('replyCard', async () => {
      const res = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
          reply_in_thread: this.config.reply_in_thread,
        },
      });
      return res?.data?.message_id;
    });
  }
}
