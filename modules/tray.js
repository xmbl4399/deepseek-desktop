// 托盘:图标 + 右键菜单(每次弹出前重建,保证"开机启动"勾选状态与注册表一致)
const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

const LOGO = path.join(__dirname, '..', 'ui', 'logo.png');

function create({ log, state, actions }) {
  function buildAppMenu() {
    const autoStart = app.getLoginItemSettings().openAtLogin;
    const currentMode = actions.getDisplayMode ? actions.getDisplayMode() : 'ball';
    log('[tray] menu rebuilt, getLoginItemSettings().openAtLogin =', autoStart, 'displayMode =', currentMode);
    return Menu.buildFromTemplate([
      { label: '打开主窗口', click: actions.showMain },
      { label: '打开对话浮窗', click: () => actions.togglePopup() },
      { label: '截图提问', click: actions.startScreenshot },
      { type: 'separator' },
      {
        label: '显示模式',
        // radio 单选语义在这里正是想要的:悬浮球/鲸鱼娘二选一,当前模式勾选
        submenu: [
          {
            label: '悬浮球',
            type: 'radio',
            checked: currentMode === 'ball',
            click: () => actions.setDisplayMode('ball'),
          },
          {
            label: '鲸鱼娘',
            type: 'radio',
            checked: currentMode === 'pet',
            click: () => actions.setDisplayMode('pet'),
          },
        ],
      },
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
