const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  screen,
  ipcMain,
  desktopCapturer,
  shell,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// ---------------- 单实例锁:防止双开(开机自启 + 手动双击会启动两个实例,托盘/悬浮球互相打架) ----------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } else if (app.isReady()) {
      showMain();
    }
  });
}

const APP_URL = 'https://chat.deepseek.com/';
const UI_PRELOAD = path.join(__dirname, 'ui', 'preload-ui.js');

// ---------------- 调试日志(写入 ds-debug.log,便于排查) ----------------
// 打包后 __dirname 指向只读的 app.asar,日志改写到 userData 目录
const LOG_FILE = path.join(app.isPackaged ? app.getPath('userData') : __dirname, 'ds-debug.log');
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
      // 主窗口只加载远程页面,不需要任何本地 preload API
    },
  });

  // 拦截 window.open:站内跳转放行,外部链接交给系统浏览器,避免开出裸 Electron 窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://chat.deepseek.com')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // 顶层导航到站外时同样交给系统浏览器
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('https://chat.deepseek.com')) {
      e.preventDefault();
      shell.openExternal(url);
    }
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
      label: '检查更新…',
      click: checkForUpdates,
    },
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

// ---------------- 自动更新 ----------------
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
      // 拖拽结束:渲染进程已用 window.moveTo 落位,主进程只做钳制+尺寸修正
      if (floatingWindow && !floatingWindow.isDestroyed() && payload && typeof payload.x === 'number') {
        const p = clampBall(payload.x, payload.y);
        floatingWindow.setBounds({ x: p.x, y: p.y, width: BALL_SIZE, height: BALL_SIZE });
      }
      break;
    }
    case 'quit':
      app.isQuiting = true;
      app.quit();
      break;
    default:
      log('[ds] unknown ui action:', name);
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
    log('[ds] screenshot failed:', err.message);
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
  log('[ds] screenshot saved:', file, fs.statSync(file).size, 'bytes');
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
    log('[ds] inject result:', JSON.stringify(result));
  } catch (err) {
    log('[ds] inject failed:', err.message);
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
    // 拦截 window.open:站外链接交给系统浏览器
    popupWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://chat.deepseek.com')) return { action: 'allow' };
      shell.openExternal(url);
      return { action: 'deny' };
    });
    popupWindow.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('https://chat.deepseek.com')) {
        e.preventDefault();
        shell.openExternal(url);
      }
    });
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
  // 浮层打开后自动聚焦输入框,方便键盘直接输入
  popupWindow.webContents.executeJavaScript(`
    (function() {
      const input = document.querySelector('textarea, input[type="text"], [contenteditable="true"]');
      if (input) input.focus();
    })();
  `).catch(() => {});
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
    log('[ds] popup inject failed:', err.message);
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
  if (!gotLock) return; // 未拿到单实例锁,等待退出

  createTray();
  createFloatingWindow();
  setupAutoUpdater();

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
  // 内嵌 PowerShell 脚本:打包后 asar 内的 .ps1 无法被 powershell -File 读取执行,必须内嵌
  const FS_CHECK_SCRIPT = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WAPI {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@ | Out-Null

if (-not ('WAPI' -as [type])) { Write-Output "WINDOWED"; exit 0 }

# 让本进程 DPI aware,使 GetWindowRect(物理像素)与 Screen.Bounds 单位一致,避免缩放后误判
[WAPI]::SetProcessDPIAware() | Out-Null

$fw = [WAPI]::GetForegroundWindow()
$r = New-Object WAPI+RECT
[WAPI]::GetWindowRect($fw, [ref]$r) | Out-Null

Add-Type -AssemblyName System.Windows.Forms | Out-Null

$tolerance = 8  # 容忍 8px 偏差(浏览器全屏视频可能有微小边框)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
$full = $false
# 遍历所有显示器:前台窗口覆盖任一屏幕即判定全屏(支持副屏全屏)
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $s.Bounds
    if ($r.Left -le ($b.Left + $tolerance) -and $r.Top -le ($b.Top + $tolerance) -and
        $r.Right -ge ($b.Right - $tolerance) -and $r.Bottom -ge ($b.Bottom - $tolerance)) {
        $full = $true
        break
    }
}
if ($full) { Write-Output "FULLSCREEN" } else { Write-Output "WINDOWED" }
`;
  // 精简环境变量:环境块过大(>64KB)会导致 Add-Type 编译失败,检测永久失效(实测 368KB 环境必挂)
  const MINIMAL_ENV = {
    PATH: process.env.PATH || '',
    SystemRoot: process.env.SystemRoot || 'C:\\Windows',
    COMSPEC: process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe',
    TEMP: process.env.TEMP || 'C:\\Windows\\Temp',
    TMP: process.env.TMP || 'C:\\Windows\\Temp',
    USERPROFILE: process.env.USERPROFILE || '',
  };
  let wasFullscreen = false;
  let ballHiddenForFs = false;
  let fsCheckRunning = false; // 防止 PS 进程堆积
  let fsCheckTimer = null;
  const FS_CHECK_INTERVAL = { fullscreen: 800, windowed: 3000 }; // 全屏时高频,平时低频
  function scheduleFsCheck(delay) {
    if (fsCheckTimer) clearTimeout(fsCheckTimer);
    fsCheckTimer = setTimeout(runFsCheck, delay);
  }
  function runFsCheck() {
    if (fsCheckRunning) return; // 上次还没完成就跳过
    fsCheckRunning = true;
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', FS_CHECK_SCRIPT],
      { timeout: 4000, windowsHide: true, env: MINIMAL_ENV },
      (err, stdout) => {
        fsCheckRunning = false;
        try {
          if (err) { log('[fullscreen] check failed:', err.message); }
          else {
            const isFs = /FULLSCREEN/.test(stdout || '');
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
            scheduleFsCheck(isFs ? FS_CHECK_INTERVAL.fullscreen : FS_CHECK_INTERVAL.windowed);
          }
        } catch (e) { /* ignore */ }
      }
    );
  }
  scheduleFsCheck(2000); // 启动 2 秒后首查
});

// 托盘驻留:所有窗口关闭时不退出,由托盘"退出"显式结束
app.on('window-all-closed', () => {
  /* keep running in tray */
});

