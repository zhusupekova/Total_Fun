#!/usr/bin/env node
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import net from 'net';

const SERVER_PORT = process.env.PORT || 7071;
const SERVER_DIR = path.join(process.cwd(), 'server');
const LOG_PATH = '/tmp/total_fun_ws.log';

function waitForPort(port, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.on('connect', () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        if (Date.now() - started > timeoutMs) reject(new Error('timeout'));
        else setTimeout(check, 100);
      });
    };
    check();
  });
}

async function main() {
  // start server
  const out = fs.openSync(LOG_PATH, 'w');
  const err = fs.openSync(LOG_PATH, 'a');
  const server = spawn('node', ['server.js'], { cwd: SERVER_DIR, stdio: ['ignore', out, err], env: { ...process.env, PORT: SERVER_PORT } });

  const stopServer = () => new Promise((resolve) => {
    if (!server || server.killed) return resolve();
    server.once('exit', resolve);
    server.kill('SIGTERM');
    setTimeout(() => server.kill('SIGKILL'), 2000);
  });

  try {
    await waitForPort(SERVER_PORT, 5000);
  } catch (e) {
    await stopServer();
    throw new Error('Server failed to start');
  }

  // run smoke
  const smoke = spawn('node', ['tools/ws_smoke.js', `--url=ws://localhost:${SERVER_PORT}`], { stdio: 'inherit' });
  const code = await new Promise((resolve) => smoke.on('close', resolve));
  await stopServer();
  if (code !== 0) {
    throw new Error(`Smoke failed with code ${code}`);
  }
}

main().catch((err) => {
  console.error('[smoke:ws:local] failed', err?.message || err);
  process.exit(1);
});
