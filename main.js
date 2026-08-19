// DeepSeek 桌面助手 - 主进程(组装层)
// 功能模块见 modules/ 目录:logger/state/security/offline/ball-menu/floating/popup/screenshot/tray/updater/shortcuts
// 本文件保留:单实例锁、主窗口、UI 动作分发、全屏检测、生命周期
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// ---------------- 模块装配 ----------------
const { log } = require('./modules/logger');
const state = require('./modules/state');
const security = require('./modules/security').create({ log });
const offline = require('./modules/offline').create({ log });
const ballMenu = require('./modules/ball-menu').create({ log, state });
const floating = require('./modules/floating').create({ log, state });
const pet = require('./modules/pet').create({ log, state });
// 显示模式协调(悬浮球/鲸鱼娘),依赖 floating + pet,须在两者之后装配
const mode = require('./modules/mode').create({ log, state, floating, pet });
// popup 的 onWindowCreated 延迟引用 shortcutsApi(shortcuts 依赖 actions,actions 依赖 popup,靠闭包解环)
let shortcutsApi = null;
const popup = require('./modules/popup').create({
  log,
  state,
  security,
  offline,
  onWindowCreated: (win) => shortcutsApi && shortcutsApi.register(win),
});
const screenshot = require('./modules/screenshot').create({ log, state, floating, popup });
const updater = require('./modules/updater').create({ log });

// ---------------- 单实例锁:防止双开(开机自启 + 手动双击会启动两个实例,托盘/悬浮球互相打架) ----------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      if (!state.mainWindow.isVisible()) state.mainWindow.show();
      state.mainWindow.focus();
    } else if (app.isReady()) {
      showMain();
    }
  });
}

// ---------------- 兜底崩溃日志:主进程异常不再静默,方便远程排查 ----------------
process.on('uncaughtException', (err) => log('[crash] uncaughtException:', (err && err.stack) || err));
process.on('unhandledRejection', (reason) => log('[crash] unhandledRejection:', reason));

// 本地 UI 页面的调试日志转发
ipcMain.on('ui:log', (_e, ...args) => log('[ui]', ...args));

const APP_URL = 'https://chat.deepseek.com/';

// ---------------- 主窗口 ----------------
function createMainWindow() {
  state.mainWindow = new BrowserWindow({
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
      sandbox: true,
      // 主窗口只加载远程页面,不需要任何本地 preload API
    },
  });

  security.attachNavigationGuard(state.mainWindow, 'main');
  offline.attachOfflineFallback(state.mainWindow, 'main');
  shortcutsApi && shortcutsApi.register(state.mainWindow);

  state.mainWindow.loadURL(APP_URL);
  state.mainWindow.once('ready-to-show', () => state.mainWindow.show());

  // 关闭按钮 → 隐藏到托盘,而非退出
  state.mainWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      state.mainWindow.hide();
    }
  });
}

function showMain() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) {
    createMainWindow();
  }
  if (state.mainWindow.isMinimized()) state.mainWindow.restore();
  state.mainWindow.show();
  state.mainWindow.focus();
}

function hideMain() {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.hide();
}

// ---------------- UI 动作分发(悬浮球/浮框 → 主进程) ----------------
function onUiAction(name, payload) {
  log('[ui:action]', name, payload);
  // 任何动作都先关掉自绘右键菜单(菜单项点击后菜单应消失)
  ballMenu.closeMenuWindow();
  switch (name) {
    case 'show-main':
    case 'main':
      showMain();
      break;
    case 'toggle-main':
      // 双击悬浮球:主窗显示则隐藏到托盘,隐藏则展开
      if (state.mainWindow && !state.mainWindow.isDestroyed() && state.mainWindow.isVisible()) {
        log('[toggle-main] hide main window');
        state.mainWindow.hide();
      } else {
        showMain();
      }
      break;
    case 'popup':
      popup.togglePopup();
      break;
    case 'popup-hide':
      hidePopup();
      break;
    case 'screenshot':
      screenshot.startScreenshot();
      break;
    case 'ball-menu':
      ballMenu.showBallMenu(payload);
      break;
    case 'toggle-mode':
      // 右键菜单"切换显示模式":悬浮球 ↔ 鲸鱼娘 循环
      mode.toggleMode();
      break;
    case 'pet-ignore':
      // 鲸鱼娘命中检测结果 → 控制窗口点击穿透
      pet.setIgnore(payload && payload.ignore);
      break;
    case 'overlay:ready':
      if (state.overlayWindow && !state.overlayWindow.isDestroyed() && state.pendingShot) {
        state.overlayWindow.webContents.send('overlay:image', state.pendingShot.dataUrl);
      }
      break;
    case 'crop':
      screenshot.handleCrop(payload || {});
      break;
    case 'cancel':
      screenshot.closeOverlay();
      break;
    case 'drag-end': {
      // 拖拽结束:渲染进程已用 window.moveTo 落位,主进程只做钳制+尺寸修正
      if (state.floatingWindow && !state.floatingWindow.isDestroyed() && payload && typeof payload.x === 'number') {
        const p = floating.clampBall(payload.x, payload.y);
        state.floatingWindow.setBounds({ x: p.x, y: p.y, width: floating.BALL_SIZE, height: floating.BALL_SIZE });
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

function hidePopup() {
  if (state.popupWindow && !state.popupWindow.isDestroyed()) state.popupWindow.hide();
}

// ---------------- 动作集合(供托盘/快捷键使用) ----------------
const actions = {
  showMain,
  hideMain,
  togglePopup: (text) => popup.togglePopup(text),
  hidePopup,
  startScreenshot: () => screenshot.startScreenshot(),
  checkForUpdates: () => updater.checkForUpdates(),
  setDisplayMode: (m) => mode.setDisplayMode(m),
  getDisplayMode: () => mode.getDisplayMode(),
};

// 托盘与快捷键依赖 actions,须在 actions 定义后实例化
const tray = require('./modules/tray').create({ log, state, actions });
shortcutsApi = require('./modules/shortcuts').create({ log, state, actions });

// ---------------- 生命周期 ----------------
app.whenReady().then(() => {
  if (!gotLock) return; // 未拿到单实例锁,等待退出

  mode.loadMode(); // 同步读持久化的显示模式(必须在建窗前)
  tray.createTray();
  mode.createActiveWindow(); // 按持久化模式建窗(默认悬浮球)
  updater.setupAutoUpdater();

  ipcMain.on('ui:action', (_e, name, payload) => onUiAction(name, payload));

  // 启动后自动弹出对话浮窗(双击桌面图标或开机自启时显示)
  setTimeout(() => {
    if (!state.popupWindow || state.popupWindow.isDestroyed()) {
      popup.togglePopup();
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
          if (err) {
            log('[fullscreen] check failed:', err.message);
          } else {
            const isFs = /FULLSCREEN/.test(stdout || '');
            if (isFs && !wasFullscreen) {
              mode.hideForFs(); // 隐藏当前显示模式窗口(悬浮球或鲸鱼娘)
            } else if (!isFs && wasFullscreen) {
              mode.restoreFromFs();
            }
            wasFullscreen = isFs;
            scheduleFsCheck(isFs ? FS_CHECK_INTERVAL.fullscreen : FS_CHECK_INTERVAL.windowed);
          }
        } catch (e) {
          /* ignore */
        }
      }
    );
  }
  scheduleFsCheck(2000); // 启动 2 秒后首查
});

// 托盘驻留:所有窗口关闭时不退出,由托盘"退出"显式结束
app.on('window-all-closed', () => {
  /* keep running in tray */
});
