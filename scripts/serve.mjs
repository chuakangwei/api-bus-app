/**
 * Static file server for local development -- `npm run serve`.
 *
 * The app is plain ES modules with no build step, so serving the repo root over
 * HTTP is all that is needed. Opening index.html via file:// will NOT work --
 * module imports and fetch both require a real origin.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT ?? 8099);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

createServer(async (req, res) => {
  const rel = decodeURI(req.url.split('?')[0]);
  const file = resolve(join(ROOT, rel === '/' ? 'index.html' : rel));
  // Refuse anything that escapes the served root.
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(PORT, () => console.log(`Serving ${ROOT} on http://localhost:${PORT}`));
