/**
 * daily-briefing.js — "FRIDAY tier" proactive daily briefing
 *
 * Gathers calendar events, Trello "In Progress" cards, active schedules,
 * and haivemind context, then synthesises a Discord-formatted briefing.
 */

import { execSync } from 'child_process';
import { getTodayEvents } from './calendar-cache.js';
import { listSchedules } from './task-scheduler.js';
import logger from './logger.js';

const TRELLO_CLI = process.env.TRELLO_CLI || '~/.local/bin/trello';

/**
 * Resolve a ~ path in a string.
 */
function resolveTilde(str) {
  if (!str || !str.startsWith('~')) return str;
  const home = process.env.HOME || '';
  return home ? home + str.slice(1) : str;
}

/* ── data collectors ─────────────────────────────────────────────── */

async function fetchCalendarEvents() {
  try {
    const events = getTodayEvents();
    if (!events.length) return '**📅 Today**\n_No events._';
    const lines = events.slice(0, 12).map(e => {
      const start = e.start.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
      const end = e.end.toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
      const url = e.bestUrl ? ` [join](${e.bestUrl})` : '';
      return `- **${start}–${end}** ${e.title}${url}`;
    });
    return `**📅 Today**\n${lines.join('\n')}`;
  } catch (err) {
    logger.warn('[briefing] calendar failed:', err.message);
    return null;
  }
}

async function fetchTrelloCards() {
  try {
    const cmd = `${resolveTilde(TRELLO_CLI)} ls "In Progress" -b openJarvis`;
    const raw = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    const lines = raw.split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .slice(0, 10);
    if (!lines.length) return '**📋 In Progress**\n_No cards._';
    return `**📋 In Progress**\n${lines.map(l => `- ${l}`).join('\n')}`;
  } catch (err) {
    logger.warn('[briefing] trello failed:', err.message);
    return null;
  }
}

async function fetchSchedules() {
  try {
    const scheds = listSchedules().filter(s => s.enabled);
    if (!scheds.length) return '**⏰ Active Schedules**\n_None._';
    const lines = scheds.slice(0, 8).map(s => {
      const interval = Math.round(s.intervalMs / 60000);
      return `- ${s.prompt.substring(0, 60)}${s.prompt.length > 60 ? '…' : ''} (every ${interval}m)`;
    });
    return `**⏰ Active Schedules**\n${lines.join('\n')}`;
  } catch (err) {
    logger.warn('[briefing] schedules failed:', err.message);
    return null;
  }
}

async function fetchHaivemindContext(gatewayUrl, gatewayToken) {
  try {
    const url = `${gatewayUrl}/v1/chat/completions`;
    const body = JSON.stringify({
      model: 'haiku',
      messages: [
        { role: 'system', content: 'You are a briefing assistant. Summarize the most relevant recent context and open items from memory in 2-3 sentences.' },
        { role: 'user', content: 'Summarize the most relevant recent context and open items from memory in 2-3 sentences.' },
      ],
      max_tokens: 200,
      temperature: 0.3,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {}),
      },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    return `**🧠 Memory**\n${text}`;
  } catch (err) {
    logger.warn('[briefing] haivemind failed:', err.message);
    return null;
  }
}

/* ── synthesis ───────────────────────────────────────────────────── */

/**
 * Truncate a section to fit within maxChars, adding an ellipsis header if needed.
 */
function truncateSection(section, maxChars) {
  if (!section) return null;
  if (section.length <= maxChars) return section;
  // Keep header + as many lines as fit
  const firstLineEnd = section.indexOf('\n');
  const header = firstLineEnd > -1 ? section.slice(0, firstLineEnd) : section;
  const body = firstLineEnd > -1 ? section.slice(firstLineEnd + 1) : '';
  const suffix = '\n…';
  const budget = maxChars - header.length - suffix.length;
  if (budget <= 0) return header + suffix;
  const truncatedBody = body.length > budget ? body.slice(0, budget - 3) + '…' : body;
  return header + '\n' + truncatedBody + suffix;
}

/**
 * Generate a formatted briefing string from all data sources.
 *
 * @param {{ gatewayUrl: string, gatewayToken: string }}
 * @returns {string}
 */
export async function generateBriefingText({ gatewayUrl, gatewayToken }) {
  const [calendar, trello, schedules, memory] = await Promise.all([
    fetchCalendarEvents(),
    fetchTrelloCards(),
    fetchSchedules(),
    fetchHaivemindContext(gatewayUrl, gatewayToken),
  ]);

  const sections = [calendar, trello, schedules, memory].filter(Boolean);
  if (!sections.length) return '**🤖 Daily Briefing**\n_No data available right now._';

  const MAX_CHARS = 1500;
  const header = '**🤖 Daily Briefing**';
  const body = sections.join('\n\n');

  // Check if we need to truncate
  if ((header + '\n' + body).length <= MAX_CHARS) {
    return header + '\n' + body;
  }

  // Truncate each section proportionally
  const perSection = Math.floor((MAX_CHARS - header.length - 4) / sections.length); // 4 for separators
  const truncated = sections.map(s => truncateSection(s, perSection)).filter(Boolean);
  return header + '\n\n' + truncated.join('\n\n');
}

/* ── posting ─────────────────────────────────────────────────────── */

/**
 * Run the full briefing pipeline: generate + post to Discord.
 *
 * @param {{ channelId: string, discordToken: string, gatewayUrl: string, gatewayToken: string }}
 * @returns {Promise<{ posted: true, text: string } | { posted: false, error: string }>}
 */
export async function runDailyBriefing({ channelId, discordToken, gatewayUrl, gatewayToken }) {
  try {
    const text = await generateBriefingText({ gatewayUrl, gatewayToken });

    // Post to Discord via REST API
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bot ${discordToken}`,
      },
      body: JSON.stringify({ content: text }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error('[briefing] discord post failed:', res.status, body);
      return { posted: false, error: `Discord HTTP ${res.status}: ${body}` };
    }

    const data = await res.json();
    logger.info('[briefing] posted successfully to', channelId);
    return { posted: true, text };
  } catch (err) {
    logger.error('[briefing] runDailyBriefing failed:', err.message);
    return { posted: false, error: err.message };
  }
}
