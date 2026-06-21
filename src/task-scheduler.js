import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const SCHEDULES_PATH = join(DATA_DIR, 'schedules.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

let schedules = loadSchedules();
let _dispatchFn = null;

function loadSchedules() {
  try {
    if (existsSync(SCHEDULES_PATH)) {
      const data = JSON.parse(readFileSync(SCHEDULES_PATH, 'utf8'));
      return data.schedules || [];
    }
  } catch (err) {
    logger.error('[scheduler] Failed to load schedules:', err.message);
  }
  return [];
}

let _saveTimeout = null;
function saveSchedules() {
  if (_saveTimeout) clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(() => {
    try {
      writeFileSync(SCHEDULES_PATH, JSON.stringify({ schedules, savedAt: new Date().toISOString() }, null, 2));
    } catch (err) {
      logger.error('[scheduler] Failed to save schedules:', err.message);
    }
  }, 500);
}

async function tick() {
  const now = Date.now();
  const due = schedules.filter(s => s.enabled && s.nextRunAt <= now);
  for (const sched of due) {
    // re-arm: daily schedules use next occurrence of dailyAt; interval schedules use now+intervalMs
    if (sched.dailyAt) {
      sched.nextRunAt = computeNextDailyRun(sched.dailyAt);
    } else {
      sched.nextRunAt = now + sched.intervalMs;
    }
    sched.lastRunAt = now;
    sched.runCount++;
    saveSchedules();
    try {
      const result = await _dispatchFn(sched);
      if (sched.terminationPhrase && result?.text?.toLowerCase().includes(sched.terminationPhrase.toLowerCase())) {
        deleteSchedule(sched.id);
        return;
      }
      if (sched.maxRuns > 0 && sched.runCount >= sched.maxRuns) {
        deleteSchedule(sched.id);
      }
    } catch (err) {
      logger.warn(`[scheduler] tick error ${sched.id}: ${err.message}`);
    }
  }
}

export function computeNextDailyRun(hhmm, fromMs = Date.now()) {
  const [h, m] = hhmm.split(':').map(Number);
  const now = new Date(fromMs);
  const candidate = new Date(now);
  candidate.setHours(h, m, 0, 0);
  if (candidate.getTime() > now.getTime()) return candidate.getTime();
  candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

let _tickInterval = null;

export function initScheduler(dispatchFn) {
  _dispatchFn = dispatchFn;
  if (_tickInterval) return; // already running — just updated dispatchFn
  const tickMs = parseInt(process.env.SCHEDULER_TICK_MS || '30000');
  _tickInterval = setInterval(tick, tickMs);
  logger.info(`[scheduler] started — ${schedules.length} schedule(s) loaded, tick every ${tickMs}ms`);
}

export function createSchedule({ prompt, promptContext, intervalMs, channelId, threadId, userId, terminationPhrase, maxRuns, mode, model, shellCmd, dailyAt }) {
  const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const entry = {
    id,
    prompt,
    promptContext: promptContext || null, // for shell+LLM hybrid: context template prepended to shell stdout
    mode: mode || 'llm',           // 'shell' | 'llm'
    model: model || 'haiku',       // gateway model alias for llm mode
    shellCmd: shellCmd || null,    // shell command string for shell mode
    intervalMs,
    dailyAt: dailyAt || null,      // "HH:MM" 24h local time — overrides intervalMs for daily fire
    nextRunAt: dailyAt
      ? computeNextDailyRun(dailyAt)
      : Date.now() + intervalMs,
    channelId,
    threadId: threadId || null,    // post back to thread if created from one
    userId,
    createdAt: Date.now(),
    lastRunAt: null,
    runCount: 0,
    maxRuns: maxRuns || 0,
    terminationPhrase: terminationPhrase || null,
    enabled: true,
  };
  schedules.push(entry);
  saveSchedules();
  logger.info(`[scheduler] created ${id}${dailyAt ? ` — daily at ${dailyAt}` : ` — every ${intervalMs}ms`}, prompt: "${prompt.substring(0, 60)}"`);
  return entry;
}

export function listSchedules() {
  return schedules;
}

export function deleteSchedule(id) {
  const before = schedules.length;
  schedules = schedules.filter(s => s.id !== id);
  if (schedules.length !== before) {
    saveSchedules();
    logger.info(`[scheduler] deleted ${id}`);
  }
}

export function pauseSchedule(id) {
  const s = schedules.find(s => s.id === id);
  if (s) { s.enabled = false; saveSchedules(); }
}

export function resumeSchedule(id) {
  const s = schedules.find(s => s.id === id);
  if (s) { s.enabled = true; saveSchedules(); }
}
