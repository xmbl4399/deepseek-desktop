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

// 最后广播的前台上下文;窗口(重)加载完成后补发,避免"加载期事件丢失"导致感知不生效
let lastContext = null;
function resendContextToWidgets() {
  if (lastContext === null) return;
  for (const w of [state.petWindow, state.floatingWindow]) {
    if (w && !w.isDestroyed()) {
      try { w.webContents.send('pet-context', { category: lastContext }); } catch (e) { /* ignore */ }
    }
  }
}

const floating = require('./modules/floating').create({ log, state, onWindowLoaded: resendContextToWidgets });
const pet = require('./modules/pet').create({ log, state, onWindowLoaded: resendContextToWidgets });
// 显示模式协调(悬浮球/鲸鱼娘),依赖 floating + pet,须在两者之后装配
const mode = require('./modules/mode').create({ log, state, floating, pet });
// 前台程序分类(前台感知开关开启时:焦点在 DeepSeek 触发工作动画,其余按程序类型适配)
const focus = require('./modules/focus');
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
    width: 768,
    height: 576,
    minWidth: 640,
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
      ballMenu.showBallMenu(payload, mode.getDisplayMode());
      break;
    case 'toggle-mode':
      // 右键菜单"切换显示模式"(旧项兜底):悬浮球 ↔ 鲸鱼娘 循环
      mode.toggleMode();
      break;
    case 'mode-ball':
      mode.setDisplayMode('ball');
      break;
    case 'mode-pet':
      mode.setDisplayMode('pet');
      break;
    case 'mode-off':
      mode.setDisplayMode('off');
      break;
    case 'pet-drag':
      // 鲸鱼娘拖拽锁:拖拽期间强制穿透关闭,防快速甩动闪断
      pet.setDragLock(payload && payload.lock);
      break;
    case 'pet-move':
      // 鲸鱼娘移动:渲染进程计算目标坐标,主进程 setPosition 驱动
      // (渲染进程 window.moveTo 无效,必须走主进程)
      pet.moveWindow(payload && payload.x, payload && payload.y);
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
    case 'ball-move':
      // 悬浮球移动:渲染进程计算目标坐标,主进程 setPosition + 钳制(半身悬出贴边,
      // 与鲸鱼娘 pet-move 同机制;渲染进程 window.moveTo 被 Chromium 钳制无法贴边)
      floating.moveWindow(payload && payload.x, payload && payload.y);
      break;
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
  setForegroundAware: (v) => {
    mode.setForegroundAware(v);
    // 开关状态变化时同步全屏检测/前台感知的运行与停止
    if (fgToggleHandler) fgToggleHandler();
  },
  getForegroundAware: () => mode.getForegroundAware(),
  setWidgetSize: (s) => {
    mode.setWidgetSize(s);
    mode.rebuildActiveWindow(); // 重建当前窗口应用新尺寸(尽量保持位置)
  },
  getWidgetSize: () => mode.getWidgetSize(),
};

// 前台感知开关的联动句柄(whenReady 内注册):开=启动前台轮询,关=停止且不再采集
let fgToggleHandler = null;

// 托盘与快捷键依赖 actions,须在 actions 定义后实例化
const tray = require('./modules/tray').create({ log, state, actions });
shortcutsApi = require('./modules/shortcuts').create({ log, state, actions });

// ---------------- 生命周期 ----------------
app.whenReady().then(() => {
  if (!gotLock) return; // 未拿到单实例锁,等待退出

  mode.loadMode(); // 同步读持久化的显示模式(必须在建窗前)
  tray.createTray();
  // 同步尺寸档位到显示模块(窗口创建时按档位取尺寸)
  floating.setWidgetSize(mode.getWidgetSize());
  pet.setWidgetSize(mode.getWidgetSize());
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

  // 前台感知(由"前台感知开关"统一控制,默认开):
  //   - 全屏自动隐藏:全屏播放视频/游戏时隐藏悬浮球/鲸鱼娘,退出恢复
  //   - 前台上下文:空闲时按前台程序类型驱动桌宠小动作
  //   开关关闭时:完全不读取前台窗口(DS_FG_MODE 门控),两项功能同时失效(隐私默认)
  const { execFile } = require('child_process');
  let wasFullscreen = false;
  let fsCheckRunning = false; // 防止 PS 进程堆积
  let fsCheckTimer = null;
  // 内嵌 PowerShell 脚本:打包后 asar 内的 .ps1 无法被 powershell -File 读取执行,必须内嵌
  // (与 check-fullscreen.ps1 保持同步,smoke-test 逐行比对)
  const FS_CHECK_SCRIPT = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WAPI {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
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
# 遍历所有显示器:前台窗口覆盖任一屏幕即判定铺满(支持副屏)
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $s.Bounds
    if ($r.Left -le ($b.Left + $tolerance) -and $r.Top -le ($b.Top + $tolerance) -and
        $r.Right -ge ($b.Right - $tolerance) -and $r.Bottom -ge ($b.Bottom - $tolerance)) {
        $full = $true
        break
    }
}
# 排除"最大化/普通窗口":最大化窗口也铺满屏幕,但带标题栏(WS_CAPTION),不是全屏
# 真全屏窗口(浏览器 F11/视频全屏/游戏)通常无标题栏;Chromium 全屏虽带 WS_MAXIMIZE,
# 但无 WS_CAPTION,所以用标题栏判据(比 WS_MAXIMIZE 更准)
$style = [WAPI]::GetWindowLong($fw, -16)
$hasCaption = ($style -band 0x00C00000) -ne 0
# 前台感知:仅 DS_FG_MODE=1 时读取前台进程名(隐私门控);默认只输出全屏标志
$suffix = ""
if ($env:DS_FG_MODE -eq "1") {
    $fwPid = 0
    [WAPI]::GetWindowThreadProcessId($fw, [ref]$fwPid) | Out-Null
    try {
        $proc = Get-Process -Id $fwPid -ErrorAction Stop
        $suffix = "|" + $proc.ProcessName
    } catch {
        $suffix = "|unknown"
    }
}
if ($full -and -not $hasCaption) { Write-Output ("FULLSCREEN" + $suffix) } else { Write-Output ("WINDOWED" + $suffix) }
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
  const FS_CHECK_INTERVAL = { fullscreen: 800, windowed: 3000 }; // 全屏时高频,平时低频

  // 广播前台上下文类别(渲染层:空闲时按类别演动画;聊天状态优先于它)
  function broadcastContext(category) {
    lastContext = category;
    log('[focus] foreground category =', category);
    for (const w of [state.petWindow, state.floatingWindow]) {
      if (w && !w.isDestroyed()) {
        try { w.webContents.send('pet-context', { category }); } catch (e) { /* ignore */ }
      }
    }
  }

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
      // DS_FG_MODE 门控:开关关闭时不采集任何前台信息
      { timeout: 4000, windowsHide: true, env: { ...MINIMAL_ENV, DS_FG_MODE: mode.getForegroundAware() ? '1' : '0' } },
      (err, stdout) => {
        fsCheckRunning = false;
        try {
          if (err) {
            log('[fullscreen] check failed:', err.message);
          } else {
            const out = String(stdout || '');
            const [flag, proc] = out.split('|');
            const isFs = flag === 'FULLSCREEN';
            if (isFs && !wasFullscreen) {
              mode.hideForFs(); // 隐藏当前显示模式窗口(悬浮球或鲸鱼娘)
            } else if (!isFs && wasFullscreen) {
              mode.restoreFromFs();
            }
            wasFullscreen = isFs;
            // 前台上下文:仅感知开启(脚本才返回进程名)且非全屏(桌宠已隐藏)时广播
            if (!isFs && proc && proc !== 'unknown') {
              const category = focus.classify(proc);
              if (category !== lastContext) broadcastContext(category);
            }
            scheduleFsCheck(isFs ? FS_CHECK_INTERVAL.fullscreen : FS_CHECK_INTERVAL.windowed);
          }
        } catch (e) {
          /* ignore */
        }
      }
    );
  }

  // 前台感知开关联动:开=启动前台轮询;关=停止轮询、恢复可能被全屏隐藏的窗口
  fgToggleHandler = () => {
    if (mode.getForegroundAware()) {
      if (!fsCheckTimer) scheduleFsCheck(500);
    } else {
      if (fsCheckTimer) { clearTimeout(fsCheckTimer); fsCheckTimer = null; }
      if (wasFullscreen) { wasFullscreen = false; mode.restoreFromFs(); }
      lastContext = null;
    }
  };

  if (mode.getForegroundAware()) scheduleFsCheck(2000); // 启动 2 秒后首查(开关关闭则完全不读前台)
});

// 托盘驻留:所有窗口关闭时不退出,由托盘"退出"显式结束
app.on('window-all-closed', () => {
  /* keep running in tray */
});
