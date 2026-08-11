const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  nativeImage,
  screen,
  ipcMain,
  desktopCapturer,
} = require('electron');
const path = require('path');
const fs = require('fs');

const APP_URL = 'https://chat.deepseek.com/';
const UI_PRELOAD = path.join(__dirname, 'ui', 'preload-ui.js');

// ---------------- 调试日志(写入 ds-debug.log,便于排查) ----------------
const LOG_FILE = path.join(__dirname, 'ds-debug.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}
ipcMain.on('ui:log', (_e, ...args) => log('[ui]', ...args));

let mainWindow = null;
let tray = null;
let floatingWindow = null;
let menuWindow = null; // 悬浮球自绘右键菜单(独立小窗口)


// ---------------- 自绘右键菜单 ----------------


function closeMenuWindow() {
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.destroy();
  menuWindow = null;
}

function showBallMenu(pos) {
  closeMenuWindow();
  const wa = screen.getPrimaryDisplay().workArea;
  const GAP = 8;
  let ax = 0, ay = 0;
  if (pos && typeof pos.mx === 'number') {
    ax = pos.mx; ay = pos.my;
  } else if (pos && typeof pos.wx === 'number') {
    ax = pos.wx; ay = pos.wy;
  } else {
    const c = screen.getCursorScreenPoint();
    ax = c.x; ay = c.y;
  }

  // 先创建窗口加载内容,再读取实际尺寸自适应定位
  menuWindow = new BrowserWindow({
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
      preload: UI_PRELOAD,
    },
  });
  menuWindow.setAlwaysOnTop(true, 'pop-up-menu');
  menuWindow.loadFile(path.join(__dirname, 'ui', 'menu.html'));

  // 加载后读取内容实际尺寸,自适应窗口
  menuWindow.webContents.once('did-finish-load', () => {
    menuWindow.webContents.executeJavaScript('[document.body.scrollWidth, document.body.scrollHeight]')
      .then(([mw, mh]) => {
        if (!menuWindow || menuWindow.isDestroyed()) return;
        // 内容尺寸 + 少量余量
        const mw2 = Math.ceil(mw) + 2;
        const mh2 = Math.ceil(mh) + 2;
        // 菜单从锚点左侧展开
        let x = ax - mw2 - GAP;
        let y = ay;
        if (x < wa.x) x = ax + GAP;
        if (y + mh2 > wa.y + wa.height) y = wa.y + wa.height - mh2;
        if (y < wa.y) y = wa.y;
        menuWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: mw2, height: mh2 });
        menuWindow.focus();
        log('[ball-menu] anchor=', [ax, ay], 'size=', [mw, mh], '-> menu at', [x, y]);
      });
  });

  menuWindow.on('blur', () => closeMenuWindow());
  menuWindow.on('closed', () => { menuWindow = null; });
}

// ---------------- 主窗口 ----------------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 600,
    minWidth: 720,
    minHeight: 480,
    icon: path.join(__dirname, 'ui', 'logo.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(APP_URL);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 关闭按钮 → 隐藏到托盘,而非退出
  mainWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------- 悬浮球 ----------------
const BALL_SIZE = 46;
const FLOAT_WIN_W = BALL_SIZE;
const FLOAT_WIN_H = BALL_SIZE;

function createFloatingWindow() {
  floatingWindow = new BrowserWindow({
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
      preload: UI_PRELOAD,
    },
  });

  // 右键菜单由渲染进程 contextmenu 事件触发,此处保留兜底拦截

  floatingWindow.setAlwaysOnTop(true, 'screen-saver');
  floatingWindow.loadFile(path.join(__dirname, 'ui', 'floating.html'));
  positionFloating();
  log('[floating] window created at', floatingWindow.getPosition());

  floatingWindow.on('closed', () => {
    floatingWindow = null;
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
  if (!floatingWindow) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const x = wa.x + wa.width - FLOAT_WIN_W;
  const y = wa.y + Math.round(wa.height / 3);
  floatingWindow.setPosition(x, y);
}

// ---------------- 托盘菜单 ----------------
function buildAppMenu() {
  const autoStart = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    { label: '打开 DS 窗口', click: showMain },
    { label: '打开对话浮窗', click: () => togglePopup() },
    { label: '截图提问', click: () => startScreenshot() },
    { label: '切换悬浮球', click: toggleFloating },
    { type: 'separator' },
    {
      label: '开机启动',
      type: 'radio',
      checked: autoStart,
      click: (mi) => {
        app.setLoginItemSettings({ openAtLogin: mi.checked });
        log('[settings] autoStart=', mi.checked);
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

// ---------------- 托盘 ----------------
function createTray() {
  const iconPath = path.join(__dirname, 'ui', 'logo.png');
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip('DeepSeek 桌面助手');

  tray.setContextMenu(buildAppMenu());
  tray.on('click', showMain);
  tray.on('double-click', showMain);
}

function toggleFloating() {
  if (!floatingWindow || floatingWindow.isDestroyed()) {
    createFloatingWindow();
  } else {
    floatingWindow.close();
  }
}

// ---------------- 全局快捷键 ----------------
function registerShortcuts() {
  // Ctrl/Cmd + Shift + D : 呼出/聚焦主窗口
  globalShortcut.register('CommandOrControl+Shift+D', showMain);
  // Ctrl/Cmd + Shift + Space : 截图提问
  globalShortcut.register('CommandOrControl+Shift+Space', startScreenshot);
}

// ---------------- UI 动作分发(悬浮球/浮框 → 主进程) ----------------
function onUiAction(name, payload) {
  log('[ui:action]', name, payload);
  // 任何动作都先关掉自绘右键菜单(菜单项点击后菜单应消失)
  closeMenuWindow();
  switch (name) {
    case 'show-main':
    case 'main':
      showMain();
      break;
    case 'toggle-main':
      // 双击悬浮球:主窗显示则隐藏到托盘,隐藏则展开
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        log('[toggle-main] hide main window');
        mainWindow.hide();
      } else {
        showMain();
      }
      break;
    case 'popup':
      togglePopup();
      break;
    case 'popup-hide':
      if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide();
      break;
    case 'screenshot':
      startScreenshot();
      break;
    case 'ball-menu':
      showBallMenu(payload);
      break;
    case 'toggle-ball':
      toggleFloating();
      break;
    case 'overlay:ready':
      if (overlayWindow && !overlayWindow.isDestroyed() && pendingShot) {
        overlayWindow.webContents.send('overlay:image', pendingShot.dataUrl);
      }
      break;
    case 'crop':
      handleCrop(payload || {});
      break;
    case 'cancel':
      closeOverlay();
      break;
    case 'drag-end': {
      // 拖拽由系统原生处理,此 case 不再使用
      break;
    }
    case 'drag-end': {
      // 拖拽结束:渲染进程已用 window.moveTo 落位,主进程只做钳制+尺寸修正(仅调一次,膨胀可控)
      if (floatingWindow && !floatingWindow.isDestroyed() && payload && typeof payload.x === 'number') {
        const p = clampBall(payload.x, payload.y);
        floatingWindow.setBounds({ x: p.x, y: p.y, width: BALL_SIZE, height: BALL_SIZE });
        log('[drag] end pos=', [p.x, p.y], 'size=', floatingWindow.getSize());
      }
      break;
    }
    case 'quit':
      app.isQuiting = true;
      app.quit();
      break;
    default:
      console.warn('[ds] unknown ui action:', name);
  }
}

// ---------------- 选区截图 ----------------
let overlayWindow = null;
let pendingShot = null; // { dataUrl, area }

async function startScreenshot() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return;
  // 隐藏悬浮球,避免拍进截图
  if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.hide();

  try {
    const primary = screen.getPrimaryDisplay();
    const wa = primary.workArea;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: wa.width, height: wa.height },
    });
    let src = sources.find((s) => String(s.display_id) === String(primary.id));
    if (!src) src = sources[0];
    if (!src) throw new Error('no screen source');

    pendingShot = { dataUrl: src.thumbnail.toDataURL(), area: wa };
    createOverlay(wa);
  } catch (err) {
    console.error('[ds] screenshot failed:', err);
    restoreFloating();
  }
}

function createOverlay(area) {
  overlayWindow = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: UI_PRELOAD,
    },
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile(path.join(__dirname, 'ui', 'overlay.html'));
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    pendingShot = null;
    restoreFloating();
  });
}

function restoreFloating() {
  if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.show();
}

function handleCrop({ dataUrl }) {
  const file = path.join(app.getPath('temp'), 'ds-screenshot.png');
  const b64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log('[ds] screenshot saved:', file, fs.statSync(file).size, 'bytes');
  closeOverlay();
  injectToPopup(file); // 注入到对话浮框:图片上传预览,等待用户输入后自行发送
}

function closeOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
}

// ---------------- 注入图片到对话浮框 ----------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function injectToPopup(imagePath) {
  try {
    const win = await getPopupReady();
    const b64 = fs.readFileSync(imagePath).toString('base64');
    const code = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');
    const result = await win.webContents.executeJavaScript(
      `${code}\n__dsInjectImage(${JSON.stringify(b64)});`
    );
    console.log('[ds] inject result:', JSON.stringify(result));
  } catch (err) {
    console.error('[ds] inject failed:', err);
  }
}

// ---------------- 对话小浮框 ----------------
let popupWindow = null;
let pendingPopupText = null;

function togglePopup(text) {
  if (popupWindow && !popupWindow.isDestroyed() && popupWindow.isVisible()) {
    popupWindow.hide();
    return;
  }
  if (text) pendingPopupText = text;
  getPopupReady();
}

// 确保浮框存在、可见且页面加载完成;返回 popupWindow
async function getPopupReady() {
  if (!popupWindow || popupWindow.isDestroyed()) {
    popupWindow = new BrowserWindow({
      width: 380,
      height: 620,
      minWidth: 340,
      minHeight: 460,
      icon: path.join(__dirname, 'ui', 'logo.png'),
      frame: false,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: false,
      hasShadow: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'), // 与主窗同一 preload,同一默认 session → 共享登录态
      },
    });
    popupWindow.setAlwaysOnTop(true, 'screen-saver');
    popupWindow.loadURL(APP_URL);
    popupWindow.once('ready-to-show', () => popupWindow.show());
    popupWindow.on('closed', () => {
      popupWindow = null;
      pendingPopupText = null;
    });
    positionPopup();
    await new Promise((resolve) => popupWindow.webContents.once('did-finish-load', resolve));
    await injectPopupUi();
    await sleep(800); // 等 SPA 交互就绪
    popupWindow.show();
    popupWindow.focus();
  } else {
    popupWindow.show();
    popupWindow.focus();
    if (popupWindow.webContents.isLoading()) {
      await new Promise((resolve) => popupWindow.webContents.once('did-finish-load', resolve));
      await sleep(800);
    }
  }
  return popupWindow;
}

function positionPopup() {
  if (!popupWindow) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const pw = popupWindow.getSize()[0];
  const ph = popupWindow.getSize()[1];
  // 屏幕右侧 1/4 处,高度居中
  const x = wa.x + Math.round(wa.width * 3 / 4) - Math.round(pw / 2);
  const y = wa.y + Math.round((wa.height - ph) / 2);
  popupWindow.setPosition(x, y);
}

async function injectPopupUi() {
  try {
    const code = fs.readFileSync(path.join(__dirname, 'popup-inject.js'), 'utf8');
    await popupWindow.webContents.executeJavaScript(`${code}\n__dsPopupInit();`);
    if (pendingPopupText) {
      fillPopupText(pendingPopupText);
      pendingPopupText = null;
    }
  } catch (err) {
    console.error('[ds] popup inject failed:', err);
  }
}

function fillPopupText(text) {
  if (!popupWindow || popupWindow.isDestroyed()) return;
  const safe = JSON.stringify(String(text));
  popupWindow.webContents
    .executeJavaScript(
      `(() => {
        const ta = document.querySelector('textarea, [contenteditable="true"]');
        if (!ta) return false;
        ta.focus();
        if (ta.tagName === 'TEXTAREA') {
          ta.value = ${safe};
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          document.execCommand('insertText', false, ${safe});
        }
        return true;
      })();`
    )
    .catch(() => {});
}

// ---------------- 生命周期 ----------------
app.whenReady().then(() => {
  createTray();
  createFloatingWindow();
  registerShortcuts();

  ipcMain.on('ui:action', (_e, name, payload) => onUiAction(name, payload));

  // 启动后自动弹出对话浮窗(双击桌面图标或开机自启时显示)
  setTimeout(() => {
    if (!popupWindow || popupWindow.isDestroyed()) {
      togglePopup();
    }
  }, 1200);

  app.on('activate', () => showMain());

  // 全屏检测:浏览器全屏播放视频时自动隐藏悬浮球,退出全屏后恢复
  const { execFile } = require('child_process');
  const fsCheckScript = path.join(__dirname, 'check-fullscreen.ps1');
  let wasFullscreen = false;
  let ballHiddenForFs = false;
  function checkFullscreen() {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fsCheckScript], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      try {
        if (err) return;
        const isFs = (stdout || '').trim() === 'FULLSCREEN';
        if (isFs && !wasFullscreen && floatingWindow && !floatingWindow.isDestroyed() && floatingWindow.isVisible()) {
          floatingWindow.hide();
          ballHiddenForFs = true;
          log('[fullscreen] detected, ball hidden');
        } else if (!isFs && wasFullscreen && ballHiddenForFs && floatingWindow && !floatingWindow.isDestroyed()) {
          floatingWindow.show();
          ballHiddenForFs = false;
          log('[fullscreen] exited, ball restored');
        }
        wasFullscreen = isFs;
      } catch (e) {
        log('[fullscreen] check error:', e.message);
      }
      setTimeout(checkFullscreen, 2000);
    });
  }
  setTimeout(checkFullscreen, 3000);
});

// 托盘驻留:所有窗口关闭时不退出,由托盘"退出"显式结束
app.on('window-all-closed', () => {
  /* keep running in tray */
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
