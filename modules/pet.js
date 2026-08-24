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

// HIT_BASE 与尺寸缩放基准:窗口命中区按 320 宽基准比例换算(与 ui/pet.js HIT 常量一致)
const PET_W = 320; // 缩放基准宽度(computeHit 分母,非实际窗口尺寸)
const PET_H = 180; // 缩放基准高度
const HIT_BASE = { x: 100, y: 25, w: 120, h: 142.5 };
// 命中检测轮询间隔(ms)
const HIT_POLL_MS = 100;
const PET_PAGE = path.join(__dirname, '..', 'ui', 'pet.html');
const UI_PRELOAD = path.join(__dirname, '..', 'ui', 'preload-ui.js');

// 三档尺寸表(纯函数,便于测试):小/中/大(16:9,可见桌宠 10-17% 屏宽)
const WIDGET_PET_SIZES = {
  small: { w: 220, h: 124 },
  medium: { w: 300, h: 169 },
  large: { w: 400, h: 225 },
};
function widgetPetSize(level) {
  return WIDGET_PET_SIZES[level] || WIDGET_PET_SIZES.medium;
}

// 命中区按当前窗口尺寸比例缩放(不取整:基准 320x180 时保持精确的 {100,25,120,142.5})
function computeHit(w, h) {
  const sx = w / PET_W;
  const sy = h / PET_H;
  return {
    x: HIT_BASE.x * sx,
    y: HIT_BASE.y * sy,
    w: HIT_BASE.w * sx,
    h: HIT_BASE.h * sy,
  };
}

// ---- debug 模式:持续记录窗口位置/鼠标位置/穿透状态,用于分析拖不动问题 ----
const DEBUG = true;                       // 临时调试开关,分析完改 false 或删除
const DEBUG_SAMPLE_MS = 2000;             // 周期采样间隔(ms)
const DEBUG_MOVE_MS = 500;                // 检测到窗口移动时的采样间隔(ms),拖拽中更密集

function create({ log, state, onWindowLoaded }) {
  let hitTimer = null;
  let debugTimer = null;
  let dragLock = false; // 拖拽中强制接收鼠标事件
  let lastInside = null;   // 上次命中结果(状态变化时记录)
  let lastIgnore = null;   // 上次穿透状态(状态变化时记录)
  let lastWinPos = null;   // 上次窗口位置(移动检测)
  let lastMouse = null;    // 上次鼠标位置(移动检测)
  let petW = PET_W;        // 当前窗口尺寸(创建时按尺寸档位计算)
  let petH = PET_H;
  let HIT = computeHit(petW, petH); // 当前命中区(随尺寸更新)

  // 主进程在设置变化/启动时调用,同步当前尺寸档位
  function setWidgetSize(level) {
    const sz = widgetPetSize(level);
    petW = sz.w;
    petH = sz.h;
    HIT = computeHit(petW, petH);
  }

  // 尺寸档位变化后原地缩放现有窗口(不销毁重建,避免旧窗口残影/引用竞态)
  function applyWidgetSize() {
    if (!state.petWindow || state.petWindow.isDestroyed()) return;
    const b = state.petWindow.getBounds();
    state.petWindow.setBounds({ x: b.x, y: b.y, width: petW, height: petH });
    // 下发新尺寸:渲染层重算命中区/落地偏移(舞台钉 px,窗口膨胀也不影响视觉)
    state.petWindow.webContents.send('pet-pos', { x: b.x, y: b.y, w: petW, h: petH });
    log('[pet] resized to', petW + 'x' + petH);
  }

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
    // 按当前尺寸档位创建窗口(小/中/大;命中区同步缩放)
    state.petWindow = new BrowserWindow({
      width: petW,
      height: petH,
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
    // 加载完成后下发初始窗口位置与尺寸:渲染进程 window.screenX 不可靠(主进程
    // setPosition 驱动),用本地 winX/winY 追踪;尺寸一并下发(渲染层按比例缩放命中区);
    // 同时通知主进程补发当前前台上下文(页面加载期的事件可能已丢失)
    state.petWindow.webContents.once('did-finish-load', () => {
      const b = state.petWindow.getBounds();
      state.petWindow.webContents.send('pet-pos', { x: b.x, y: b.y, w: petW, h: petH });
      if (typeof onWindowLoaded === 'function') onWindowLoaded();
    });
    startHitDetect();
    debugLog('window created at', state.petWindow.getPosition());
    log('[pet] window created at', state.petWindow.getPosition(), 'size', petW + 'x' + petH);
    if (DEBUG) debugTimer = setTimeout(debugSample, 1000); // 启动 1s 后开始采样

    const win = state.petWindow;
    win.on('closed', () => {
      // 仅当仍是本窗口引用时才清空,避免异步关闭期间新窗口引用被误清(残影/引用竞态)
      if (state.petWindow === win) state.petWindow = null;
      stopHitDetect();
      if (debugTimer) { clearTimeout(debugTimer); debugTimer = null; }
    });
  }

  // 默认位置:人物主体(HIT 区)右缘贴屏幕右缘、垂直居中
  // (窗口右缘会悬出屏幕,人物才真正"贴边";与拖拽钳制到右缘时的位置一致)
  function positionPet() {
    if (!state.petWindow) return;
    const wa = screen.getPrimaryDisplay().workArea;
    const x = wa.x + wa.width - HIT.x - HIT.w;
    const y = wa.y + Math.round(wa.height / 2) - Math.round(petH / 2);
    // setPosition 要求整数(HIT 区缩放后可能是浮点,须取整,否则抛 conversion failure)
    state.petWindow.setPosition(Math.round(x), Math.round(y));
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
    // 钳制:人物主体(HIT 区)始终完整在屏幕内,窗口透明边可悬出屏幕外(贴边站立)
    //   窗口左缘 ∈ [wa.x - HIT.x, wa.x + wa.width - HIT.x - HIT.w]
    //   窗口顶缘 ∈ [wa.y - HIT.y, wa.y + wa.height - HIT.y - HIT.h]
    const minX = wa.x - HIT.x;
    const maxX = wa.x + wa.width - HIT.x - HIT.w;
    const minY = wa.y - HIT.y;
    const maxY = wa.y + wa.height - HIT.y - HIT.h;
    const cx = Math.min(Math.max(x, minX), maxX);
    const cy = Math.min(Math.max(y, minY), maxY);
    // setBounds 同时钉住当前尺寸:GPU 禁用环境下透明窗口被脚本移动会尺寸漂移
    // (探针复现 320→543px),钉尺寸保证鲸鱼娘始终是设定大小
    w.setBounds({ x: Math.round(cx), y: Math.round(cy), width: petW, height: petH });
    // 发生钳制时回传实际位置:渲染进程 winX/winY 必须与实际同步,否则拖到屏幕
    // 边缘后本地坐标漂移,导致后续偏移计算错乱(越拖越偏/拖不动)。
    // 正常拖拽(未钳制)时 setBounds 即请求值,渲染进程本地值天然一致,无需回传。
    if (Math.round(cx) !== Math.round(x) || Math.round(cy) !== Math.round(y)) {
      w.webContents.send('pet-pos', { x: Math.round(cx), y: Math.round(cy) });
    }
  }

  return {
    createPetWindow,
    destroyPetWindow,
    positionPet,
    setIgnore,
    setDragLock,
    moveWindow,
    setWidgetSize,
    applyWidgetSize,
    widgetPetSize,
    PET_W,
    PET_H,
  };
}

module.exports = { create };
