// 悬浮球:常驻桌面的小球(单击弹浮窗/双击切主窗/右键菜单由 floating.js 触发)
// 尺寸:托盘"尺寸"选项 小/中/大(默认中=46),不做分辨率自适应
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const BALL_SIZE = 46; // 中档(默认)
const FLOATING_PAGE = path.join(__dirname, '..', 'ui', 'floating.html');
const UI_PRELOAD = path.join(__dirname, '..', 'ui', 'preload-ui.js');

// 三档尺寸表(纯函数,便于测试):小/中/大
const WIDGET_BALL_SIZES = { small: 40, medium: 46, large: 70 };
function widgetBallSize(level) {
  return WIDGET_BALL_SIZES[level] || BALL_SIZE;
}

function create({ log, state, onWindowLoaded }) {
  let ballSize = BALL_SIZE; // 当前尺寸(创建窗口时按尺寸档位计算)

  // 主进程在设置变化/启动时调用,同步当前尺寸档位
  function setWidgetSize(level) {
    ballSize = widgetBallSize(level);
  }

  // 尺寸档位变化后原地缩放现有窗口(不销毁重建,避免旧窗口残影/引用竞态)
  function applyWidgetSize() {
    if (!state.floatingWindow || state.floatingWindow.isDestroyed()) return;
    const b = state.floatingWindow.getBounds();
    state.floatingWindow.setBounds({ x: b.x, y: b.y, width: ballSize, height: ballSize });
    log('[floating] resized to', ballSize);
  }

  function createFloatingWindow() {
    state.floatingWindow = new BrowserWindow({
      width: ballSize,
      height: ballSize,
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
    log('[floating] window created at', state.floatingWindow.getPosition(), 'size', ballSize);
    // 加载完成后下发初始窗口位置:渲染进程 window.screenX 不可靠(位置由主进程
    // setPosition 驱动),渲染进程用本地 ballX/ballY 追踪,与鲸鱼娘 pet-pos 同机制;
    // 同时通知主进程补发当前前台上下文(页面加载期的事件可能已丢失)
    state.floatingWindow.webContents.once('did-finish-load', () => {
      const b = state.floatingWindow.getBounds();
      state.floatingWindow.webContents.send('ball-pos', { x: b.x, y: b.y });
      if (typeof onWindowLoaded === 'function') onWindowLoaded();
    });

    const win = state.floatingWindow;
    win.on('closed', () => {
      // 仅当仍是本窗口引用时才清空,避免异步关闭期间新窗口引用被误清(残影/引用竞态)
      if (state.floatingWindow === win) state.floatingWindow = null;
    });
  }

  // 悬浮球位置:球心始终在屏幕内,最多悬出半个球体(经典悬浮球停靠,可贴边)
  // 注:松手时主进程按此钳制落位,渲染进程拖拽过程不受限(可拖出屏幕,松手拉回半身)
  function clampBall(x, y) {
    const wa = screen.getPrimaryDisplay().workArea;
    const HALF = ballSize / 2;
    return {
      x: Math.round(Math.min(Math.max(x, wa.x - HALF), wa.x + wa.width - HALF)),
      y: Math.round(Math.min(Math.max(y, wa.y - HALF), wa.y + wa.height - HALF)),
    };
  }

  function positionFloating() {
    if (!state.floatingWindow) return;
    const wa = screen.getPrimaryDisplay().workArea;
    // 默认位:主屏右缘、垂直居中
    const x = wa.x + wa.width - ballSize;
    const y = wa.y + Math.round(wa.height / 2) - Math.round(ballSize / 2);
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

  // 渲染进程拖拽 → 主进程移动(与鲸鱼娘 moveWindow 同机制):
  // 渲染进程 window.moveTo 被 Chromium 钳制在屏幕内,窗口永远无法悬出 → 贴不了边。
  // 主进程 setPosition 无此限制,配合 clampBall(球心贴边)实现半身悬出停靠。
  function moveWindow(x, y) {
    const w = state.floatingWindow;
    if (!w || w.isDestroyed()) return;
    const p = clampBall(x, y);
    // setBounds 同时钉住当前尺寸:GPU 禁用环境下透明窗口被脚本移动会尺寸漂移
    // (探针复现 320→543px),钉尺寸保证悬浮球始终是设定大小的可点区域
    w.setBounds({ x: p.x, y: p.y, width: ballSize, height: ballSize });
    // 发生钳制时回传实际位置:渲染进程本地 ballX/ballY 必须与实际同步,防坐标漂移
    if (p.x !== Math.round(x) || p.y !== Math.round(y)) {
      w.webContents.send('ball-pos', { x: p.x, y: p.y });
    }
  }

  return {
    createFloatingWindow,
    clampBall,
    moveWindow,
    positionFloating,
    toggleFloating,
    restoreFloating,
    setWidgetSize,
    applyWidgetSize,
    widgetBallSize,
    BALL_SIZE,
  };
}

module.exports = { create };
