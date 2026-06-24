/**
 * src/comms/errors.js
 *
 * Shared error class for the neutral comms layer (Jarvis v2 §1.3).
 *
 * STEP 0: additive skeleton — nothing imports this in live code yet.
 */

/**
 * Thrown by a CommsProvider when message delivery fails.
 *
 * `kind` discriminator values:
 *   'missing-permissions' — the bot lacks permission to send to this channel/chat.
 *   'dm-blocked'          — the recipient has DMs blocked or the bot is not a mutual member.
 *   'not-found'           — the channel/chat/thread no longer exists.
 *   'rate-limited'        — the surface API is throttling the send; may retry later.
 *
 * @typedef {'missing-permissions'|'dm-blocked'|'not-found'|'rate-limited'} SendErrorKind
 */
export class SendError extends Error {
  /**
   * @param {SendErrorKind} kind      - discriminator for programmatic handling
   * @param {string}        surface   - 'discord' | 'telegram' | 'voice'
   * @param {string}        channelId - surface-native channel/chat id
   * @param {unknown}       [cause]   - original error from the surface SDK
   */
  constructor(kind, surface, channelId, cause) {
    super(`${surface}:${kind}`);
    this.name = 'SendError';
    /** @type {SendErrorKind} */
    this.kind = kind;
    /** @type {string} */
    this.surface = surface;
    /** @type {string} */
    this.channelId = channelId;
    /** @type {unknown} */
    this.cause = cause;
  }
}
