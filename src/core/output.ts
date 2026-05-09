// Output manager: debounced card updates to avoid Feishu rate limits

import { FeishuClient } from '../feishu/client.js';
import { progressCard } from '../feishu/cards.js';

export class OutputManager {
  private feishu: FeishuClient;
  private chatId: string;
  private serverId: string;
  private replyToMsgId: string;

  private cardMsgId: string | null = null;
  private firstCardPromise: Promise<string | undefined> | null = null;
  private toolLogs: string[] = [];
  private lastText = '';
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;
  private flushing = false;
  private pendingFlush = false;
  private closed = false;
  public startTime = Date.now();

  constructor(
    feishu: FeishuClient,
    chatId: string,
    serverId: string,
    replyToMsgId: string,
  ) {
    this.feishu = feishu;
    this.chatId = chatId;
    this.serverId = serverId;
    this.replyToMsgId = replyToMsgId;
  }

  addToolLog(text: string) {
    this.toolLogs.push(text);
    if (this.toolLogs.length > 8) this.toolLogs.shift();
    this.dirty = true;
    this.scheduleFlush();
  }

  updateText(text: string) {
    this.lastText = text;
    this.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.closed) return;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush().catch(err => {
        console.error('[output] flush error:', err?.message ?? err);
      }), 2000);
    }
  }

  /**
   * Flush dirty state to Feishu. Serialized: only one in-flight at a time.
   * If a flush is already running, mark pendingFlush; the running one will
   * re-check and flush again after completion.
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flushing) {
      this.pendingFlush = true;
      return;
    }
    if (!this.dirty && this.cardMsgId) return;

    this.flushing = true;
    try {
      do {
        this.dirty = false;
        this.pendingFlush = false;
        const card = progressCard(this.serverId, this.toolLogs, this.lastText);

        try {
          if (!this.cardMsgId) {
            // First card: dedupe with firstCardPromise so concurrent flushes
            // don't accidentally create two cards.
            if (!this.firstCardPromise) {
              this.firstCardPromise = this.feishu.replyCard(this.replyToMsgId, card);
            }
            const id = await this.firstCardPromise;
            this.cardMsgId = id ?? null;
          } else {
            await this.feishu.updateCard(this.cardMsgId, card);
          }
        } catch (err: any) {
          console.error('[output] feishu api error:', err?.message ?? err);
          // Don't rethrow — flushing should never break the task pipeline.
        }
      } while (this.pendingFlush && !this.closed);
    } finally {
      this.flushing = false;
    }
  }

  async replaceWithCard(card: any): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Wait for any in-flight flush to settle so we don't fight it.
    while (this.flushing) {
      await new Promise(r => setTimeout(r, 50));
    }
    try {
      if (this.cardMsgId) {
        await this.feishu.updateCard(this.cardMsgId, card);
      } else {
        // First card never created — make sure we only send one.
        if (!this.firstCardPromise) {
          this.firstCardPromise = this.feishu.replyCard(this.replyToMsgId, card);
        }
        const id = await this.firstCardPromise;
        this.cardMsgId = id ?? null;
      }
    } catch (err: any) {
      console.error('[output] replaceWithCard error:', err?.message ?? err);
    }
  }
}
