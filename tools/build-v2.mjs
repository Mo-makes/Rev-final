// Builds the experimental v2 site into dist-v2/.
// Shared, already-approved media (photos, fonts, logos, the sponsorship packet) is copied
// from rev-site/assets so it isn't duplicated in git; rev-site-v2/ is layered on top.
// The approved site in rev-site/ and its dist/ build are not touched.
import { cp, mkdir, rm, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'rev-site-v2');
const shared = path.join(root, 'rev-site', 'assets');
const output = path.join(root, 'dist-v2');
const sharedFolders = ['brand', 'docs', 'fonts', 'icons', 'img'];
const skip = new Set(['README.md', 'PERFORMANCE.md']);

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'assets'), { recursive: true });

for (const folder of sharedFolders) {
  await cp(path.join(shared, folder), path.join(output, 'assets', folder), { recursive: true });
}
await cp(source, output, {
  recursive: true,
  filter: (file) => !skip.has(path.basename(file)) && !path.basename(file).startsWith('.'),
});

// Local serving config: real 404s, no SPA fallback, HTML always revalidated.
await writeFile(path.join(output, 'serve.json'), JSON.stringify({
  cleanUrls: false,
  headers: [
    { source: '**/*.html', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    { source: 'assets/**', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
  ],
}, null, 2));

let files = 0;
let bytes = 0;
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else { files += 1; bytes += (await stat(full)).size; }
  }
}
await walk(output);
console.log(`dist-v2: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
