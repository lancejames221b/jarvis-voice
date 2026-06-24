import fs from 'fs';
import logger from '../logger.js';

export const HISTORY_CAP = 20;

const CACHE = new Map();

function getStorePath() {
  return process.env.TELEGRAM_HISTORY_STORE
    || `${process.env.HOME || '/tmp'}/.local/state/jarvis-voice/telegram-history.json`;
}

function readStore() {
  const storePath = getStorePath();
  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    if (!raw || !raw.trim()) return {};
    const store = JSON.parse(raw);
    // Hydrate in-memory cache from disk
    for (const [key, entries] of Object.entries(store)) {
      if (Array.isArray(entries)) {
        CACHE.set(key, entries);
      }
    }
    return store;
  } catch (err) {
    if (err.code === 'ENOENT' || !err.code) {
      return {};
    }
    logger.warn(`telegram/history-store: failed to read store at ${getStorePath()}: ${err.message}`);
    return {};
  }
}

function writeStore(store) {
  const storePath = getStorePath();
  const dir = storePath.substring(0, storePath.lastIndexOf('/'));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // directory may already exist
  }
  const tmpPath = storePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
    fs.renameSync(tmpPath, storePath);
  } catch (err) {
    logger.warn(`telegram/history-store: failed to persist store to ${storePath}: ${err.message}`);
    // Clean up temp file if write succeeded but rename failed
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

function getCache() {
  if (!CACHE.has('__initialized')) {
    readStore();
    CACHE.set('__initialized', true);
  }
  return CACHE;
}

export function loadHistory(chatKey) {
  const cache = getCache();
  return cache.get(chatKey) || [];
}

export function pushHistory(chatKey, role, content) {
  const cache = getCache();
  const entries = cache.get(chatKey) || [];
  entries.push({ role, content });
  // Trim to HISTORY_CAP most recent
  if (entries.length > HISTORY_CAP) {
    entries.splice(0, entries.length - HISTORY_CAP);
  }
  cache.set(chatKey, entries);
  // Persist the whole store
  const store = {};
  for (const [k, v] of cache.entries()) {
    if (k !== '__initialized') store[k] = v;
  }
  writeStore(store);
}

export function clearHistory(chatKey) {
  const cache = getCache();
  cache.delete(chatKey);
  // Persist the whole store
  const store = {};
  for (const [k, v] of cache.entries()) {
    if (k !== '__initialized') store[k] = v;
  }
  writeStore(store);
}

/** Reset in-memory cache and delete the on-disk store file. For test use only. */
export function resetCache() {
  CACHE.clear();
  try { fs.unlinkSync(getStorePath()); } catch { /* ignore */ }
}
