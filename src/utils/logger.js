const fs = require('fs');
const path = require('path');

const logsDir = path.join(process.cwd(), 'data', 'logs');

function getLogPath() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(logsDir, `${date}.log`);
}

function write(level, message, meta = {}) {
  const ts = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  const line = `[${ts}] [${level}] ${message}${metaStr}\n`;

  process.stdout.write(line);

  try {
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(getLogPath(), line);
  } catch {
    // non-fatal
  }
}

const logger = {
  info:  (msg, meta) => write('INFO',  msg, meta),
  warn:  (msg, meta) => write('WARN',  msg, meta),
  error: (msg, meta) => write('ERROR', msg, meta),
};

module.exports = logger;
