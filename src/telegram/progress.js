import logger from '../logger.js';

/**
 * Create an editable "progress draft" message lifecycle.
 *
 * When verbose mode is on, the adapter creates one draft message that is
 * edited in place to reflect progress ("starting", "working"...), then
 * finalized before the real answer is sent.
 *
 * @param {object}   params
 * @param {function} params.sendMessage  — async (chatId, text, opts) => {message_id}
 * @param {function} params.editMessage   — async (chatId, messageId, text, opts) => void
 * @param {string}   params.chatId
 * @param {string}   [params.topicId]     — when set, opts includes message_thread_id
 * @param {number}   [params.throttleMs]  — coalesce edits, default 2000
 * @returns {{ update(text: string): void, finalize(): Promise<void> }}
 */
export function createProgressDraft({ sendMessage, editMessage, chatId, topicId, throttleMs = 2000 }) {
  let messageId = null;
  let pendingText = null;
  let timer = null;
  let finalized = false;

  const opts = {};
  if (topicId) opts.message_thread_id = topicId;

  function scheduleEdit() {
    if (finalized || messageId == null) return;
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      const text = pendingText;
      if (text == null) return;
      pendingText = null;
      editMessage(chatId, messageId, text, opts).catch(
        err => logger.warn(`telegram/progress: editMessage failed: ${err.message}`)
      );
    }, throttleMs);
  }

  function update(text) {
    if (finalized) return;
    pendingText = text;

    if (messageId == null) {
      // Lazily send the draft message on first update
      sendMessage(chatId, text, opts).then(
        res => {
          messageId = res.message_id ?? res;
          scheduleEdit();
        },
        err => logger.warn(`telegram/progress: sendMessage failed: ${err.message}`)
      ).catch(() => { /* swallow */ });
    } else {
      scheduleEdit();
    }
  }

  async function finalize() {
    if (finalized) return;
    finalized = true;

    // Clear any pending throttle timer
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    // Flush any remaining pending text
    const text = pendingText;
    pendingText = null;

    if (messageId != null && text != null) {
      try {
        await editMessage(chatId, messageId, text, opts);
      } catch (err) {
        logger.warn(`telegram/progress: final editMessage failed: ${err.message}`);
      }
    }
  }

  return { update, finalize };
}
