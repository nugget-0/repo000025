// Bundles page.html into server.mjs -> dist/index.mjs, then zip it and deploy as a Neon Function.
import fs from 'node:fs';
const html = fs.readFileSync('page.html', 'utf8');
const src = fs.readFileSync('server.mjs', 'utf8').split('__PAGE_HTML__').join(JSON.stringify(html));
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.mjs', src);
console.log('built dist/index.mjs');
