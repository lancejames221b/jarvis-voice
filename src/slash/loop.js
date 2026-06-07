/**
 * loop.js — /loop slash command.
 *
 * Runs a prompt on a repeating interval inside a Discord thread, using the
 * gateway's warm --resume session so context accumulates across iterations.
 * Each response is posted as a new message in the thread.
 *
 * /loop prompt:<text> [interval:<30s|1m|5m|...>] [model:<haiku|sonnet|opus>] [max:<N>]
 *
 * - No interval → self-pacing: waits for the previous response before firing again
 * - "stop", "done", /stop in the thread → cancels the loop
 * - terminates when response contains "LOOP_DONE" or max runs reached
 */

import { SlashCommandBuilder } from 'discord.js';
import { exec } from 'node:child_process';
import logger from '../logger.js';
import { speakText } from '../voice/speech-output.js';

const GATEWAY_URL   = process.env.JARVIS_GATEWAY_URL || 'http://127.0.0.1:22100';
const GATEWAY_TOKEN = process.env.JARVIS_GATEWAY_TOKEN || '';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';

// Active loops keyed by threadId → { cancelled, iteration, currentAc, sleepTimer, sleepResolve }
export const _activeLoops = new Map();

export const LOOP_CMD = new SlashCommandBuilder()
  .setName('loop')
  .setDescription('Run a prompt on a repeating loop in a thread (warm session, context accumulates)')
  .addStringOption(opt =>
    opt.setName('prompt').setDescription('The task/prompt to run each iteration').setRequired(true))
  .addStringOption(opt =>
    opt.setName('interval').setDescription('Interval e.g. 30s, 1m, 5m (omit = self-pacing)').setRequired(false))
  .addStringOption(opt =>
    opt.setName('model').setDescription('Model: haiku | sonnet | opus (default sonnet)').setRequired(false))
  .addIntegerOption(opt =>
    opt.setName('max').setDescription('Max iterations before auto-stop (0 = unlimited)').setRequired(false))
  .addStringOption(opt =>
    opt.setName('verify').setDescription('Shell command that gates completion (e.g. "pytest -q"); loop is done only when it passes').setRequired(false));

function _discordApi(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`https://discord.com/api/v10${path}`, opts);
}

async function _postToThread(threadId, content) {
  try {
    await _discordApi(`/channels/${threadId}/messages`, 'POST', {
      content: content.substring(0, 2000),
    });
  } catch (err) {
    logger.warn(`[loop] failed to post to thread ${threadId}: ${err.message}`);
  }
}

async function _callGateway(prompt, channelKey, model, signal) {
  const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      user: channelKey,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gateway error ${res.status}: ${err.substring(0, 200)}`);
  }

  let fullText = '';
  const reader = res.body;
  const decoder = new TextDecoder();
  let buf = '';

  for await (const chunk of reader) {
    if (signal?.aborted) break;
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content || '';
        fullText += delta;
      } catch { /* skip malformed */ }
    }
  }

  return fullText.trim();
}

function _parseInterval(str) {
  if (!str) return null;
  const m = str.match(/^(\d+)\s*(s|sec|second|m|min|minute|h|hr|hour)s?$/i);
  if (!m) return null;
  const n = parseInt(m[1]);
  const u = m[2].toLowerCase();
  if (u.startsWith('s')) return n * 1000;
  if (u.startsWith('m')) return n * 60_000;
  if (u.startsWith('h')) return n * 3600_000;
  return null;
}

// ── Verifier gate ────────────────────────────────────────────────────────────
//
// A loop may carry a user-provided verify command (e.g. "pytest -q", "npm test").
// After each model turn we run it ON THIS BOX (jarvis-voice runs on the same host,
// `generic`, where the agent's shell work lands), with a hard timeout. The loop is
// only declared "verified complete" when this command passes (exit 0, or its output
// contains an optional success token). The verify command is fixed once at loop
// start from the user's words — it is NEVER re-derived by the model each turn, so a
// confused model can't widen what gets executed.
const VERIFY_TIMEOUT_MS = 120_000;

/**
 * Run the loop's verify command. Resolves to { ok, code, output } and never rejects.
 * ok = exit 0 AND (no successToken given OR output contains successToken).
 */
function _runVerify(verifyCmd, successToken = null) {
  return new Promise((resolve) => {
    let done = false;
    const child = exec(verifyCmd, { timeout: VERIFY_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (done) return;
      done = true;
      const output = `${stdout || ''}${stderr || ''}`.trim();
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      let ok = code === 0;
      if (ok && successToken) ok = output.toLowerCase().includes(successToken.toLowerCase());
      resolve({ ok, code, output });
    });
    child.on('error', () => {
      if (done) return;
      done = true;
      resolve({ ok: false, code: -1, output: `verify command failed to start` });
    });
  });
}

// ── STATUS contract ───────────────────────────────────────────────────────────
//
// Each iteration the model ends with one of:
//   STATUS: WORKING
//   STATUS: BLOCKED <reason>
//   STATUS: DONE
// Parse the LAST such line (model may discuss the contract earlier in its reply).
function _parseStatus(text) {
  if (!text) return { status: 'WORKING', reason: '' };
  const matches = [...text.matchAll(/^\s*STATUS:\s*(WORKING|BLOCKED|DONE)\b[ \t]*(.*)$/gim)];
  if (!matches.length) return { status: 'WORKING', reason: '' };
  const last = matches[matches.length - 1];
  return { status: last[1].toUpperCase(), reason: (last[2] || '').trim() };
}

// Normalize a blocked reason for "same block twice" comparison.
function _normReason(r) {
  return (r || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Convergence guard ───────────────────────────────────────────────────────────
//
// Cheap fingerprint of an iteration's output (strip the STATUS line, loop header,
// digits/whitespace) + a token-overlap similarity. Three near-identical iterations
// in a row = no progress → escalate as blocked.
const CONVERGENCE_THRESHOLD = 0.85;   // >85% token overlap = "same"
const CONVERGENCE_STREAK    = 3;       // 3 near-identical iterations in a row

function _fingerprint(text) {
  return (text || '')
    .replace(/^\s*STATUS:.*$/gim, '')
    .replace(/\*\*\[Loop[^\]]*\]\*\*/gi, '')
    .replace(/\d+/g, '')
    .toLowerCase()
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _similar(a, b) {
  if (!a || !b) return 0;
  const sa = new Set(a.split(' '));
  const sb = new Set(b.split(' '));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0;
}

// ── Natural-language verify-command extraction ──────────────────────────────────
//
// Pull a verify command out of "until `<cmd>` works/passes/is green" phrasing.
// Returns { verifyCmd, successToken } or null. Only a backtick/quote-delimited
// command is accepted as a shell command — we never run free text as a command.
function _extractVerify(content) {
  if (!content) return null;
  // until `<cmd>` passes/works/green  |  until "<cmd>" ...
  const m = content.match(/until\s+[`"']([^`"']{2,200})[`"']\s*(?:passes|works|is\s+green|succeeds|exits?\s+(?:0|clean))?/i);
  if (m) return { verifyCmd: m[1].trim(), successToken: null };
  // "until tests pass" / "until pytest is green" → well-known commands
  if (/until\s+(the\s+)?tests?\s+(pass|are\s+green|go\s+green)/i.test(content)) {
    return { verifyCmd: 'npm test', successToken: null, _wellKnown: 'tests' };
  }
  if (/until\s+pytest\s+(is\s+green|passes)/i.test(content)) {
    return { verifyCmd: 'pytest -q', successToken: null, _wellKnown: 'pytest' };
  }
  return null;
}

/**
 * Detect natural-language loop intent in a message and extract params.
 *
 * Triggers on iterate-until-done phrasing — "keep …ing until X", "work on …
 * until done", "loop on …", "repeatedly …", "until you're done" — but
 * deliberately NOT on fixed-interval phrasing ("every 2 minutes …"), which is
 * handled by the scheduler. Returns null when no loop intent is present.
 *
 * @param {string} content
 * @returns {{prompt:string, model:string, maxRuns:number, intervalMs:number|null, verifyCmd:string|null, successToken:string|null}|null}
 */
export function detectLoopIntent(content) {
  if (!content || typeof content !== 'string') return null;
  const c = content.trim();
  const lower = c.toLowerCase();

  // Fixed-interval ("every N units") belongs to the scheduler, not the loop.
  if (/every\s+\d+\s*(second|minute|hour|min|sec|s|m|h)s?/i.test(c)) return null;

  // Loop-intent signals (any one is enough).
  const signals = [
    /\bkeep\s+(\w+ing|going|trying|working)\b/i,        // keep checking / keep going / keep working
    /\b(loop|iterate)\s+(on|over|through|until)\b/i,     // loop on X, iterate until X
    /\brepeatedly\b/i,
    /\bover\s+and\s+over\b/i,
    /\buntil\s+(it'?s?\s+)?(done|complete|finished|fixed|passing|green|healthy|resolved|working)\b/i,
    /\b(work|keep working)\s+on\b.*\buntil\b/i,
    /\bdon'?t\s+stop\s+until\b/i,
    /\b(retry|try)\b.*\buntil\b/i,
  ];
  if (!signals.some(re => re.test(lower))) return null;

  // Optional model override ("using sonnet", "haiku:").
  const _modelAliases = { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus', 'claude-haiku': 'haiku', 'claude-sonnet': 'sonnet', 'claude-opus': 'opus' };
  const _m = c.match(/\busing\s+(haiku|sonnet|opus|claude-haiku|claude-sonnet|claude-opus)\b/i)
    || c.match(/\b(haiku|sonnet|opus):/i);
  const model = _m ? (_modelAliases[_m[1].toLowerCase()] || 'sonnet') : 'sonnet';

  // Optional explicit run count ("up to 5 times", "5 iterations").
  let maxRuns = 0;
  const _runs = c.match(/\b(?:up\s+to\s+)?(\d+)\s*(?:times|iterations|rounds|runs)\b/i);
  if (_runs) maxRuns = Math.max(1, parseInt(_runs[1]));

  // Strip the loop-control language to leave the underlying task as the prompt.
  let prompt = c
    .replace(/^\s*(jarvis[,:]?\s+)/i, '')
    .replace(/\b(please|can you|could you|i want you to|i need you to)\b/gi, '')
    .replace(/\bkeep\b/gi, '')
    .replace(/\brepeatedly\b/gi, '')
    .replace(/\bover\s+and\s+over\b/gi, '')
    .replace(/\bloop\s+(on|over|through)\b/gi, '')
    .replace(/\b(?:up\s+to\s+)?\d+\s*(?:times|iterations|rounds|runs)\b/gi, '')
    .replace(/\busing\s+(haiku|sonnet|opus|claude-haiku|claude-sonnet|claude-opus)\b/gi, '')
    .replace(/\b(haiku|sonnet|opus):/gi, '')
    .replace(/\bdon'?t\s+stop\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!prompt) prompt = c;

  // Optional verify command ("until `pytest -q` passes", "until tests pass").
  const _verify = _extractVerify(c);
  const verifyCmd    = _verify?.verifyCmd || null;
  const successToken = _verify?.successToken || null;

  return { prompt, model, maxRuns, intervalMs: null, verifyCmd, successToken };
}

// Hard safety cap: a self-judged loop can NEVER run more than this many
// iterations, even if the model never emits LOOP_DONE. Prevents runaway
// token burn from an auto-started (natural-language) loop.
const HARD_MAX_ITERATIONS = 25;

// Wrap a self-judged loop's prompt with the iteration turn-contract. The model
// does one unit of work, then ends with a STATUS line the engine parses to decide
// whether to continue, escalate (BLOCKED), or finish (DONE). A verify command, when
// present, is the real done-gate — DONE is only honored if verify also passes.
function _wrapSelfJudged(prompt, iter, maxRuns, verifyCmd) {
  const cap = maxRuns > 0 ? maxRuns : HARD_MAX_ITERATIONS;
  const lines = [
    `[AUTONOMOUS LOOP — iteration ${iter} of at most ${cap}]`,
    `Task: ${prompt}`,
    ``,
    `Do the next concrete unit of work toward the task now, then report progress concisely.`,
    ``,
    `Do NOT roll your own poller or background loop — no "while true; sleep; done", no nohup,`,
    `no detached cron/tmux capture loop. THIS loop is your iteration mechanism; you'll be`,
    `called again automatically to continue. If you need to wait for a long job, do one check`,
    `now and report what you saw.`,
    ``,
    `End EVERY reply with exactly one status line on its own line:`,
    `  STATUS: WORKING            — made progress, more to do (you'll be called again)`,
    `  STATUS: BLOCKED <reason>   — genuinely stuck; state the specific blocker in <reason>`,
    `  STATUS: DONE               — the task is fully and verifiably complete`,
  ];
  if (verifyCmd) {
    lines.push(
      ``,
      `Completion is verified by running: ${verifyCmd}`,
      `Only claim STATUS: DONE when you believe that command will pass. The engine runs it`,
      `to confirm — if it fails, you'll be called again regardless of what you said.`,
    );
  } else {
    lines.push(
      ``,
      `There is no automated verify command, so when you say STATUS: DONE you MUST include a`,
      `one-line evidence statement first ("verified: <the concrete thing you checked>"). Do not`,
      `claim DONE on optimism — only when you have actually observed the success condition.`,
    );
  }
  lines.push(
    ``,
    `If you are blocked on something only the user can resolve (missing access, an ambiguous`,
    `decision, a wrong assumption baked into the task), say STATUS: BLOCKED <reason> rather than`,
    `spinning or pretending it's done. Being honestly blocked is better than a fake completion.`,
  );
  return lines.join('\n');
}

/**
 * Core loop engine shared by /loop (slash) and natural-language auto-loops.
 *
 * @param {object} o
 * @param {string} o.prompt        The task prompt.
 * @param {string} o.parentId      Channel the request came from.
 * @param {boolean} o.isThread     Whether parentId is already a thread.
 * @param {string} o.model         Model alias (haiku|sonnet|opus).
 * @param {number|null} o.intervalMs  null = self-pacing.
 * @param {number} o.maxRuns       0 = use HARD_MAX_ITERATIONS cap.
 * @param {boolean} o.selfJudged   true = wrap prompt with the STATUS turn-contract.
 * @param {string|null} o.verifyCmd  Optional shell command that gates completion.
 * @param {string|null} o.successToken  Optional substring verify output must contain.
 * @param {(msg:string)=>Promise<void>} o.ack  Called once with the startup confirmation.
 * @returns {Promise<{threadId:string}|null>}
 */
export async function startLoopCore({ prompt, parentId, isThread, model = 'sonnet', intervalMs = null, maxRuns = 0, selfJudged = false, verifyCmd = null, successToken = null, ack }) {
  const selfPacing = intervalMs === null;

  // Resolve target thread (reuse current thread, else create one).
  let threadId;
  try {
    if (isThread) {
      threadId = parentId;
    } else {
      const slug = prompt.slice(0, 50).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'loop';
      const res  = await _discordApi(`/channels/${parentId}/threads`, 'POST', {
        name: `loop: ${slug}`,
        auto_archive_duration: 1440,
        type: 11,
      });
      const data = await res.json();
      if (!data.id) throw new Error(JSON.stringify(data));
      threadId = data.id;
    }
  } catch (err) {
    if (ack) await ack(`Failed to set up loop thread: ${err.message}`);
    return null;
  }

  if (_activeLoops.has(threadId)) {
    if (ack) await ack(`Loop already running in <#${threadId}>. Say "stop loop" or use /stop.`);
    return { threadId, alreadyRunning: true };
  }

  const channelKey = `loop:${threadId}`;
  const hardCap    = maxRuns > 0 ? maxRuns : HARD_MAX_ITERATIONS;
  const paceLabel  = selfPacing ? 'self-pacing' : intervalMs < 60_000 ? `every ${intervalMs/1000}s` : `every ${intervalMs/60_000}m`;
  const capLabel   = maxRuns > 0 ? `, max ${maxRuns} runs` : ` (auto-stops when done, hard cap ${HARD_MAX_ITERATIONS})`;
  const verifyLabel = verifyCmd ? `, verify: \`${verifyCmd}\`` : '';

  if (ack) {
    await ack(
      isThread ? `🔁 Loop started (${paceLabel}${capLabel}${verifyLabel}) — replies in this thread.`
               : `🔁 Loop started in <#${threadId}> (${paceLabel}${capLabel}${verifyLabel}).`
    );
  }

  const state = { iteration: 0, cancelled: false };
  _activeLoops.set(threadId, state);

  // Escalate to the user when a loop genuinely can't finish: post to the thread
  // and speak a TL;DR (speakText falls back to text if no voice connection).
  const escalateBlocked = async (reason, iter) => {
    const r = (reason || 'no specific reason given').substring(0, 400);
    await _postToThread(threadId, `🚧 **Blocked — need you.** After ${iter} iteration${iter !== 1 ? 's' : ''}, the loop is stuck:\n> ${r}\n\nSay "stop loop" to end it, or reply with guidance and I'll continue.`);
    try { await speakText(`I'm blocked on the loop and need your help. ${r.split('\n')[0].substring(0, 200)}`); } catch { /* speak is best-effort */ }
  };

  const run = async () => {
    let lastBlockedReason = null;   // for "same block twice" detection
    let prevFingerprint   = null;   // for convergence detection
    let convergedStreak   = 0;

    while (!state.cancelled) {
      state.iteration++;
      const iter = state.iteration;

      const ac = new AbortController();
      state.currentAc = ac;

      const turnPrompt = selfJudged ? _wrapSelfJudged(prompt, iter, maxRuns, verifyCmd) : prompt;

      let text = '';
      let turnFailed = false;
      try {
        text = await _callGateway(turnPrompt, channelKey, model, ac.signal);
      } catch (err) {
        if (state.cancelled) break;
        turnFailed = true;
        logger.warn(`[loop] iteration ${iter} error: ${err.message}`);
        await _postToThread(threadId, `⚠️ Loop iteration ${iter} failed: ${err.message.substring(0, 200)}`);
      }

      if (state.cancelled) break;

      if (text) {
        const header = `**[Loop ${iter}/${hardCap}]**\n`;
        await _postToThread(threadId, header + text);
      }

      // Self-judged loops use the full STATUS / verify / convergence machinery.
      // Fixed-count loops (selfJudged === false) just run to their cap.
      if (selfJudged && text) {
        const { status, reason } = _parseStatus(text);

        // ── Convergence guard: 3 near-identical iterations in a row = stuck ──
        const fp = _fingerprint(text);
        if (prevFingerprint && _similar(prevFingerprint, fp) >= CONVERGENCE_THRESHOLD) {
          convergedStreak++;
        } else {
          convergedStreak = 0;
        }
        prevFingerprint = fp;
        if (convergedStreak >= CONVERGENCE_STREAK - 1) {
          await escalateBlocked(`No progress for ${CONVERGENCE_STREAK} iterations in a row (the loop is repeating itself). Original task: ${prompt.substring(0, 160)}`, iter);
          break;
        }

        // ── Blocked escalation: same blocker twice → halt and surface to user ──
        if (status === 'BLOCKED') {
          const norm = _normReason(reason);
          if (lastBlockedReason && norm && norm === lastBlockedReason) {
            await escalateBlocked(reason, iter);
            break;
          }
          lastBlockedReason = norm;   // first time: note it, give one more turn to recover
        } else {
          lastBlockedReason = null;   // a non-blocked turn clears the streak
        }

        // ── Done gate: DONE is only honored if the verifier agrees (or, with no ──
        //    verifier, the turn carried evidence per the contract). ──
        if (status === 'DONE') {
          if (verifyCmd) {
            await _postToThread(threadId, `🧪 Verifying with \`${verifyCmd}\`…`);
            const v = await _runVerify(verifyCmd, successToken);
            if (v.ok) {
              await _postToThread(threadId, `✅ Verified — loop complete after ${iter} iteration${iter !== 1 ? 's' : ''} (\`${verifyCmd}\` passed).`);
              try { await speakText(`Loop complete. The verification passed.`); } catch {}
              break;
            }
            await _postToThread(threadId, `❌ Verify failed (exit ${v.code}) — continuing.\n\`\`\`\n${(v.output || '').substring(0, 600)}\n\`\`\``);
            // Feed the failure back so the next turn sees it (resume context already
            // accumulates, but make the failure explicit and unmissable).
            // Falls through to the next iteration.
          } else {
            const hasEvidence = /\bverified:\s*\S/i.test(text);
            if (hasEvidence) {
              await _postToThread(threadId, `✅ Loop complete after ${iter} iteration${iter !== 1 ? 's' : ''} (self-reported, evidence stated).`);
              break;
            }
            await _postToThread(threadId, `⚠️ Claimed DONE without an evidence line — not accepting yet. Continuing (state "verified: <what you checked>" to finish).`);
            // Falls through to the next iteration.
          }
        }
      }

      // Hard safety cap — always enforced, even for self-judged loops.
      if (state.iteration >= hardCap) {
        const capMsg = selfJudged
          ? `🚧 Loop hit its cap of ${hardCap} iterations without verifiably finishing — stopping so it doesn't spin. Last status above; say "stop loop" or give guidance to continue.`
          : `✅ Loop reached cap of ${hardCap} runs — stopped.`;
        await _postToThread(threadId, capMsg);
        if (selfJudged) { try { await speakText(`The loop hit its iteration cap without finishing. I've stopped it.`); } catch {} }
        break;
      }

      // Don't hammer the gateway if the turn errored out.
      if (turnFailed && selfPacing) {
        await new Promise(r => setTimeout(r, 5_000));
      } else if (selfPacing) {
        await new Promise(r => setTimeout(r, 2_000));
      } else {
        await new Promise(r => {
          state.sleepResolve = r;
          state.sleepTimer = setTimeout(r, intervalMs);
        });
      }
    }

    _activeLoops.delete(threadId);
    logger.info(`[loop] ended for thread ${threadId} after ${state.iteration} iterations`);
  };

  run().catch(err => {
    logger.error(`[loop] fatal error in thread ${threadId}: ${err.message}`);
    _activeLoops.delete(threadId);
    _postToThread(threadId, `❌ Loop crashed: ${err.message.substring(0, 200)}`).catch(() => {});
  });

  return { threadId };
}

export async function handleLoopCommand(interaction) {
  const prompt      = interaction.options.getString('prompt');
  const intervalStr = interaction.options.getString('interval') || null;
  const modelOpt    = interaction.options.getString('model') || 'sonnet';
  const maxRuns     = interaction.options.getInteger('max') || 0;
  const verifyCmd   = interaction.options.getString('verify') || null;

  if (!prompt) {
    await interaction.reply({ content: 'Prompt is required.', ephemeral: true });
    return;
  }

  const intervalMs = _parseInterval(intervalStr);

  await interaction.deferReply();

  await startLoopCore({
    prompt,
    parentId: interaction.channelId,
    isThread: !!interaction.channel?.isThread?.(),
    model: modelOpt,
    intervalMs,
    maxRuns,
    verifyCmd,
    // Self-judge (STATUS contract) when the user didn't pin a fixed run count.
    selfJudged: maxRuns === 0,
    ack: (msg) => interaction.editReply(msg),
  });
}

/**
 * Natural-language entry point: start an auto-loop from a Discord message
 * (no slash command). Always self-judged with a hard iteration cap.
 *
 * @param {object} message     discord.js Message.
 * @param {object} parsed      { prompt, model, intervalMs, maxRuns }.
 * @param {(msg:string)=>Promise<void>} reply  Posts the startup confirmation.
 */
export async function startLoopFromMessage(message, parsed, reply) {
  const isThread = !!message.channel?.isThread?.();
  return startLoopCore({
    prompt: parsed.prompt,
    parentId: message.channelId,
    isThread,
    model: parsed.model || 'sonnet',
    intervalMs: parsed.intervalMs ?? null,
    maxRuns: parsed.maxRuns || 0,
    verifyCmd: parsed.verifyCmd || null,
    successToken: parsed.successToken || null,
    selfJudged: true,
    ack: reply,
  });
}

export function stopLoop(threadId) {
  const state = _activeLoops.get(threadId);
  if (!state) return false;
  state.cancelled = true;
  state.currentAc?.abort();
  if (state.sleepTimer) clearTimeout(state.sleepTimer);
  if (state.sleepResolve) state.sleepResolve();
  _activeLoops.delete(threadId);
  return true;
}

export function isLoopRunning(threadId) {
  return _activeLoops.has(threadId);
}
