import fs from 'fs';
import TOML from '@iarna/toml';

export interface ServerConfig {
  id: string;
  name: string;
  host: string;
  user: string;
  key: string;               // SSH private key path
  claude_path?: string;       // claude CLI path on remote
  default_workspace?: string;
  workspaces: WorkspaceConfig[];
}

export interface WorkspaceConfig {
  id: string;
  name: string;
  cwd: string;
}

export interface FeishuConfig {
  app_id: string;
  app_secret: string;
  verification_token?: string;
  encrypt_key?: string;
  allow_users: string[];
  group_at_only: boolean;
  reply_in_thread: boolean;
  bot_open_id?: string;  // optional: when set, group @bot detection uses this
}

export interface HubConfig {
  server: {
    data_dir: string;
  };
  feishu: FeishuConfig;
  remotes: ServerConfig[];
  configPath: string;
}

export function loadConfig(path: string): HubConfig {
  const raw = fs.readFileSync(path, 'utf-8');
  const parsed = TOML.parse(raw) as any;

  // Validate feishu block
  const fb = parsed.feishu ?? {};
  if (!fb.app_id || !fb.app_secret) {
    throw new Error(`[config] ${path}: missing required feishu.app_id / feishu.app_secret`);
  }

  const remotes: ServerConfig[] = (parsed.remote ?? []).map((r: any, idx: number) => {
    if (!r.id) throw new Error(`[config] remote #${idx} missing id`);
    if (!r.host) throw new Error(`[config] remote "${r.id}" missing host`);
    if (!r.key) throw new Error(`[config] remote "${r.id}" missing key`);
    return {
      id: r.id,
      name: r.name ?? r.id,
      host: r.host,
      user: r.user ?? 'ubuntu',
      key: r.key,
      claude_path: r.claude_path,
      default_workspace: r.default_workspace,
      workspaces: (r.workspace ?? []).map((w: any, widx: number) => {
        if (!w.id) throw new Error(`[config] remote "${r.id}" workspace #${widx} missing id`);
        return {
          id: w.id,
          name: w.name ?? w.id,
          cwd: w.cwd ?? '.',
        };
      }),
    };
  });

  return {
    server: {
      data_dir: parsed.server?.data_dir ?? '.feishu-claude-data',
    },
    feishu: {
      app_id: fb.app_id,
      app_secret: fb.app_secret,
      verification_token: fb.verification_token,
      encrypt_key: fb.encrypt_key,
      allow_users: fb.allow_users ?? [],
      group_at_only: fb.group_at_only ?? true,
      reply_in_thread: fb.reply_in_thread ?? false,
      bot_open_id: fb.bot_open_id,
    },
    remotes,
    configPath: path,
  };
}

/**
 * Serialize the in-memory config back to TOML and write to disk.
 * Uses @iarna/toml so we never have to hand-roll TOML ever again.
 */
function persistConfig(config: HubConfig): void {
  const obj: any = {
    server: { data_dir: config.server.data_dir },
    feishu: {
      app_id: config.feishu.app_id,
      app_secret: config.feishu.app_secret,
      ...(config.feishu.verification_token ? { verification_token: config.feishu.verification_token } : {}),
      ...(config.feishu.encrypt_key ? { encrypt_key: config.feishu.encrypt_key } : {}),
      allow_users: config.feishu.allow_users,
      group_at_only: config.feishu.group_at_only,
      reply_in_thread: config.feishu.reply_in_thread,
      ...(config.feishu.bot_open_id ? { bot_open_id: config.feishu.bot_open_id } : {}),
    },
    remote: config.remotes.map(r => ({
      id: r.id,
      name: r.name,
      host: r.host,
      user: r.user,
      key: r.key,
      ...(r.claude_path ? { claude_path: r.claude_path } : {}),
      ...(r.default_workspace ? { default_workspace: r.default_workspace } : {}),
      workspace: r.workspaces.map(w => ({ id: w.id, name: w.name, cwd: w.cwd })),
    })),
  };

  const tomlText = TOML.stringify(obj);
  // Atomic write: write to tmp + rename
  const tmp = config.configPath + '.tmp';
  fs.writeFileSync(tmp, tomlText);
  fs.renameSync(tmp, config.configPath);
}

/**
 * Add a new server to config and persist.
 */
export function addServerToConfig(
  config: HubConfig,
  server: { id: string; name: string; host: string; user: string; key: string; cwd: string },
): ServerConfig {
  if (config.remotes.find(r => r.id === server.id)) {
    throw new Error(`server id "${server.id}" already exists`);
  }
  const newServer: ServerConfig = {
    id: server.id,
    name: server.name,
    host: server.host,
    user: server.user,
    key: server.key,
    default_workspace: 'home',
    workspaces: [{ id: 'home', name: 'Home', cwd: server.cwd }],
  };
  config.remotes.push(newServer);
  persistConfig(config);
  return newServer;
}

/**
 * Update fields on an existing server and persist.
 * Only fields present in `patch` are changed; others stay as-is.
 * Server id is immutable here (would invalidate sessions in store).
 */
export function updateServerInConfig(
  config: HubConfig,
  serverId: string,
  patch: {
    name?: string;
    host?: string;
    user?: string;
    key?: string;
    default_workspace?: string;
    workspace_cwd?: string;  // updates the default workspace's cwd if provided
  },
): ServerConfig | null {
  const server = config.remotes.find(r => r.id === serverId);
  if (!server) return null;
  if (patch.name !== undefined) server.name = patch.name;
  if (patch.host !== undefined) server.host = patch.host;
  if (patch.user !== undefined) server.user = patch.user;
  if (patch.key !== undefined) server.key = patch.key;
  if (patch.default_workspace !== undefined) server.default_workspace = patch.default_workspace;
  if (patch.workspace_cwd !== undefined) {
    const defWsId = server.default_workspace ?? server.workspaces[0]?.id;
    const ws = server.workspaces.find(w => w.id === defWsId);
    if (ws) ws.cwd = patch.workspace_cwd;
  }
  persistConfig(config);
  return server;
}

/**
 * Remove a server from config and persist. Returns the removed server, or null if not found.
 * Note: caller is responsible for cleaning up SSH key files / sessions if desired.
 */
export function removeServerFromConfig(
  config: HubConfig,
  serverId: string,
): ServerConfig | null {
  const idx = config.remotes.findIndex(r => r.id === serverId);
  if (idx < 0) return null;
  const [removed] = config.remotes.splice(idx, 1);
  persistConfig(config);
  return removed;
}

/**
 * Add a workspace to an existing server and persist.
 */
export function addWorkspaceToConfig(
  config: HubConfig,
  serverId: string,
  workspace: { id: string; name: string; cwd: string },
): WorkspaceConfig | null {
  const server = config.remotes.find(r => r.id === serverId);
  if (!server) return null;
  if (server.workspaces.find(w => w.id === workspace.id)) {
    throw new Error(`workspace id "${workspace.id}" already exists on "${serverId}"`);
  }
  server.workspaces.push(workspace);
  persistConfig(config);
  return workspace;
}
