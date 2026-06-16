import logger from '../logger.js';
import { isTelegramOwner } from '../channel-access.js';
import { generateTextResponse } from '../brain/brain.js';
import { getChannelModel } from '../channel-models.js';
import { telegramChatKey, getTelegramProjectPath, registerTelegramChat } from './registry.js';
import { getEngine, setEngine, resolveEngineEnv } from './engine.js';
import { parseCommand } from './commands.js';
import { terseStatus, detailBody } from './format.js';
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

  // Image / document: download the file, build a prompt-context block (vision
  // description for images, inlined/handed-off content for documents) and treat
  // that as the message. The text-only brain can't see pixels, so the picture is
  // turned into words here (src/telegram/vision.js + attachments.js).
  if (update.kind === 'image' || update.kind === 'document') {
    if (!deps.downloadFile) {
      await send(chatId, '📎 attachments are not enabled here', topicId ? { topicId } : {});
      return;
    }
    // Documents land in the bound project dir so the agent can open them by path;
    // images go to a temp dir (consumed by the vision call, not opened later).
    const projectPath = getTelegramProjectPath(chatKey);
    const dir = update.kind === 'document'
      ? (projectPath || deps.tmpDir || '/tmp')
      : (deps.tmpDir || '/tmp');
    let savedPath;
    try {
      savedPath = await deps.downloadFile(update.fileId, dir);
    } catch (e) {
      logger.error({ err: e.message, chatKey, kind: update.kind }, '[telegram] attachment download failed');
      await send(chatId, "⚠️ couldn't download that attachment", topicId ? { topicId } : {});
      return;
    }
    if (update.kind === 'image') {
      await send(chatId, '🖼️ looking at that image…', topicId ? { topicId } : {});
    }
    const ctx = await buildAttachmentContext({
      kind: update.kind,
      path: savedPath,
      fileName: update.fileName || savedPath.split('/').pop(),
      mimeType: update.mimeType || null,
      caption: update.caption || null,
    });
    // The brain message is the caption (the user's actual ask) plus the context.
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
    });
    const full = result?.text ?? '';
    pushHistory(chatKey, 'assistant', full);
    await send(chatId, terseStatus(full), topicId ? { topicId } : {});
    const detail = detailBody(full);
    if (detail) for (const chunk of detail) await send(chatId, chunk, topicId ? { topicId } : {});
  } catch (e) {
    logger.error({ err: e.message, chatKey }, '[telegram-adapter] brain error');
    await send(chatId, '⚠️ engine error — try again or /engine claude', {});
  } finally {
    aborters.delete(chatKey);
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
