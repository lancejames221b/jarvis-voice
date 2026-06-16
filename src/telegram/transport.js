import TelegramBot from 'node-telegram-bot-api';
import logger from '../logger.js';

export function normalizeUpdate(message) {
  if (!message || typeof message.text !== 'string') return null;
  return {
    userId: String(message.from?.id ?? ''),
    chatId: String(message.chat?.id ?? ''),
    topicId: message.message_thread_id != null ? String(message.message_thread_id) : null,
    text: message.text,
    messageId: String(message.message_id ?? ''),
  };
}

// Pure send helper: builds Telegram options and delegates to `sender`.
export async function splitSend(sender, chatId, text, { topicId, replyTo } = {}) {
  const opts = {};
  if (topicId) opts.message_thread_id = topicId;
  if (replyTo) opts.reply_to_message_id = replyTo;
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
    stop: () => bot.stopPolling(),
  };
}
