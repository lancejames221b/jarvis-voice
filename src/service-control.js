/**
 * Service Control — programmatic systemctl stop/start on env-var toggle
 *
 * When a JARVIS_*_ENABLED flag is set to 'false', jarvis-voice stops the
 * underlying GPU service so the VRAM is actually freed, not just idle.
 *
 * Unit names are configurable via env vars:
 *
 *   JARVIS_STT_SYSTEMD_UNIT            default: whisper-service.service   (system unit)
 *   JARVIS_TTS_CHATTERBOX_SYSTEMD_UNIT default: jarvis-chatterbox-tts.service (user unit)
 *   JARVIS_TTS_KOKORO_SYSTEMD_UNIT     default: kokoro-tts.service (user unit)
 *
 * Design rules:
 * - Stop on startup when the flag is false. Never auto-start anything at startup.
 * - All failures are logged and silently swallowed — never crash jarvis-voice.
 * - For system units, check sudo -n first; log a clear hint if not available.
 * - For user units, use systemctl --user (no sudo needed).
 * - Service-control never writes to Discord directly — callers build replies.
 */

import { exec } from 'child_process';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(__dirname, '..', '.env');

// ── Unit name overrides ───────────────────────────────────────────────────────
const STT_UNIT        = process.env.JARVIS_STT_SYSTEMD_UNIT
                          || 'whisper-service.service';
const CHATTERBOX_UNIT = process.env.JARVIS_TTS_CHATTERBOX_SYSTEMD_UNIT
                          || 'jarvis-chatterbox-tts.service';
const KOKORO_UNIT     = process.env.JARVIS_TTS_KOKORO_SYSTEMD_UNIT
                          || 'kokoro-tts.service';

// ── Internal helper ───────────────────────────────────────────────────────────
/**
 * Run a shell command, resolve with stdout on success, reject with Error on failure.
 * @param {string} cmd
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<string>}
 */
function run(cmd, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim();
        reject(new Error(msg || `exit ${err.code}`));
      } else {
        resolve((stdout || '').trim());
      }
    });
    child.on('error', reject);
  });
}

// ── System-level unit (requires sudo) ────────────────────────────────────────
async function stopSystemUnit(unit) {
  try {
    await run('sudo -n true');
  } catch {
    logger.warn(
      `[service-control] Cannot stop system unit '${unit}' — sudo NOPASSWD not available for this user.\n` +
      `  To enable programmatic service control, add this line to /etc/sudoers.d/jarvis-voice:\n` +
      `    ${process.env.USER || 'generic'} ALL=(ALL) NOPASSWD: /bin/systemctl stop ${unit}, /bin/systemctl start ${unit}\n` +
      `  (Run: sudo visudo -f /etc/sudoers.d/jarvis-voice)`
    );
    return;
  }

  try {
    const status = await run(`sudo -n systemctl is-active ${unit}`).catch(() => 'inactive');
    if (status !== 'active' && status !== 'activating') {
      logger.info(`[service-control] System unit '${unit}' is already stopped (${status}) — skipping`);
      return;
    }
    await run(`sudo -n systemctl stop ${unit}`);
    logger.info(`[service-control] Stopped system unit '${unit}' (VRAM freed)`);
  } catch (err) {
    logger.warn(`[service-control] Failed to stop system unit '${unit}': ${err.message}`);
  }
}

/**
 * Start a systemd SYSTEM unit.
 * @param {string} unit
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function startSystemUnit(unit) {
  try {
    await run('sudo -n true');
  } catch {
    const hint = 'sudo NOPASSWD not configured — see /etc/sudoers.d/jarvis-voice';
    logger.warn(`[service-control] Cannot start system unit '${unit}' — ${hint}`);
    return { ok: false, message: hint };
  }

  try {
    const status = await run(`sudo -n systemctl is-active ${unit}`).catch(() => 'inactive');
    if (status === 'active') {
      logger.info(`[service-control] System unit '${unit}' already active`);
      return { ok: true, message: 'already active' };
    }
    await run(`sudo -n systemctl start ${unit}`);
    logger.info(`[service-control] Started system unit '${unit}'`);
    return { ok: true, message: 'started' };
  } catch (err) {
    logger.warn(`[service-control] Failed to start system unit '${unit}': ${err.message}`);
    return { ok: false, message: err.message };
  }
}

// ── User-level unit (no sudo needed) ─────────────────────────────────────────
async function stopUserUnit(unit) {
  try {
    const status = await run(`systemctl --user is-active ${unit}`).catch(() => 'inactive');
    if (status !== 'active' && status !== 'activating') {
      logger.info(`[service-control] User unit '${unit}' is already stopped (${status}) — skipping`);
      return;
    }
    await run(`systemctl --user stop ${unit}`);
    logger.info(`[service-control] Stopped user unit '${unit}' (VRAM freed)`);
  } catch (err) {
    logger.warn(`[service-control] Failed to stop user unit '${unit}': ${err.message}`);
  }
}

/**
 * Start a systemd USER unit.
 * @param {string} unit
 * @param {object} [opts]
 * @param {boolean} [opts.enableFirst] - run `systemctl --user enable` before start
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function startUserUnit(unit, { enableFirst = false } = {}) {
  try {
    if (enableFirst) {
      await run(`systemctl --user enable ${unit}`).catch(e =>
        logger.warn(`[service-control] enable ${unit} (non-fatal): ${e.message}`)
      );
    }
    const status = await run(`systemctl --user is-active ${unit}`).catch(() => 'inactive');
    if (status === 'active') {
      logger.info(`[service-control] User unit '${unit}' already active`);
      return { ok: true, message: 'already active' };
    }
    await run(`systemctl --user start ${unit}`);
    logger.info(`[service-control] Started user unit '${unit}'`);
    return { ok: true, message: 'started' };
  } catch (err) {
    logger.warn(`[service-control] Failed to start user unit '${unit}': ${err.message}`);
    return { ok: false, message: err.message };
  }
}

// ── .env persistence ──────────────────────────────────────────────────────────
/**
 * Read the .env file, update one or more KEY=value lines atomically, write back.
 * Keys that don't exist are appended. Other lines are untouched.
 *
 * Also updates process.env so the running process reflects the new values
 * immediately (without restart).
 *
 * @param {Record<string, string>} updates - e.g. { JARVIS_STT_ENABLED: 'false' }
 */
export function persistEnvVars(updates) {
  let raw = '';
  try {
    if (existsSync(ENV_FILE)) raw = readFileSync(ENV_FILE, 'utf8');
  } catch (err) {
    logger.warn(`[service-control] Could not read .env: ${err.message}`);
  }

  const lines = raw.split('\n');
  const pending = new Set(Object.keys(updates));

  const updated = lines.map(line => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (m && pending.has(m[1])) {
      pending.delete(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });

  // Append keys that weren't present in the file
  for (const key of pending) {
    updated.push(`${key}=${updates[key]}`);
  }

  try {
    const tmp = `${ENV_FILE}.${Date.now()}.tmp`;
    writeFileSync(tmp, updated.join('\n'), 'utf8');
    renameSync(tmp, ENV_FILE);
    // Mirror into process.env so behaviour changes immediately
    for (const [k, v] of Object.entries(updates)) {
      process.env[k] = v;
    }
    logger.info(`[service-control] .env updated: ${Object.keys(updates).join(', ')}`);
  } catch (err) {
    logger.warn(`[service-control] Failed to write .env: ${err.message}`);
  }
}

// ── Service status query ──────────────────────────────────────────────────────
/**
 * Query live systemd status for all three voice services.
 * @returns {Promise<{stt: object, chatterbox: object, kokoro: object}>}
 */
export async function queryServiceStatus() {
  const [sttActive, cbActive, kokoroActive] = await Promise.all([
    // Try sudo first for system unit; fall back to unprivileged is-active
    run(`sudo -n systemctl is-active ${STT_UNIT}`)
      .catch(() => run(`systemctl is-active ${STT_UNIT}`))
      .catch(() => 'unknown'),
    run(`systemctl --user is-active ${CHATTERBOX_UNIT}`).catch(() => 'unknown'),
    run(`systemctl --user is-active ${KOKORO_UNIT}`).catch(() => 'unknown'),
  ]);

  return {
    stt: {
      unit: STT_UNIT,
      active: sttActive,
      envEnabled: process.env.JARVIS_STT_ENABLED !== 'false',
    },
    chatterbox: {
      unit: CHATTERBOX_UNIT,
      active: cbActive,
      envEnabled: process.env.JARVIS_TTS_CHATTERBOX_ENABLED !== 'false',
    },
    kokoro: {
      unit: KOKORO_UNIT,
      active: kokoroActive,
      envEnabled: process.env.JARVIS_TTS_KOKORO_ENABLED !== 'false',
    },
  };
}

// ── Public named start/stop helpers ──────────────────────────────────────────

/** Stop STT whisper (system unit, requires sudo). */
export async function stopSTT() {
  await stopSystemUnit(STT_UNIT);
  return { ok: true, unit: STT_UNIT };
}

/** Start STT whisper (system unit, requires sudo). */
export async function startSTT() {
  return startSystemUnit(STT_UNIT);
}

/** Stop Chatterbox TTS (user unit). */
export async function stopChatterbox() {
  await stopUserUnit(CHATTERBOX_UNIT);
  return { ok: true, unit: CHATTERBOX_UNIT };
}

/** Start Chatterbox TTS (user unit). */
export async function startChatterbox() {
  return startUserUnit(CHATTERBOX_UNIT);
}

/** Stop Kokoro TTS (user systemd unit). */
export async function stopKokoro() {
  await stopUserUnit(KOKORO_UNIT);
  return { ok: true, unit: KOKORO_UNIT };
}

/**
 * Start Kokoro TTS (user systemd unit).
 * Re-enables the unit first — it was disabled on 2026-05-06 to prevent
 * auto-start at boot. Enabling restores the intended restart-on-boot behaviour.
 */
export async function startKokoro() {
  return startUserUnit(KOKORO_UNIT, { enableFirst: true });
}

// ── Startup hook ──────────────────────────────────────────────────────────────

/**
 * Called once at startup. For each disabled flag, stop the corresponding service.
 * All errors are caught and logged — never throws.
 *
 * @returns {Promise<void>}
 */
export async function applyServiceToggles() {
  const sttEnabled        = process.env.JARVIS_STT_ENABLED         !== 'false';
  const chatterboxEnabled = process.env.JARVIS_TTS_CHATTERBOX_ENABLED !== 'false';
  const kokoroEnabled     = process.env.JARVIS_TTS_KOKORO_ENABLED   !== 'false';

  const tasks = [];

  if (!sttEnabled) {
    logger.info(`[service-control] JARVIS_STT_ENABLED=false — stopping system unit '${STT_UNIT}'`);
    tasks.push(stopSystemUnit(STT_UNIT));
  }

  if (!chatterboxEnabled) {
    logger.info(`[service-control] JARVIS_TTS_CHATTERBOX_ENABLED=false — stopping user unit '${CHATTERBOX_UNIT}'`);
    tasks.push(stopUserUnit(CHATTERBOX_UNIT));
  }

  if (!kokoroEnabled) {
    logger.info(`[service-control] JARVIS_TTS_KOKORO_ENABLED=false — stopping user unit '${KOKORO_UNIT}'`);
    tasks.push(stopUserUnit(KOKORO_UNIT));
  }

  if (tasks.length === 0) {
    logger.info('[service-control] All voice services enabled — no service stops needed');
    return;
  }

  await Promise.allSettled(tasks);
}

// ── Exported config values ────────────────────────────────────────────────────
export const SERVICE_UNITS = {
  STT_UNIT,
  CHATTERBOX_UNIT,
  KOKORO_UNIT,
};
