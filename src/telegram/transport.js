import TelegramBot from 'node-telegram-bot-api';
import logger from '../logger.js';

export function normalizeUpdate(message) {
  if (!message) return null;
  const base = {
    userId: String(message.from?.id ?? ''),
    chatId: String(message.chat?.id ?? ''),
    topicId: message.message_thread_id != null ? String(message.message_thread_id) : null,
    messageId: String(message.message_id ?? ''),
  };
  // Text message — the common case. kind:'text' for symmetry with voice.
  if (typeof message.text === 'string') {
    return { ...base, kind: 'text', text: message.text };
  }
  // Voice note — carry the file id so the adapter can download + transcribe.
  // A spoken caption is rare on voice notes but pass it through if present.
  if (message.voice && message.voice.file_id) {
    return {
      ...base,
      kind: 'voice',
      fileId: String(message.voice.file_id),
      duration: message.voice.duration ?? null,
      caption: typeof message.caption === 'string' ? message.caption : null,
    };
  }
  // Photo — Telegram delivers an array of size variants, smallest → largest.
  // Take the last (largest) so vision has the most detail to work with.
  if (Array.isArray(message.photo) && message.photo.length) {
    const largest = message.photo[message.photo.length - 1];
    if (largest?.file_id) {
      return {
        ...base,
        kind: 'image',
        fileId: String(largest.file_id),
        caption: typeof message.caption === 'string' ? message.caption : null,
      };
    }
  }
  // Document — any file the user attaches. An image sent as a file (uncompressed)
  // arrives here with an image/* mime, so route those to the image path too.
  if (message.document && message.document.file_id) {
    const doc = message.document;
    const mimeType = typeof doc.mime_type === 'string' ? doc.mime_type : null;
    const fileName = typeof doc.file_name === 'string' ? doc.file_name : null;
    const caption = typeof message.caption === 'string' ? message.caption : null;
    if (mimeType && mimeType.startsWith('image/')) {
      return { ...base, kind: 'image', fileId: String(doc.file_id), caption, fileName, mimeType };
    }
    return { ...base, kind: 'document', fileId: String(doc.file_id), fileName, mimeType, caption };
  }
  // Anything else (sticker, location, …) — not handled.
  return null;
}

// Pure send helper: builds Telegram options and delegates to `sender`.
export async function splitSend(sender, chatId, text, { topicId, replyTo, parseMode } = {}) {
  const opts = {};
  if (topicId) opts.message_thread_id = topicId;
  if (replyTo) opts.reply_to_message_id = replyTo;
  if (parseMode) opts.parse_mode = parseMode;
  await sender(chatId, text, opts);
}

// Live wiring. token from env; long-polls. onMessage receives a normalized update.
export function createTransport(token, onMessage) {
  const bot = new TelegramBot(token, { polling: true });
  bot.on('message', async (message) => {
    const update = normalizeUpdate(message);
    if (!update) return;
    try {
      await onMessage(update);
    } catch (e) {
      logger.error({ err: e.message }, '[telegram-transport] onMessage failed');
    }
  });
  bot.on('polling_error', (e) => logger.warn({ err: e.message }, '[telegram-transport] polling_error'));
  const sender = (chatId, text, opts) => bot.sendMessage(chatId, text, opts);
  return {
    sendMessage: (chatId, text, opts = {}) => splitSend(sender, chatId, text, opts),
    // Downloads a Telegram file (by file_id) into downloadDir; resolves to the saved path.
    downloadFile: (fileId, downloadDir) => bot.downloadFile(fileId, downloadDir),
    stop: () => bot.stopPolling(),
  };
}
