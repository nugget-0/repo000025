// Loads the real backend (server.mjs) from GitHub, so updating it = git push.
const SRC = 'https://raw.githubusercontent.com/nugget-0/repo000025/main/server.mjs';
let mod = null, src = '', at = 0;
async function load() {
  if (mod && Date.now() - at < 60000) return mod;
  at = Date.now();
  try {
    const r = await fetch(SRC + '?t=' + Date.now());
    if (r.ok) {
      const t = await r.text();
      if (t !== src) {
        try {
          const m = await import('data:text/javascript;base64,' + Buffer.from(t).toString('base64'));
          mod = m.default; src = t;
        } catch (e) { if (!mod) throw e; }
      }
    }
  } catch (e) { if (!mod) throw e; }
  if (!mod) throw new Error('could not load backend');
  return mod;
}
export default {
  async fetch(req) {
    try { return await (await load()).fetch(req); }
    catch (e) {
      return new Response(JSON.stringify({ error: 'Loader: ' + e.message }), {
        status: 500, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    }
  },
};
