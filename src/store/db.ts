import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface SessionRow {
  id: string;
  feishu_chat_id: string;
  feishu_user_id: string;
  feishu_root_msg_id: string | null;
  server_id: string;
  workspace_id: string;
  claude_session_id: string | null;
  permission_mode: string;
  created_at: number;
  last_active_at: number;
}

export class Store {
  private db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, 'hub.db'));
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        feishu_chat_id TEXT NOT NULL,
        feishu_user_id TEXT NOT NULL,
        feishu_root_msg_id TEXT,
        server_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        claude_session_id TEXT,
        permission_mode TEXT NOT NULL DEFAULT 'accept-edits',
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_chat_user
        ON sessions(feishu_chat_id, feishu_user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_chat_root
        ON sessions(feishu_chat_id, feishu_root_msg_id);

      CREATE TABLE IF NOT EXISTS message_links (
        feishu_msg_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_user
        ON tasks(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_session
        ON tasks(session_id);
    `);
  }

  findSessionById(id: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  }

  findSession(chatId: string, userId: string, rootMsgId?: string): SessionRow | undefined {
    if (rootMsgId) {
      return this.db.prepare(
        `SELECT * FROM sessions WHERE feishu_chat_id = ? AND feishu_root_msg_id = ?
         ORDER BY last_active_at DESC LIMIT 1`
      ).get(chatId, rootMsgId) as SessionRow | undefined;
    }
    return this.db.prepare(
      `SELECT * FROM sessions WHERE feishu_chat_id = ? AND feishu_user_id = ?
       AND feishu_root_msg_id IS NULL
       ORDER BY last_active_at DESC LIMIT 1`
    ).get(chatId, userId) as SessionRow | undefined;
  }

  createSession(session: SessionRow) {
    this.db.prepare(`
      INSERT INTO sessions (id, feishu_chat_id, feishu_user_id, feishu_root_msg_id,
        server_id, workspace_id, claude_session_id, permission_mode, created_at, last_active_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id, session.feishu_chat_id, session.feishu_user_id,
      session.feishu_root_msg_id, session.server_id, session.workspace_id,
      session.claude_session_id, session.permission_mode,
      session.created_at, session.last_active_at,
    );
  }

  updateSessionClaudeId(sessionId: string, claudeSessionId: string | null) {
    this.db.prepare(
      `UPDATE sessions SET claude_session_id = ?, last_active_at = ? WHERE id = ?`
    ).run(claudeSessionId, Date.now(), sessionId);
  }

  updateSessionServer(sessionId: string, serverId: string, workspaceId: string) {
    this.db.prepare(
      `UPDATE sessions SET server_id = ?, workspace_id = ?, last_active_at = ? WHERE id = ?`
    ).run(serverId, workspaceId, Date.now(), sessionId);
  }

  updateSessionPermission(sessionId: string, mode: string) {
    this.db.prepare(
      `UPDATE sessions SET permission_mode = ?, last_active_at = ? WHERE id = ?`
    ).run(mode, Date.now(), sessionId);
  }

  touchSession(sessionId: string) {
    this.db.prepare(
      `UPDATE sessions SET last_active_at = ? WHERE id = ?`
    ).run(Date.now(), sessionId);
  }

  linkMessage(feishuMsgId: string, sessionId: string, taskId?: string) {
    this.db.prepare(`
      INSERT OR REPLACE INTO message_links (feishu_msg_id, session_id, task_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(feishuMsgId, sessionId, taskId ?? null, Date.now());
  }

  findSessionByMessage(feishuMsgId: string): SessionRow | undefined {
    const link = this.db.prepare(
      `SELECT session_id FROM message_links WHERE feishu_msg_id = ?`
    ).get(feishuMsgId) as { session_id: string } | undefined;
    if (!link) return undefined;
    return this.db.prepare(
      `SELECT * FROM sessions WHERE id = ?`
    ).get(link.session_id) as SessionRow | undefined;
  }

  /**
   * Get the user's most recent permission mode.
   * If chatId is provided, scopes the lookup to that chat so settings from
   * one chat don't leak into another.
   */
  getLastPermissionMode(userId: string, chatId?: string): string | undefined {
    if (chatId) {
      const row = this.db.prepare(
        `SELECT permission_mode FROM sessions
         WHERE feishu_user_id = ? AND feishu_chat_id = ?
         ORDER BY last_active_at DESC LIMIT 1`
      ).get(userId, chatId) as { permission_mode: string } | undefined;
      if (row) return row.permission_mode;
      // Fall back to any session for this user
    }
    const row = this.db.prepare(
      `SELECT permission_mode FROM sessions WHERE feishu_user_id = ?
       ORDER BY last_active_at DESC LIMIT 1`
    ).get(userId) as { permission_mode: string } | undefined;
    return row?.permission_mode;
  }

  // ─── Simple KV store for pending operations ───

  setPendingServer(userId: string, info: string) {
    this.db.prepare(`
      INSERT OR REPLACE INTO kv (key, value, created_at) VALUES (?, ?, ?)
    `).run(`pending_server:${userId}`, info, Date.now());
  }

  getPendingServer(userId: string): string | undefined {
    const row = this.db.prepare(
      `SELECT value FROM kv WHERE key = ?`
    ).get(`pending_server:${userId}`) as { value: string } | undefined;
    return row?.value;
  }

  clearPendingServer(userId: string) {
    this.db.prepare(`DELETE FROM kv WHERE key = ?`).run(`pending_server:${userId}`);
  }

  /**
   * Delete all kv entries older than `olderThanMs`. Called periodically to
   * sweep abandoned pending_* flows.
   */
  sweepStaleKv(olderThanMs: number = 24 * 3600 * 1000): number {
    const cutoff = Date.now() - olderThanMs;
    const res = this.db.prepare(`DELETE FROM kv WHERE created_at < ?`).run(cutoff);
    return res.changes;
  }

  // ─── Task usage tracking ───

  recordTask(task: {
    id: string;
    sessionId: string;
    serverId: string;
    userId: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number;
    durationMs: number;
  }) {
    this.db.prepare(`
      INSERT OR REPLACE INTO tasks (id, session_id, server_id, user_id,
        input_tokens, output_tokens, cache_read_tokens, cost_usd, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.sessionId, task.serverId, task.userId,
      task.inputTokens, task.outputTokens, task.cacheReadTokens,
      task.costUsd, task.durationMs, Date.now(),
    );
  }

  getUsageByUser(userId: string, sinceDays: number = 30): {
    taskCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCostUsd: number;
    totalDurationMs: number;
  } {
    const since = Date.now() - sinceDays * 86400000;
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as taskCount,
        COALESCE(SUM(input_tokens), 0) as totalInputTokens,
        COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(cache_read_tokens), 0) as totalCacheReadTokens,
        COALESCE(SUM(cost_usd), 0) as totalCostUsd,
        COALESCE(SUM(duration_ms), 0) as totalDurationMs
      FROM tasks WHERE user_id = ? AND created_at > ?
    `).get(userId, since) as any;
    return row;
  }

  getUsageAll(sinceDays: number = 30): {
    taskCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCostUsd: number;
    totalDurationMs: number;
  } {
    const since = Date.now() - sinceDays * 86400000;
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as taskCount,
        COALESCE(SUM(input_tokens), 0) as totalInputTokens,
        COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(cache_read_tokens), 0) as totalCacheReadTokens,
        COALESCE(SUM(cost_usd), 0) as totalCostUsd,
        COALESCE(SUM(duration_ms), 0) as totalDurationMs
      FROM tasks WHERE created_at > ?
    `).get(since) as any;
    return row;
  }

  getRecentTasks(userId: string, limit: number = 10): {
    id: string; server_id: string; input_tokens: number; output_tokens: number;
    cost_usd: number; duration_ms: number; created_at: number;
  }[] {
    return this.db.prepare(`
      SELECT id, server_id, input_tokens, output_tokens, cost_usd, duration_ms, created_at
      FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(userId, limit) as any[];
  }
}
