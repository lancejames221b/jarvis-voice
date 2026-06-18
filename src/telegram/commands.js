const KNOWN = new Set(['register', 'engine', 'model', 'status', 'cancel', 'verbose']);

export function parseCommand(text) {
  const t = String(text ?? '').trim();
  if (!t.startsWith('/')) return null;
  const [head, ...rest] = t.slice(1).split(/\s+/);
  const cmd = head.split('@')[0].toLowerCase(); // strip @botname suffix
  const arg = rest.length ? rest.join(' ') : null;
  if (!KNOWN.has(cmd)) return { cmd: 'unknown', arg: cmd };
  return { cmd, arg };
}
