/**
 * src/comms/index.js — comms registry barrel (Jarvis v2 §1.4).
 *
 * Provides:
 *   registerProvider(surface, provider) — register a CommsProvider for a surface
 *   getProvider(surface)                — retrieve a registered provider (throws if missing)
 *   send(recipient, msg)                — resolve provider, compute caps, deliver
 *
 * Nothing registers a live provider yet in STEP 1 — this is the registry
 * infrastructure, ready for providers to opt in.
 */

/** @type {Map<string, import('./provider.js').CommsProvider>} */
const _registry = new Map();

/**
 * Register a CommsProvider for its surface.
 * Overwrites any previously registered provider for the same surface.
 *
 * @param {string} surface
 * @param {import('./provider.js').CommsProvider} provider
 */
export function registerProvider(surface, provider) {
  _registry.set(surface, provider);
}

/**
 * Retrieve the registered provider for a surface.
 *
 * @param {string} surface
 * @returns {import('./provider.js').CommsProvider}
 * @throws {Error} if no provider is registered for the surface
 */
export function getProvider(surface) {
  const provider = _registry.get(surface);
  if (!provider) {
    throw new Error(`comms: no provider registered for surface "${surface}"`);
  }
  return provider;
}

/**
 * Deliver an OutMessage to a Recipient.
 *
 * Resolves the provider by recipient.surface, computes capabilities for the
 * recipient, and delegates to provider.send(recipient, msg, caps).
 *
 * @param {import('./types.js').Recipient} recipient
 * @param {import('./types.js').OutMessage} msg
 * @returns {Promise<import('./types.js').SendResult>}
 */
export async function send(recipient, msg) {
  const provider = getProvider(recipient.surface);
  const caps = provider.capabilities(recipient);
  return provider.send(recipient, msg, caps);
}
