/**
 * config.js — Unified OpenJarvis configuration loader.
 *
 * Single source of truth for everything Lance tunes by hand:
 * Discord/gateway tokens, feature flags, allowed users, channel routing,
 * voice triggers, contacts, MCP server list.
 *
 * Read order:
 *   1. ~/.config/openjarvis/config.yaml (preferred, when present)
 *   2. Legacy fallback: .env + JSON shards (during refactor; removed when stable)
 *
 * Usage:
 *   import config from './config.js';
 *   const token = config.get('discord.token');
 *   const allowedUsers = config.get('users.allowed', []);
 *   const speakerOn = config.get('flags.speakerVerifyEnabled', false);
 *
 * State files (sessions, ledger, focus, hud, task) are NOT managed here.
 * They rotate, the bot writes them itself, and they don't belong with config.
 */

import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const STATE_DIR = join(homedir(), '.local', 'state', 'jarvis-voice');
const USER_CONFIG_DIR = join(homedir(), '.config', 'jarvis-voice');

const UNIFIED_PATH = process.env.OPENJARVIS_CONFIG_PATH ||
                     join(homedir(), '.config', 'openjarvis', 'config.yaml');

let _unifiedCache = null;
let _unifiedCacheMtimeMs = 0;
let _legacyMode = false;

function _readUnified() {
  if (!existsSync(UNIFIED_PATH)) return null;
  const stat = statSync(UNIFIED_PATH);
  if (_unifiedCache && stat.mtimeMs === _unifiedCacheMtimeMs) return _unifiedCache;
  const text = readFileSync(UNIFIED_PATH, 'utf8');
  const parsed = YAML.parse(text) || {};
  _unifiedCache = parsed;
  _unifiedCacheMtimeMs = stat.mtimeMs;
  _legacyMode = false;
  return parsed;
}

function _readLegacyShards() {
  // Fallback path: assemble the shape from the existing files so call sites
  // migrated to config.get() keep working before the migration script runs.
  const out = {
    discord: {
      token: process.env.DISCORD_TOKEN || '',
      guildId: process.env.DISCORD_GUILD_ID || '',
      voiceChannelId: process.env.DISCORD_VOICE_CHANNEL_ID || '',
      textChannelId: process.env.DISCORD_TEXT_CHANNEL_ID || '',
      hudChannelId: process.env.HUD_CHANNEL_ID || '',
      botId: process.env.JARVIS_BOT_ID || '',
    },
    gateway: {
      url: process.env.JARVIS_GATEWAY_URL || process.env.GATEWAY_URL || 'http://127.0.0.1:22103',
      token: process.env.JARVIS_GATEWAY_TOKEN || process.env.GATEWAY_TOKEN || '',
      timeoutMs: parseInt(process.env.GATEWAY_TIMEOUT_MS || '300000', 10),
    },
    admin: {
      token: process.env.JARVIS_ADMIN_TOKEN || '',
      port: parseInt(process.env.JARVIS_ADMIN_PORT || '3101', 10),
      bind: process.env.JARVIS_ADMIN_BIND || '0.0.0.0',
    },
    flags: {
      speakerVerifyEnabled: process.env.SPEAKER_VERIFY_ENABLED !== 'false',
      speakerVerifyStrict:  process.env.SPEAKER_VERIFY_STRICT === 'true',
      taskAgentEnabled:     process.env.TASK_AGENT_ENABLED === 'true',
      multiUserEnabled:     process.env.MULTI_USER_ENABLED === 'true',
      activityFeedEnabled:  process.env.ACTIVITY_FEED_ENABLED !== 'false',
      voiceMessageAutoReply: process.env.VOICE_MESSAGE_AUTO_REPLY !== 'false',
      webhookCallbackMode:  process.env.WEBHOOK_CALLBACK_MODE === 'true',
      voiceAckEnabled:      process.env.VOICE_ACK_ENABLED === 'true',
      agentDispatchAckEnabled: process.env.AGENT_DISPATCH_ACK_ENABLED !== 'false',
      immediateAcksEnabled: process.env.IMMEDIATE_ACKS_ENABLED === 'true',
      voiceThreadReportsEnabled: process.env.VOICE_THREAD_REPORTS !== 'false',
    },
    models: {
      voice: process.env.VOICE_MODEL || '',
      dispatch: process.env.DISPATCH_MODEL || '',
      default: process.env.DEFAULT_CLAUDE_MODEL || 'claude-opus-4-7',
      triggers: _safeJson(join(REPO_ROOT, 'config', 'models.json'), { triggers: [] }).triggers,
    },
    speaker: {
      verifyUrl: process.env.SPEAKER_VERIFY_URL || 'http://localhost:8767/verify',
      threshold: parseFloat(process.env.SPEAKER_THRESHOLD || '0.45'),
      rebuffEnabled: process.env.SPEAKER_REBUFF_ENABLED === 'true',
    },
    users: {
      allowed: _safeJson(join(REPO_ROOT, 'data', 'allowed-users.json'), []),
    },
    channels: {
      ask: _safeJson(join(STATE_DIR, 'channel-ask-mode.json'), {}),
      mcp: _safeJson(join(STATE_DIR, 'channel-mcp-mode.json'), {}),
      models: _safeJson(join(STATE_DIR, 'channel-models.json'), {}),
      accounts: _safeJson(join(STATE_DIR, 'channel-accounts.json'),
        { profiles: { default: { configDir: null, label: 'default' } }, channels: {} }),
      access: _safeJson(join(REPO_ROOT, 'data', 'channel-access.json'), {}),
    },
    contacts: _safeJson(join(USER_CONFIG_DIR, 'contacts.json'), {}),
    mcp: {
      configPath: process.env.JARVIS_MCP_CONFIG_PATH || join(USER_CONFIG_DIR, 'jarvis-mcp.json'),
      servers: _safeJson(join(USER_CONFIG_DIR, 'jarvis-mcp.json'), { mcpServers: {} }).mcpServers,
    },
    persona: _safeJson(join(REPO_ROOT, 'data', 'persona-state.json'), {}),
    shortcuts: _safeJson(join(REPO_ROOT, 'data', 'shortcuts.json'), {}),
    projects: _safeJson(join(REPO_ROOT, 'config', 'projects.json'), {}),
  };
  return out;
}

function _safeJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function _deepMerge(base, overlay) {
  if (overlay == null) return base;
  if (typeof overlay !== 'object' || Array.isArray(overlay)) return overlay;
  const out = (base != null && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {};
  for (const k of Object.keys(overlay)) {
    out[k] = _deepMerge(out[k], overlay[k]);
  }
  return out;
}

function _load() {
  // Always compute legacy shape first so partial YAML can't regress unmapped keys.
  // YAML keys overlay on top. Arrays from YAML replace arrays from legacy (not merge).
  const legacy = _readLegacyShards();
  const unified = _readUnified();
  if (unified == null) {
    _legacyMode = true;
    return legacy;
  }
  _legacyMode = false;
  return _deepMerge(legacy, unified);
}

function _toBool(v, fb) {
  if (v === true || v === false) return v;
  if (v == null) return fb;
  const s = String(v).toLowerCase().trim();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === '') return false;
  return fb;
}

function _toNumber(v, fb) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fb;
  if (v == null || v === '') return fb;
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function _toList(v, fb) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return fb;
  if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
  return fb;
}

function _resolve(obj, dottedPath) {
  if (!dottedPath) return obj;
  const parts = dottedPath.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

const config = {
  /**
   * Get a config value by dotted path.
   * @param {string} path - e.g. 'discord.token', 'flags.speakerVerifyEnabled', 'users.allowed'
   * @param {*} fallback - returned if the path is undefined
   */
  get(path, fallback) {
    const data = _load();
    const v = _resolve(data, path);
    return v === undefined ? fallback : v;
  },

  /** Get a value coerced to number; fallback when missing/NaN. */
  getNumber(path, fallback) {
    return _toNumber(this.get(path), fallback);
  },

  /** Get a value coerced to boolean; accepts true/'true'/1/'yes'/'on'. */
  getBool(path, fallback) {
    return _toBool(this.get(path), fallback);
  },

  /** Get a value as an array; YAML arrays passthrough, legacy CSV strings split. */
  getList(path, fallback = []) {
    return _toList(this.get(path), fallback);
  },

  /** Force a reload from disk (clears mtime cache). Used by reload hooks. */
  reload() {
    _unifiedCache = null;
    _unifiedCacheMtimeMs = 0;
    return _load();
  },

  /** True if currently reading from legacy shards (no unified YAML present). */
  isLegacy() {
    _load();
    return _legacyMode;
  },

  /** Absolute path to the unified config file (regardless of existence). */
  path() {
    return UNIFIED_PATH;
  },

  /** Dump the entire effective config tree (for debugging / migration verification). */
  dump() {
    return JSON.parse(JSON.stringify(_load()));
  },
};

export default config;
