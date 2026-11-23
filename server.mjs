import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

// The site itself is hosted on Vercel (index.html); this only serves the API.
const PAGE = 'Wyspr API';
const ADMIN = 'nugget';

// ---------- database over Neon's HTTP SQL endpoint (no driver needed) ----------
const DB_URL = process.env.DATABASE_URL || process.env.DB_URL;
let sqlEndpoint = null;
function endpoints() {
  const host = new URL(DB_URL).hostname;
  const rest = host.split('.').slice(1).join('.');
  return [`https://api.${rest}/sql`, `https://${host}/sql`];
}
async function q(query, params = []) {
  const list = sqlEndpoint ? [sqlEndpoint] : endpoints();
  let lastErr;
  for (const url of list) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Neon-Connection-String': DB_URL,
          'Neon-Raw-Text-Output': 'true',
        },
        body: JSON.stringify({ query, params: params.map(p => (p === null || p === undefined ? null : String(p))) }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const e = new Error(data.message || ('db error ' + r.status));
        e.code = data.code; e.db = true;
        throw e;
      }
      sqlEndpoint = url;
      return data.rows || [];
    } catch (e) {
      lastErr = e;
      if (e.db) throw e; // real SQL error, don't try another endpoint
    }
  }
  throw lastErr;
}

// ---------- helpers ----------
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
const err = (msg, status = 400) => json({ error: msg }, status);
const sha = s => createHash('sha256').update(s).digest('hex');

function hashPass(pw) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(pw, salt, 32).toString('hex');
}
function checkPass(pw, stored) {
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(pw, salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function newSession(userId) {
  const token = randomBytes(32).toString('hex');
  await q('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [sha(token), userId]);
  return token;
}
async function getUser(req) {
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const rows = await q(
    'SELECT u.id, u.username, u.prompt FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND NOT u.banned',
    [sha(auth.slice(7))]
  );
  return rows[0] || null;
}
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

// ---------- API ----------
async function api(req, path) {
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  if (path === '/api/signup' || path === '/api/login') {
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!USERNAME_RE.test(username)) return err('Username must be 3–20 letters, numbers or _');
    if (password.length < 6) return err('Password must be at least 6 characters');
    if (path === '/api/signup') {
      const taken = await q('SELECT 1 FROM users WHERE username = $1', [username]);
      if (taken.length) return err('That username is taken');
      const rows = await q('INSERT INTO users (username, pass_hash) VALUES ($1, $2) RETURNING id', [username, hashPass(password)]);
      return json({ token: await newSession(rows[0].id), username });
    }
    const rows = await q('SELECT id, pass_hash, banned FROM users WHERE username = $1', [username]);
    if (!rows.length || !checkPass(password, rows[0].pass_hash)) return err('Wrong username or password', 401);
    if (rows[0].banned === 't' || rows[0].banned === 'true') return err('This account is banned', 403);
    return json({ token: await newSession(rows[0].id), username });
  }

  if (path.startsWith('/api/profile/')) {
    const name = decodeURIComponent(path.slice(13)).toLowerCase();
    const rows = await q('SELECT username, prompt FROM users WHERE username = $1', [name]);
    if (!rows.length) return err('No one with that username', 404);
    return json(rows[0]);
  }

  // everything below needs an account
  const me = await getUser(req);
  if (!me) return err('Sign in first', 401);

  if (path.startsWith('/api/admin/')) return admin(path, body, me);

  switch (path) {
    case '/api/me':
      return json({ username: me.username, prompt: me.prompt, admin: me.username === ADMIN });

    case '/api/logout':
      await q('DELETE FROM sessions WHERE token = $1', [sha((req.headers.get('authorization') || '').slice(7))]);
      return json({ ok: true });

    case '/api/prompt': {
      const prompt = String(body.prompt || '').trim().slice(0, 120) || 'send me anonymous messages!';
      await q('UPDATE users SET prompt = $1 WHERE id = $2', [prompt, me.id]);
      return json({ prompt });
    }

    case '/api/send': {
      const to = String(body.to || '').toLowerCase();
      const text = String(body.body || '').trim();
      if (!text) return err('Write something first');
      if (text.length > 500) return err('Max 500 characters');
      const target = await q('SELECT id FROM users WHERE username = $1', [to]);
      if (!target.length) return err('No one with that username', 404);
      const toId = target[0].id;
      if (String(toId) === String(me.id)) return err("You can't message yourself");
      const blocked = await q('SELECT 1 FROM blocks WHERE blocker = $1 AND blocked = $2', [toId, me.id]);
      if (blocked.length) return err("You can't message this person", 403);
      const recent = await q("SELECT count(*) AS n FROM messages WHERE from_user = $1 AND created_at > now() - interval '1 hour'", [me.id]);
      if (Number(recent[0].n) >= 10) return err('Slow down — max 10 messages an hour', 429);
      await q('INSERT INTO messages (to_user, from_user, body, revealed) VALUES ($1, $2, $3, $4)', [toId, me.id, text, body.reveal ? 'true' : 'false']);
      return json({ ok: true });
    }

    case '/api/inbox': {
      // sender name only leaves the server if the sender chose to reveal
      const rows = await q(
        `SELECT m.id, m.body, m.created_at, m.reply, m.revealed,
                CASE WHEN m.revealed THEN u.username END AS from_name
           FROM messages m JOIN users u ON u.id = m.from_user
          WHERE m.to_user = $1 ORDER BY m.created_at DESC LIMIT 100`, [me.id]);
      return json(rows.map(r => ({ ...r, revealed: r.revealed === 't' || r.revealed === 'true' })));
    }

    case '/api/sent': {
      const rows = await q(
        `SELECT m.id, m.body, m.created_at, m.reply, m.revealed, u.username AS to_name
           FROM messages m JOIN users u ON u.id = m.to_user
          WHERE m.from_user = $1 ORDER BY m.created_at DESC LIMIT 100`, [me.id]);
      return json(rows.map(r => ({ ...r, revealed: r.revealed === 't' || r.revealed === 'true' })));
    }

    case '/api/reveal': {
      const rows = await q('UPDATE messages SET revealed = true WHERE id = $1 AND from_user = $2 RETURNING id', [body.id, me.id]);
      return rows.length ? json({ ok: true }) : err('Not your message', 404);
    }

    case '/api/reply': {
      const text = String(body.text || '').trim().slice(0, 500);
      if (!text) return err('Write a reply first');
      const rows = await q('UPDATE messages SET reply = $1, replied_at = now() WHERE id = $2 AND to_user = $3 RETURNING id', [text, body.id, me.id]);
      return rows.length ? json({ ok: true }) : err('Not your message', 404);
    }

    case '/api/delete': {
      await q('DELETE FROM messages WHERE id = $1 AND to_user = $2', [body.id, me.id]);
      return json({ ok: true });
    }

    case '/api/block': {
      // block the (still hidden) sender of a message in my inbox
      const rows = await q('SELECT from_user FROM messages WHERE id = $1 AND to_user = $2', [body.id, me.id]);
      if (!rows.length) return err('Not your message', 404);
      await q('INSERT INTO blocks (blocker, blocked) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me.id, rows[0].from_user]);
      await q('DELETE FROM messages WHERE to_user = $1 AND from_user = $2', [me.id, rows[0].from_user]);
      return json({ ok: true });
    }

    case '/api/unblockall':
      await q('DELETE FROM blocks WHERE blocker = $1', [me.id]);
      return json({ ok: true });

    case '/api/report': {
      const rows = await q('SELECT 1 FROM messages WHERE id = $1 AND to_user = $2', [body.id, me.id]);
      if (!rows.length) return err('Not your message', 404);
      await q('INSERT INTO reports (message_id, reporter) VALUES ($1, $2)', [body.id, me.id]);
      return json({ ok: true });
    }
  }
  return err('Not found', 404);
}

// ---------- admin (only @nugget) ----------
const bool = v => v === 't' || v === 'true' || v === true;
async function admin(path, body, me) {
  if (me.username !== ADMIN) return err('Admins only', 403);
  switch (path) {
    case '/api/admin/stats': {
      const r = await q(`SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM messages) AS messages,
        (SELECT count(*) FROM messages WHERE created_at > now() - interval '1 day') AS messages_24h,
        (SELECT count(*) FROM reports) AS reports, (SELECT count(*) FROM users WHERE banned) AS banned`);
      return json(r[0]);
    }
    case '/api/admin/users': {
      const rows = await q(`SELECT u.id, u.username, u.prompt, u.banned, u.created_at,
        (SELECT count(*) FROM messages m WHERE m.from_user = u.id) AS sent,
        (SELECT count(*) FROM messages m WHERE m.to_user = u.id) AS received,
        (SELECT count(*) FROM reports r JOIN messages m ON m.id = r.message_id WHERE m.from_user = u.id) AS reported
        FROM users u ORDER BY u.created_at DESC LIMIT 500`);
      return json(rows.map(r => ({ ...r, banned: bool(r.banned) })));
    }
    case '/api/admin/messages': {
      const user = String(body.user || '').toLowerCase();
      const rows = await q(`SELECT m.id, m.body, m.created_at, m.reply, m.revealed, f.username AS from_name, t.username AS to_name,
        (SELECT count(*) FROM reports r WHERE r.message_id = m.id) AS reports
        FROM messages m JOIN users f ON f.id = m.from_user JOIN users t ON t.id = m.to_user
        WHERE ($1 = '' OR f.username = $1 OR t.username = $1) AND ($2 = 'false' OR EXISTS (SELECT 1 FROM reports r WHERE r.message_id = m.id))
        ORDER BY m.created_at DESC LIMIT 300`, [user, body.reported ? 'true' : 'false']);
      return json(rows.map(r => ({ ...r, revealed: bool(r.revealed) })));
    }
    case '/api/admin/delete': {
      await q('DELETE FROM messages WHERE id = $1', [body.id]);
      return json({ ok: true });
    }
    case '/api/admin/ban': {
      const name = String(body.username || '').toLowerCase();
      if (name === ADMIN) return err("Can't ban the admin");
      const ban = body.ban ? 'true' : 'false';
      const rows = await q('UPDATE users SET banned = $1 WHERE username = $2 RETURNING id', [ban, name]);
      if (!rows.length) return err('No such user', 404);
      if (body.ban) await q('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]);
      return json({ ok: true });
    }
  }
  return err('Not found', 404);
}

const handler = {
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      } });
    }
    if (path.startsWith('/api/')) {
      try { return await api(req, path); }
      catch (e) { return err('Server error: ' + e.message, 500); }
    }
    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
};
export default handler;
