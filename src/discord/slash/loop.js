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

import logger from '../../logger.js';

const GATEWAY_URL   = process.env.JARVIS_GATEWAY_URL || 'http://127.0.0.1:22100';
const GATEWAY_TOKEN = process.env.JARVIS_GATEWAY_TOKEN || '';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';

// Active loops keyed by threadId → { cancel, iteration }
export const _activeLoops = new Map();

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

export async function handleLoopCommand(interaction) {
  const prompt      = interaction.options.getString('prompt');
  const intervalStr = interaction.options.getString('interval') || null;
  const modelOpt    = interaction.options.getString('model') || 'sonnet';
  const maxRuns     = interaction.options.getInteger('max') || 0;

  if (!prompt) {
    await interaction.reply({ content: 'Prompt is required.', ephemeral: true });
    return;
  }

  const intervalMs = _parseInterval(intervalStr);
  const selfPacing = intervalMs === null;

  await interaction.deferReply();

  const parentId = interaction.channelId;
  const isThread = interaction.channel?.isThread?.();

  // Use current thread if already in one; otherwise create a new thread
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
    await interaction.editReply(`Failed to set up loop thread: ${err.message}`);
    return;
  }

  if (_activeLoops.has(threadId)) {
    await interaction.editReply(`Loop already running in <#${threadId}>. Say "stop loop" or use /stop.`);
    return;
  }

  const channelKey = `loop:${threadId}`;
  const paceLabel  = selfPacing ? 'self-pacing' : intervalMs < 60_000 ? `every ${intervalMs/1000}s` : `every ${intervalMs/60_000}m`;
  const maxLabel   = maxRuns > 0 ? `, max ${maxRuns} runs` : '';

  await interaction.editReply(
    isThread ? `Loop started (${paceLabel}${maxLabel}) — replies in this thread.`
             : `Loop started in <#${threadId}> (${paceLabel}${maxLabel}).`
  );

  let cancelled = false;
  const state = { iteration: 0, cancelled: false };
  _activeLoops.set(threadId, state);

  const run = async () => {
    while (!state.cancelled) {
      state.iteration++;
      const iter = state.iteration;

      const ac = new AbortController();
      state.currentAc = ac;

      let text = '';
      try {
        text = await _callGateway(prompt, channelKey, modelOpt, ac.signal);
      } catch (err) {
        if (state.cancelled) break;
        logger.warn(`[loop] iteration ${iter} error: ${err.message}`);
        await _postToThread(threadId, `⚠️ Loop iteration ${iter} failed: ${err.message.substring(0, 200)}`);
      }

      if (state.cancelled) break;

      if (text) {
        const header = `**[Loop ${iter}${maxRuns > 0 ? `/${maxRuns}` : ''}]**\n`;
        await _postToThread(threadId, header + text);

        // Termination check
        if (text.includes('LOOP_DONE') || /\b(all done|task complete|finished|no more|nothing left)\b/i.test(text)) {
          await _postToThread(threadId, `✅ Loop complete after ${iter} iteration${iter !== 1 ? 's' : ''}.`);
          break;
        }
      }

      if (maxRuns > 0 && state.iteration >= maxRuns) {
        await _postToThread(threadId, `✅ Loop reached max ${maxRuns} runs — stopped.`);
        break;
      }

      if (selfPacing) {
        // Brief pause between self-paced iterations to avoid hammering
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
