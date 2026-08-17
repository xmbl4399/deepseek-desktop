// 托盘:图标 + 右键菜单(每次弹出前重建,保证"开机启动"勾选状态与注册表一致)
const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

const LOGO = path.join(__dirname, '..', 'ui', 'logo.png');

function create({ log, state, actions }) {
  function buildAppMenu() {
    const autoStart = app.getLoginItemSettings().openAtLogin;
    log('[tray] menu rebuilt, getLoginItemSettings().openAtLogin =', autoStart);
    return Menu.buildFromTemplate([
      { label: '打开 DS 窗口', click: actions.showMain },
      { label: '打开对话浮窗', click: () => actions.togglePopup() },
      { label: '截图提问', click: actions.startScreenshot },
      { label: '切换悬浮球', click: actions.toggleFloating },
      { type: 'separator' },
      {
        label: '检查更新…',
        click: actions.checkForUpdates,
      },
      {
        label: '开机启动',
        // 必须用 checkbox:radio 是单选语义,已勾选的项再点击无法取消勾选(表现为"关不掉")
        type: 'checkbox',
        checked: autoStart,
        click: (mi) => {
          // 显式传 path:Windows 下 get 判定注册表值是否等于 exe 路径,不传 path 时两者可能不一致导致状态误判
          app.setLoginItemSettings({ openAtLogin: mi.checked, path: process.execPath });
          log('[settings] autoStart=', mi.checked, '-> registry now:', app.getLoginItemSettings().openAtLogin);
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.isQuiting = true;
          app.quit();
        },
      },
    ]);
  }

  function createTray() {
    const trayIcon = nativeImage.createFromPath(LOGO).resize({ width: 16, height: 16 });
    state.tray = new Tray(trayIcon);
    state.tray.setToolTip('DeepSeek 桌面助手');

    state.tray.setContextMenu(buildAppMenu());
    // 每次弹出菜单前重建:保证"开机启动"勾选状态与注册表实际一致(只构建一次会显示过期状态)
    state.tray.on('right-click', () => state.tray.setContextMenu(buildAppMenu()));
    state.tray.on('click', actions.showMain);
    state.tray.on('double-click', actions.showMain);
  }

  return { createTray, buildAppMenu };
}

module.exports = { create };
