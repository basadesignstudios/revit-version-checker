// Runs the exact parser from app.js against real Revit files using Node built-ins only.
//
//   node tests/parse.test.mjs                 # every Revit file in ./samples
//   node tests/parse.test.mjs path/to/file.rvt other/folder
//
// Files are read in slices through a file handle, the same way the browser
// uses File.slice(), so nothing is loaded whole into memory.

import { readFile, readdir, stat, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = new Set(['.rvt', '.rfa', '.rte', '.rft']);

// Load app.js into a sandbox with no `document`, so only the parser is defined.
const sandbox = { TextDecoder, Map, Uint8Array, DataView, Math, Error, Promise };
sandbox.globalThis = sandbox;
vm.runInNewContext(await readFile(path.join(root, 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });
const { detectVersion, readCfbStream, scanForVersion } = sandbox.RevitVersion;

async function collect(target, out) {
  let info;
  try { info = await stat(target); } catch { return false; }
  if (info.isDirectory()) {
    for (const name of await readdir(target)) await collect(path.join(target, name), out);
  } else if (EXT.has(path.extname(target).toLowerCase())) {
    out.push(target);
  }
  return true;
}

async function nodeReader(file) {
  const handle = await open(file, 'r');
  const { size } = await handle.stat();
  let bytesRead = 0;
  return {
    size,
    handle,
    get bytesRead() { return bytesRead; },
    async read(offset, length) {
      length = Math.max(0, Math.min(length, size - offset));
      const buf = new Uint8Array(length);
      const r = await handle.read(buf, 0, length, offset);
      bytesRead += r.bytesRead;
      return buf.subarray(0, r.bytesRead);
    }
  };
}

const targets = process.argv.slice(2);
const files = [];
if (targets.length === 0) {
  const found = await collect(path.join(root, 'samples'), files);
  if (!found) console.log('No ./samples folder found.');
} else {
  for (const t of targets) {
    if (!(await collect(path.resolve(t), files))) console.log(`Not found: ${t}`);
  }
}
if (files.length === 0) {
  console.log('No Revit files (.rvt, .rfa, .rte, .rft) to test.');
  process.exit(0);
}

let failures = 0;
for (const file of files) {
  const reader = await nodeReader(file);
  try {
    const r = await detectVersion(reader);
    // Also run the fallback scan on its own so both paths are exercised.
    const scanReader = await nodeReader(file);
    const s = await scanForVersion(scanReader);
    await scanReader.handle.close();

    const mb = (reader.size / 1048576).toFixed(1);
    const label = r.version ? `Revit ${r.version}${r.isLT ? ' LT' : ''}` : 'NOT DETECTED';
    const agree = s.version === r.version ? 'scan agrees' : `scan says ${s.version ?? 'nothing'}`;
    console.log(`${label.padEnd(14)} via ${r.method} (${r.source ?? '-'}), build ${r.build ?? '-'}, ` +
      `read ${reader.bytesRead} of ${reader.size} bytes (${mb} MB), ${agree}  ${file}`);
    if (!r.version) failures++;
  } catch (e) {
    failures++;
    console.log(`ERROR  ${file}: ${e.message}`);
  } finally {
    await reader.handle.close();
  }
}
console.log(`\n${files.length - failures}/${files.length} files detected.`);
process.exit(failures ? 1 : 0);
