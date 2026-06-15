/**
 * cgg dispatch — natural-language + `!cgg` call-graph router.
 *
 * cgg (NeuralNotwerk/cgg) is an offline call-graph generator: point it at a
 * file or folder, get a mermaid call graph. Discord cannot render mermaid
 * natively, so this module renders the mermaid to a PNG via mermaid-cli
 * (mmdc) and posts the PNG inline PLUS the raw .mmd file attached.
 *
 * Two entry shapes, both routed through tryCggDispatch():
 *   1. Explicit command:  !cgg <path> [filter] [hops]
 *   2. Agent / NL intent: "call graph of <path>", "callgraph <path>",
 *      "cgg <path> filter <name>"
 *
 * Returns { handled: true } once it has replied, or { handled: false } when
 * no cgg intent matched so the caller falls through to the brain. This mirrors
 * the kanban-dispatch precedent (src/kanban-dispatch.js): a pre-brain
 * intercept that shells out to a local binary and renders the result.
 *
 * Safety:
 *   - the analysis path is resolved against a base root and may not escape it
 *     (no `..` traversal, no absolute paths outside the base)
 *   - cgg and mmdc run with execFile (no shell), bounded by a timeout
 *   - temp files are written under os.tmpdir() and cleaned up
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { AttachmentBuilder } from 'discord.js';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import logger from './logger.js';

const execFileAsync = promisify(execFile);

// Binaries. cgg lands in ~/.cargo/bin via `cargo install`; mmdc is the locally
// installed mermaid-cli in this repo's node_modules. Both overridable by env.
const CGG_BIN = process.env.CGG_BIN || `${process.env.HOME}/.cargo/bin/cgg`;
const MMDC_BIN =
  process.env.CGG_MMDC_BIN ||
  path.join(process.cwd(), 'node_modules', '.bin', 'mmdc');

// Puppeteer config so mmdc uses the system chromium (no bundled download).
// Written once on first render. --no-sandbox is required for headless root/CI.
// Probe the candidates on disk and pick the first that exists — paths differ
// per host (gamez has /usr/bin/chromium; generic only has google-chrome).
const CHROMIUM_PATH =
  process.env.CGG_CHROMIUM ||
  ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/snap/bin/chromium']
    .find((p) => existsSync(p)) ||
  '/usr/bin/chromium';

// Base root the analysis path is resolved under. Defaults to this repo so a
// bare `!cgg src/brain.js` works in dev; a per-channel project path can be
// passed in by the caller (resolved from the channel registry).
const DEFAULT_BASE = process.env.CGG_BASE || process.cwd();

const CGG_TIMEOUT_MS = Number(process.env.CGG_TIMEOUT_MS || 60_000);
const MMDC_TIMEOUT_MS = Number(process.env.CGG_MMDC_TIMEOUT_MS || 60_000);

// Mermaid can exceed Discord/render limits on huge graphs. Cap node count by
// refusing to render past this many lines; the .mmd is still attached so the
// user gets the full graph as text.
const MAX_MERMAID_LINES = Number(process.env.CGG_MAX_MERMAID_LINES || 1200);

// ── intent parsing ───────────────────────────────────────────────────────────

const LEAD = /^(?:jarvis\s*[,.]?\s*)?/i;

/**
 * Parse a message into a cgg request, or null if it is not a cgg intent.
 * Returns { path, filters: string[], hops: number|null } on a match.
 */
export function parseCggIntent(raw) {
  const text = (raw || '').trim();
  if (!text) return null;

  // 1. Explicit command:  !cgg <path> [filter] [hops]
  //    hops is the last token if it is a bare integer; filter is the middle.
  const bang = text.match(/^!cgg\b\s*(.*)$/is);
  if (bang) {
    return parseArgs(bang[1]);
  }

  // 2. NL: "call graph of <rest>" / "callgraph <rest>" / "cgg <rest>"
  const nl = text
    .replace(LEAD, '')
    .match(/^(?:call\s*graph(?:\s+of)?|callgraph|cgg)\b\s*(.+)$/is);
  if (nl) {
    return parseArgs(nl[1]);
  }

  return null;
}

/**
 * Parse the argument tail after the command word.
 * Grammar (all parts after <path> optional):
 *   <path> [filter <regex>...] [hops <n>] [<filter>] [<n>]
 * Bare trailing integer => hops. "filter X" / "--filter X" => filter.
 * Anything else after the path that is not a recognized keyword is treated
 * as a single filter pattern (covers `!cgg src/brain.js generateResponse 1`).
 */
function parseArgs(tail) {
  const tokens = (tail || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  const targetPath = tokens.shift();
  const filters = [];
  let hops = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const low = t.toLowerCase();
    if ((low === 'filter' || low === '--filter') && tokens[i + 1]) {
      filters.push(tokens[++i]);
      continue;
    }
    if ((low === 'hops' || low === '-n' || low === '--hops') && tokens[i + 1]) {
      const n = parseInt(tokens[++i], 10);
      if (Number.isFinite(n)) hops = n;
      continue;
    }
    // bare integer at the end => hops
    if (/^-?\d+$/.test(t)) {
      hops = parseInt(t, 10);
      continue;
    }
    // otherwise a positional filter pattern
    filters.push(t);
  }

  return { path: targetPath, filters, hops };
}

// ── path safety ──────────────────────────────────────────────────────────────

/**
 * Resolve `target` under `base`, refusing escapes. Returns the absolute path
 * or null if the resolved path leaves the base directory.
 */
function safeResolve(base, target) {
  const baseAbs = path.resolve(base);
  // expand a leading ~ to the base for convenience, strip leading slash so it
  // is always treated as relative to base
  const cleaned = target.replace(/^~\/?/, '').replace(/^\/+/, '');
  const abs = path.resolve(baseAbs, cleaned);
  if (abs !== baseAbs && !abs.startsWith(baseAbs + path.sep)) return null;
  return abs;
}

// ── render pipeline ──────────────────────────────────────────────────────────

let _puppeteerCfgPath = null;
async function ensurePuppeteerConfig() {
  if (_puppeteerCfgPath) return _puppeteerCfgPath;
  const p = path.join(os.tmpdir(), 'cgg-puppeteer-config.json');
  await fs.writeFile(
    p,
    JSON.stringify({
      executablePath: CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }),
  );
  _puppeteerCfgPath = p;
  return p;
}

/**
 * Run cgg + mmdc. Returns { mmd, mmdText, png|null, stats, skippedRender }.
 * Throws on cgg failure (caller surfaces the message to Discord).
 */
async function runCgg({ analysisPath, filters, hops }) {
  const stamp = `${process.pid}-${Math.abs(hashStr(analysisPath + filters.join(',') + hops))}`;
  const mmdPath = path.join(os.tmpdir(), `cgg-${stamp}.mmd`);
  const pngPath = path.join(os.tmpdir(), `cgg-${stamp}.png`);

  const args = [analysisPath, '-t', 'mermaid', '-o', mmdPath];
  for (const f of filters) args.push('--filter', f);
  if (hops !== null && hops !== undefined) args.push('-n', String(hops));

  let stats = '';
  try {
    const { stderr } = await execFileAsync(CGG_BIN, args, {
      timeout: CGG_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    stats = (stderr || '').trim().split('\n').pop() || '';
  } catch (err) {
    throw new Error(`cgg failed: ${(err.stderr || err.message || '').toString().slice(0, 400)}`);
  }

  const mmdText = await fs.readFile(mmdPath, 'utf8').catch(() => '');
  const lineCount = mmdText.split('\n').length;

  let pngBuffer = null;
  let skippedRender = false;
  if (mmdText.trim() && lineCount <= MAX_MERMAID_LINES) {
    try {
      const cfg = await ensurePuppeteerConfig();
      await execFileAsync(
        MMDC_BIN,
        ['-i', mmdPath, '-o', pngPath, '-t', 'dark', '-b', 'transparent', '-p', cfg],
        { timeout: MMDC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true' } },
      );
      pngBuffer = await fs.readFile(pngPath).catch(() => null);
    } catch (err) {
      logger.warn(`[cgg] mmdc render failed: ${(err.message || '').slice(0, 200)}`);
      pngBuffer = null;
    }
  } else if (lineCount > MAX_MERMAID_LINES) {
    skippedRender = true;
  }

  // cleanup temp files (best effort)
  fs.unlink(mmdPath).catch(() => {});
  fs.unlink(pngPath).catch(() => {});

  return { mmdText, pngBuffer, stats, skippedRender, lineCount };
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// ── public dispatch ──────────────────────────────────────────────────────────

/**
 * Attempt to handle `content` as a cgg request against `message`.
 * @param {import('discord.js').Message} message
 * @param {string} content
 * @param {{ base?: string }} [opts] base = project root the path resolves under
 * @returns {Promise<{handled: boolean}>}
 */
export async function tryCggDispatch(message, content, opts = {}) {
  const intent = parseCggIntent(content);
  if (!intent) return { handled: false };

  const base = opts.base || DEFAULT_BASE;
  const analysisPath = safeResolve(base, intent.path);
  if (!analysisPath) {
    await safeReply(message, `cgg: refusing path \`${intent.path}\` (escapes ${path.basename(base)}).`);
    return { handled: true };
  }

  // confirm the path exists under base
  try {
    await fs.access(analysisPath);
  } catch {
    await safeReply(message, `cgg: \`${intent.path}\` not found under \`${base}\`.`);
    return { handled: true };
  }

  const filterDesc = intent.filters.length ? ` filter=${intent.filters.join(',')}` : '';
  const hopDesc = intent.hops !== null ? ` hops=${intent.hops}` : '';
  logger.info(`[cgg] ${analysisPath}${filterDesc}${hopDesc} (by ${message.author?.tag || '?'})`);

  let typing;
  try {
    typing = message.channel?.sendTyping?.();
  } catch {}
  await Promise.resolve(typing).catch(() => {});

  let result;
  try {
    result = await runCgg({ analysisPath, filters: intent.filters, hops: intent.hops });
  } catch (err) {
    await safeReply(message, `cgg: ${(err.message || 'error').slice(0, 400)}`);
    return { handled: true };
  }

  if (!result.mmdText.trim()) {
    await safeReply(message, `cgg: no callables matched${filterDesc ? ` (${filterDesc.trim()})` : ''}. ${result.stats}`);
    return { handled: true };
  }

  const rel = path.relative(base, analysisPath) || path.basename(analysisPath);
  const header = `**cgg** \`${rel}\`${filterDesc}${hopDesc}\n${result.stats ? '`' + result.stats + '`' : ''}`;

  const files = [];
  if (result.pngBuffer) {
    files.push(new AttachmentBuilder(result.pngBuffer, { name: 'callgraph.png' }));
  }
  files.push(
    new AttachmentBuilder(Buffer.from(result.mmdText, 'utf8'), { name: 'callgraph.mmd' }),
  );

  let note = '';
  if (result.skippedRender) {
    note = `\n_(graph is ${result.lineCount} lines, past the ${MAX_MERMAID_LINES}-line render cap — PNG skipped, .mmd attached)_`;
  } else if (!result.pngBuffer) {
    note = `\n_(PNG render unavailable — .mmd attached)_`;
  }

  await safeReply(message, { content: header + note, files });
  return { handled: true };
}

async function safeReply(message, payload) {
  try {
    if (typeof payload === 'string') {
      await message.reply(payload);
    } else {
      await message.reply(payload);
    }
  } catch (err) {
    logger.warn(`[cgg] reply failed: ${(err.message || '').slice(0, 200)}`);
    try {
      await message.channel?.send(typeof payload === 'string' ? payload : payload);
    } catch {}
  }
}
