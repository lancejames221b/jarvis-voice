import logger from '../logger.js';

/**
 * Start a self-refreshing Telegram "typing" chat action.
 *
 * @param {object}   params
 * @param {function} params.sendAction  — async (chatId, opts) => void
 * @param {string}   params.chatId
 * @param {string}   [params.topicId]   — when set, opts includes message_thread_id
 * @param {number}   [params.intervalMs] — refresh interval, default 5000
 * @returns {function} stop — idempotent, never throws
 */
export function startTyping({ sendAction, chatId, topicId, intervalMs = 5000 }) {
  let timer = null;

  const tick = async () => {
    try {
      const opts = {};
      if (topicId) opts.message_thread_id = topicId;
      await sendAction(chatId, opts);
    } catch (err) {
      logger.warn(`telegram/typing: sendAction failed for chat ${chatId}: ${err.message}`);
    }
  };

  // Fire immediately so the user sees typing within ~1s.
  tick();

  timer = setInterval(tick, intervalMs);

  const stop = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  return stop;
}
