/**
 * src/comms/provider.js
 *
 * JSDoc typedef for the CommsProvider contract (Jarvis v2 §1.2).
 * No runtime code — this file is the canonical contract reference.
 *
 * STEP 0: additive skeleton — nothing imports this in live code yet.
 */

/**
 * A CommsProvider is the single bridge between the neutral comms layer and one
 * concrete surface (Discord, Telegram, Voice, …).
 *
 * Lifecycle:
 *   1. `capabilities(recipient)` — resolve what this surface supports for the
 *      given recipient (channel vs thread vs DM may differ).
 *   2. `send(recipient, msg, caps)` — deliver the OutMessage.  The same `caps`
 *      instance that was passed to buildRuntimeBlock() on the gateway side is
 *      re-used here, so "what the model was told it can do" and "what the
 *      renderer enforces" cannot diverge.
 *   3. `sendTyping(recipient)` — optional; no-op if the surface does not
 *      support typing indicators.
 *
 * @typedef {Object} CommsProvider
 * @property {'discord'|'telegram'|'voice'} surface
 * @property {(recipient: import('./types.js').Recipient) => import('../capabilities/schema.js').Capabilities} capabilities
 *   Resolve Capabilities for this recipient on this surface.
 * @property {(recipient: import('./types.js').Recipient, msg: import('./types.js').OutMessage, caps: import('../capabilities/schema.js').Capabilities) => Promise<import('./types.js').SendResult>} send
 *   Deliver msg to recipient.  Chunking, markdown downgrade, AttachmentBuilder
 *   wrapping, and EmbedBuilder wrapping all happen inside send().
 * @property {(recipient: import('./types.js').Recipient) => Promise<void>} [sendTyping]
 *   Optional affordance — omit or no-op if the surface does not support it.
 */

export {};
