// 悬浮球自绘右键菜单(独立小窗口):点击菜单项后菜单应消失,由 main.js 的 onUiAction 执行动作
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const MENU_PAGE = path.join(__dirname, '..', 'ui', 'menu.html');
const UI_PRELOAD = path.join(__dirname, '..', 'ui', 'preload-ui.js');

function create({ log, state }) {
  function closeMenuWindow() {
    if (state.menuWindow && !state.menuWindow.isDestroyed()) state.menuWindow.destroy();
    state.menuWindow = null;
  }

  function showBallMenu(pos, mode) {
    closeMenuWindow();
    const wa = screen.getPrimaryDisplay().workArea;
    const GAP = 8;
    let ax = 0,
      ay = 0;
    if (pos && typeof pos.mx === 'number') {
      ax = pos.mx;
      ay = pos.my;
    } else if (pos && typeof pos.wx === 'number') {
      ax = pos.wx;
      ay = pos.wy;
    } else {
      const c = screen.getCursorScreenPoint();
      ax = c.x;
      ay = c.y;
    }

    // 先创建窗口加载内容,再读取实际尺寸自适应定位
    state.menuWindow = new BrowserWindow({
      width: 200,
      height: 200,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: UI_PRELOAD,
      },
    });
    state.menuWindow.setAlwaysOnTop(true, 'pop-up-menu');
    state.menuWindow.loadFile(MENU_PAGE);

    // 加载后读取内容实际尺寸,自适应窗口;同时高亮当前显示模式项
    const modeOk = mode === 'ball' || mode === 'pet' || mode === 'off';
    state.menuWindow.webContents.once('did-finish-load', () => {
      state.menuWindow.webContents
        .executeJavaScript(
          "(function(){" +
            "document.querySelectorAll('.mi-mode').forEach(function(el){" +
            "el.classList.toggle('checked', el.dataset.act === 'mode-" + (modeOk ? mode : '') + "');" +
            "});" +
            "return [document.body.scrollWidth, document.body.scrollHeight];" +
            "})()"
        )
        .then(([mw, mh]) => {
          if (!state.menuWindow || state.menuWindow.isDestroyed()) return;
          // 内容尺寸 + 少量余量
          const mw2 = Math.ceil(mw) + 2;
          const mh2 = Math.ceil(mh) + 2;
          // 菜单从锚点左侧展开
          let x = ax - mw2 - GAP;
          let y = ay;
          if (x < wa.x) x = ax + GAP;
          if (y + mh2 > wa.y + wa.height) y = wa.y + wa.height - mh2;
          if (y < wa.y) y = wa.y;
          state.menuWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: mw2, height: mh2 });
          state.menuWindow.focus();
          log('[ball-menu] anchor=', [ax, ay], 'size=', [mw, mh], '-> menu at', [x, y]);
        });
    });

    state.menuWindow.on('blur', () => closeMenuWindow());
    state.menuWindow.on('closed', () => {
      state.menuWindow = null;
    });
  }

  return { closeMenuWindow, showBallMenu };
}

module.exports = { create };
