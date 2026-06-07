/**
 * discord-voice-commands.js — Admin Discord commands for live GPU service control
 *
 * Handles @mention or DM commands like:
 *   voice off / voice on / voice status / voice help
 *   stt off / stt on
 *   tts off / tts on
 *   chatterbox off / chatterbox on
 *   kokoro off / kokoro on
 *
 * Only responds to users in the JARVIS_ADMIN_USER_IDS allowlist.
 * Calls service-control.js for actual systemd control; builds Discord replies here.
 * Never imports from index.js — no circular dependencies.
 */

import logger from './logger.js';
import {
  startSTT, stopSTT,
  startChatterbox, stopChatterbox,
  startKokoro, stopKokoro,
  queryServiceStatus,
  persistEnvVars,
} from './service-control.js';

// ── Admin allowlist ───────────────────────────────────────────────────────────
// Primary: JARVIS_ADMIN_USER_IDS (comma-separated Discord user IDs)
// Fallback: OWNER_USER_ID, then first entry in ALLOWED_USERS
function getAdminIds() {
  const raw = process.env.JARVIS_ADMIN_USER_IDS
    || process.env.OWNER_USER_ID
    || (process.env.ALLOWED_USERS || '').split(',')[0].trim();
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Returns true if the Discord user ID is in the admin allowlist.
 * @param {string} userId
 * @returns {boolean}
 */
export function isVoiceCmdAdmin(userId) {
  return getAdminIds().includes(userId);
}

// ── Command parser ────────────────────────────────────────────────────────────
/**
 * Pattern: [optional wake-word prefix] <service> <on|off|status|help>
 * Services: voice, stt, tts, chatterbox, kokoro
 * All case-insensitive.
 *
 * @param {string} content - message text (with @mention already stripped)
 * @returns {{ service: string, action: string } | null}
 */
export function parseVoiceCommand(content) {
  const cleaned = content.trim().replace(/\s+/g, ' ').toLowerCase();
  const m = cleaned.match(
    /^(voice|stt|tts|chatterbox|kokoro)\s+(on|off|status|help)$|^(voice)\s+(status|help)$/
  );
  if (!m) return null;
  const service = m[1] || m[3];
  const action  = m[2] || m[4];
  return { service, action };
}

// ── Action executor ───────────────────────────────────────────────────────────
/**
 * Execute a parsed voice command.
 * Returns a Discord-ready reply string (1-3 lines).
 *
 * @param {{ service: string, action: string }} cmd
 * @returns {Promise<string>}
 */
export async function executeVoiceCommand({ service, action }) {
  // ── help ──────────────────────────────────────────────────────────────────
  if (action === 'help' || service === 'voice' && action === 'help') {
    return [
      '**Voice service commands** (admin only):',
      '`voice on/off` — all three (STT + Chatterbox + Kokoro)',
      '`stt on/off` — Whisper STT only',
      '`tts on/off` — both TTS engines (Chatterbox + Kokoro)',
      '`chatterbox on/off` — Chatterbox only',
      '`kokoro on/off` — Kokoro only',
      '`voice status` — current state of all services',
    ].join('\n');
  }

  // ── status ────────────────────────────────────────────────────────────────
  if (action === 'status') {
    const s = await queryServiceStatus();
    const fmt = (name, info) => {
      const dot = info.active === 'active' ? '🟢' : info.active === 'inactive' ? '🔴' : '🟡';
      const env = info.envEnabled ? 'enabled' : 'disabled';
      return `${dot} **${name}**: ${info.active} (env=${env})`;
    };
    return [
      '**Voice service status:**',
      fmt('STT (whisper)', s.stt),
      fmt('Chatterbox TTS', s.chatterbox),
      fmt('Kokoro TTS', s.kokoro),
    ].join('\n');
  }

  // ── on/off ────────────────────────────────────────────────────────────────
  const on = action === 'on';

  if (service === 'voice') {
    // All three
    if (on) {
      const [r1, r2, r3] = await Promise.all([startSTT(), startChatterbox(), startKokoro()]);
      persistEnvVars({
        JARVIS_STT_ENABLED: 'true',
        JARVIS_TTS_CHATTERBOX_ENABLED: 'true',
        JARVIS_TTS_KOKORO_ENABLED: 'true',
      });
      const ok = r1.ok && r2.ok && r3.ok;
      const warn = [r1, r2, r3].filter(r => !r.ok).map(r => r.message).join('; ');
      return ok
        ? '✓ voice on — STT, Chatterbox, Kokoro started'
        : `⚠️ voice on — partial: ${warn}`;
    } else {
      await Promise.all([stopSTT(), stopChatterbox(), stopKokoro()]);
      persistEnvVars({
        JARVIS_STT_ENABLED: 'false',
        JARVIS_TTS_CHATTERBOX_ENABLED: 'false',
        JARVIS_TTS_KOKORO_ENABLED: 'false',
      });
      return '✓ voice off — STT, Chatterbox, Kokoro stopped';
    }
  }

  if (service === 'stt') {
    if (on) {
      const r = await startSTT();
      persistEnvVars({ JARVIS_STT_ENABLED: 'true' });
      return r.ok ? '✓ STT on — whisper started' : `⚠️ STT start failed: ${r.message}`;
    } else {
      await stopSTT();
      persistEnvVars({ JARVIS_STT_ENABLED: 'false' });
      return '✓ STT off — whisper stopped';
    }
  }

  if (service === 'tts') {
    // Both TTS engines
    if (on) {
      const [r1, r2] = await Promise.all([startChatterbox(), startKokoro()]);
      persistEnvVars({
        JARVIS_TTS_CHATTERBOX_ENABLED: 'true',
        JARVIS_TTS_KOKORO_ENABLED: 'true',
      });
      const ok = r1.ok && r2.ok;
      const warn = [r1, r2].filter(r => !r.ok).map(r => r.message).join('; ');
      return ok
        ? '✓ TTS on — Chatterbox, Kokoro started'
        : `⚠️ TTS on — partial: ${warn}`;
    } else {
      await Promise.all([stopChatterbox(), stopKokoro()]);
      persistEnvVars({
        JARVIS_TTS_CHATTERBOX_ENABLED: 'false',
        JARVIS_TTS_KOKORO_ENABLED: 'false',
      });
      return '✓ TTS off — Chatterbox, Kokoro stopped';
    }
  }

  if (service === 'chatterbox') {
    if (on) {
      const r = await startChatterbox();
      persistEnvVars({ JARVIS_TTS_CHATTERBOX_ENABLED: 'true' });
      return r.ok ? '✓ Chatterbox on — started' : `⚠️ Chatterbox start failed: ${r.message}`;
    } else {
      await stopChatterbox();
      persistEnvVars({ JARVIS_TTS_CHATTERBOX_ENABLED: 'false' });
      return '✓ Chatterbox off — stopped';
    }
  }

  if (service === 'kokoro') {
    if (on) {
      const r = await startKokoro();
      persistEnvVars({ JARVIS_TTS_KOKORO_ENABLED: 'true' });
      return r.ok ? '✓ Kokoro on — started' : `⚠️ Kokoro start failed: ${r.message}`;
    } else {
      await stopKokoro();
      persistEnvVars({ JARVIS_TTS_KOKORO_ENABLED: 'false' });
      return '✓ Kokoro off — stopped';
    }
  }

  return null; // unhandled (shouldn't reach here if parseVoiceCommand matched)
}

/**
 * Top-level handler: parse content, check admin, execute, return reply string.
 * Returns null if the message isn't a voice command (so callers can fall through).
 * Returns a string reply if it is a voice command (even if denied).
 *
 * @param {string} content    - message text with @mention stripped
 * @param {string} userId     - Discord user ID of the author
 * @returns {Promise<string|null>}
 */
export async function handleVoiceCommand(content, userId) {
  const cmd = parseVoiceCommand(content);
  if (!cmd) return null;

  if (!isVoiceCmdAdmin(userId)) {
    logger.warn(`[voice-cmd] non-admin ${userId} tried: ${content}`);
    return null; // silently ignore non-admin; consistent with other admin checks
  }

  logger.info(`[voice-cmd] admin ${userId}: ${cmd.service} ${cmd.action}`);

  try {
    const reply = await executeVoiceCommand(cmd);
    return reply;
  } catch (err) {
    logger.warn(`[voice-cmd] executeVoiceCommand error: ${err.message}`);
    return `❌ Command failed: ${err.message}`;
  }
}
