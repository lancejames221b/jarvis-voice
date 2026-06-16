import logger from '../logger.js';
import { isTelegramOwner } from '../channel-access.js';
import { generateTextResponse } from '../brain/brain.js';
import { getChannelModel } from '../channel-models.js';
import { telegramChatKey, getTelegramProjectPath, registerTelegramChat } from './registry.js';
import { getEngine, setEngine, resolveEngineEnv } from './engine.js';
import { parseCommand } from './commands.js';
import { renderReply } from './format.js';
import { createTransport } from './transport.js';
import { transcribeVoiceNote } from './voice-in.js';
import { buildAttachmentContext } from './attachments.js';

// per-chat in-memory live window (durability is the memory layer's job, not this)
const histories = new Map();      // chatKey -> [{role, content}]
const aborters = new Map();       // chatKey -> AbortController
const HISTORY_CAP = 20;

function pushHistory(chatKey, role, content) {
  const h = histories.get(chatKey) || [];
  h.push({ role, content });
  while (h.length > HISTORY_CAP) h.shift();
  histories.set(chatKey, h);
}

/**
 * Core update handler. `deps.send(chatId, text, opts)` sends a reply.
 * `deps.allowedUsers` is the tier-2 id list (strings).
 */
export async function handleUpdate(update, deps) {
  const { userId, chatId, topicId } = update;
  let { text } = update;
  const send = deps.send;
  const allowedUsers = deps.allowedUsers || [];
  const chatKey = telegramChatKey(chatId, topicId);
  const owner = isTelegramOwner(userId);
  const allowlisted = owner || allowedUsers.includes(String(userId));
  logger.info({ userId, chatId, topicId, owner, allowlisted, kind: update.kind }, '[telegram] inbound');

  if (!allowlisted) {
    await send(chatId, 'not authorized', {});
    return;
  }

  // Voice note: download the OGG, transcribe via the Whisper-only STT path
  // (no speaker gate), then treat the transcript as the message text.
  if (update.kind === 'voice') {
    if (!deps.downloadFile || !deps.transcribeVoice) {
      await send(chatId, '🎤 voice messages are not enabled here', topicId ? { topicId } : {});
      return;
    }
    let oggPath;
    try {
      oggPath = await deps.downloadFile(update.fileId, deps.tmpDir || '/tmp');
    } catch (e) {
      logger.error({ err: e.message, chatKey }, '[telegram] voice download failed');
      await send(chatId, "⚠️ couldn't download that voice message", topicId ? { topicId } : {});
      return;
    }
    text = await deps.transcribeVoice(oggPath);
    if (!text) {
      await send(chatId, "🎤 couldn't make out that voice message — try again?", topicId ? { topicId } : {});
      return;
    }
    // Echo the transcript so the user sees what was heard.
    await send(chatId, `🎤 “${text}”`, topicId ? { topicId } : {});
  }

  // Image / document: download the file and hand the agent an @<abs-path>
  // reference. `claude -p` reads @-referenced files as native input — real
  // multimodal vision for images, direct read for documents — so the agent sees
  // the actual file rather than a second-hand description (src/telegram/attachments.js).
  if (update.kind === 'image' || update.kind === 'document') {
    if (!deps.downloadFile) {
      await send(chatId, '📎 attachments are not enabled here', topicId ? { topicId } : {});
      return;
    }
    // Save into the bound project dir when there is one (stable, and the agent
    // can re-open it with its own tools); otherwise a temp dir.
    const dir = getTelegramProjectPath(chatKey) || deps.tmpDir || '/tmp';
    let savedPath;
    try {
      savedPath = await deps.downloadFile(update.fileId, dir);
    } catch (e) {
      logger.error({ err: e.message, chatKey, kind: update.kind }, '[telegram] attachment download failed');
      await send(chatId, "⚠️ couldn't download that attachment", topicId ? { topicId } : {});
      return;
    }
    const ctx = buildAttachmentContext({
      kind: update.kind,
      path: savedPath,
      fileName: update.fileName || savedPath.split('/').pop(),
      caption: update.caption || null,
    });
    // The brain message is the caption (the user's actual ask) plus the @ref.
    // With no caption, a neutral lead-in keeps the prompt well-formed.
    const lead = update.caption
      ? String(update.caption).trim()
      : (update.kind === 'image' ? 'Take a look at this image.' : 'Take a look at this file.');
    text = `${lead}${ctx}`;
  }

  // Only typed messages are parsed as slash commands. A voice transcript or an
  // attachment caption that happens to start with "/" should be chatted, not run.
  const cmd = (update.kind === 'voice' || update.kind === 'image' || update.kind === 'document')
    ? null
    : parseCommand(text);
  if (cmd) {
    await handleCommand(cmd, { chatKey, chatId, owner, send });
    return;
  }

  // Plain message: route to the brain (chat/status). Coding spawn is a follow-up
  // capability that rides the same gateway path; chat works with or without a binding.
  pushHistory(chatKey, 'user', text);
  const history = histories.get(chatKey);
  const controller = new AbortController();
  aborters.set(chatKey, controller);
  let full;
  let brainFailed = false;
  try {
    // Route through the lightweight text-channel path (NOT the voice path, which
    // builds a 120K-char skills prompt and is hardwired to the global voice
    // session). sessionUser carries the CLAUDE.md-shaped key so the gateway gives
    // each chat/topic its own Claude session and strips the :topic: suffix for
    // profile lookup. engineEnv applies the per-chat claude|qwen swap.
    const engine = getEngine(chatKey);
    const engineEnv = resolveEngineEnv(engine);
    const model = engine === 'qwen'
      ? engineEnv.model
      : (getChannelModel(chatKey) || undefined);
    const result = await generateTextResponse(text, {
      sessionUser: `agent:main:${chatKey}`,
      channelId: chatKey,
      engineEnv: Object.keys(engineEnv).length ? engineEnv : null,
      model,
      discordChatHistory: history,
      surfaceHint: 'telegram',
    });
    full = result?.text ?? '';
    pushHistory(chatKey, 'assistant', full);
  } catch (e) {
    // ONLY a genuine brain/engine failure lands here. Telegram send failures are
    // handled separately below so a transient network blip on a reply chunk is
    // never mislabeled as an "engine error".
    brainFailed = true;
    logger.error({ err: e.message, chatKey }, '[telegram-adapter] brain error');
  } finally {
    aborters.delete(chatKey);
  }

  const base = topicId ? { topicId } : {};
  if (brainFailed) {
    await safeSend(send, chatId, '⚠️ engine error — try again or /engine claude', base);
    return;
  }
  // Deliver the reply rendered for Telegram: rich HTML, with the plain-text
  // rendering as a per-chunk fallback if Telegram rejects the markup. Each chunk
  // is individually resilient (retry on transient EFATAL) and a failed chunk
  // never aborts the rest.
  const { html, plain } = renderReply(full);
  for (let i = 0; i < html.length; i++) {
    await safeSend(send, chatId, html[i], { ...base, parseMode: 'HTML' }, plain[i]);
  }
}

// Send a Telegram message resiliently. Never throws — a delivery failure is
// logged, not propagated, so it can't be confused with an engine error or abort
// the remaining chunks. Recovery, in order:
//   1. transient network failure ("EFATAL: fetch failed") → one retry
//   2. HTML parse rejection (Telegram 400 on bad markup) → resend as plain text
//      (when a `plainFallback` is provided)
async function safeSend(send, chatId, text, opts, plainFallback) {
  try {
    await send(chatId, text, opts);
    return;
  } catch (e) {
    const msg = e.message || '';
    // A parse/400 on the HTML path: drop parse_mode and send the plain rendering.
    if (plainFallback !== undefined && (/can't parse|parse entities|400/i.test(msg))) {
      logger.warn({ err: msg, chatId }, '[telegram-adapter] HTML rejected, sending plain text');
      try {
        const { parseMode: _drop, ...plainOpts } = opts || {};
        await send(chatId, plainFallback, plainOpts);
        return;
      } catch (e2) {
        logger.error({ err: e2.message, chatId }, '[telegram-adapter] plain fallback failed');
        return;
      }
    }
    // Otherwise treat as a transient network blip and retry once.
    logger.warn({ err: msg, chatId }, '[telegram-adapter] send failed, retrying once');
    try {
      await send(chatId, text, opts);
    } catch (e2) {
      logger.error({ err: e2.message, chatId }, '[telegram-adapter] send failed after retry');
    }
  }
}

async function handleCommand(cmd, { chatKey, chatId, owner, send }) {
  const ownerOnly = ['register', 'engine', 'model', 'cancel'];
  if (ownerOnly.includes(cmd.cmd) && !owner) {
    await send(chatId, 'read-only: that command is owner-only', {});
    return;
  }
  switch (cmd.cmd) {
    case 'register':
      if (!cmd.arg) { await send(chatId, 'usage: /register <abs-path>', {}); return; }
      registerTelegramChat(chatKey, cmd.arg);
      await send(chatId, `bound to ${cmd.arg}`, {});
      return;
    case 'engine':
      try { setEngine(chatKey, cmd.arg); await send(chatId, `engine: ${cmd.arg}`, {}); }
      catch { await send(chatId, 'usage: /engine claude|qwen', {}); }
      return;
    case 'model':
      // setChannelModel is imported lazily to keep the test surface small
      { const { setChannelModel } = await import('../channel-models.js');
        setChannelModel(chatKey, cmd.arg); await send(chatId, `model: ${cmd.arg}`, {}); }
      return;
    case 'status': {
      const path = getTelegramProjectPath(chatKey) || '(unbound)';
      await send(chatId, `path: ${path} · engine: ${getEngine(chatKey)} · model: ${getChannelModel(chatKey) || 'default'}`, {});
      return;
    }
    case 'cancel': {
      const a = aborters.get(chatKey);
      if (a) a.abort();
      await send(chatId, 'cancelled', {});
      return;
    }
    default:
      await send(chatId, `unknown command: /${cmd.arg}`, {});
  }
}

// Bootstrap entry — called from src/index.js when TELEGRAM_BOT_TOKEN is set.
export function startTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { logger.info('[telegram] no TELEGRAM_BOT_TOKEN — adapter not started'); return null; }
  const allowedUsers = (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const transport = createTransport(token, (update) =>
    handleUpdate(update, {
      send: (cid, text, opts) => transport.sendMessage(cid, text, opts),
      allowedUsers,
      tmpDir: process.env.TELEGRAM_TMP_DIR || '/tmp',
      downloadFile: (fileId, dir) => transport.downloadFile(fileId, dir),
      transcribeVoice: (oggPath) => transcribeVoiceNote(oggPath),
    }));
  logger.info({ allowedUsers: allowedUsers.length }, '🛰️  Telegram adapter started');
  return transport;
}
