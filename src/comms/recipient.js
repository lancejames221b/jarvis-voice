/**
 * recipient.js — channel-key parsing and thread-suffix stripping.
 *
 * Single source of truth for interpreting session channelKeys across all
 * surfaces (discord, telegram). Previously, each call site in jarvis-gateway
 * used a Discord-only regex that silently returned a non-match for Telegram
 * keys, causing ask-mode and mcp-mode to always be off for Telegram sessions.
 */

/**
 * Parse a session channelKey into its surface + raw ids.
 *
 * Supported formats:
 *   discord:  agent:main:discord:channel:<id>[:thread:<tid>]
 *   telegram: agent:main:telegram:chat:<id>[:topic:<tid>]   (<id> may be negative: -100...)
 *
 * @param {string|null|undefined} channelKey
 * @returns {{ surface: string, channelId: string, threadId: string|null }|null}
 */
export function parseChannelKey(channelKey) {
  if (!channelKey) return null;

  // Discord: channel id is always a positive decimal integer.
  const discord = channelKey.match(/discord:channel:(\d+)(?::thread:(\d+))?/);
  if (discord) {
    return {
      surface: "discord",
      channelId: discord[1],
      threadId: discord[2] ?? null,
    };
  }

  // Telegram: chat id may be negative (supergroup/channel ids start with -100).
  // [\w-]+ matches digits, word chars, and a leading minus sign.
  const telegram = channelKey.match(/telegram:chat:([\w-]+)(?::topic:(\d+))?/);
  if (telegram) {
    return {
      surface: "telegram",
      channelId: telegram[1],
      threadId: telegram[2] ?? null,
    };
  }

  return null;
}

/**
 * Strip a trailing :thread:<id> (discord) or :topic:<id> (telegram) suffix.
 * Returns the key unchanged if there is no such suffix.
 *
 * @param {string} k
 * @returns {string}
 */
export const stripThreadSuffix = (k) => k.replace(/:(thread|topic):\d+$/, "");
