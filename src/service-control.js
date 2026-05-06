/**
 * Service Control — programmatic systemctl / docker stop on env-var toggle
 *
 * When a JARVIS_*_ENABLED flag is set to 'false', jarvis-voice stops the
 * underlying GPU service so the VRAM is actually freed, not just idle.
 *
 * Unit / container names are configurable via env vars so GitHub users can
 * adapt them to their own distro / setup without touching this file:
 *
 *   JARVIS_STT_SYSTEMD_UNIT          default: whisper-service.service   (system unit)
 *   JARVIS_TTS_CHATTERBOX_SYSTEMD_UNIT default: jarvis-chatterbox-tts.service (user unit)
 *   JARVIS_TTS_KOKORO_DOCKER_NAME    default: kokoro  (docker container name OR
 *                                    falls back to port-8880 lookup if name not found)
 *
 * Design rules:
 * - Stop on startup when the flag is false. Never auto-start anything.
 * - All failures are logged and silently swallowed — never crash jarvis-voice.
 * - For system units, check sudo -n first; log a clear hint if not available.
 * - For user units, use systemctl --user (no sudo needed).
 * - For docker, exec `docker stop` (user must be in the docker group).
 */

import { exec } from 'child_process';
import logger from './logger.js';

// ── Unit / container name overrides ──────────────────────────────────────────
const STT_UNIT        = process.env.JARVIS_STT_SYSTEMD_UNIT
                          || 'whisper-service.service';
const CHATTERBOX_UNIT = process.env.JARVIS_TTS_CHATTERBOX_SYSTEMD_UNIT
                          || 'jarvis-chatterbox-tts.service';
const KOKORO_DOCKER   = process.env.JARVIS_TTS_KOKORO_DOCKER_NAME
                          || 'kokoro';

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
    // belt-and-suspenders: also reject on timeout (exec timeout only kills the child)
    child.on('error', reject);
  });
}

// ── System-level unit (requires sudo) ────────────────────────────────────────
/**
 * Stop a systemd SYSTEM unit (e.g. whisper-service.service).
 * Checks for sudo -n capability first; logs a helpful hint if missing.
 * @param {string} unit
 * @returns {Promise<void>}
 */
async function stopSystemUnit(unit) {
  // First probe: can we run sudo without a password?
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
    // Check if unit is actually running before attempting stop (avoid spurious errors)
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

// ── User-level unit (no sudo needed) ─────────────────────────────────────────
/**
 * Stop a systemd USER unit (e.g. jarvis-chatterbox-tts.service).
 * @param {string} unit
 * @returns {Promise<void>}
 */
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

// ── Docker container ──────────────────────────────────────────────────────────
/**
 * Stop a Docker container by name.  If the named container isn't found, falls
 * back to finding whatever is listening on port 8880 (the default Kokoro port).
 * @param {string} containerName
 * @returns {Promise<void>}
 */
async function stopDockerContainer(containerName) {
  // Verify docker is accessible (user must be in docker group)
  try {
    await run('docker info --format "{{.ServerVersion}}"');
  } catch (err) {
    logger.warn(
      `[service-control] Cannot control Docker — docker daemon unreachable or user not in docker group.\n` +
      `  Error: ${err.message}\n` +
      `  Fix: sudo usermod -aG docker ${process.env.USER || 'generic'}  (then re-login)`
    );
    return;
  }

  // Check if the named container exists and is running
  let target = containerName;
  try {
    const running = await run(`docker ps --filter name=^/${containerName}$ --format "{{.Names}}"`);
    if (!running) {
      // Name not found — try port-based fallback
      const byPort = await run('docker ps --filter publish=8880 --format "{{.Names}}"').catch(() => '');
      if (!byPort) {
        logger.info(`[service-control] Docker container '${containerName}' not running (port 8880 also clear) — skipping`);
        return;
      }
      target = byPort.split('\n')[0].trim();
      logger.info(`[service-control] Container '${containerName}' not found by name; using port-8880 match: '${target}'`);
    }
    await run(`docker stop ${target}`);
    logger.info(`[service-control] Stopped Docker container '${target}' (VRAM freed)`);
  } catch (err) {
    logger.warn(`[service-control] Failed to stop Docker container '${target}': ${err.message}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

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
    logger.info(`[service-control] JARVIS_TTS_KOKORO_ENABLED=false — stopping Docker container '${KOKORO_DOCKER}'`);
    tasks.push(stopDockerContainer(KOKORO_DOCKER));
  }

  if (tasks.length === 0) {
    logger.info('[service-control] All voice services enabled — no service stops needed');
    return;
  }

  // Run all stops in parallel; await all so errors are caught before startup continues
  await Promise.allSettled(tasks);
}

// ── Exported config values (useful for tests / docs) ─────────────────────────
export const SERVICE_UNITS = {
  STT_UNIT,
  CHATTERBOX_UNIT,
  KOKORO_DOCKER,
};
