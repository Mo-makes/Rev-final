// Serves dist-v2/ (the experimental v2 site) on port 3002 so it can run beside the
// approved site on 3000.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stat } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await stat(path.join(root, 'dist-v2', 'index.html'));
const port = process.env.PORT_V2 || '3002';
const server = spawn(process.execPath, [
  path.join(root, 'node_modules/serve/build/main.js'), 'dist-v2',
  '--config', path.join(root, 'dist-v2', 'serve.json'), '--listen', port, '--no-clipboard',
], { cwd: root, stdio: 'inherit', env: { ...process.env, NO_UPDATE_CHECK: '1' } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code || 0));
server.on('error', (error) => { console.error(error.message); process.exit(1); });
