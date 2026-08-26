/**
 * Cheap syntax gate: parse every JS file we ship. No dependencies, no config.
 * Not a substitute for ESLint -- it just guarantees nothing unparseable lands.
 */

import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SKIP = new Set(['node_modules', '.git', '.github', 'data']);

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (['.js', '.mjs'].includes(extname(e.name))) yield p;
  }
}

const files = [];
for await (const f of walk('.')) files.push(f);

const failures = [];
await Promise.all(
  files.map(async (f) => {
    try {
      await run(process.execPath, ['--check', f]);
    } catch (err) {
      failures.push(`${f}\n${err.stderr?.trim() ?? err.message}`);
    }
  }),
);

if (failures.length > 0) {
  console.error(`${failures.length} file(s) failed to parse:\n`);
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`${files.length} file(s) parse cleanly.`);
