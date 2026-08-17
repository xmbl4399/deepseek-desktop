// 调试日志:写入 ds-debug.log(打包后写入 userData,避免 asar 只读)
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const LOG_FILE = path.join(
  app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..'),
  'ds-debug.log'
);

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  try {
    // 日志防膨胀:超过 1MB 滚动为 .old(保留最近一份),避免无限增长
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) {
      try {
        fs.renameSync(LOG_FILE, LOG_FILE + '.old');
      } catch (e) {
        /* ignore */
      }
    }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    /* ignore */
  }
}

module.exports = { log };
