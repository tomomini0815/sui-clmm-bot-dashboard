import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const botDir = path.join(projectDir, 'bot_v2');
const frontendDir = path.join(projectDir, 'frontend');
const logDir = path.join(botDir, 'logs');
const logFile = path.join(logDir, 'supervisor.log');
const frontendUrl = 'http://127.0.0.1:5174';
const maxLogBytes = 10 * 1024 * 1024;
const retainedLogs = 5;
const restartDelayMs = 5000;
const legacyLogMaxBytes = 2 * 1024 * 1024;
const legacyLogFiles = [
  path.join(botDir, 'backend.log'),
  path.join(logDir, 'backend_error.log'),
  path.join(logDir, 'backend_error-2.log'),
  path.join(logDir, 'backend_out.log'),
  path.join(logDir, 'backend_out-2.log'),
  path.join(frontendDir, 'logs', 'frontend_error.log'),
  path.join(frontendDir, 'logs', 'frontend_out.log'),
];

let botChild = null;
let frontendChild = null;
let browserOpened = false;
let stopping = false;

fs.mkdirSync(logDir, { recursive: true });

function compactLegacyLogs() {
  for (const file of legacyLogFiles) {
    try {
      const stats = fs.statSync(file);
      if (stats.size <= legacyLogMaxBytes) continue;

      const descriptor = fs.openSync(file, 'r+');
      try {
        const retainedBytes = Math.min(legacyLogMaxBytes, stats.size);
        const tail = Buffer.allocUnsafe(retainedBytes);
        fs.readSync(descriptor, tail, 0, retainedBytes, stats.size - retainedBytes);
        fs.writeSync(descriptor, tail, 0, retainedBytes, 0);
        fs.ftruncateSync(descriptor, retainedBytes);
      } finally {
        fs.closeSync(descriptor);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function rotateLogs(incomingBytes) {
  let currentBytes = 0;

  try {
    currentBytes = fs.statSync(logFile).size;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (currentBytes + incomingBytes <= maxLogBytes) return;

  fs.rmSync(`${logFile}.${retainedLogs}`, { force: true });
  for (let index = retainedLogs - 1; index >= 1; index -= 1) {
    const source = `${logFile}.${index}`;
    if (fs.existsSync(source)) {
      fs.renameSync(source, `${logFile}.${index + 1}`);
    }
  }
  if (fs.existsSync(logFile)) {
    fs.renameSync(logFile, `${logFile}.1`);
  }
}

function writeLog(message) {
  const output = Buffer.isBuffer(message) ? message : Buffer.from(String(message));
  rotateLogs(output.length);
  fs.appendFileSync(logFile, output);
}

function logSupervisor(message) {
  writeLog(`[${new Date().toISOString()}] [supervisor] ${message}\n`);
}

function startBot() {
  if (stopping) return;

  logSupervisor('Starting Sui Bot backend');
  botChild = spawn('/opt/homebrew/bin/node', ['dist/index.js'], {
    cwd: botDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: process.env.PORT || '3002',
      FORCE_COLOR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  botChild.stdout.on('data', writeLog);
  botChild.stderr.on('data', writeLog);

  botChild.on('error', (error) => {
    logSupervisor(`Failed to start backend: ${error.stack || error.message}`);
  });

  botChild.on('exit', (code, signal) => {
    botChild = null;
    logSupervisor(`Backend exited (code=${code}, signal=${signal}); restarting in 5 seconds`);
    if (!stopping) setTimeout(startBot, restartDelayMs);
  });
}

function startFrontend() {
  if (stopping) return;

  logSupervisor('Starting Sui Bot frontend');
  frontendChild = spawn(
    '/opt/homebrew/bin/node',
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5174', '--strictPort'],
    {
      cwd: frontendDir,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  frontendChild.stdout.on('data', writeLog);
  frontendChild.stderr.on('data', writeLog);

  frontendChild.on('error', (error) => {
    logSupervisor(`Failed to start frontend: ${error.stack || error.message}`);
  });

  frontendChild.on('exit', (code, signal) => {
    frontendChild = null;
    logSupervisor(`Frontend exited (code=${code}, signal=${signal}); restarting in 5 seconds`);
    if (!stopping) setTimeout(startFrontend, restartDelayMs);
  });
}

async function openFrontendWhenReady() {
  for (let attempt = 0; attempt < 60 && !stopping && !browserOpened; attempt += 1) {
    try {
      const response = await fetch(frontendUrl);
      if (response.ok) {
        browserOpened = true;
        logSupervisor(`Opening frontend in browser: ${frontendUrl}`);
        const opener = spawn('/usr/bin/open', [frontendUrl], {
          detached: true,
          stdio: 'ignore',
        });
        opener.unref();
        return;
      }
    } catch {
      // The frontend may still be compiling.
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!browserOpened && !stopping) {
    logSupervisor(`Frontend did not become ready: ${frontendUrl}`);
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logSupervisor(`Received ${signal}; stopping backend and frontend`);

  const children = [botChild, frontendChild].filter(Boolean);
  if (children.length === 0) process.exit(0);

  const forceStop = setTimeout(() => {
    botChild?.kill('SIGKILL');
    frontendChild?.kill('SIGKILL');
  }, 10000);
  forceStop.unref();

  let remaining = children.length;
  for (const child of children) {
    child.once('exit', () => {
      remaining -= 1;
      if (remaining === 0) process.exit(0);
    });
    child.kill('SIGTERM');
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logSupervisor(`Supervisor error: ${error.stack || error.message}`);
  process.exit(1);
});

compactLegacyLogs();
startBot();
startFrontend();
void openFrontendWhenReady();
