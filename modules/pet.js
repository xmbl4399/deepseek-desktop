// 鲸鱼娘:透明动画桌宠窗口(320x180,动画链由 ui/pet.js 驱动)
// 与悬浮球(floating.js)同级:窗口本身只负责创建/销毁/穿透控制/定位,
// 行为逻辑(动画链/拖拽/命中检测)全部在渲染进程 ui/pet.js 内。
// 点击穿透:主进程每 100ms 轮询 screen.getCursorScreenPoint(),
//   命中 HIT_BOX(人物区域) → setIgnoreMouseEvents(false) 正常接收;
//   移出人物/窗口 → setIgnoreMouseEvents(true,{forward:true}) 透明区直达下层。
//   拖拽中(渲染进程发 pet-drag lock:true)强制穿透关闭,防止快速甩动闪断。
// 注:不能用渲染进程 mousemove 做命中检测——鼠标静止时无事件,穿透永远关不掉,拖不动。
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const PET_W = 320;
const PET_H = 180;
// 人物命中区(窗口像素,与 ui/pet.js 的 HIT 常量一致)
const HIT = { x: 100, y: 25, w: 120, h: 142.5 };
// 命中检测轮询间隔(ms)
const HIT_POLL_MS = 100;
const PET_PAGE = path.join(__dirname, '..', 'ui', 'pet.html');
const UI_PRELOAD = path.join(__dirname, '..', 'ui', 'preload-ui.js');

// ---- debug 模式:持续记录窗口位置/鼠标位置/穿透状态,用于分析拖不动问题 ----
const DEBUG = true;                       // 临时调试开关,分析完改 false 或删除
const DEBUG_SAMPLE_MS = 2000;             // 周期采样间隔(ms)
const DEBUG_MOVE_MS = 500;                // 检测到窗口移动时的采样间隔(ms),拖拽中更密集

function create({ log, state }) {
  let hitTimer = null;
  let debugTimer = null;
  let dragLock = false; // 拖拽中强制接收鼠标事件
  let lastInside = null;   // 上次命中结果(状态变化时记录)
  let lastIgnore = null;   // 上次穿透状态(状态变化时记录)
  let lastWinPos = null;   // 上次窗口位置(移动检测)
  let lastMouse = null;    // 上次鼠标位置(移动检测)

  function debugLog(...args) {
    if (DEBUG) log('[pet-debug]', ...args);
  }

  // 周期采样:窗口位置 + 鼠标位置 + 命中 + 穿透 + 拖拽锁(拖拽移动中加密采样)
  function debugSample() {
    const w = state.petWindow;
    if (!w || w.isDestroyed()) return;
    const cur = screen.getCursorScreenPoint();
    const b = w.getBounds();
    const moved = lastWinPos && (lastWinPos.x !== b.x || lastWinPos.y !== b.y);
    const mouseMoved = lastMouse && (lastMouse.x !== cur.x || lastMouse.y !== cur.y);
    lastWinPos = { x: b.x, y: b.y };
    lastMouse = { x: cur.x, y: cur.y };
    debugLog(
      `win=(${b.x},${b.y} ${b.width}x${b.height}) mouse=(${cur.x},${cur.y}) ` +
      `inside=${lastInside} ignore=${lastIgnore ? 'ON' : 'OFF'} dragLock=${dragLock} ` +
      `winMoved=${!!moved} mouseMoved=${!!mouseMoved}`
    );
    // 窗口在移动(拖拽中)→ 加密采样;静止 → 低频采样
    clearTimeout(debugTimer);
    debugTimer = setTimeout(debugSample, moved ? DEBUG_MOVE_MS : DEBUG_SAMPLE_MS);
  }

  function createPetWindow() {
    state.petWindow = new BrowserWindow({
      width: PET_W,
      height: PET_H,
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

    state.petWindow.setAlwaysOnTop(true, 'screen-saver');
    // 初始全穿透:透明区不挡下层应用
    state.petWindow.setIgnoreMouseEvents(true, { forward: true });
    state.petWindow.loadFile(PET_PAGE);
    positionPet();
    // 加载完成后下发初始窗口位置:渲染进程 window.screenX 不可靠(主进程 setPosition
    // 不更新渲染进程 screenX),渲染进程用本地 winX/winY 追踪窗口位置
    state.petWindow.webContents.once('did-finish-load', () => {
      const b = state.petWindow.getBounds();
      state.petWindow.webContents.send('pet-pos', { x: b.x, y: b.y });
    });
    startHitDetect();
    debugLog('window created at', state.petWindow.getPosition());
    log('[pet] window created at', state.petWindow.getPosition());
    if (DEBUG) debugTimer = setTimeout(debugSample, 1000); // 启动 1s 后开始采样

    state.petWindow.on('closed', () => {
      state.petWindow = null;
      stopHitDetect();
      if (debugTimer) { clearTimeout(debugTimer); debugTimer = null; }
    });
  }

  // 默认位置:主屏右下角贴底(落地对齐由渲染进程 translateY 完成)
  function positionPet() {
    if (!state.petWindow) return;
    const wa = screen.getPrimaryDisplay().workArea;
    state.petWindow.setPosition(wa.x + wa.width - PET_W - 24, wa.y + wa.height - PET_H);
  }

  function destroyPetWindow() {
    if (state.petWindow && !state.petWindow.isDestroyed()) state.petWindow.close();
  }

  function setIgnore(ignore) {
    if (!state.petWindow || state.petWindow.isDestroyed()) return;
    const on = !!ignore;
    if (lastIgnore === on) return; // 状态没变不重复设置
    lastIgnore = on;
    state.petWindow.setIgnoreMouseEvents(on, on ? { forward: true } : undefined);
    debugLog(`ignore -> ${on ? 'ON(穿透)' : 'OFF(接收)'} at mouse=(${screen.getCursorScreenPoint().x},${screen.getCursorScreenPoint().y})`);
  }

  // 轮询命中检测:光标在人物 HIT_BOX 内 → 关穿透;否则 → 开穿透
  function hitTest() {
    const w = state.petWindow;
    if (!w || w.isDestroyed()) return;
    const cur = screen.getCursorScreenPoint();
    const b = w.getBounds();
    const inside =
      cur.x >= b.x + HIT.x && cur.x <= b.x + HIT.x + HIT.w &&
      cur.y >= b.y + HIT.y && cur.y <= b.y + HIT.y + HIT.h;
    // 状态变化时记录一次命中切换
    if (inside !== lastInside) {
      lastInside = inside;
      debugLog(`inside -> ${inside} (win=(${b.x},${b.y}) mouse=(${cur.x},${cur.y}))`);
    }
    // 拖拽中强制接收(穿透关闭),避免快速甩动时误判为移出人物导致事件流中断
    setIgnore(dragLock ? false : !inside);
  }

  function startHitDetect() {
    stopHitDetect();
    hitTimer = setInterval(hitTest, HIT_POLL_MS);
  }

  function stopHitDetect() {
    if (hitTimer) {
      clearInterval(hitTimer);
      hitTimer = null;
    }
  }

  // 拖拽锁:渲染进程 pointerdown/up 时调用,拖拽期间强制穿透关闭
  function setDragLock(lock) {
    dragLock = !!lock;
    hitTest(); // 立即应用
    log('[pet] dragLock =', dragLock);
  }

  // 渲染进程拖拽/自动移动 → 主进程移动窗口
  // (渲染进程 window.moveTo 在 Electron 中无效,窗口位置必须由主进程 setPosition 驱动)
  function moveWindow(x, y) {
    const w = state.petWindow;
    if (!w || w.isDestroyed()) return;
    const wa = screen.getPrimaryDisplay().workArea;
    // 钳制在屏幕内
    const cx = Math.min(Math.max(x, wa.x), wa.x + wa.width - PET_W);
    const cy = Math.min(Math.max(y, wa.y), wa.y + wa.height - PET_H);
    w.setPosition(Math.round(cx), Math.round(cy));
  }

  return {
    createPetWindow,
    destroyPetWindow,
    positionPet,
    setIgnore,
    setDragLock,
    moveWindow,
    PET_W,
    PET_H,
  };
}

module.exports = { create };
