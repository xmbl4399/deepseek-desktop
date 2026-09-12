// DeepSeek 桌面助手 - 主进程(组装层)
// 功能模块见 modules/ 目录:logger/state/security/offline/ball-menu/floating/tray/updater/shortcuts
// 本文件保留:单实例锁、主窗口(多标签壳)、UI 动作分发、应用菜单、全屏检测、生命周期
const { app, BrowserWindow, ipcMain, screen, dialog, clipboard, Menu, shell } = require('electron');
const path = require('path');

// Windows 任务栏/通知/更新提示的应用标识;不设置时会显示为 electron.app.* 或与快捷方式分组错乱。
// 注意:此项不影响 app.getName()/userData 路径(改 userData 目录会导致登录态与设置丢失,本项目不做)
app.setAppUserModelId('com.deepseek.desktop');

// ---------------- 模块装配 ----------------
const { log } = require('./modules/logger');
const state = require('./modules/state');
const security = require('./modules/security').create({ log });
const offline = require('./modules/offline').create({ log });
// 菜单模型:托盘与悬浮球菜单共用同一份项序/分组(modules/menu-model.js),
// 这里只提供"当前状态"作为渲染依据 —— 加项/调顺序改 menu-model.js 即可,两个入口同时生效
const ballMenu = require('./modules/ball-menu').create({ log, state, getMenuContext: menuContext });
// 每个 webview 的"手势起点选区快照"(webview-preload 在 pointerdown 时上报):
// webContents.id → { text, at }。context-menu 阶段用它区分"选区是这次手势刚选中"还是"本来就选中"。
const selectionSnapshots = new Map();
const SNAPSHOT_TTL = 5000; // 超过 5s 的快照视为过期(避免残留旧值误判)
function selectionBeforeGesture(wc) {
  const snap = selectionSnapshots.get(wc.id);
  if (!snap || Date.now() - snap.at > SNAPSHOT_TTL) return null; // null = 未知 → 走旧行为(直接弹菜单)
  return snap.text;
}
const contextMenu = require('./modules/context-menu').create({ log, security, selectionBeforeGesture });

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
let shortcutsApi = null;
const screenshot = require('./modules/screenshot').create({ log, state });
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
process.on('unhandledRejection', (reason) => {
  // Error 对象 JSON 序列化是 {},需展开 message/stack 才能定位
  log('[crash] unhandledRejection:', reason && reason.message ? reason.message : reason, reason && reason.stack ? '\n' + reason.stack : '');
});

// 本地 UI 页面的调试日志转发
ipcMain.on('ui:log', (_e, ...args) => log('[ui]', ...args));

// ---------------- 主窗口(多标签壳) ----------------
const MAIN_PAGE = path.join(__dirname, 'ui', 'main.html');
const UI_PRELOAD = path.join(__dirname, 'ui', 'preload-ui.js');
const WEBVIEW_PRELOAD = path.join(__dirname, 'ui', 'webview-preload.js');

// 站外链接点击捕获器(注入 webview 主世界):网页自身拦截了链接点击导致导航守卫不触发,
// 这里在捕获阶段拦截 <a> 点击,站外链接交给主进程默认浏览器打开
// 站内判定必须按 origin 精确比较:前缀匹配会被 https://chat.deepseek.com.evil.tld 与
// https://chat.deepseek.com@evil.tld 骗过,导致钓鱼页在应用内(无地址栏)打开
const LINK_GUARD_SCRIPT = `(() => {
  if (window.__dsLinkGuard) return;
  window.__dsLinkGuard = true;
  const ORIGIN = ${JSON.stringify(security.APP_ORIGIN)};
  const isAppUrl = (href) => {
    try { return new URL(href).origin === ORIGIN; } catch (e) { return false; }
  };
  document.addEventListener('click', (e) => {
    const el = e.target;
    const a = el && el.closest ? el.closest('a[href]') : null;
    if (!a) return;
    const href = a.href || '';
    if (!href.startsWith('http') || isAppUrl(href)) return;
    e.preventDefault();
    e.stopPropagation();
    if (window.dsWebview && window.dsWebview.openExternal) window.dsWebview.openExternal(href);
  }, true);
})();`;

// 主窗尺寸按"尺寸档位"对应分辨率区间:小=720p、中=1080p/1440p、大=2160p+
// (与悬浮球/鲸鱼娘的 小/中/大 档位联动,调整任一侧都同步)
function mainSizeFor(tier, availW) {
  if (tier === 'small') return { w: 800, h: 600 };
  if (tier === 'large') return { w: 1280, h: 960 };
  return availW <= 2400 ? { w: 960, h: 720 } : { w: 1120, h: 840 }; // medium:1080p / 1440p
}

function createMainWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const sz = mainSizeFor(mode.getWidgetSize(), wa.width);
  const MAIN_W = sz.w;
  const MAIN_H = sz.h;
  state.mainWindow = new BrowserWindow({
    width: MAIN_W,
    height: MAIN_H,
    // 默认位:屏幕居中(水平+垂直)
    x: wa.x + Math.round(wa.width / 2) - Math.round(MAIN_W / 2),
    y: wa.y + Math.round(wa.height / 2) - Math.round(MAIN_H / 2),
    minWidth: 480,
    minHeight: 360,
    // 标题栏显示产品名(壳页面 ui/main.html 也带 <title>DeepSeek</title>,此处兜底首帧不闪旧名)
    title: 'DeepSeek',
    icon: path.join(__dirname, 'ui', 'logo.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 多标签壳:本地页面 + webview;webview 内容自带隔离,壳无需 sandbox
      sandbox: false,
      webviewTag: true,
      preload: UI_PRELOAD,
    },
  });

  // webview 安全:只允许附加 chat.deepseek.com(防恶意页面塞任意 webview);
  // 同时注入 webview preload(外部链接通道)与点击捕获器
  state.mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!security.isAppUrl(params.src)) {
      log('[security] blocked webview attach:', params.src);
      event.preventDefault();
      return;
    }
    webPreferences.preload = WEBVIEW_PRELOAD;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });

  state.mainWindow.loadFile(MAIN_PAGE);
  state.mainWindow.once('ready-to-show', () => state.mainWindow.show());
  shortcutsApi && shortcutsApi.register(state.mainWindow); // 壳层快捷键(tabs:action 发往壳)
  // 壳加载完成后下发主窗置顶状态(置顶按钮初始态)
  state.mainWindow.webContents.once('did-finish-load', () => broadcastMainTop());

  // 关闭按钮 → 隐藏到托盘,而非退出;首次关闭用系统气泡说明一次(否则新用户会以为"关不掉/后台偷跑")
  state.mainWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      state.mainWindow.hide();
      if (!mode.isCloseHintShown()) {
        mode.markCloseHintShown();
        tray.notify('DeepSeek 已最小化到托盘', '程序仍在后台运行,右键托盘图标可显示或退出。');
        log('[ui] close-to-tray hint shown');
      }
    }
  });
}

// 尺寸档位变化 → 主窗口同步档位尺寸(仅 setBounds 缩放,保留标签页与位置;
// 不销毁重建——销毁会丢失所有打开标签,视觉效果相同)
function resizeMainWindow() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const sz = mainSizeFor(mode.getWidgetSize(), wa.width);
  const b = state.mainWindow.getBounds();
  state.mainWindow.setBounds({ x: b.x, y: b.y, width: sz.w, height: sz.h });
  log('[main] resized to', sz.w + 'x' + sz.h);
}

// 主窗置顶状态广播给壳渲染层(置顶按钮高亮)
function broadcastMainTop() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  try {
    state.mainWindow.webContents.send('main-top', { on: mode.getMainOnTop() });
  } catch (e) { /* ignore */ }
}

// 向主窗壳发送消息;壳未加载完则等 did-finish-load 后补发
function sendToShell(channel, payload) {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) showMain();
  const wc = state.mainWindow && state.mainWindow.webContents;
  if (!wc) return;
  if (wc.isLoading()) {
    log('[ss] sendToShell', channel, '-> wait did-finish-load');
    wc.once('did-finish-load', () => {
      log('[ss] sendToShell', channel, '-> sent after load');
      try { wc.send(channel, payload); } catch (e) { /* ignore */ }
    });
  } else {
    log('[ss] sendToShell', channel, '-> sent now');
    try { wc.send(channel, payload); } catch (e) { /* ignore */ }
  }
}

function shellToast(text) {
  sendToShell('toast', { text });
}

// 截图完成 → 打开主窗 → 壳在当前(活动)标签执行粘贴(不新建标签,避免标签混乱)
function pasteScreenshotToNewTab() {
  log('[ss] pasteScreenshotToNewTab (active tab)');
  showMain();
  sendToShell('screenshot-paste', {});
}

// 当前(活动)标签就绪:JS 注入粘贴剪贴板截图(不依赖 webContents.paste()/窗口帧焦点,
// 最小化/未交互过的主窗也能粘贴;输入框异步渲染时重试 ~20s)
function pasteToActiveWebview(wcId) {
  const wc = wcId ? webviewWcs.get(wcId) : null;
  if (!wc || wc.isDestroyed()) {
    log('[ss] paste: no webview for id', wcId);
    shellToast('截图已复制,请到输入框手动 Ctrl+V 粘贴');
    return;
  }
  const img = clipboard.readImage();
  if (img.isEmpty()) {
    log('[ss] paste: clipboard image empty');
    shellToast('剪贴板没有图片,请重新截图');
    return;
  }
  const dataUrl = img.toDataURL();
  // 在页面内:找输入框 → 聚焦 → 构造 ClipboardEvent('paste') 派发图片 File
  // (base64 用 atob 解码,避免 fetch(data:) 受页面 CSP 限制)
  const pasteScript = `(() => {
    const cands = [
      'textarea',
      '[contenteditable="true"]',
      'div[role="textbox"]',
      '[data-testid="chat-input"]',
      'input[type="text"]',
      'input:not([type])',
    ];
    let el = null;
    for (const s of cands) {
      const e = document.querySelector(s);
      if (!e) continue;
      const editable = e.tagName === 'TEXTAREA' || e.tagName === 'INPUT'
        || e.isContentEditable || e.getAttribute('contenteditable') !== null;
      if (editable) { el = e; break; }
    }
    if (!el) return 'not-found';
    el.focus();
    try {
      const b64 = ${JSON.stringify(dataUrl)}.split(',')[1] || '';
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return 'ok';
    } catch (e) {
      return 'dispatch-fail:' + (e && e.message);
    }
  })()`;
  let tries = 0;
  const MAX_TRIES = 30; // ~20s(输入框在页面加载完成后异步渲染)
  const attempt = () => {
    if (tries++ > MAX_TRIES) {
      log('[ss] paste: input not found after', MAX_TRIES, 'tries');
      shellToast('未找到输入框,截图已复制,请手动 Ctrl+V');
      return;
    }
    wc.executeJavaScript(pasteScript, true)
      .then((res) => {
        log('[ss] paste: attempt', tries, 'res=', res);
        if (res === 'ok') {
          shellToast('截图已粘贴到当前对话');
        } else if (res === 'not-found') {
          setTimeout(attempt, 700);
        } else {
          // 派发失败兜底:原生 paste(此时窗口已 showMain 恢复,帧焦点存在)
          try {
            wc.paste();
            log('[ss] paste: dispatch fail, native paste fallback, res=', res);
            shellToast('截图已粘贴到当前对话');
          } catch (e2) {
            log('[ss] paste: fallback threw', e2 && e2.message);
            shellToast('截图已复制,请手动 Ctrl+V 粘贴');
          }
        }
      })
      .catch((e) => {
        log('[ss] paste: executeJavaScript threw', e && e.message);
        setTimeout(attempt, 700);
      });
  };
  attempt();
}

// ---------------- 活动标签工具(查找 / 缩放 / 开发者工具都作用于当前标签) ----------------
function activeWc() {
  const wc = activeWcId ? webviewWcs.get(activeWcId) : null;
  if (wc && !wc.isDestroyed()) return wc;
  // 兜底:取第一个未销毁的标签(activeWcId 尚未上报时,如启动即按快捷键)
  for (const w of webviewWcs.values()) {
    if (!w.isDestroyed()) return w;
  }
  return null;
}

// 缩放:Ctrl+= / Ctrl+- / Ctrl+0(Electron zoomLevel,实际比例 = 1.2^level)
const zoomLevels = new Map();
function zoomActive(dir) {
  const wc = activeWc();
  if (!wc) return;
  let level = zoomLevels.get(wc.id) || 0;
  if (dir === 'in') level = Math.min(level + 0.5, 4);
  else if (dir === 'out') level = Math.max(level - 0.5, -3);
  else level = 0;
  zoomLevels.set(wc.id, level);
  wc.setZoomLevel(level);
  const pct = Math.round(Math.pow(1.2, level) * 100);
  shellToast('缩放 ' + pct + '%');
  log('[zoom] level=', level, 'pct=', pct);
}

// 页内查找:壳层查找条收集输入 → 当前标签 findInPage(结果数由 found-in-page 回传壳层)
function openFindBar() {
  showMain();
  sendToShell('find-open', {});
}

function findInActive(text, opts) {
  const wc = activeWc();
  if (!wc) return;
  const q = String(text || '');
  if (!q) {
    wc.stopFindInPage('clearSelection');
    return;
  }
  wc.findInPage(q, opts || {});
}

function closeFindBar() {
  const wc = activeWc();
  if (wc) wc.stopFindInPage('clearSelection');
  sendToShell('find-closed', {});
}

function toggleDevTools() {
  const wc = activeWc();
  if (!wc) return;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: 'detach' });
}

// 关于:版本号 + 项目主页 + 检查更新(应用内唯一能确认当前版本的地方)
function showAbout() {
  dialog
    .showMessageBox({
      type: 'info',
      title: '关于 DeepSeek',
      message: 'DeepSeek 桌面版',
      detail: [
        '版本 ' + app.getVersion(),
        'Electron ' + process.versions.electron,
        '仓库 https://github.com/xmbl4399/deepseek-desktop',
      ].join('\n'),
      buttons: ['检查更新', '关闭'],
      defaultId: 1,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) updater.checkForUpdates();
    })
    .catch(() => {});
}

// 应用菜单(中文):不设置时按 Alt 会弹出 Electron 英文默认菜单(含 Toggle Developer Tools)。
// 编辑类 role 同时为 webview 内的复制/粘贴/撤销提供可靠的加速键。
function setupAppMenu() {
  const tabAction = (action) => () => sendToShell('tabs:action', { action });
  const template = [
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '标签',
      submenu: [
        { label: '新建标签', accelerator: 'CmdOrCtrl+T', click: tabAction('new') },
        { label: '关闭当前标签', accelerator: 'CmdOrCtrl+Shift+W', click: tabAction('close') },
        { label: '恢复关闭的标签', accelerator: 'CmdOrCtrl+Shift+T', click: tabAction('reopen') },
        { type: 'separator' },
        { label: '下一个标签', click: tabAction('next') },
        { label: '上一个标签', click: tabAction('prev') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载当前标签', accelerator: 'CmdOrCtrl+R', click: tabAction('reload') },
        { label: '页内查找', accelerator: 'CmdOrCtrl+F', click: openFindBar },
        { type: 'separator' },
        { label: '放大', click: () => zoomActive('in') },
        { label: '缩小', click: () => zoomActive('out') },
        { label: '重置缩放', click: () => zoomActive('reset') },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'F12', click: toggleDevTools },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于 DeepSeek', click: showAbout },
        { label: '检查更新…', click: () => updater.checkForUpdates() },
        { label: '项目主页', click: () => security.openExternalSafe('https://github.com/xmbl4399/deepseek-desktop') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  log('[menu] application menu installed (zh-CN)');
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

// 卸载 DeepSeek:定位 NSIS 卸载程序,二次确认后运行(仅打包版有意义)
function uninstallApp() {
  if (!app.isPackaged) {
    dialog.showMessageBox({ type: 'info', message: '开发模式下不支持卸载' }).catch(() => {});
    return;
  }
  const exeDir = path.dirname(process.execPath);
  // 注意:这两个文件名来自安装目录实际产物(productName = "DeepSeek Desktop"),
  // 与界面显示名 "DeepSeek" 无关,不要为了文案统一而改这里,否则会找不到卸载程序
  const candidates = [
    path.join(exeDir, 'Uninstall', 'DeepSeek Desktop.exe'),
    path.join(exeDir, 'Uninstall.exe'),
  ];
  const fs = require('fs');
  const un = candidates.find((p) => fs.existsSync(p));
  if (!un) {
    dialog
      .showMessageBox({ type: 'warning', message: '未找到卸载程序,请到 系统设置 → 应用 中卸载' })
      .catch(() => {});
    return;
  }
  dialog
    .showMessageBox({
      type: 'warning',
      title: '卸载 DeepSeek',
      message: '确定要卸载 DeepSeek 吗?',
      detail: '将运行卸载程序,应用与本地数据将被移除。',
      buttons: ['确认卸载', '取消'],
      defaultId: 1,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response !== 0) return;
      app.isQuiting = true;
      const { spawn } = require('child_process');
      spawn(un, ['/S'], { detached: true, stdio: 'ignore' }).unref();
      app.quit();
    })
    .catch(() => {});
}

// ---------------- 菜单上下文(托盘 + 悬浮球菜单共用的渲染依据) ----------------
// 只描述"当前是什么状态",不决定"有哪些项" —— 项序/分组在 modules/menu-model.js。
// 函数声明会提升,所以装配区(tray/ballMenu)可以先引用再定义。
function menuContext() {
  return {
    mainVisible: !!(state.mainWindow && !state.mainWindow.isDestroyed() && state.mainWindow.isVisible()),
    mode: mode.getDisplayMode(),
    size: mode.getWidgetSize(),
    mainOnTop: mode.getMainOnTop(),
    foregroundAware: mode.getForegroundAware(),
    autoStart: app.getLoginItemSettings().openAtLogin,
    version: app.getVersion(),
  };
}

// 打开数据目录(日志所在处;打包版是 %APPDATA%\deepseek-desktop,开发版是项目根)
function openDataDir() {
  const dir = app.isPackaged ? app.getPath('userData') : path.join(__dirname);
  shell.openPath(dir).catch(() => {});
  log('[ui] open data dir:', dir);
}

// ---------------- UI 动作分发(悬浮球/浮框/托盘共用) ----------------
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
    case 'ball-menu':
      ballMenu.showBallMenu(payload);
      break;
    case 'menu-close':
      // 自绘菜单按 Esc:窗口已在上方统一关闭,这里不做别的(不能落到 default 报未知动作)
      break;
    case 'size-small':
    case 'size-medium':
    case 'size-large':
      // 尺寸档位(托盘子菜单 / 悬浮球菜单共用同一动作 id)
      actions.setWidgetSize(name.slice(5));
      break;
    case 'screenshot':
      // 截图提问(悬浮右键菜单/托盘):选区框选 → 剪贴板 → 新标签自动粘贴
      actions.startScreenshot();
      break;
    case 'overlay:ready':
      // 框选遮罩就绪:回传全屏截图
      if (state.overlayWindow && !state.overlayWindow.isDestroyed() && state.pendingShot) {
        state.overlayWindow.webContents.send('overlay:image', state.pendingShot.dataUrl);
      }
      break;
    case 'crop': {
      // 框选完成:入剪贴板 → 打开主窗 → 新建标签 → 自动粘贴
      const p = payload || {};
      log('[ss] crop received, dataUrl len=', (p.dataUrl || '').length, 'w=', p.width, 'h=', p.height);
      const ok = screenshot.handleCrop(p);
      log('[ss] handleCrop ok=', ok);
      if (ok) pasteScreenshotToNewTab();
      break;
    }
    case 'cancel':
      screenshot.closeOverlay();
      break;
    case 'screenshot-paste-loaded': {
      // 当前标签就绪(壳层携带活动标签 webContents id):聚焦输入框 + 粘贴剪贴板截图
      const id = payload && payload.id ? payload.id : activeWcId;
      log('[ss] paste-loaded received, wcId=', id, 'registered=', !!(id && webviewWcs.get(id)));
      pasteToActiveWebview(id);
      break;
    }
    case 'tab-active':
      // 壳层上报当前活动标签(切换/新建标签时),截图粘贴以此定位
      activeWcId = payload && payload.id ? payload.id : null;
      break;
    case 'find':
      // 壳层查找条输入 → 当前标签页内查找
      findInActive(payload && payload.text, {
        forward: payload && payload.backward ? false : true,
        findNext: !!(payload && payload.findNext),
      });
      break;
    case 'find-close':
      closeFindBar();
      break;
    case 'copy-text':
      // 壳层复制到剪贴板(标签标题等;渲染层 navigator.clipboard 在 file:// 下不可靠)
      clipboard.writeText(String((payload && payload.text) || ''));
      log('[ui] copy-text len=', String((payload && payload.text) || '').length);
      break;
    case 'zoom':
      zoomActive(payload && payload.dir);
      break;
    case 'about':
      showAbout();
      break;
    case 'toggle-main-top': {
      // 主窗置顶:主窗内按钮/两个菜单共用(mode 持久化 + 广播给壳按钮 + 刷新托盘勾选)。
      // 勾选值优先取渲染层回传的"目标值"(原生 checkbox 会给出),没有则按当前状态取反 ——
      // 这样自绘菜单(只发意图)与原生菜单(发目标值)能共用同一分支
      const next = payload && typeof payload.checked === 'boolean' ? payload.checked : !mode.getMainOnTop();
      mode.setMainOnTop(next);
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.setAlwaysOnTop(next);
      }
      broadcastMainTop();
      tray.refresh();
      break;
    }
    case 'toggle-foreground': {
      // 前台感知开关:关 = 完全不读取前台窗口(全屏自动隐藏与前台上下文动画同时失效)
      const next = payload && typeof payload.checked === 'boolean' ? payload.checked : !mode.getForegroundAware();
      actions.setForegroundAware(next);
      tray.refresh();
      break;
    }
    case 'toggle-autostart': {
      const next = payload && typeof payload.checked === 'boolean' ? payload.checked : !app.getLoginItemSettings().openAtLogin;
      // 显式传 path:Windows 下 get 判定注册表值是否等于 exe 路径,不传时两者可能不一致导致状态误判
      app.setLoginItemSettings({ openAtLogin: next, path: process.execPath });
      log('[settings] autoStart =', next, '-> registry now:', app.getLoginItemSettings().openAtLogin);
      tray.refresh();
      break;
    }
    case 'uninstall':
      uninstallApp();
      break;
    case 'open-data-dir':
      openDataDir();
      break;
    case 'toggle-mode':
      // 右键菜单"切换显示模式"(旧项兜底):悬浮球 ↔ 鲸鱼娘 循环
      mode.toggleMode();
      break;
    case 'mode-ball':
      mode.setDisplayMode('ball');
      tray.refresh();
      break;
    case 'mode-pet':
      mode.setDisplayMode('pet');
      tray.refresh();
      break;
    case 'mode-off':
      // 关闭显示 = 桌宠窗口全部销毁,用户会瞬间失去所有入口 → 弹一次系统气泡告知怎么找回
      mode.setDisplayMode('off');
      tray.refresh();
      tray.notify('桌宠已隐藏', '右键托盘图标 → 桌宠显示,可重新显示悬浮球或鲸鱼娘。');
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

// ---------------- 动作集合(供快捷键/内部调用;菜单项统一走上面的 onUiAction) ----------------
const actions = {
  showMain,
  hideMain,
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
    mode.rebuildActiveWindow(); // 重建当前桌宠窗口应用新尺寸
    resizeMainWindow();         // 主窗口同步档位尺寸(仅缩放,保留标签页)
  },
  getWidgetSize: () => mode.getWidgetSize(),
  setMainOnTop: (v) => {
    mode.setMainOnTop(v);
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.setAlwaysOnTop(v === true);
    }
    broadcastMainTop(); // 同步壳内 📌 按钮状态(托盘切换时)
    tray.refresh();     // 同步托盘勾选状态(任一入口切换都立即刷新)
  },
  getMainOnTop: () => mode.getMainOnTop(),
  // 截图提问(悬浮右键菜单/托盘):选区框选 → 剪贴板 → 新标签自动粘贴
  startScreenshot: () => screenshot.startScreenshot(),
  // 卸载 DeepSeek(托盘菜单,二次确认后运行卸载程序)
  uninstallApp: () => uninstallApp(),
  // 页内查找 / 缩放 / 开发者工具 / 关于(快捷键与应用菜单共用)
  openFind: () => openFindBar(),
  zoom: (dir) => zoomActive(dir),
  toggleDevTools: () => toggleDevTools(),
  showAbout: () => showAbout(),
};

// 前台感知开关的联动句柄(whenReady 内注册):开=启动前台轮询,关=停止且不再采集
let fgToggleHandler = null;

// 托盘与快捷键依赖 actions,须在 actions 定义后实例化
const tray = require('./modules/tray').create({
  log,
  state,
  onMenuAction: onUiAction,      // 托盘菜单项与悬浮球菜单走同一个动作入口
  getMenuContext: menuContext,
});
shortcutsApi = require('./modules/shortcuts').create({ log, state, actions });

// 每个 webview 标签页:挂导航守卫 + 离线兜底 + 窗口内快捷键(快捷键转发到壳层管理标签)
const webviewWcs = new Map(); // webContents.id → webContents(活动标签定位用)
let activeWcId = null;        // 当前活动标签的 webContents.id(壳层 tab-active 上报)
app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() !== 'webview') return;
  webviewWcs.set(wc.id, wc);
  wc.once('destroyed', () => {
    webviewWcs.delete(wc.id);
    zoomLevels.delete(wc.id);
    selectionSnapshots.delete(wc.id);
  });
  const fakeWin = { webContents: wc };
  security.attachNavigationGuard(fakeWin, 'webview');
  offline.attachOfflineFallback(fakeWin, 'webview');
  // 右键/长按触摸菜单:Electron 不提供网页内容默认菜单,必须自己注册(选中文字才有"复制")
  contextMenu.attach(wc, 'webview#' + wc.id);
  // 页内查找结果数回传壳层(查找条显示 3/12)
  wc.on('found-in-page', (_ev, result) => {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
    try {
      state.mainWindow.webContents.send('find-result', {
        matches: result.matches,
        active: result.activeMatchOrdinal,
        final: result.finalUpdate,
      });
    } catch (e) { /* ignore */ }
  });
  if (shortcutsApi && state.mainWindow && !state.mainWindow.isDestroyed()) {
    shortcutsApi.register(wc, state.mainWindow.webContents);
  }
  // 每次页面(重)加载完成后注入链接点击捕获器(网页拦截点击导致导航守卫不触发)
  wc.on('dom-ready', () => {
    wc.executeJavaScript(LINK_GUARD_SCRIPT, true).catch(() => {});
  });
});

// webview 外部链接通道(webview-preload 转发)
ipcMain.on('webview:open-external', (_e, url) => security.openExternalSafe(url));

// webview 手势起点选区快照(webview-preload 在 pointerdown 时上报)
ipcMain.on('webview:selection-snapshot', (e, text) => {
  if (!e.sender || e.sender.isDestroyed()) return;
  selectionSnapshots.set(e.sender.id, { text: String(text || ''), at: Date.now() });
});

// ---------------- 生命周期 ----------------
app.whenReady().then(() => {
  if (!gotLock) return; // 未拿到单实例锁,等待退出

  mode.loadMode(); // 同步读持久化的显示模式(必须在建窗前)
  // 中文应用菜单(替换 Electron 英文默认菜单;编辑类 role 兼作 webview 剪贴板加速键)
  setupAppMenu();
  // 开机启动默认开:仅首次启动(打包版)自动设置,记录标记后不再干预(用户可托盘关闭)
  if (app.isPackaged && !mode.isAutoStartInit()) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
    mode.markAutoStartInit();
  }
  tray.createTray();
  // 同步尺寸档位到显示模块(窗口创建时按档位取尺寸)
  floating.setWidgetSize(mode.getWidgetSize());
  pet.setWidgetSize(mode.getWidgetSize());
  mode.createActiveWindow(); // 按持久化模式建窗(默认悬浮球)
  updater.setupAutoUpdater();

  ipcMain.on('ui:action', (_e, name, payload) => onUiAction(name, payload));

  // 自绘菜单折叠组展开/收起 → 内容尺寸变了,按锚点重设菜单窗口。
  // 单独走一条通道而不是复用 ui:action:onUiAction 会先关掉菜单窗口(那是"菜单项被点击"的语义),
  // 而展开折叠组只是改布局,菜单必须留在原地。sender 校验防止其它窗口冒用。
  ipcMain.on('ui:resize', (e, w, h) => {
    if (!state.menuWindow || state.menuWindow.isDestroyed()) return;
    if (e.sender !== state.menuWindow.webContents) return;
    const at = ballMenu.fitMenu(w, h);
    log('[ball-menu] resize ->', [w, h], at && [at.x, at.y]);
  });

  // 启动即显示主窗口(唯一对话入口;默认右半屏居中 640x480)
  showMain();
  // 应用持久化的主窗置顶状态
  if (mode.getMainOnTop() && state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.setAlwaysOnTop(true);
  }

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
            // 单次失败不能终结检测链:保持上次判定,按低频继续重试。
            // 否则恰逢"全屏隐藏中"失败时,wasFullscreen 恒为 true,
            // 悬浮球/鲸鱼娘将永久隐藏、永不恢复(实测 2026-09-05 复现)
            log('[fullscreen] check failed:', err.message);
            scheduleFsCheck(FS_CHECK_INTERVAL.windowed);
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
