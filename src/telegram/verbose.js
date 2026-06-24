import fs from 'fs';
import logger from '../logger.js';

const CACHE = new Map();

function getStorePath() {
  return process.env.TELEGRAM_VERBOSE_STORE
    || `${process.env.HOME || '/tmp'}/.local/state/jarvis-voice/telegram-verbose.json`;
}

function readStore() {
  const storePath = getStorePath();
  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    if (!raw || !raw.trim()) return {};
    const store = JSON.parse(raw);
    for (const [key, val] of Object.entries(store)) {
      CACHE.set(key, val);
    }
    return store;
  } catch (err) {
    if (err.code === 'ENOENT' || !err.code) {
      return {};
    }
    logger.warn(`telegram/verbose: failed to read store at ${getStorePath()}: ${err.message}`);
    return {};
  }
}

function writeStore() {
  const storePath = getStorePath();
  const dir = storePath.substring(0, storePath.lastIndexOf('/'));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // directory may already exist
  }
  const store = {};
  for (const [k, v] of CACHE.entries()) {
    if (k !== '__initialized') store[k] = v;
  }
  const tmpPath = storePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
    fs.renameSync(tmpPath, storePath);
  } catch (err) {
    logger.warn(`telegram/verbose: failed to persist store to ${storePath}: ${err.message}`);
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

export function isVerbose(chatKey) {
  const cache = getCache();
  return cache.get(chatKey) === true;
}

export function setVerbose(chatKey, on) {
  const cache = getCache();
  cache.set(chatKey, on);
  writeStore();
}

/** Reset in-memory cache and delete the on-disk store file. For test use only. */
export function resetCache() {
  CACHE.clear();
  try { fs.unlinkSync(getStorePath()); } catch { /* ignore */ }
}
