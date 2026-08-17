// 悬浮球:常驻桌面的 46x46 小球(单击弹浮窗/双击切主窗/右键菜单由 floating.js 触发)
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const BALL_SIZE = 46;
const FLOAT_WIN_W = BALL_SIZE;
const FLOAT_WIN_H = BALL_SIZE;
const FLOATING_PAGE = path.join(__dirname, '..', 'ui', 'floating.html');
const UI_PRELOAD = path.join(__dirname, '..', 'ui', 'preload-ui.js');

function create({ log, state }) {
  function createFloatingWindow() {
    state.floatingWindow = new BrowserWindow({
      width: FLOAT_WIN_W,
      height: FLOAT_WIN_H,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: UI_PRELOAD,
      },
    });

    state.floatingWindow.setAlwaysOnTop(true, 'screen-saver');
    state.floatingWindow.loadFile(FLOATING_PAGE);
    positionFloating();
    log('[floating] window created at', state.floatingWindow.getPosition());

    state.floatingWindow.on('closed', () => {
      state.floatingWindow = null;
    });
  }

  // 悬浮球位置:至少留一半球体在屏幕内
  function clampBall(x, y) {
    const wa = screen.getPrimaryDisplay().workArea;
    return {
      x: Math.round(Math.min(Math.max(x, wa.x), wa.x + wa.width - FLOAT_WIN_W)),
      y: Math.round(Math.min(Math.max(y, wa.y), wa.y + wa.height - FLOAT_WIN_H)),
    };
  }

  function positionFloating() {
    if (!state.floatingWindow) return;
    const wa = screen.getPrimaryDisplay().workArea;
    const x = wa.x + wa.width - FLOAT_WIN_W;
    const y = wa.y + Math.round(wa.height / 3);
    state.floatingWindow.setPosition(x, y);
  }

  function toggleFloating() {
    if (!state.floatingWindow || state.floatingWindow.isDestroyed()) {
      createFloatingWindow();
    } else {
      state.floatingWindow.close();
    }
  }

  function restoreFloating() {
    if (state.floatingWindow && !state.floatingWindow.isDestroyed()) state.floatingWindow.show();
  }

  return {
    createFloatingWindow,
    clampBall,
    positionFloating,
    toggleFloating,
    restoreFloating,
    BALL_SIZE,
  };
}

module.exports = { create };
