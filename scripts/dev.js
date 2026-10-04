// `npm run dev`: the server restarted on every code change, with .env loaded when there is one.
// Node 22's --watch tries to watch the --env-file-if-exists file even when it's missing and crashes
// (ENOENT in the watcher, then EPIPE in the server) on a checkout without .env, so the env file is
// only passed when it exists.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const args = [...(fs.existsSync('.env') ? ['--env-file=.env'] : []), '--watch', '--watch-preserve-output', 'server/index.js'];
const child = spawn(process.execPath, args, { stdio: 'inherit' });
// Ctrl+C reaches the child from the terminal too; forwarding covers `kill <pid>` of this launcher
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
