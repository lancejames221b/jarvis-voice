/**
 * src/comms/providers/discord.js — DiscordProvider
 *
 * The ONLY file in the comms layer that imports discord.js types.
 * Wraps neutral AgnosticFile / NeutralEmbed shapes into discord.js
 * AttachmentBuilder / EmbedBuilder at the delivery boundary.
 *
 * Usage:
 *   const provider = makeDiscordProvider({ client });
 *   await provider.send(recipient, msg, caps);
 *
 * This provider is DORMANT in STEP 1 — nothing calls send() live yet.
 * It is dependency-injected so it remains unit-testable without a real client.
 */

import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { SURFACE_DEFAULTS } from '../../capabilities/schema.js';
import { chunkText } from '../chunk.js';

/**
 * Map a neutral AgnosticFile to a discord.js AttachmentBuilder.
 *
 * @param {import('../types.js').AgnosticFile} f
 * @returns {import('discord.js').AttachmentBuilder}
 */
function toAttachmentBuilder(f) {
  if (f.path) return new AttachmentBuilder(f.path, { name: f.name });
  if (f.buffer) return new AttachmentBuilder(f.buffer, { name: f.name });
  throw new Error(`AgnosticFile "${f.name}" has neither path nor buffer`);
}

/**
 * Map a neutral NeutralEmbed to a discord.js EmbedBuilder.
 *
 * @param {import('../types.js').NeutralEmbed} embed
 * @returns {import('discord.js').EmbedBuilder}
 */
function toEmbedBuilder(embed) {
  const builder = new EmbedBuilder();
  if (embed.title) builder.setTitle(embed.title);
  if (embed.fields && embed.fields.length > 0) builder.addFields(embed.fields);
  return builder;
}

/**
 * Factory for the Discord CommsProvider.
 *
 * @param {{ client: import('discord.js').Client }} deps
 * @returns {import('../provider.js').CommsProvider}
 */
export function makeDiscordProvider(deps) {
  const { client } = deps;

  return {
    surface: 'discord',

    /**
     * Return capabilities for this recipient on Discord.
     * Uses SURFACE_DEFAULTS.discord merged with { surface: 'discord' }.
     *
     * @param {import('../types.js').Recipient} _recipient
     * @returns {import('../../capabilities/schema.js').Capabilities}
     */
    capabilities(_recipient) {
      return { ...SURFACE_DEFAULTS.discord, surface: 'discord' };
    },

    /**
     * Deliver an OutMessage to a Discord channel or thread.
     *
     * Chunking: msg.text is split by caps.maxLen; files + embed attach to the
     * first chunk only; subsequent chunks are text-only.
     *
     * @param {import('../types.js').Recipient} recipient
     * @param {import('../types.js').OutMessage} msg
     * @param {import('../../capabilities/schema.js').Capabilities} caps
     * @returns {Promise<import('../types.js').SendResult>}
     */
    async send(recipient, msg, caps) {
      // Resolve the target channel/thread via the injected client.
      let channel = client.channels.cache.get(recipient.id);
      if (!channel) {
        channel = await client.channels.fetch(recipient.id);
      }
      if (!channel) {
        throw new Error(`DiscordProvider: channel not found: ${recipient.id}`);
      }

      // Build discord.js attachment array (files on first chunk only).
      const discordFiles = (msg.attachments ?? []).map(toAttachmentBuilder);

      // Build embed (first chunk only, if present).
      const discordEmbed = msg.embed ? toEmbedBuilder(msg.embed) : null;

      // Chunk the text.
      const text = msg.text ?? '';
      const chunks = text.trim() ? chunkText(text, caps.maxLen) : [];

      // If there is no text but there are files/embed, send a single empty message.
      if (chunks.length === 0) {
        const sendOpts = {};
        if (discordFiles.length > 0) sendOpts.files = discordFiles;
        if (discordEmbed) sendOpts.embeds = [discordEmbed];

        const sent = await _sendToChannel(channel, recipient, msg.replyTo, sendOpts);
        return { messageId: sent?.id ?? null, channelId: recipient.id };
      }

      // Send the first chunk with files + embed attached.
      const firstOpts = { content: chunks[0] };
      if (discordFiles.length > 0) firstOpts.files = discordFiles;
      if (discordEmbed) firstOpts.embeds = [discordEmbed];

      const firstSent = await _sendToChannel(channel, recipient, msg.replyTo, firstOpts);

      // Subsequent chunks are text-only (no files or embed).
      for (let i = 1; i < chunks.length; i++) {
        await channel.send({ content: chunks[i] });
      }

      return { messageId: firstSent?.id ?? null, channelId: recipient.id };
    },

    /**
     * Send a typing indicator to the channel (optional affordance).
     *
     * @param {import('../types.js').Recipient} recipient
     * @returns {Promise<void>}
     */
    async sendTyping(recipient) {
      let channel = client.channels.cache.get(recipient.id);
      if (!channel) {
        try { channel = await client.channels.fetch(recipient.id); } catch { return; }
      }
      if (channel?.sendTyping) await channel.sendTyping();
    },
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Send a message to a channel, respecting the replyTo context.
 *
 * @param {object} channel     - discord.js channel/thread object
 * @param {import('../types.js').Recipient} recipient
 * @param {import('../types.js').ReplyContext|undefined} replyTo
 * @param {object} opts        - discord send options (content, files, embeds, …)
 * @returns {Promise<object>}  - discord.js Message
 */
async function _sendToChannel(channel, recipient, replyTo, opts) {
  if (replyTo?.messageId && recipient.kind === 'reply') {
    return channel.send({
      ...opts,
      reply: {
        messageReference: replyTo.messageId,
        failIfNotExists: false,
      },
      allowedMentions: replyTo.suppressMention
        ? { repliedUser: false }
        : undefined,
    });
  }
  return channel.send(opts);
}
