# Wyspr

Anonymous messages, but with accounts. Senders must sign in, so the receiver sees "anonymous" while the server can still enforce blocks, rate limits and reports. Senders can choose to reveal themselves.

Live: https://br-empty-fog-az0bothu-wyspr.compute.c-3.ap-southeast-1.aws.neon.tech/

- `server.mjs`: Neon Function (API + serves the page). Talks to Postgres over Neon's HTTP SQL endpoint, so there are no dependencies.
- `page.html`: the whole frontend. Share links look like `/u/username`.
- `schema.sql`: database tables (Neon project `nuggetngl`).
- `build.mjs`: `node build.mjs` puts the page into the server and writes `dist/index.mjs`, which gets zipped and deployed as the `wyspr` function.
