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
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    /* ignore */
  }
  console.log(line);
}
ipcMain.on('ui:log', (_e, ...args) => log('[ui]', ...args));

let mainWindow = null;
let tray = null;
let floatingWindow = null;
let menuWindow = null; // 悬浮球自绘右键菜单(独立小窗口)
let lastDragLog = 0; // 拖动中节流日志时间戳

// ---------------- 自绘右键菜单 ----------------
const MENU_W = 160;
const MENU_H = 210;

function closeMenuWindow() {
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.destroy();
  menuWindow = null;
}

function showBallMenu(pos) {
  // 悬浮球窗口 focusable:false,Windows 下原生 Menu.popup 无法以其为宿主弹出,
  // 改用自绘 HTML 菜单小窗口(微信/QQ 悬浮球同款交互)。
  closeMenuWindow();
  const wa = screen.getPrimaryDisplay().workArea;
  // 定位锚点:优先用鼠标屏幕坐标(右键时鼠标在球上,直观可靠);
  // window.screenX 在拖拽后可能偏移(窗口尺寸与内容尺寸不一致),仅作回退。
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
  // 菜单从锚点左侧展开(向左偏移菜单宽+间距),向右下展开,不覆盖球
  let x = ax - MENU_W - GAP;
  let y = ay;
  // 左侧放不下 → 翻到锚点右侧
  if (x < wa.x) x = ax + GAP;
  // 垂直越界修正
  if (y + MENU_H > wa.y + wa.height) y = wa.y + wa.height - MENU_H;
  if (y < wa.y) y = wa.y;
  log('[ball-menu] anchor=', [ax, ay], 'ball=', [pos?.wx, pos?.wy], '-> menu at', [x, y]);

  menuWindow = new BrowserWindow({
    width: MENU_W,
    height: MENU_H,
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
  menuWindow.setPosition(Math.round(x), Math.round(y));
  menuWindow.loadFile(path.join(__dirname, 'ui', 'menu.html'));
  menuWindow.focus();
  log('[ball-menu] menuWindow created at', { x, y }, 'size', [MENU_W, MENU_H]);
  // 点击菜单外部(窗口失焦)即关闭
  menuWindow.on('blur', () => {
    log('[ball-menu] menu blur -> close');
    closeMenuWindow();
  });
  menuWindow.on('closed', () => {
    log('[ball-menu] menu closed');
    menuWindow = null;
  });
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
const TRAY_H = 23;
const FLOAT_WIN_W = BALL_SIZE;
const FLOAT_WIN_H = BALL_SIZE + TRAY_H; // 球+托盘总高

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

  // 拦截系统右键:系统拖拽区(-webkit-app-region:drag)右键被系统接管,
  // 通过 webContents 的 'context-menu' 事件拦截,弹出自绘菜单
  floatingWindow.webContents.on('context-menu', (e, params) => {
    const pos = floatingWindow.getPosition();
    onUiAction(null, 'ball-menu', { wx: pos[0], wy: pos[1], mx: params.x, my: params.y });
  });

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
  const halfX = Math.ceil(FLOAT_WIN_W / 2);
  const halfY = Math.ceil(FLOAT_WIN_H / 2);
  return {
    x: Math.round(Math.min(Math.max(x, wa.x - halfX), wa.x + wa.width - halfX)),
    y: Math.round(Math.min(Math.max(y, wa.y - halfY), wa.y + wa.height - halfY)),
  };
}

function positionFloating() {
  if (!floatingWindow) return;
  const wa = screen.getPrimaryDisplay().workArea;
  // 默认位置:屏幕右侧,高度 1/3 处
  const x = wa.x + wa.width - FLOAT_WIN_W - 24;
  const y = wa.y + Math.round(wa.height / 3);
  floatingWindow.setPosition(x, y);
}

// ---------------- 统一应用菜单(托盘 + 悬浮球右键共用) ----------------
function buildAppMenu() {
  return Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMain },
    { label: '截图提问', click: () => startScreenshot() },
    { label: '对话小浮框', click: () => togglePopup() },
    { label: '显示/隐藏悬浮球', click: toggleFloating },
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

// 浮框打开后,若悬浮球与浮框重叠(浮框右下角会盖住默认位置的球),把球挪到浮框上方
function repositionBallAwayFromPopup() {
  if (!floatingWindow || floatingWindow.isDestroyed()) return;
  if (!popupWindow || popupWindow.isDestroyed()) return;
  const [bx, by] = floatingWindow.getPosition();
  const pr = popupWindow.getBounds();
  const overlap =
    bx < pr.x + pr.width && bx + FLOAT_WIN_W > pr.x && by < pr.y + pr.height && by + FLOAT_WIN_H > pr.y;
  log('[popup] ball=', [bx, by], 'popup=', pr, 'overlap=', overlap);
  if (!overlap) return;
  const wa = screen.getDisplayNearestPoint({ x: bx + FLOAT_WIN_W / 2, y: by + FLOAT_WIN_H / 2 }).workArea;
  let nx = Math.min(Math.max(pr.x + pr.width - FLOAT_WIN_W, wa.x), wa.x + wa.width - FLOAT_WIN_W);
  let ny = pr.y - FLOAT_WIN_H - 8; // 优先放到浮框正上方
  if (ny < wa.y) ny = pr.y + pr.height + 8; // 上方放不下则放到下方
  log('[popup] move ball away', [bx, by], '->', [nx, ny]);
  floatingWindow.setPosition(nx, ny);
}

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
      width: 420,
      height: 520,
      minWidth: 360,
      minHeight: 380,
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
  // 屏幕右侧 1/3 处,高度居中
  const x = wa.x + Math.round(wa.width * 2 / 3) - Math.round(pw / 2);
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

  app.on('activate', () => showMain());
});

// 托盘驻留:所有窗口关闭时不退出,由托盘"退出"显式结束
app.on('window-all-closed', () => {
  /* keep running in tray */
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
