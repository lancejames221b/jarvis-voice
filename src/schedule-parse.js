/**
 * schedule-parse.js — robust natural-language interval/duration parsing for
 * the scheduler, shared by the text path (index.js) and the voice path
 * (command-dispatch.js).
 *
 * Handles the phrasings the old brittle `every\s+\d+` regex missed:
 *   - "every minute" / "every hour"        → implicit count of 1
 *   - "every five minutes" (spelled-out)   → 5
 *   - "monitor it for five minutes"        → run-for-a-window (maxRuns derived)
 *   - "every couple of minutes"            → 2
 *   - "every half hour"                    → 30 min
 */

// Spelled-out cardinals → number. Covers the range a person actually speaks
// for an interval ("every forty-five seconds" is about the ceiling).
const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  couple: 2, few: 3, several: 4, half: 0.5,
};

const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 };

function _unitKey(unitWord) {
  const u = unitWord.toLowerCase();
  if (u.startsWith('h')) return 'h';
  if (u.startsWith('m') && !u.startsWith('mil')) return 'm'; // minute/min/m (not "millisecond")
  if (u.startsWith('s')) return 's';
  return null;
}

// Turn a numeric token (digits OR a number-word OR null) into a count.
function _toCount(token, fallback = 1) {
  if (token == null || token === '') return fallback;
  const t = String(token).toLowerCase().trim();
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  // "forty five" / "forty-five"
  const parts = t.split(/[\s-]+/).filter(Boolean);
  if (parts.length === 2 && NUMBER_WORDS[parts[0]] != null && NUMBER_WORDS[parts[1]] != null
      && NUMBER_WORDS[parts[0]] >= 20 && NUMBER_WORDS[parts[1]] < 10) {
    return NUMBER_WORDS[parts[0]] + NUMBER_WORDS[parts[1]];
  }
  if (NUMBER_WORDS[t] != null) return NUMBER_WORDS[t];
  return fallback;
}

const _NUM = '\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty|forty|fifty|sixty|couple|few|several|half';
const _UNIT = 'seconds?|secs?|minutes?|mins?|hours?|hrs?|s|m|h';

/**
 * Parse a recurring interval from spoken/typed text.
 * Returns { intervalMs, matchText } or null if no recurring intent.
 *
 * Matches:
 *   "every 5 minutes", "every five minutes", "every minute",
 *   "every couple of minutes", "every half hour", "every 30 sec"
 */
export function parseInterval(text) {
  if (!text) return null;
  // "every [N] [of] <unit>"  — N optional (→ 1), optional "of" after couple/few
  const re = new RegExp(
    `\\bevery\\s+(?:(${_NUM})\\s+(?:of\\s+)?)?(${_UNIT})\\b`, 'i');
  const m = text.match(re);
  if (!m) return null;
  const unit = _unitKey(m[2]);
  if (!unit) return null;
  const count = _toCount(m[1], 1);
  const intervalMs = Math.max(1000, Math.round(count * UNIT_MS[unit]));
  return { intervalMs, matchText: m[0] };
}

/**
 * Parse a "run for a window" duration — "for five minutes", "for the next
 * 2 hours", "for 30 seconds". Returns { durationMs, matchText } or null.
 */
export function parseDuration(text) {
  if (!text) return null;
  const re = new RegExp(
    `\\bfor\\s+(?:the\\s+next\\s+)?(${_NUM})\\s+(${_UNIT})\\b`, 'i');
  const m = text.match(re);
  if (!m) return null;
  const unit = _unitKey(m[2]);
  if (!unit) return null;
  const count = _toCount(m[1], 1);
  const durationMs = Math.max(1000, Math.round(count * UNIT_MS[unit]));
  return { durationMs, matchText: m[0] };
}

/**
 * True when the text expresses a recurring OR windowed monitoring intent that
 * the scheduler should handle. This is the broadened trigger that replaces the
 * old `every\s+\d+...` test.
 *
 * - recurring interval present ("every minute", "every 5 min"), OR
 * - a monitoring verb + a "for <duration>" window ("monitor it for 5 minutes")
 */
export function isScheduleIntent(text) {
  if (!text) return false;
  if (parseInterval(text)) return true;
  // Windowed monitoring: needs both a monitor-ish verb AND a duration, so we
  // don't grab "set a timer for 5 minutes" or "wait for 5 minutes".
  const hasMonitorVerb = /\b(monitor|watch|keep an eye|check|track|poll|ping|tail|observe)\b/i.test(text);
  if (hasMonitorVerb && parseDuration(text)) return true;
  return false;
}

/**
 * Infer execution mode and shell command from the monitoring subject.
 *
 * Returns { mode, shellCmd } where mode is 'shell' or 'llm'.
 * When mode === 'shell', shellCmd is the command whose stdout will be fed
 * to an LLM for interpretation (shell+LLM hybrid).
 * When mode === 'llm', shellCmd is null.
 */
function _inferScheduleMode(prompt) {
  // Torrent / qBittorrent / download monitoring
  if (/torrent|qbt|qbittorrent|download(s|ing)?/i.test(prompt)) {
    return {
      mode: 'shell',
      shellCmd: 'curl -s http://127.0.0.1:8080/api/v2/torrents/info',
    };
  }

  // HTTP / URL reachability monitoring
  const urlMatch = prompt.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    return {
      mode: 'shell',
      shellCmd: `curl -o /dev/null -s -w "%{http_code}" ${urlMatch[0]}`,
    };
  }

  // Disk / memory / CPU
  if (/\b(disk\s+space|disk\s+usage|free\s+space|storage|df\b)/i.test(prompt)) {
    return { mode: 'shell', shellCmd: 'df -h' };
  }
  if (/\b(memory|ram|swap)\b/i.test(prompt)) {
    return { mode: 'shell', shellCmd: 'free -h' };
  }
  if (/\b(cpu|load\s+avg(erage)?)\b/i.test(prompt)) {
    return { mode: 'shell', shellCmd: "uptime && top -bn1 | head -5" };
  }

  // Process / service / daemon liveness
  // e.g. "check if nginx is running", "is sshd alive", "monitor the cron service"
  const procMatch = prompt.match(
    /(?:check\s+(?:if\s+)?|is\s+|monitor\s+(?:the\s+)?|watch\s+(?:the\s+)?)(\w+)\s+(?:is\s+)?(?:running|up|alive|active)/i,
  );
  if (procMatch) {
    const procName = procMatch[1];
    return {
      mode: 'shell',
      shellCmd: `pgrep -a ${procName} && systemctl is-active ${procName} 2>/dev/null || echo "not found"`,
    };
  }
  // Broader: "check/monitor process/service/daemon"
  if (/\b(process|service|daemon)\b.*\b(running|alive|up|active)\b/i.test(prompt) ||
      /\b(running|alive|up|active)\b.*\b(process|service|daemon)\b/i.test(prompt)) {
    return { mode: 'shell', shellCmd: 'ps aux | head -20' };
  }

  // Default: LLM-only (no shell command)
  return { mode: 'llm', shellCmd: null };
}

/**
 * Full parse → schedule params. Resolves interval, duration→maxRuns,
 * "until <phrase>" termination, model override, mode/shellCmd, and strips
 * only interval/duration tokens to leave a meaningful monitoring prompt.
 *
 * Returns { intervalMs, maxRuns, terminationPhrase, model, mode, shellCmd, prompt, promptContext }
 * or null if no schedule intent detected.
 *
 * promptContext (shell mode only) — the full LLM prompt template that the
 * dispatch fn should use after prepending actual shell stdout.
 */
export function parseScheduleRequest(text) {
  if (!text || !isScheduleIntent(text)) return null;

  const interval = parseInterval(text);
  const duration = parseDuration(text);

  // Default interval when only a window is given ("monitor for 5 minutes"):
  // poll once a minute, or every 1/5 of the window, whichever is coarser, so a
  // short window still yields a few checks but doesn't hammer.
  let intervalMs;
  if (interval) {
    intervalMs = interval.intervalMs;
  } else if (duration) {
    intervalMs = Math.min(60_000, Math.max(10_000, Math.round(duration.durationMs / 5)));
  } else {
    intervalMs = 60_000;
  }

  // maxRuns from a window duration.
  let maxRuns = 0;
  if (duration) {
    maxRuns = Math.max(1, Math.floor(duration.durationMs / intervalMs));
  }

  // "until <phrase>" — phrase-based termination (ignore if it's actually a duration).
  let terminationPhrase = null;
  const untilMatch = text.match(/\buntil\s+(.+?)(?:\.|$)/i);
  if (untilMatch) {
    const phrase = untilMatch[1].trim();
    if (!/^(?:a|an|the\s+next\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|half|couple|few)\s*(second|minute|hour|min|sec|s|m|h)/i.test(phrase)) {
      terminationPhrase = phrase;
    }
  }

  // Normalise common "done/finished/complete" variants to the sentinel 'DONE'
  // so the dispatch fn can do a simple string comparison.
  if (terminationPhrase) {
    if (/^(all\s+)?(done|finished?|complete[d]?|through|success(ful)?)$/i.test(terminationPhrase)) {
      terminationPhrase = 'DONE';
    } else if (/^when\s+(all\s+)?(done|finished?|complete[d]?)/i.test(terminationPhrase)) {
      terminationPhrase = 'DONE';
    }
  }
  // Also catch bare "when finished/done/complete" patterns not caught by the
  // until-match regex (e.g. "stop when done", "when all done").
  if (!terminationPhrase) {
    if (/\b(stop\s+when|when\s+(all\s+)?(done|finished?|complete[d]?))\b/i.test(text)) {
      terminationPhrase = 'DONE';
    }
  }

  // Optional model override.
  const aliases = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus', 'claude-haiku': 'haiku', 'claude-sonnet': 'sonnet', 'claude-opus': 'opus' };
  const mm = text.match(/\busing\s+(haiku|sonnet|opus|claude-haiku|claude-sonnet|claude-opus)\b/i)
    || text.match(/\b(haiku|sonnet|opus):/i);
  const model = mm ? (aliases[mm[1].toLowerCase()] || 'haiku') : 'haiku';

  // Strip ONLY scheduling control tokens — interval ("every 2 minutes"),
  // duration ("for 5 minutes"), "until <phrase>", and model hints.
  // Do NOT strip the monitoring verb or subject nouns.
  let prompt = text
    .replace(interval ? interval.matchText : '', '')
    .replace(duration ? duration.matchText : '', '')
    .replace(/\buntil\s+.+?(?:\.|$)/gi, '')
    .replace(/\bwhen\s+(?:all\s+)?(?:done|finished?|complete[d]?)\b/gi, '')
    .replace(/\bstop\s+when\s+(?:done|finished?|complete[d]?)\b/gi, '')
    .replace(/\busing\s+(haiku|sonnet|opus|claude-haiku|claude-sonnet|claude-opus)\b/gi, '')
    .replace(/\b(haiku|sonnet|opus):/gi, '')
    .replace(/^\s*(jarvis[,:]?\s+)/i, '')
    .replace(/^\s*(hey|ok|okay)[,:\s]+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Fall back to the full original text if stripping left nothing useful.
  if (!prompt || prompt.length < 3) prompt = text.trim();

  // Infer execution mode from the remaining meaningful prompt.
  const { mode, shellCmd } = _inferScheduleMode(prompt);

  // Build promptContext for shell+LLM hybrid mode.
  // The dispatch fn prepends the actual shell stdout before this block.
  let promptContext = null;
  if (mode === 'shell') {
    const doneClause = terminationPhrase === 'DONE'
      ? ' If the condition is fully met (e.g. all torrents complete, service up, target reached), reply with exactly DONE on its own line.'
      : '';
    promptContext =
      `[SHELL OUTPUT BELOW]\n` +
      `Original request: ${prompt}\n` +
      `Instructions: Analyze the shell output and summarize the current status concisely.${doneClause}`;
  } else if (terminationPhrase === 'DONE') {
    // LLM mode with a done-check: append instruction to the prompt itself.
    prompt = `${prompt}. Reply with DONE when the condition is fully met.`;
  }

  return { intervalMs, maxRuns, terminationPhrase, model, mode, shellCmd, prompt, promptContext };
}
