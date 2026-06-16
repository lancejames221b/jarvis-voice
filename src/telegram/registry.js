// src/telegram/registry.js — Telegram chat/topic ↔ project-directory binding.
// Reuses the existing channel-registry JSON file under a "telegram" top-level key.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import logger from '../logger.js';

const REGISTRY_PATH =
  process.env.CHANNEL_REGISTRY_PATH ||
  `${process.env.HOME || '/tmp'}/dev/contexts/channel-registry.json`;

/**
 * Build a registry key for a Telegram chat (with optional forum topic).
 *
 * @param {string|number} chatId
 * @param {string|number|null|undefined} [topicId]
 * @returns {string}
 */
export function telegramChatKey(chatId, topicId) {
  const base = `telegram:chat:${chatId}`;
  return topicId ? `${base}:topic:${topicId}` : base;
}

/**
 * Load the channel-registry JSON. Returns {} on any failure (non-fatal).
 * @returns {object}
 */
function _load() {
  try {
    if (!existsSync(REGISTRY_PATH)) return {};
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (e) {
    logger.warn({ err: e.message }, '[telegram-registry] load failed (non-fatal)');
    return {};
  }
}

/**
 * Look up the project directory bound to a telegram chat key.
 *
 * @param {string} chatKey — e.g. "telegram:chat:111" or "telegram:chat:111:topic:222"
 * @returns {string|null}
 */
export function getTelegramProjectPath(chatKey) {
  const reg = _load();
  return reg.telegram?.[chatKey]?.projectPath ?? null;
}

/**
 * Bind a telegram chat key to a project directory on disk.
 * Preserves all other top-level sections (e.g. registry.discord) untouched.
 *
 * @param {string} chatKey
 * @param {string} projectPath
 */
export function registerTelegramChat(chatKey, projectPath) {
  const reg = _load();
  reg.telegram = reg.telegram || {};
  reg.telegram[chatKey] = { ...(reg.telegram[chatKey] || {}), projectPath };
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2), 'utf8');
  logger.info({ chatKey, projectPath }, '[telegram-registry] bound');
}
