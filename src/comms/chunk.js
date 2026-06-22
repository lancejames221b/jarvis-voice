/**
 * src/comms/chunk.js
 *
 * Per-surface character limits and a pure text splitter (Jarvis v2 §1.4).
 *
 * The split logic mirrors the chunking in src/discord/message-handlers.js
 * (lines ~1002-1010) so that behavior is consistent when callers migrate to
 * the neutral comms layer:
 *   1. Prefer to break on the last "\n\n" before the limit.
 *   2. Fall back to the last "\n" before the limit if the \n\n split would
 *      produce a piece shorter than 500 chars.
 *   3. Hard-cut at `limit` when no suitable newline is found close enough.
 *   4. Trim leading whitespace from each continuation piece (mirrors .trimStart()).
 *
 * STEP 0: additive skeleton — nothing imports this in live code yet.
 */

/**
 * Per-surface maximum character counts for a single outbound message.
 *
 * voice: 0 means "no chunking" — TTS decides output length separately
 * (enforceOutputLength handles that path in speech-output.js).
 *
 * @type {{ discord: number, telegram: number, voice: number }}
 */
export const LIMITS = {
  discord: 2000,
  telegram: 4096,
  voice: 0,
};

/**
 * Split `text` into an array of strings each no longer than `limit` characters.
 *
 * Special cases:
 *   - limit <= 0  → returns [text] unchanged (used by voice surface).
 *   - empty / whitespace-only → returns [].
 *
 * Break preference (matches message-handlers.js ~line 1006-1008):
 *   1. Last "\n\n" at or before `limit` (paragraph break).
 *   2. Last "\n"  at or before `limit`, but only if \n\n was found at < 500
 *      characters (i.e. too close to the start to be useful).
 *   3. Hard cut at `limit`.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string[]}
 */
export function chunkText(text, limit) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  if (limit <= 0) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Look for the best break point within [0, limit].
    let splitAt = remaining.lastIndexOf('\n\n', limit);
    if (splitAt < 500) splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt < 500) splitAt = limit;

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  return chunks;
}
