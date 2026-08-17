// 自动更新(electron-updater):开发模式跳过,打包后启用
const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

function create({ log }) {
  function checkForUpdates() {
    if (!app.isPackaged) {
      dialog.showMessageBox({ type: 'info', message: '开发模式下不检查更新' }).catch(() => {});
      return;
    }
    autoUpdater
      .checkForUpdates()
      .then((res) => {
        const v = res && res.updateInfo && res.updateInfo.version;
        dialog.showMessageBox({ type: 'info', message: v ? `发现新版本 ${v},正在后台下载…` : '已是最新版本' }).catch(() => {});
      })
      .catch((e) => {
        log('[updater] manual check failed:', e && e.message);
        dialog.showMessageBox({ type: 'warning', message: '检查更新失败: ' + ((e && e.message) || e) }).catch(() => {});
      });
  }

  function setupAutoUpdater() {
    if (!app.isPackaged) return; // 开发模式无 app-update.yml,跳过
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => log('[updater] update available:', info && info.version));
    autoUpdater.on('update-not-available', () => log('[updater] up to date'));
    autoUpdater.on('error', (e) => log('[updater] error:', e && e.message));
    autoUpdater.on('update-downloaded', (info) => {
      log('[updater] downloaded:', info && info.version);
      dialog
        .showMessageBox({
          type: 'info',
          title: '更新已就绪',
          message: `新版本 ${info.version} 已下载完成`,
          detail: '重启应用即可完成安装,是否立即重启?',
          buttons: ['立即重启', '稍后'],
          defaultId: 0,
          cancelId: 1,
        })
        .then(({ response }) => {
          if (response === 0) {
            app.isQuiting = true;
            autoUpdater.quitAndInstall();
          }
        })
        .catch(() => {});
    });
    // 启动 8 秒后静默检查(不打扰用户)
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify().catch((e) => log('[updater] background check failed:', e && e.message));
    }, 8000);
  }

  return { checkForUpdates, setupAutoUpdater };
}

module.exports = { create };
