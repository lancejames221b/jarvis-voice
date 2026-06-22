import "../src/config-env-bootstrap.js";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { parseChannelKey } from "../src/comms/recipient.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.JARVIS_GATEWAY_PORT || process.env.ZEROCLAW_COMPAT_PORT || 22100);
const ZEROCLAW_BASE_URL = process.env.JARVIS_BACKEND_URL || process.env.ZEROCLAW_BASE_URL || "http://127.0.0.1:22101";
const GATEWAY_TOKEN = process.env.JARVIS_GATEWAY_TOKEN || "";
// Shell aliases (like `claude --dangerously-skip-permissions`) don't survive spawn().
// Use the actual binary path and pass flags explicitly.
const CLAUDE_BIN = process.env.CLAUDE_BIN || `${process.env.HOME}/.local/bin/claude`;
// Logical model aliases — map short names to Anthropic model IDs.
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const LMS_MODEL = process.env.JARVIS_LMS_MODEL || "qwen/qwen3.6-35b-a3b";
const MODEL_ALIASES = {
  claude:          process.env.DISPATCH_MODEL      || "claude-sonnet-4-6",
  sonnet:          process.env.DISPATCH_MODEL      || "claude-sonnet-4-6",
  opus:            process.env.DISPATCH_MODEL_DEEP || "claude-opus-4-7",
  haiku:           "claude-haiku-4-5-20251001",
  "opus-plan":     process.env.DISPATCH_MODEL_DEEP || "claude-opus-4-7",
  // qwen aliases resolve to the LM Studio model ID (engineEnvForModel sets the base URL)
  "qwen":          LMS_MODEL,
  "qwen-focused":  LMS_MODEL,
  "qwen-fast":     LMS_MODEL,
};
// Strip a trailing -<effort> suffix to get the base alias, then add effort suffixes.
EFFORT_LEVELS.forEach(l => {
  MODEL_ALIASES[`claude-${l}`]  = MODEL_ALIASES["claude"];
  MODEL_ALIASES[`sonnet-${l}`]  = MODEL_ALIASES["sonnet"];
  MODEL_ALIASES[`opus-${l}`]    = MODEL_ALIASES["opus"];
});
const CLAUDE_MODEL_RE = /^claude-/;
// Return the effort level encoded in an alias (e.g. "claude-high" → "high", "opus-plan" → "max")
function effortForAlias(raw) {
  if (!raw) return null;
  const m = String(raw).trim();
  if (m === "opus-plan") return "max";
  const suffix = EFFORT_LEVELS.find(l => m.endsWith(`-${l}`));
  return suffix || null;
}
function resolveModel(raw) {
  if (!raw) return "";
  const m = String(raw).trim();
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, m)) return MODEL_ALIASES[m];
  if (CLAUDE_MODEL_RE.test(m)) {
    // Strip a known effort suffix so "claude-sonnet-4-6-high" doesn't reach the CLI.
    const stripped = m.replace(new RegExp(`-(${EFFORT_LEVELS.join("|")})$`), "");
    return stripped;
  }
  return "";
}
const DEFAULT_CLAUDE_MODEL = resolveModel(process.env.DISPATCH_MODEL) || "claude-sonnet-4-6";

// Qwen alias → LM Studio env overlay.
// Temperature tiers:
//   qwen            → 1.0 general/conversational (Jarvis default)
//   qwen-focused    → 0.6 coding/precise (anti-loop sampling)
//   qwen-fast       → 0.7 no-think fast responses
// Temperature is stored in engineEnv.temperature for logging/future proxy use.
// LM Studio currently uses its per-model default config for actual temp;
// the alias documents intent and will drive a lightweight proxy when added.
const QWEN_ALIASES = {
  'qwen':         { temperature: 1.0, label: 'general' },
  'qwen-focused': { temperature: 0.6, label: 'focused' },
  'qwen-fast':    { temperature: 0.7, label: 'fast' },
};
function engineEnvForModel(alias) {
  if (!alias || !QWEN_ALIASES[alias]) return null;
  const lmsBase = process.env.JARVIS_LMS_BASE_URL;
  if (!lmsBase) return null;
  const lmsModel = process.env.JARVIS_LMS_MODEL || 'qwen/qwen3.6-35b-a3b';
  const { temperature, label } = QWEN_ALIASES[alias];
  return { ANTHROPIC_BASE_URL: lmsBase, ANTHROPIC_AUTH_TOKEN: 'lmstudio', model: lmsModel, temperature, label };
}
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || "";
const DEFAULT_REPORT_CHANNEL = process.env.DISCORD_REPORT_CHANNEL_ID || process.env.DISCORD_TEXT_CHANNEL_ID || "";
const ALERT_WEBHOOK_TOKEN = process.env.ALERT_WEBHOOK_TOKEN || "";
const ALERT_WEBHOOK_PORT = process.env.ALERT_WEBHOOK_PORT || "3335";
const ALERT_WEBHOOK_HOST = process.env.TAILSCALE_IP || process.env.ALERT_WEBHOOK_HOST || "127.0.0.1";
const SPEAK_URL = process.env.JARVIS_SPEAK_URL || process.env.ZEROCLAW_COMPAT_SPEAK_URL || `http://${ALERT_WEBHOOK_HOST}:${ALERT_WEBHOOK_PORT}/speak`;
// Persist sessions to ~/.local/state so chatIds survive service restarts and reboots.
// /tmp is wiped on reboot; every restart meant fresh cursor-agent contexts.
const _defaultSessionDir = `${process.env.HOME}/.local/state/jarvis-voice`;
const SESSION_STORE_PATH = process.env.SESSION_STORE_PATH || `${_defaultSessionDir}/jarvis-sessions.json`;
const CHANNEL_ACCOUNTS_PATH = process.env.CHANNEL_ACCOUNTS_PATH || `${_defaultSessionDir}/channel-accounts.json`;
// Ensure the state directory exists (harmless if already present)
try { fs.mkdirSync(_defaultSessionDir, { recursive: true }); } catch {}
const CURSOR_AGENT_TIMEOUT_MS = parseInt(process.env.GATEWAY_CLAUDE_TIMEOUT_MS || '600000');  // default 10 min
const CURSOR_AGENT_TIMEOUT_LMS_MS = parseInt(process.env.GATEWAY_LMS_TIMEOUT_MS || '1800000'); // default 30 min for local models

// ── Per-channel account profiles ─────────────────────────────────────────────
// Maps channels to separate CLAUDE_CONFIG_DIR paths for multi-account routing.
// Each configDir must be pre-authenticated via: CLAUDE_CONFIG_DIR=<path> claude login
function loadChannelAccounts() {
  try {
    return JSON.parse(fs.readFileSync(CHANNEL_ACCOUNTS_PATH, "utf8"));
  } catch {
    return { profiles: { default: { configDir: null, label: "primary (process owner)" } }, channels: {} };
  }
}
let channelAccounts = loadChannelAccounts();

function resolveProfile(channelKey) {
  if (!channelKey) return channelAccounts.profiles?.default ?? null;
  // Try exact match first; then strip thread/topic suffix so thread sessions
  // (Discord :thread:) and Telegram :topic: sessions inherit their parent profile.
  let profileName = channelAccounts.channels?.[channelKey];
  if (!profileName) {
    const parentKey = channelKey.replace(/:(thread|topic):\d+$/, "");
    if (parentKey !== channelKey) profileName = channelAccounts.channels?.[parentKey];
  }
  profileName = profileName || "default";
  return channelAccounts.profiles?.[profileName] ?? channelAccounts.profiles?.default ?? null;
}

function validateProfiles() {
  const profiles = channelAccounts.profiles || {};
  let valid = 0; let invalid = 0;
  for (const [name, p] of Object.entries(profiles)) {
    if (!p.configDir) { valid++; continue; }
    try {
      fs.accessSync(`${p.configDir}/.credentials.json`, fs.constants.R_OK);
      valid++;
    } catch {
      log("profile_warn", { profile: name, configDir: p.configDir, msg: "credentials not found — run: CLAUDE_CONFIG_DIR=<path> claude login" });
      invalid++;
    }
  }
  return { total: Object.keys(profiles).length, valid, invalid };
}

// ── Metrics counters ─────────────────────────────────────────────────────────
const metrics = {
  requests: 0,
  requestsStreaming: 0,
  timeouts: 0,
  errors: 0,
  sessionsCreated: 0,
  sessionsResumed: 0,
  sessionsRotated: 0,
  hooksAgent: 0,
  rssKills: 0,
  clientAborts: 0,
};

// ── Session persistence ───────────────────────────────────────────────────────
// channelSessions persists across service restarts via a JSON file.
// On restart, cursor-agent silently starts fresh context if a UUID is stale.
function loadSessions() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(SESSION_STORE_PATH, "utf8"))));
  } catch {
    return new Map();
  }
}
function saveSessions() {
  try {
    fs.writeFileSync(SESSION_STORE_PATH, JSON.stringify(Object.fromEntries(channelSessions)));
  } catch (e) { log("session_save_warn", { path: SESSION_STORE_PATH, error: e.message }); }
}

const channelSessions = loadSessions();
// Per-channel turn counters (persisted alongside sessions in SESSION_STORE_PATH)
function loadJsonFile(path) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return {}; }
}
const channelTurns = new Map(Object.entries(loadJsonFile(SESSION_STORE_PATH + ".turns")));
function saveTurns() {
  try { fs.writeFileSync(SESSION_STORE_PATH + ".turns", JSON.stringify(Object.fromEntries(channelTurns))); }
  catch (e) { log("turns_save_warn", { error: e.message }); }
}
const CURSOR_MAX_TURNS_PER_CHAT = parseInt(process.env.JARVIS_MAX_TURNS || process.env.CURSOR_MAX_TURNS || "150");
const CURSOR_MAX_AGE_MS = parseInt(process.env.JARVIS_MAX_AGE_MS || process.env.CURSOR_MAX_AGE_MS || String(3 * 24 * 3600 * 1000)); // 3 days
// createdAt timestamps per channel for age-based rotation
const channelCreatedAt = new Map(Object.entries(loadJsonFile(SESSION_STORE_PATH + ".created")));
function saveCreatedAt() {
  try { fs.writeFileSync(SESSION_STORE_PATH + ".created", JSON.stringify(Object.fromEntries(channelCreatedAt))); }
  catch (e) { log("created_save_warn", { error: e.message }); }
}

// Prune sessions older than 30 days at startup to keep the store bounded.
{
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let pruned = 0;
  for (const [key] of channelSessions) {
    const age = channelCreatedAt.get(key);
    if (age && now - age > THIRTY_DAYS_MS) {
      channelSessions.delete(key);
      channelCreatedAt.delete(key);
      channelTurns.delete(key);
      pruned++;
    }
  }
  if (pruned > 0) {
    log("sessions_pruned", { count: pruned });
    saveSessions();
    saveTurns();
    saveCreatedAt();
  }
}

// Per-channel in-flight Promise lock — prevents duplicate create-chat on concurrent requests
const channelSessionLocks = new Map();

// ── Child process tracking for clean shutdown ─────────────────────────────────
const activeChildren = new Set();

// ── Base args for all claude -p calls ────────────────────────────────────────
// --dangerously-skip-permissions: equivalent to --trust + --force in cursor-agent.
//   Auto-approves tool use and MCP connections in headless mode.
// --include-partial-messages: equivalent to --stream-partial-output.
//   Emits partial assistant events as content accumulates (used for SSE delta forwarding).
// --chrome: enables the Claude-in-Chrome integration. On a machine with Chrome
// + the extension installed, claude-p creates a Unix socket bridge the extension
// can connect to for browser tool calls. On headless hosts (generic) the flag
// is a no-op — no extension to connect, so tool calls would just be unavailable
// with no side effects.
const BASE_ARGS = [
  "-p", "--verbose", "--dangerously-skip-permissions", "--chrome",
  "--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config",
  "--output-format", "stream-json", "--include-partial-messages",
];

// Channels in ask-only mode get these args instead (no dangerous perms, plan mode).
// Plan mode means Claude can read + search + reason, but refuses Bash/Edit/Write.
const ASK_MODE_ARGS = [
  "-p", "--verbose", "--permission-mode", "plan", "--chrome",
  "--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config",
  "--output-format", "stream-json", "--include-partial-messages",
];

// Read channel-ask-mode.json at spawn time — lightweight, one file read per spawn.
const ASK_MODE_FILE = `${process.env.HOME}/.local/state/jarvis-voice/channel-ask-mode.json`;
function _channelIsInAskMode(channelKey) {
  if (!channelKey) return false;
  // Task agents are never in ask mode — they run autonomously
  if (channelKey.startsWith("task-agent:")) return false;
  let state;
  try { state = JSON.parse(fs.readFileSync(ASK_MODE_FILE, "utf8")); } catch { return false; }
  // channelKey format: "agent:main:discord:channel:<id>[:thread:<tid>]"
  //                 or "agent:main:telegram:chat:<id>[:topic:<tid>]"
  const parsed = parseChannelKey(channelKey);
  if (!parsed) return false;
  const { channelId, threadId } = parsed;
  // Thread-scoped first, then channel-scoped
  if (threadId && state[threadId] === true) return true;
  if (channelId && state[channelId] === true) return true;
  return false;
}

// Read channel-mcp-mode.json at spawn time. Returns:
//   { mode: 'off' }                        → use empty mcpServers (current fast default)
//   { mode: 'full' }                       → use the curated jarvis-mcp.json
//   { mode: 'subset', servers: [...] }     → use a narrowed subset of jarvis-mcp.json
// Same file-read overhead as _channelIsInAskMode; both are ~1ms per spawn.
const MCP_MODE_FILE   = `${process.env.HOME}/.local/state/jarvis-voice/channel-mcp-mode.json`;
const MCP_CONFIG_PATH = process.env.JARVIS_MCP_CONFIG_PATH ||
                        `${process.env.HOME}/.config/jarvis-voice/jarvis-mcp.json`;
function _channelMcpMode(channelKey) {
  if (!channelKey) return { mode: "off" };
  // Task agents always get full MCP — they need tools to complete their work
  if (channelKey.startsWith("task-agent:")) return { mode: "full" };
  let state;
  try { state = JSON.parse(fs.readFileSync(MCP_MODE_FILE, "utf8")); } catch { return { mode: "off" }; }
  const parsed = parseChannelKey(channelKey);
  if (!parsed) return { mode: "off" };
  const { channelId, threadId } = parsed;
  const raw = (threadId && state[threadId] !== undefined) ? state[threadId]
            : (channelId && state[channelId] !== undefined) ? state[channelId]
            : null;
  if (raw === "full") return { mode: "full" };
  if (raw === "off")  return { mode: "off" };
  if (Array.isArray(raw) && raw.length) return { mode: "subset", servers: raw };
  return { mode: "off" };
}

function log(event, data = {}) {
  const entry = { ts: new Date().toISOString(), svc: "jarvis-gateway", event, ...data };
  console.log(JSON.stringify(entry));
}

function requireAuth(req, res, next) {
  if (!GATEWAY_TOKEN) return next();
  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${GATEWAY_TOKEN}`) return next();
  res.status(401).json({ error: "Unauthorized" });
}

function contentToText(content) {
  if (typeof content === "string") return content.replace(/\0/g, "");
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item.text === "string") return item.text;
      if (item && item.type === "text" && typeof item.text === "string") return item.text;
      return "";
    }).filter(Boolean).join("\n").replace(/\0/g, "");
  }
  return "";
}

// Collapse messages array to a flat prompt string.
// System message is extracted and prepended as a context block so cursor-agent
// can distinguish instructions from conversation history.
function collapseMessages(messages = []) {
  const sys = messages.find((m) => m?.role === "system");
  const turns = messages.filter((m) => m?.role !== "system");
  const sysText = sys ? contentToText(sys.content) : "";
  const history = turns
    .map((msg) => {
      const role = String(msg?.role || "user").toUpperCase();
      const text = contentToText(msg?.content);
      return text ? `${role}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return sysText ? `${sysText}\n\n---\n\n${history}` : history;
}

// Spawn claude -p with stream-json output; optionally resume a prior session.
// Prompt is written to stdin to avoid ARG_MAX limits on large conversation histories.
function spawnClaudeStream(prompt, model, chatId, channelKey, effort, engineEnv = null) {
  const askMode = _channelIsInAskMode(channelKey);
  const base = askMode ? ASK_MODE_ARGS : BASE_ARGS;

  // Swap the --mcp-config value based on per-channel MCP mode.
  // BASE_ARGS/ASK_MODE_ARGS both include `--mcp-config '{"mcpServers":{}}'` — when MCP mode
  // is 'full' or 'subset' for this channel, we replace that inline JSON with a config-file
  // path (or a narrowed inline JSON for subsets). --strict-mcp-config is kept in both cases
  // so the subprocess doesn't load user-global MCP defaults.
  const mcpMode = _channelMcpMode(channelKey);
  const args = [...base];
  const mcpIdx = args.indexOf("--mcp-config");
  if (mcpIdx >= 0 && mcpIdx + 1 < args.length) {
    if (mcpMode.mode === "full") {
      args[mcpIdx + 1] = MCP_CONFIG_PATH;
      log("mcp_mode_spawn", { channelKey, mode: "full", path: MCP_CONFIG_PATH });
    } else if (mcpMode.mode === "subset") {
      // Build an inline JSON by reading the full config and selecting the requested servers.
      try {
        const full = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf8"));
        const filtered = { mcpServers: {} };
        for (const name of mcpMode.servers) {
          if (full.mcpServers?.[name]) filtered.mcpServers[name] = full.mcpServers[name];
        }
        args[mcpIdx + 1] = JSON.stringify(filtered);
        log("mcp_mode_spawn", { channelKey, mode: "subset", servers: mcpMode.servers });
      } catch (err) {
        log("mcp_mode_spawn_error", { channelKey, error: err.message });
        // fall through with empty config
      }
    }
    // 'off' — leave args[mcpIdx+1] as the empty-mcpServers string (default)
  }

  args.push("--model", model);
  if (askMode) log("ask_mode_spawn", { channelKey });
  if (effort) args.push("--effort", effort);
  if (chatId) args.push("--resume", chatId);
  // Strip stale token overrides; keep ANTHROPIC_BASE_URL only if ClaudeFlare is configured.
  const { CLAUDE_CODE_OAUTH_TOKEN: _b, ...cleanEnv } = process.env;
  // Route through ClaudeFlare proxy when JARVIS_CLAUDEFLARE_URL is set.
  // Unset it otherwise so claude uses its own stored OAuth credentials.
  if (process.env.JARVIS_CLAUDEFLARE_URL) {
    cleanEnv.ANTHROPIC_BASE_URL = process.env.JARVIS_CLAUDEFLARE_URL;
    if (process.env.JARVIS_CLAUDEFLARE_TOKEN) cleanEnv.ANTHROPIC_AUTH_TOKEN = process.env.JARVIS_CLAUDEFLARE_TOKEN;
  } else {
    delete cleanEnv.ANTHROPIC_BASE_URL;
  }
  // Per-request engine overlay (Telegram /engine qwen): point the SAME claude -p
  // subprocess at LM Studio. Wins over ClaudeFlare for this spawn. null/{} for claude.
  if (engineEnv && engineEnv.ANTHROPIC_BASE_URL) {
    cleanEnv.ANTHROPIC_BASE_URL = engineEnv.ANTHROPIC_BASE_URL;
    if (engineEnv.ANTHROPIC_AUTH_TOKEN) cleanEnv.ANTHROPIC_AUTH_TOKEN = engineEnv.ANTHROPIC_AUTH_TOKEN;
    log("engine_overlay_spawn", { channelKey, baseUrl: engineEnv.ANTHROPIC_BASE_URL });
  }
  const profile = resolveProfile(channelKey);
  if (profile?.configDir) cleanEnv.CLAUDE_CONFIG_DIR = profile.configDir;
  const spawnTimeoutMs = (engineEnv?.ANTHROPIC_BASE_URL) ? CURSOR_AGENT_TIMEOUT_LMS_MS : CURSOR_AGENT_TIMEOUT_MS;
  log("claude_spawn", { model, chatId: chatId || null, channelKey, profile: profile?.label || "default", configDir: profile?.configDir || null, timeoutMs: spawnTimeoutMs });
  const child = spawn(CLAUDE_BIN, args, {
    env: cleanEnv,
    timeout: spawnTimeoutMs,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Track the child BEFORE touching stdin so a throw on `.end()` (non-string prompt,
  // already-closed pipe, etc.) doesn't leave an untracked/unkillable subprocess.
  activeChildren.add(child);
  child.on("close", () => activeChildren.delete(child));
  try {
    child.stdin.end(String(prompt ?? "").replace(/\0/g, ""), "utf8");
  } catch (err) {
    log("stdin_write_failed", { channelKey, error: err.message });
    try { child.kill("SIGKILL"); } catch {}
    throw err;
  }
  return child;
}

// Map any channelKey to the stable haivemind memory category for that surface.
// Thread/topic suffixes are stripped so a thread/topic shares its parent's
// memory (same inheritance the profile/ask-mode/mcp lookups already use).
//   discord:  agent:main:discord:channel:<id>[:thread:<tid>]  -> channel:<id>
//   telegram: agent:main:telegram:chat:<id>[:topic:<tid>]     -> channel:telegram:chat:<id>
// Returns null for an unrecognized key (memory then skipped, not misfiled).
// IMPORTANT: this must agree with the read side (getChannelContext, which
// prepends "channel:" to the channelId it is handed) — see brain.js.
function memoryCategory(channelKey) {
  const k = String(channelKey || "");
  const d = k.match(/discord:channel:(\d+)/);
  if (d) return `channel:${d[1]}`;
  const t = k.match(/telegram:chat:([\w-]+)/);
  if (t) return `channel:telegram:chat:${t[1]}`;
  return null;
}

// Summarize the old chatId to haivemind before rotation so context survives.
// Fire-and-forget — does not block the rotation; new chat starts fresh immediately.
async function summarizeAndStoreChat(channelKey, oldChatId) {
  const SUMMARY_PROMPT = "In 400 words or less, summarize the key state of this conversation: decisions made, open tasks, blockers, and any important context the next session should know. Be specific and terse.";
  try {
    const result = await callClaudeAgent(SUMMARY_PROMPT, DEFAULT_CLAUDE_MODEL, oldChatId);
    if (!result.text) return;
    // Store under the per-surface namespace — getChannelContext() reads it next turn.
    // (Previously this only matched discord:channel:<id> AND required DISCORD_TOKEN,
    // so Telegram session summaries were silently dropped — Telegram had no memory.)
    const category = memoryCategory(channelKey);
    if (category) {
      // Use the MCP JSON-RPC envelope via storeMemory(). A prior bug POSTed to a
      // bare /store_memory path haivemind doesn't serve, silently dropping summaries.
      try {
        await storeMemory(`[SESSION SUMMARY] ${result.text}`, category);
      } catch (err) {
        log("chat_summary_store_failed", { channelKey, category, error: err.message });
      }
    }
    log("chat_summary_stored", { channelKey, category, chars: result.text.length });
  } catch (e) {
    log("chat_summary_failed", { channelKey, error: e.message });
  }
}

// Return an existing chatId for the channel, or create a new one.
// Uses a per-channel Promise lock to prevent duplicate create-chat on concurrent requests.
// Rotates automatically if turn count or age limits are exceeded.
async function getOrCreateChatId(channelKey) {
  if (channelKey && channelSessions.has(channelKey)) {
    const turns = channelTurns.get(channelKey) || 0;
    const age = Date.now() - (channelCreatedAt.get(channelKey) || 0);
    if (turns >= CURSOR_MAX_TURNS_PER_CHAT || age > CURSOR_MAX_AGE_MS) {
      const oldChatId = channelSessions.get(channelKey);
      log("chat_rotation", { channelKey, turns, ageMs: age, reason: turns >= CURSOR_MAX_TURNS_PER_CHAT ? "turns" : "age" });
      // Summarize old session to haivemind (fire-and-forget, does not block rotation)
      summarizeAndStoreChat(channelKey, oldChatId).catch(() => {});
      metrics.sessionsRotated++;
      channelSessions.delete(channelKey);
      channelTurns.delete(channelKey);
      channelCreatedAt.delete(channelKey);
      saveSessions(); saveTurns(); saveCreatedAt();
    } else {
      metrics.sessionsResumed++;
      return channelSessions.get(channelKey);
    }
  }
  // No existing session — return null. claude -p will create a fresh session
  // and return a session_id in the system init event; setSession() stores it.
  metrics.sessionsCreated++;
  return null;
}

function setSession(channelKey, sessionId) {
  if (!channelKey || !sessionId) return;
  const prev = channelSessions.get(channelKey);
  const isNew = !channelSessions.has(channelKey);
  const isRotation = !isNew && prev && prev !== sessionId;
  channelSessions.set(channelKey, sessionId);
  channelTurns.set(channelKey, (channelTurns.get(channelKey) || 0) + 1);
  if (isNew) { channelCreatedAt.set(channelKey, Date.now()); saveCreatedAt(); }
  saveSessions(); saveTurns();

  // Notify jarvis-voice admin-api so it can update the pinned handoff card.
  if (isRotation) notifyHandoffRotation(channelKey, prev, sessionId);
}

// Extract the parent channel id from a channelKey like
// "agent:main:discord:channel:<channelId>[:thread:<threadId>]"
function parseChannelId(channelKey) {
  const m = (channelKey || '').match(/discord:channel:(\d+)(?::thread:(\d+))?/);
  if (!m) return null;
  return { channelId: m[1], threadId: m[2] || null };
}

function notifyHandoffRotation(channelKey, oldId, newId) {
  const parsed = parseChannelId(channelKey);
  if (!parsed) return;
  const adminUrl = process.env.JARVIS_ADMIN_URL || "http://127.0.0.1:3101";
  const token = process.env.JARVIS_ADMIN_TOKEN;
  if (!token) return; // admin API disabled
  const body = JSON.stringify({
    channelId: parsed.channelId,
    threadId: parsed.threadId,
    oldChatId: oldId,
    newChatId: newId,
  });
  fetch(`${adminUrl}/admin/handoff/rotation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body,
    signal: AbortSignal.timeout(5000),
  }).then(r => {
    if (!r.ok) log("handoff_rotation_notify_failed", { status: r.status, channelKey });
  }).catch(err => {
    log("handoff_rotation_notify_error", { error: err.message, channelKey });
  });
}

// ── RSS watchdog — kills cursor-agent children that grow beyond 2.5 GB ───────
const MAX_CHILD_RSS_BYTES = parseFloat(process.env.CURSOR_MAX_RSS_GB || "2.5") * 1024 ** 3;
function getChildRss(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = stat.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? parseInt(m[1]) * 1024 : 0;
  } catch { return 0; }
}
setInterval(() => {
  for (const child of activeChildren) {
    if (!child.pid) continue;
    const rss = getChildRss(child.pid);
    if (rss > MAX_CHILD_RSS_BYTES) {
      log("rss_watchdog_kill", { pid: child.pid, rssGb: (rss / 1e9).toFixed(2), limitGb: MAX_CHILD_RSS_BYTES / 1e9 });
      try { child.kill("SIGKILL"); } catch {}
    }
  }
}, 30_000).unref();

// Buffer the full response from claude -p (non-streaming path).
// Parses NDJSON lines; extracts text from result event and session_id from system:init.
async function callClaudeAgent(prompt, modelOverride, chatId, channelKey, engineEnv = null) {
  const effort = effortForAlias(modelOverride);
  const model = resolveModel(modelOverride) || DEFAULT_CLAUDE_MODEL;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawnClaudeStream(prompt, model, chatId, channelKey, effort, engineEnv);
    let buf = "";
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdout.on("data", (d) => { buf += d; });
    child.on("close", (code) => {
      const durationMs = Date.now() - start;
      let resultText = "";
      let sessionId = chatId || null;
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.session_id) sessionId = ev.session_id;
          if (ev.type === "result") {
            if (ev.is_error) return reject(new Error(ev.result || "claude error"));
            resultText = ev.result || "";
          }
        } catch { /* skip malformed lines */ }
      }
      if (code !== 0 && !resultText) {
        if (code === 143) metrics.timeouts++;
        else metrics.errors++;
        const msg = code === 143
          ? `claude timed out after ${CURSOR_AGENT_TIMEOUT_MS / 1000}s — task may need more time`
          : `claude exited ${code}: ${stderr.slice(0, 300)}`;
        log("claude_agent_error", { code, durationMs, model, error: msg });
        return reject(new Error(msg));
      }
      log("claude_agent_done", { code, durationMs, model, chars: resultText.length });
      resolve({ text: resultText, model: `claude/${model}`, sessionId });
    });
    child.on("error", (err) => { metrics.errors++; reject(err); });
  });
}

// Extract the single most-informative argument from a tool_use input object.
function _toolArg(name, input) {
  const s = (v) => String(v ?? "").trim();
  switch (name) {
    case "Bash":        return s(input.command).slice(0, 120);
    case "Read":        return s(input.file_path);
    case "Write":       return s(input.file_path);
    case "Edit":        return s(input.file_path);
    case "Glob":        return [s(input.pattern), s(input.path)].filter(Boolean).join("  ");
    case "Grep":        return `/${s(input.pattern)}/` + (input.path ? `  ${s(input.path)}` : "");
    case "WebFetch":    return s(input.url).slice(0, 100);
    case "WebSearch":   return s(input.query).slice(0, 100);
    case "Agent":       return s(input.description || input.prompt).slice(0, 80);
    case "Task":
    case "TaskCreate":
    case "TaskUpdate":  return s(input.description || input.title || input.task_id).slice(0, 80);
    default: {
      // Generic: first string value in input
      const first = Object.values(input).find(v => typeof v === "string");
      return first ? s(first).slice(0, 80) : "";
    }
  }
}

// Format tool result into a short readable preview line.
function _toolResultPreview(toolName, raw) {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "✓ (empty)";
  // For Bash: show exit-code hint if present, then first line of output
  if (toolName === "Bash") {
    const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
    const first = lines[0] ?? "";
    const more = lines.length > 1 ? `  (+${lines.length - 1} lines)` : "";
    return `✓  ${first.slice(0, 120)}${more}`;
  }
  // For Read/Grep/Glob: line count + first content line
  if (["Read", "Grep", "Glob"].includes(toolName)) {
    const lines = raw.split("\n").filter(Boolean);
    const first = lines[0]?.trim() ?? "";
    return `✓  ${first.slice(0, 100)}${lines.length > 1 ? `  (${lines.length} lines)` : ""}`;
  }
  // Generic: first 140 chars
  return `✓  ${text.slice(0, 140)}${text.length > 140 ? "…" : ""}`;
}

// Stream claude -p NDJSON deltas directly to an SSE response.
// Returns the resolvedSessionId once the stream completes.
async function streamClaudeToSSE(prompt, model, chatId, res, req, channelKey, effort, engineEnv = null) {
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawnClaudeStream(prompt, model, chatId, channelKey, effort, engineEnv);
    let lineBuf = "";
    let resolvedSessionId = chatId;
    let clientAborted = false;
    let lastTextLen = 0;  // tracks how many chars we've already forwarded as deltas
    const _seenToolIds = new Set();       // dedupe tool_use progress lines per request
    const _toolIdToName = new Map();      // tool_use_id → name, for result attribution

    // Client-disconnect handler — kill the cursor-agent child when the HTTP
    // client aborts the stream. Without this, aborted requests orphan the
    // child process until RSS watchdog or shutdown kills it.
    // Use res.on('close') rather than req.on('close') — the body-parser
    // middleware consumes the request stream, and `res.close` fires reliably
    // when the TCP connection closes on both normal end and abort.
    const onClose = () => {
      if (clientAborted) return;
      // If the response completed cleanly, res.writableEnded is true — skip.
      if (res.writableEnded) return;
      clientAborted = true;
      log("stream_client_aborted", { model, durationMs: Date.now() - start });
      metrics.clientAborts = (metrics.clientAborts || 0) + 1;
      try { child.kill("SIGTERM"); } catch {}
      // Give it 2s to exit cleanly, then SIGKILL.
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2_000).unref();
      reject(new Error("client disconnected"));
    };
    res.once("close", onClose);

    function sendDelta(text) {
      if (clientAborted) return;
      const chunk = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: `claude/${model}`,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    function handleLine(line) {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      // session_id appears on every event type in claude CLI output
      if (ev.session_id) resolvedSessionId = ev.session_id;
      // claude CLI accumulates text across assistant events; emit only the new chars each time
      if (ev.type === "assistant") {
        const blocks = ev.message?.content ?? [];
        // Emit text deltas
        const textBlock = blocks.find(b => b.type === "text");
        const text = textBlock?.text ?? "";
        if (text.length > lastTextLen) {
          sendDelta(text.slice(lastTextLen));
          lastTextLen = text.length;
        }
        // Emit full tool_use lines: name + key argument
        for (const block of blocks) {
          if (block.type === "tool_use" && block.name) {
            const toolKey = `tool:${block.id ?? block.name}`;
            if (!_seenToolIds.has(toolKey)) {
              _seenToolIds.add(toolKey);
              if (block.id) _toolIdToName.set(block.id, block.name);
              const arg = _toolArg(block.name, block.input ?? {});
              const argStr = arg ? ` › ${arg}` : "";
              sendDelta(`\n🔧 **${block.name}**${argStr}\n`);
            }
          }
        }
      }
      // user-type events carry tool_result blocks — emit truncated result
      if (ev.type === "user") {
        const blocks = ev.message?.content ?? [];
        for (const block of blocks) {
          if (block.type === "tool_result") {
            const toolName = _toolIdToName.get(block.tool_use_id) ?? "";
            const raw = Array.isArray(block.content)
              ? block.content.map(c => c.text ?? "").join("")
              : (block.content ?? "");
            const preview = _toolResultPreview(toolName, raw);
            sendDelta(`  ↳ ${preview}\n`);
          }
        }
      }
      if (ev.type === "result" && ev.is_error) {
        // Kill the child so it doesn't keep running until its 10-minute spawn timeout.
        // Before this fix, an is_error from claude rejected the Promise but left the
        // subprocess alive — the onClose handler skipped the kill path when res was
        // already ended by the outer catch.
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2_000).unref();
        return reject(new Error(ev.result || "claude stream error"));
      }
    }

    child.stdout.on("data", (chunk) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop(); // hold incomplete last line
      for (const line of lines) handleLine(line);
    });
    child.stderr.on("data", () => {});
    child.on("close", (code) => {
      res.removeListener("close", onClose);
      if (clientAborted) return; // already rejected with "client disconnected"
      if (lineBuf.trim()) handleLine(lineBuf);
      const durationMs = Date.now() - start;
      if (code !== 0) {
        if (code === 143) metrics.timeouts++;
        else metrics.errors++;
        const msg = code === 143
          ? `claude timed out after ${CURSOR_AGENT_TIMEOUT_MS / 1000}s — task may need more time`
          : `claude exited ${code}`;
        log("claude_agent_error", { code, durationMs, model, streaming: true, error: msg });
        return reject(new Error(msg));
      }
      log("claude_agent_done", { code, durationMs, model, streaming: true });
      resolve(resolvedSessionId);
    });
    child.on("error", (err) => {
      res.removeListener("close", onClose);
      metrics.errors++;
      reject(err);
    });
  });
}

function openAiCompletionResponse(model, text) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
  };
}

function extractTaskId(message) {
  const match = message.match(/taskId":"([^"]+)"/) || message.match(/Task #(\d+)/i);
  return match ? match[1] : "";
}

function extractTargetChannelId(message) {
  const match = message.match(/channel:(\d{10,})/);
  return match ? match[1] : DEFAULT_REPORT_CHANNEL;
}

function summarize(text) {
  const trimmed = String(text || "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "Task completed.";
  const parts = trimmed.match(/[^.!?]+[.!?]*/g) || [trimmed];
  return parts.slice(0, 2).join(" ").slice(0, 320).trim();
}

async function postDiscordMessage(channelId, content) {
  if (!DISCORD_TOKEN || !channelId || !content) return;
  const chunks = content.match(/[\s\S]{1,1900}/g) || [];
  for (const chunk of chunks) {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: chunk }),
      signal: AbortSignal.timeout(10_000), // 10s timeout — prevents hanging if Discord API is slow
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord ${response.status}: ${body}`);
    }
  }
}

const HAIVEMIND_URL = process.env.HAIVEMIND_URL || `http://127.0.0.1:${process.env.HAIVEMIND_PORT || 8900}`;
const REMEMBER_RE = /^(?:jarvis[,\s]+)?(?:remember|store|save|note)\s+(?:this[:\s]+)?(.+)/i;

// Store a memory directly via haivemind HTTP — no LLM involvement.
async function storeMemory(content, category = "global") {
  const res = await fetch(`${HAIVEMIND_URL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "store_memory", arguments: { content, category } },
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`haivemind ${res.status}`);
  const raw = await res.text();
  // haivemind responds with SSE — extract the data: line
  const dataLine = raw.split("\n").find(l => l.startsWith("data:"));
  const body = JSON.parse(dataLine ? dataLine.slice(5).trim() : raw);
  const text = body?.result?.content?.[0]?.text || body?.result?.structuredContent?.result || "{}";
  // Extract memory ID from text like "Memory stored with ID: <uuid>"
  const idMatch = text.match(/[0-9a-f-]{36}/);
  return idMatch ? { memory_id: idMatch[0] } : {};
}

async function postSpeakSummary(message, taskId) {
  if (!ALERT_WEBHOOK_TOKEN || !message) return;
  // Timeout prevents hanging if jarvis-voice is unresponsive (OOM, restart, etc.)
  // A failed /speak callback means the task won't get its result delivered, but at least
  // the gateway doesn't hang indefinitely blocking the entire microtask chain.
  await fetch(SPEAK_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ALERT_WEBHOOK_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, source: "task-progress", taskId }),
    signal: AbortSignal.timeout(10_000), // 10s timeout — prevents indefinite hangs
  });
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), sessions: channelSessions.size, activeChildren: activeChildren.size });
});

app.get("/models", requireAuth, (_req, res) => {
  res.json({
    aliases: Object.entries(MODEL_ALIASES).map(([alias, model]) => ({ alias, model })),
    default: DEFAULT_CLAUDE_MODEL,
  });
});

app.get("/metrics", (_req, res) => {
  res.json({
    ...metrics,
    activeSessions: channelSessions.size,
    activeChildren: activeChildren.size,
    pendingLocks: channelSessionLocks.size,
    maxTurnsPerChat: CURSOR_MAX_TURNS_PER_CHAT,
    maxRssGb: MAX_CHILD_RSS_BYTES / 1e9,
    uptime: process.uptime(),
  });
});

// Inject or overwrite a channelKey → chatId mapping. Used by the terminal-to-Discord
// handoff flow: the terminal rsyncs its session .jsonl up, then tells us
// "this chatId now belongs to <channelKey>" so subsequent Discord messages resume it.
app.post("/v1/sessions/inject", requireAuth, (req, res) => {
  const { channelKey, chatId } = req.body || {};
  if (!channelKey || !chatId) {
    return res.status(400).json({ error: "channelKey and chatId required" });
  }
  const prev = channelSessions.get(channelKey) || null;
  setSession(channelKey, chatId);
  log("session_injected", { channelKey, chatId, prevChatId: prev });
  res.json({ ok: true, channelKey, chatId, prevChatId: prev });
});

app.post("/admin/reload-accounts", requireAuth, (_req, res) => {
  channelAccounts = loadChannelAccounts();
  const stats = validateProfiles();
  log("accounts_reloaded", stats);
  res.json({ ok: true, profiles: stats });
});

app.post("/v1/chat/completions", requireAuth, async (req, res) => {
  metrics.requests++;
  let releaseLock = () => {}; // hoisted so catch block can always call it safely
  try {
    const requestedModel = String(req.body?.model || DEFAULT_CLAUDE_MODEL);
    const model = resolveModel(requestedModel) || DEFAULT_CLAUDE_MODEL;
    const effort = effortForAlias(requestedModel);
    const channelKey = String(req.body?.user || "").trim() || null;
    const wantStream = Boolean(req.body?.stream);

    if (wantStream) metrics.requestsStreaming++;

    // Intercept "remember X" patterns — store directly to haivemind, skip claude.
    const lastUserMsg = (req.body?.messages || []).filter(m => m?.role === "user").pop();
    const rememberMatch = lastUserMsg && REMEMBER_RE.exec(contentToText(lastUserMsg.content));
    if (rememberMatch) {
      const content = rememberMatch[1].trim();
      try {
        const stored = await storeMemory(content);
        const memId = stored?.memory_id || stored?.id || "ok";
        const reply = `Saved. (${memId.slice(0, 8)})`;
        log("memory_stored", { channelKey, chars: content.length, memId });
        if (wantStream) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          const chunk = { id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: requestedModel, choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.json(openAiCompletionResponse(requestedModel, reply));
        }
        return;
      } catch (e) {
        log("memory_store_failed", { channelKey, error: e.message });
        // fall through to claude on failure
      }
    }

    // Serialize concurrent new-session requests for the same channel.
    // If another request is mid-create for this channel, wait for it to finish so we
    // don't spawn two separate claude -p sessions simultaneously.
    //
    // Previously: we awaited the inflight lock, THEN called getOrCreateChatId, THEN
    // set our own lock. Two concurrent requests both saw no existing lock before the
    // first await completed, both got null chatIds, and both installed separate locks
    // (second overwrites first). Fix: take the lock BEFORE getOrCreateChatId, using a
    // drain loop so arriving requests always see the in-flight promise.
    while (channelSessionLocks.has(channelKey)) {
      await channelSessionLocks.get(channelKey);
    }
    let lockResolve = null;
    const sessionLock = new Promise(r => { lockResolve = r; });
    channelSessionLocks.set(channelKey, sessionLock);
    releaseLock = () => {
      if (lockResolve) { lockResolve(); channelSessionLocks.delete(channelKey); lockResolve = null; }
    };

    const chatId = await getOrCreateChatId(channelKey);

    // Lock is held through the full Claude spawn for both new and resumed sessions.
    // Resuming the same chatId concurrently causes multiple claude --resume processes
    // to compete on the same session, each taking 8+ min and piling up indefinitely.

    // On a resumed session: re-inject the system prompt on every turn so Jarvis instructions
    // survive compaction. Claude already has full conversation history via --resume.
    // On a new session: send the full collapsed context (system + history + user message).
    const _sysMsg = (req.body?.messages || []).find(m => m?.role === "system");
    const _sysText = _sysMsg ? contentToText(_sysMsg.content) : "";
    const prompt = chatId
      ? (_sysText ? `${_sysText}\n\n${contentToText(lastUserMsg?.content || "")}` : contentToText(lastUserMsg?.content || ""))
      : collapseMessages(req.body?.messages || []);

    if (wantStream) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      let resolvedSessionId;
      try {
        resolvedSessionId = await streamClaudeToSSE(prompt, model, chatId, res, req, channelKey, effort, req.body?.engineEnv || engineEnvForModel(requestedModel) || null);
      } catch (streamError) {
        releaseLock();
        // Don't try to write to a closed/aborted socket.
        if (streamError.message === "client disconnected" || res.writableEnded || req.destroyed) return;
        log("stream_error", { channelKey, model, error: streamError.message });
        res.write(`data: ${JSON.stringify({ error: streamError.message })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      setSession(channelKey, resolvedSessionId);
      releaseLock();

      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // Non-streaming path
    const result = await callClaudeAgent(prompt, requestedModel, chatId, channelKey, req.body?.engineEnv || engineEnvForModel(requestedModel) || null);
    setSession(channelKey, result.sessionId);
    releaseLock();
    res.json(openAiCompletionResponse(requestedModel, result.text));
  } catch (error) {
    releaseLock();
    metrics.errors++;
    log("completions_error", { error: String(error.message || error) });
    res.status(502).json({ error: String(error.message || error) });
  }
});

app.post("/hooks/agent", requireAuth, async (req, res) => {
  metrics.hooksAgent++;
  const message = String(req.body?.message || "");
  // channelKey = req.body.user, matching /v1/chat/completions convention so voice
  // ACTION tasks resume the same Claude chat as voice KNOWLEDGE turns.
  const channelKey = String(req.body?.user || "").trim() || null;
  const requestedModel = req.body?.model ? String(req.body.model) : undefined;
  const taskId = extractTaskId(message);
  const channelId = extractTargetChannelId(message);
  res.status(202).json({ accepted: true, taskId, backend: "jarvis-gateway" });

  queueMicrotask(async () => {
    let result;
    try {
      const chatId = await getOrCreateChatId(channelKey);
      result = await callClaudeAgent(message, requestedModel, chatId, channelKey, req.body?.engineEnv || engineEnvForModel(requestedModel) || null);
      if (channelKey && result?.sessionId) setSession(channelKey, result.sessionId);
    } catch (error) {
      const failure = `Task ${taskId || ""} failed: ${error.message || error}`.trim();
      log("hooks_agent_error", { taskId, channelId, error: String(error.message || error) });
      try {
        if (channelId) await postDiscordMessage(channelId, failure);
      } catch (discordError) {
        log("discord_post_error", { taskId, error: String(discordError.message || discordError) });
      }
      try {
        await postSpeakSummary("The task failed.", taskId);
      } catch (speakError) {
        log("speak_post_error", { taskId, error: String(speakError.message || speakError) });
      }
      return;
    }

    try {
      if (channelId) {
        await postDiscordMessage(channelId, result.text || "Task completed with no text response.");
      }
    } catch (discordError) {
      log("discord_post_error", { taskId, error: String(discordError.message || discordError) });
    }

    try {
      await postSpeakSummary(summarize(result.text), taskId);
    } catch (speakError) {
      log("speak_post_error", { taskId, error: String(speakError.message || speakError) });
    }

    log("hooks_agent_done", { taskId, channelId, model: result.model });
  });
});

// ── Task Agent — isolated session, full MCP, no session accumulation ──────────
// Spawns a fresh Claude session (chatId=null) with MCP via "task-agent:" channelKey.
// Brain layer calls this for tool-heavy intents to keep the main voice session lean.
app.post("/v1/task/run", requireAuth, async (req, res) => {
  metrics.hooksAgent++;
  const prompt  = String(req.body?.prompt  || "");
  const model   = req.body?.model ? String(req.body.model) : undefined;
  const taskId  = req.body?.taskId ? String(req.body.taskId) : null;
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  res.status(202).json({ accepted: true, taskId, backend: "jarvis-gateway/task-agent" });

  queueMicrotask(async () => {
    // Unique per-task key — always fresh session (chatId=null), always full MCP
    const channelKey = `task-agent:${taskId || Date.now()}`;
    let result;
    try {
      result = await callClaudeAgent(prompt, model, null, channelKey);
    } catch (error) {
      log("task_agent_error", { taskId, error: String(error.message || error) });
      try { await postSpeakSummary("The task could not be completed.", taskId); } catch {}
      return;
    }
    try { await postSpeakSummary(summarize(result.text), taskId); } catch (e) {
      log("task_agent_speak_error", { taskId, error: String(e.message || e) });
    }
    log("task_agent_done", { taskId, model: result.model, chars: result.text?.length });
  });
});

// ── Blade TTS audio file route ────────────────────────────────────────────────
// Serves generated WAV files written by the Blade WS handler.
// Files are cleaned up automatically 60 s after creation.
const BLADE_TTS_DIR = "/tmp";
app.get("/v1/blade/tts/:id", requireAuth, (req, res) => {
  const id = String(req.params.id || "").replace(/[^a-zA-Z0-9-]/g, "");
  const filePath = `${BLADE_TTS_DIR}/blade-tts-${id}.wav`;
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "TTS file not found or expired" });
  }
  res.setHeader("Content-Type", "audio/wav");
  fs.createReadStream(filePath).pipe(res);
});

app.use((_req, res) => {
  res.status(405).json({ error: "Unsupported route" });
});

// ── Vuzix Blade 2 WebSocket relay ─────────────────────────────────────────────
// Path: ws://host:22100/v1/blade
// Auth: Bearer token (JARVIS_GATEWAY_TOKEN), same as HTTP routes.
// Frames are JSON objects in both directions.
//
// Inbound frame types (Blade → gateway):
//   { type: "prompt",      text: string }   — run a new Claude turn
//   { type: "stop" }                        — abort the active claude process
//   { type: "new-session" }                 — rotate to a fresh Claude session
//   { type: "approve" }                     — confirm a pending approval prompt
//   { type: "deny" }                        — reject a pending approval prompt
//
// Outbound frame types (gateway → Blade):
//   { type: "token",    text: string }      — streaming partial text delta
//   { type: "done",     fullText: string }  — stream finished; fullText = everything
//   { type: "approval", prompt: string }    — paused, awaiting approve/deny
//   { type: "error",    message: string }   — something went wrong
//   { type: "tts",      url: string }       — TTS audio available at this GET URL

// ANSI escape code stripper (blade display has no ANSI rendering)
const ANSI_RE = /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;
function stripAnsiForBlade(str) {
  return String(str || "").replace(ANSI_RE, "");
}

// Approval-prompt detector — patterns that claude uses when it needs confirmation
const APPROVAL_RE = /\[Y\/n\]|Approve\?|allow|deny|yes\/no|\(y\/N\)/i;

const bladeWss = new WebSocketServer({ noServer: true });

bladeWss.on("connection", (ws, req) => {
  // ── Auth ─────────────────────────────────────────────────────────────────
  if (GATEWAY_TOKEN) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${GATEWAY_TOKEN}`) {
      ws.close(4001, "Unauthorized");
      return;
    }
  }

  // ── Per-connection state ─────────────────────────────────────────────────
  const channelKey = `agent:main:blade:session:${crypto.randomUUID()}`;
  let chatId = null;        // resolved after first getOrCreateChatId
  let activeChild = null;   // current claude subprocess (if streaming)
  let approved = null;      // null=not waiting, true=approved, false=denied
  let approvalResolve = null; // resolve fn for the in-flight approval promise

  // Warm the session immediately on connect
  getOrCreateChatId(channelKey).then(id => { chatId = id; }).catch(() => {});

  log("blade_connected", { channelKey });

  function send(frame) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(JSON.stringify(frame)); } catch (e) {
        log("blade_send_error", { channelKey, error: e.message });
      }
    }
  }

  // ── Inbound message handler ──────────────────────────────────────────────
  ws.on("message", async (raw) => {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch {
      send({ type: "error", message: "invalid JSON frame" });
      return;
    }

    // ── approve / deny — resolve in-flight approval gate ──────────────────
    if (frame.type === "approve" || frame.type === "deny") {
      approved = frame.type === "approve";
      if (approvalResolve) { approvalResolve(approved); approvalResolve = null; }
      return;
    }

    // ── stop — kill active process ────────────────────────────────────────
    if (frame.type === "stop") {
      if (activeChild) {
        try { activeChild.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { activeChild?.kill("SIGKILL"); } catch {} }, 2_000).unref();
        activeChild = null;
      }
      return;
    }

    // ── new-session — rotate Claude session ───────────────────────────────
    if (frame.type === "new-session") {
      if (activeChild) {
        try { activeChild.kill("SIGTERM"); } catch {}
        activeChild = null;
      }
      channelSessions.delete(channelKey);
      channelTurns.delete(channelKey);
      channelCreatedAt.delete(channelKey);
      saveSessions(); saveTurns(); saveCreatedAt();
      chatId = null;
      await getOrCreateChatId(channelKey).then(id => { chatId = id; }).catch(() => {});
      send({ type: "token", text: "[session rotated]\n" });
      return;
    }

    // ── prompt — run a claude turn ────────────────────────────────────────
    if (frame.type === "prompt") {
      const promptText = String(frame.text || "").trim();
      if (!promptText) { send({ type: "error", message: "empty prompt" }); return; }
      if (activeChild) { send({ type: "error", message: "busy — send stop first" }); return; }

      // Resolve chatId if not yet warmed
      if (chatId === null) {
        try { chatId = await getOrCreateChatId(channelKey); } catch (e) {
          send({ type: "error", message: `session error: ${e.message}` });
          return;
        }
      }

      const model = DEFAULT_CLAUDE_MODEL;
      let child;
      try {
        child = spawnClaudeStream(promptText, model, chatId, channelKey, null);
      } catch (e) {
        send({ type: "error", message: `spawn failed: ${e.message}` });
        return;
      }
      activeChild = child;

      let lineBuf = "";
      let fullText = "";
      let resolvedSessionId = chatId;
      let lastTextLen = 0;
      approved = null;
      approvalResolve = null;

      child.stdout.on("data", async (chunk) => {
        lineBuf += chunk.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop(); // hold incomplete last line

        for (const line of lines) {
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }

          if (ev.session_id) resolvedSessionId = ev.session_id;

          if (ev.type === "assistant") {
            const textBlock = (ev.message?.content ?? []).find(b => b.type === "text");
            const text = textBlock?.text ?? "";
            if (text.length > lastTextLen) {
              const delta = stripAnsiForBlade(text.slice(lastTextLen));
              lastTextLen = text.length;
              fullText += delta;
              send({ type: "token", text: delta });

              // Scan for approval patterns in the new delta
              if (APPROVAL_RE.test(delta)) {
                const lines = delta.split("\n").filter(Boolean);
                const lastLine = lines[lines.length - 1] || delta.trim();
                send({ type: "approval", prompt: lastLine });
                // Pause: wait for approve/deny frame (or WS close)
                const userApproval = await new Promise((resolve) => {
                  approvalResolve = resolve;
                  // Auto-deny if WS closes while waiting
                  ws.once("close", () => resolve(false));
                });
                if (!userApproval) {
                  // User denied — kill the claude process
                  try { child.kill("SIGTERM"); } catch {}
                  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2_000).unref();
                }
              }
            }
          }

          if (ev.type === "result" && ev.is_error) {
            send({ type: "error", message: ev.result || "claude stream error" });
            try { child.kill("SIGTERM"); } catch {}
          }
        }
      });

      child.stderr.on("data", () => {}); // swallow stderr

      child.on("close", async (code) => {
        activeChild = null;
        if (lineBuf.trim()) {
          // Flush any partial line
          let ev;
          try { ev = JSON.parse(lineBuf); } catch { ev = null; }
          if (ev?.session_id) resolvedSessionId = ev.session_id;
        }

        // Persist session
        if (resolvedSessionId) setSession(channelKey, resolvedSessionId);
        chatId = resolvedSessionId;

        const summary = fullText.trim() ? summarize(fullText) : "";
        send({ type: "done", fullText });

        // TTS — write summary to a temp WAV file via postSpeakSummary (fire-and-forget)
        // postSpeakSummary only POSTs to piper-server (speaks on local speakers);
        // we also expose the audio if piper-server returns a file path.
        // Since postSpeakSummary doesn't return a file path, we generate a unique ID
        // for the TTS URL and serve it if the piper-server wrote a file there.
        if (summary) {
          const ttsId = crypto.randomUUID();
          const ttsPath = `${BLADE_TTS_DIR}/blade-tts-${ttsId}.wav`;

          // Best-effort: trigger speak (fire-and-forget, no await blocking WS response)
          postSpeakSummary(summary, null).catch(() => {});

          // If piper-server also saves to ttsPath (configured externally), expose the URL.
          // Auto-cleanup after 60 s regardless.
          const cleanupTimer = setTimeout(() => {
            fs.unlink(ttsPath, () => {});
          }, 60_000);
          cleanupTimer.unref();

          send({ type: "tts", url: `/v1/blade/tts/${ttsId}` });
        }

        if (code !== 0 && code !== null) {
          log("blade_claude_exit_error", { channelKey, code });
        }
      });

      child.on("error", (err) => {
        activeChild = null;
        send({ type: "error", message: `process error: ${err.message}` });
      });

      return;
    }

    send({ type: "error", message: `unknown frame type: ${frame.type}` });
  });

  ws.on("close", () => {
    log("blade_disconnected", { channelKey });
    if (activeChild) {
      try { activeChild.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { activeChild?.kill("SIGKILL"); } catch {} }, 2_000).unref();
      activeChild = null;
    }
    // Resolve any pending approval gate so streaming stops
    if (approvalResolve) { approvalResolve(false); approvalResolve = null; }
  });

  ws.on("error", (err) => {
    log("blade_ws_error", { channelKey, error: err.message });
  });
});

// ── Graceful shutdown — drain in-flight cursor-agent children before exiting ──
// Waits up to 30 s for active children to finish, then force-kills stragglers.
// TimeoutStopSec=45s in the service unit gives this enough runway.
async function shutdown(signal) {
  log("shutdown_start", { signal, activeChildren: activeChildren.size });
  server.close();
  const deadline = Date.now() + 30_000;
  while (activeChildren.size > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
  }
  if (activeChildren.size > 0) {
    log("shutdown_drain_timeout", { remaining: activeChildren.size });
    for (const child of activeChildren) { try { child.kill("SIGKILL"); } catch {} }
  }
  log("shutdown_done", { signal });
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Startup validation ────────────────────────────────────────────────────────
import { accessSync, constants as fsConstants } from "node:fs";
function validateStartup() {
  try {
    accessSync(CLAUDE_BIN, fsConstants.X_OK);
  } catch {
    log("fatal", { msg: `Claude CLI not found or not executable at ${CLAUDE_BIN}. Run: claude login` });
    process.exit(1);
  }
  if (!GATEWAY_TOKEN) {
    log("warn", { msg: "JARVIS_GATEWAY_TOKEN not set — all requests will be rejected as Unauthorized" });
  }
}
validateStartup();

const server = app.listen(PORT, "0.0.0.0", () => {
  const profileStats = validateProfiles();
  log("startup", {
    port: PORT,
    bin: CLAUDE_BIN,
    model: DEFAULT_CLAUDE_MODEL,
    sessions: channelSessions.size,
    sessionStore: SESSION_STORE_PATH,
    profiles_loaded: profileStats,
  });
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/v1/blade") {
    bladeWss.handleUpgrade(req, socket, head, (ws) => {
      bladeWss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});
