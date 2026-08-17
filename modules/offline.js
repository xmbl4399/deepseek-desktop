// 离线兜底:主文档加载失败(断网/DNS 失败)时显示本地提示页
// offline.html 自带网络探测:恢复后 location.replace 回 APP_URL,无需主进程参与重试
const path = require('path');

const OFFLINE_PAGE = path.join(__dirname, '..', 'ui', 'offline.html');

function create({ log }) {
  function attachOfflineFallback(win, label) {
    let lastFailAt = 0;
    win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return; // 子资源失败不处理
      if (errorCode === -3) return; // ERR_ABORTED:导航被替换(如重试跳转)的正常中止
      // 防抖:手动重试仍失败时避免重复 reload 干扰
      const now = Date.now();
      if (now - lastFailAt < 500) return;
      lastFailAt = now;
      log(`[offline] ${label} load failed: ${errorCode} ${errorDescription} ${validatedURL} -> show offline page`);
      win.loadFile(OFFLINE_PAGE).catch(() => {});
    });
  }

  // 等待加载结束(成功或失败都 resolve,避免断网时 did-finish-load 不触发导致永久挂起)
  function waitLoadStop(webContents) {
    return new Promise((resolve) => {
      const done = () => resolve();
      webContents.once('did-finish-load', done);
      webContents.once('did-fail-load', done);
    });
  }

  return { attachOfflineFallback, waitLoadStop, OFFLINE_PAGE };
}

module.exports = { create };
