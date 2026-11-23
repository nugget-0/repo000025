# Wyspr

Anonymous messages, but with accounts. Senders must sign in, so the receiver sees "anonymous" while the server can still enforce blocks, rate limits and reports. Senders can choose to reveal themselves.

The page is hosted on Vercel; the API runs on a Neon Function.

- `index.html`: the whole frontend, hosted on Vercel. Calls the API on Neon.
- `server.mjs`: the API. The Neon Function `wyspr` is a small loader that pulls this file from GitHub (main) about once a minute, so pushing changes here updates the live API — no redeploy needed.
- `loader.mjs`: that loader (what's actually deployed on Neon).
- `schema.sql`: database tables (Neon project `nuggetngl`).
- `vercel.json`: makes `/u/username` and `/admin` load the page on Vercel.

Admin panel: sign in as @nugget and click **Admin** (or go to `/admin`). Shows stats, every user, every message with sender and receiver, reports, and lets you delete messages and ban/unban accounts.
