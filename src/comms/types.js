/**
 * src/comms/types.js
 *
 * JSDoc typedefs for the neutral comms layer (Jarvis v2 §1.1).
 * No runtime code — this file exists solely as a type-documentation anchor
 * that other modules can reference via @typedef imports.
 *
 * STEP 0: additive skeleton — nothing imports these types in live code yet.
 */

/**
 * @typedef {Object} Recipient
 * @property {'discord'|'telegram'|'voice'} surface
 * @property {'channel'|'thread'|'user'|'chat'} kind
 * @property {string} id         - namespaced by surface; raw id within surface
 * @property {string} [topicId]  - telegram forum topic / discord thread parent
 */

/**
 * @typedef {Object} AgnosticFile
 * NEVER a discord.js AttachmentBuilder — surfaces wrap to their own types at the boundary.
 * @property {'image'|'audio'|'doc'|'video'} kind
 * @property {string} [path]    - on-disk path (allowlist-validated before use)
 * @property {Buffer} [buffer]  - in-memory bytes (e.g. cgg PNG/mmd buffers)
 * @property {string} name
 * @property {string} [mime]
 */

/**
 * @typedef {Object} NeutralEmbed
 * @property {string} [title]
 * @property {{name:string, value:string}[]} [fields]
 */

/**
 * @typedef {Object} ReplyContext
 * @property {string}  [messageId]       - discord allowedMentions+reply / telegram reply_to_message_id
 * @property {string}  [threadId]        - discord thread / telegram message_thread_id
 * @property {boolean} [suppressMention]
 */

/**
 * @typedef {Object} OutMessage
 * The ONLY shape that crosses the comms boundary from any producer.
 * @property {string}          [text]
 * @property {AgnosticFile[]}  [attachments]
 * @property {NeutralEmbed}    [embed]
 * @property {{audioPath:string}} [voice]  - voice surface only; pre-synthesized audio
 * @property {ReplyContext}    [replyTo]
 * @property {Object}          [meta]      - surface-specific hints e.g. {parseMode?, silent?}
 */

/**
 * @typedef {Object} SendResult
 * @property {string|null} messageId  - null for voice (no message id)
 * @property {string}      channelId
 */

export {};
