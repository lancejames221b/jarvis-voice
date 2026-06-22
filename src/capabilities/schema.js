/**
 * src/capabilities/schema.js
 *
 * Flat Capabilities typedef and frozen per-surface defaults (Jarvis v2 §2.1, §2.2).
 *
 * Resolution logic lives in src/capabilities/resolve.js (STEP 5).
 * This file is the canonical schema reference — nothing else should define
 * the shape or the surface defaults.
 *
 * STEP 0: additive skeleton — nothing imports this in live code yet.
 */

/**
 * A flat, typed descriptor of what a given session can do.
 *
 * The SAME instance feeds both sides of the comms contract:
 *   - gateway: buildRuntimeBlock(caps) → preamble injected into the prompt
 *   - comms:   CommsProvider.send(recipient, msg, caps) → rendering decisions
 *
 * This means "what the model is told it can do" and "what the renderer
 * enforces" cannot diverge.
 *
 * @typedef {Object} Capabilities
 * @property {'discord'|'telegram'|'voice'} surface
 * @property {string}  model            - resolved model id (LABEL only in prompt, never a raw channel id)
 * @property {'claude'|'qwen'} engine
 * @property {number}  maxLen           - 2000 discord / 4096 telegram / 0 voice (no chunking)
 * @property {boolean} supportsMarkdown
 * @property {boolean} supportsEmbeds
 * @property {boolean} canAttachFiles
 * @property {boolean} canThread
 * @property {boolean} canReact
 * @property {boolean} isVoice
 * @property {boolean} canReadFilePaths - claude: true; qwen: false (files inlined as text)
 * @property {boolean} hasTools         - claude && mcp!=='off' && !askMode write-block
 * @property {'off'|'subset'|'full'} mcpMode
 * @property {boolean} askMode          - plan/read-only mode
 */

/**
 * Code-side fallback surface defaults.
 *
 * These MUST match the config.yaml `capabilities:` block exactly so that a
 * missing config on generic does not silently change behavior.
 *
 * config.yaml equivalent:
 * ```yaml
 * capabilities:
 *   discord:  { maxLen: 2000, supportsMarkdown: true,  supportsEmbeds: true,  canAttachFiles: true,  canThread: true, canReact: true }
 *   telegram: { maxLen: 4096, supportsMarkdown: false, supportsEmbeds: false, canAttachFiles: true,  canThread: true, canReact: false }
 *   voice:    { maxLen: 0,    supportsMarkdown: false, supportsEmbeds: false, canAttachFiles: false, isVoice: true }
 * ```
 *
 * @type {Readonly<Record<'discord'|'telegram'|'voice', Partial<Capabilities>>>}
 */
export const SURFACE_DEFAULTS = Object.freeze({
  discord: Object.freeze({
    surface: 'discord',
    maxLen: 2000,
    supportsMarkdown: true,
    supportsEmbeds: true,
    canAttachFiles: true,
    canThread: true,
    canReact: true,
    isVoice: false,
    canReadFilePaths: true,
    hasTools: true,
    mcpMode: 'full',
    askMode: false,
  }),
  telegram: Object.freeze({
    surface: 'telegram',
    maxLen: 4096,
    supportsMarkdown: false,
    supportsEmbeds: false,
    canAttachFiles: true,
    canThread: true,
    canReact: false,
    isVoice: false,
    canReadFilePaths: true,
    hasTools: true,
    mcpMode: 'full',
    askMode: false,
  }),
  voice: Object.freeze({
    surface: 'voice',
    maxLen: 0,
    supportsMarkdown: false,
    supportsEmbeds: false,
    canAttachFiles: false,
    canThread: false,
    canReact: false,
    isVoice: true,
    canReadFilePaths: false,
    hasTools: false,
    mcpMode: 'off',
    askMode: false,
  }),
});

export {};
