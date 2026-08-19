// 鲸鱼娘:透明动画桌宠渲染层
// 移植自 dsh-pet(PC2005-cloud)的动画链模型,去 React 化改原生 DOM,
// 并适配 Electron 透明窗口:移动=窗口 moveTo,穿透=IPC 控制主进程 setIgnoreMouseEvents。
// 核心结构保留 dsh-pet 设计:
//   1. 双缓冲 video 交叉淡入 + gen 代数守卫(切换无空白帧、快速连点不竞态)
//   2. 动画链:每个动画一次性播放,播完按概率选下一个(30%待机/10%转向/40%动作/20%移动)
//   3. HIT_BOX 命中层:人物 bbox 区域才响应鼠标,透明区点击直达下层 UI
//   4. 拖拽保持按下点偏移 + 5px 阈值判定 + 幽灵点击抑制
//   5. facing 镜像(inline scaleX(-1),旧视频淡出时保持原朝向)
//   6. 落地对齐(640x360 画布脚底 y=330 → 窗口内 translateY)

const api = window.ds;
const stage = document.getElementById('stage');
const hit = document.getElementById('hit');
const vA = document.getElementById('va');
const vB = document.getElementById('vb');

function dbg(...args) {
  try { api.log(...args); } catch (e) {}
}

// ---------- 常量(对齐 dsh-pet thumb:640x360 画布,脚底 y=330) ----------
const PET_W = 320;
const PET_H = 180;
// 命中矩形(640x360 画布像素坐标,dsh-pet 实测 41 个动画站立帧 bbox 并集)
const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };
// 换算为窗口像素
const HIT = {
  x: (HIT_BOX.x0 / 640) * PET_W,
  y: (HIT_BOX.y0 / 360) * PET_H,
  w: ((HIT_BOX.x1 - HIT_BOX.x0) / 640) * PET_W,
  h: ((HIT_BOX.y1 - HIT_BOX.y0) / 360) * PET_H,
};
// 落地对齐:脚底距画布底 30/360,舞台下移让脚贴窗口底(窗口底=屏幕底)
const bottomPad = PET_H * ((360 - 330) / 360);

// ---------- 动画目录(精简集 8 个) ----------
const IDLE = '待机呼吸休闲';       // 主体待机
const TURN = '东张西望';           // 转向(内容本身是"偏左看到偏右",播完翻转 facing)
const ACTS = ['鲸鱼吐泡泡特效'];    // 随机动作池(精简集仅此 1 个)
const CLICKS = ['点击回应 - 开心跃动', '点击回应 - 害羞惊讶']; // 点击回应(2 选 1)
const DRAG = '被鼠标拖拽悬空反馈';  // 拖拽动画
const MOVES = ['螃蟹走路', '原地漂浮踏步']; // 移动动画池

// 移动参数(dsh-pet 原值)
const MOVE_MIN_PX = 60;
const MOVE_MAX_PX = 240;
const MOVE_MARGIN = 20;
const MOVE_LEAD_SEC = 2; // 动画开头 2s 准备动作,位置不动
const MOVE_TAIL_SEC = 2; // 动画结尾 2s 收尾动作,位置不动

const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min));
const pick = (pool, exclude) => {
  const entries = exclude ? pool.filter((n) => n !== exclude) : pool;
  return entries[Math.floor(Math.random() * entries.length)];
};

// ---------- 双缓冲状态 ----------
let front = 0;            // 当前显示:0=A, 1=B
let pending = null;       // 加载中 {anim, once, gen}
let gen = 0;              // 切换代数(过期回调守卫)
let anim = IDLE;          // 当前动画名(镜像,供异步回调读取)
let once = true;          // 一次性播放(链式模型全部一次性)
let facing = 'left';      // 朝向:left | right

// ---------- 交互状态 ----------
let drag = { active: false, dragging: false, sx: 0, sy: 0, offX: 0, offY: 0 };
let justDragged = false;  // 拖拽结束抑制幽灵点击
let clickTimer = null;

// 窗口位置本地追踪:Electron 中渲染进程 window.moveTo 无效,移动全走主进程
// setPosition(IPC pet-move),window.screenX 不会随主进程移动更新,故用本地值。
let winX = 0;
let winY = 0;
api.on('pet-pos', (pos) => {
  if (pos && typeof pos.x === 'number' && (pos.x !== winX || pos.y !== winY)) {
    winX = pos.x;
    winY = pos.y;
    dbg('pet-pos set', [winX, winY]);
  }
});

// ---------- 移动状态 ----------
let moveRef = null;       // rAF id
let moveToken = 0;        // 移动令牌(取消使旧回调失效)
let pendingMove = null;   // 计划中的移动 {startX, targetX}

// ---------- 视频资源路径 ----------
function assetSrc(name) {
  return 'pet-assets/' + encodeURIComponent(name) + '.webm';
}

// ---------- 双缓冲切换(核心播放逻辑,移植 dsh-pet switchTo) ----------
// 两个 video 层叠:目标 src 设到"非显示"的那个,loadeddata 后交叉淡入,
// 旧画面一直显示到新画面就绪,永不闪空白。
function switchTo(next, nextOnce) {
  // 目标已在加载中则跳过
  if (pending && pending.anim === next && pending.once === nextOnce) return;
  const g = ++gen;
  pending = { anim: next, once: nextOnce, gen: g };

  const el = front === 0 ? vB : vA;
  if (!el) return;
  el.src = assetSrc(next);
  el.loop = !nextOnce;
  el.muted = true;
  el.autoplay = true;
  el.playsInline = true;
  el.onended = nextOnce ? handleEnded : undefined;
  el.load();

  const onReady = () => {
    el.removeEventListener('loadeddata', onReady);
    if (pending && pending.gen !== g) return; // 过期:期间又有更新的切换
    const old = front === 0 ? vA : vB;
    el.classList.add('is-front');
    if (old && old !== el) old.classList.remove('is-front');
    front = front === 0 ? 1 : 0;
    pending = null;
    // facing 镜像:新视频按当前朝向设置,旧视频保持自己的 transform 淡出
    el.style.transform = facing === 'right' ? 'scaleX(-1)' : '';
    el.play().catch(() => {});
    if (pendingMove) startMoveDrive(el);
  };
  el.addEventListener('loadeddata', onReady);
  if (el.readyState >= 2) onReady();
}

// ---------- 动画链:播完按概率选下一个(30/10/40/20) ----------
function pickNext() {
  const roll = Math.random();
  let next = '';
  if (roll < 0.3) {
    next = IDLE;               // 30% 待机
  } else if (roll < 0.4) {
    next = TURN;               // 10% 转向
  } else if (roll < 0.8) {
    next = pick(ACTS, anim);   // 40% 随机动作
  } else if (tryMove()) {
    next = pick(MOVES);        // 20% 移动(空间不够回退动作)
  } else {
    next = pick(ACTS, anim);
  }
  setAnim(next);
}

function handleEnded() {
  if (drag.active) return; // 拖拽中不打断
  if (anim === TURN) {
    facing = facing === 'left' ? 'right' : 'left'; // 转向播完翻转朝向
  }
  // 点击回应/拖拽动画(用户打断触发)播完 → 先回待机缓冲
  if (anim === DRAG || CLICKS.includes(anim)) {
    setAnim(IDLE);
    return;
  }
  pickNext(); // 自主链:按概率选下一个
}

function setAnim(next) {
  anim = next;
  once = true;
  switchTo(anim, once); // 无 React 依赖:每次调用直接触发切换(含同名重播,由 pending 检查去重)
}

// ---------- 移动系统(适配:窗口移动而非元素移动) ----------
function tryMove() {
  if (moveRef || pendingMove) return true; // 已在移动/已计划
  // 方向按实际朝向;东张西望刚播完时 facing 即将翻转,方向取反
  const dir = (facing === 'right') !== (anim === TURN) ? 1 : -1;
  const cx = winX + PET_W / 2;
  const distance = randomBetween(MOVE_MIN_PX, MOVE_MAX_PX);
  const target = cx + dir * distance;
  const availW = window.screen.availWidth;
  const leftBound = MOVE_MARGIN + PET_W / 2;
  const rightBound = availW - MOVE_MARGIN - PET_W / 2;
  if (target < leftBound || target > rightBound) return false; // 空间不够
  pendingMove = { startX: cx, targetX: target };
  return true;
}

function startMoveDrive(el) {
  if (!pendingMove || moveRef) return;
  const pm = pendingMove;
  pendingMove = null;
  const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10;
  const travelWindow = Math.max(0.1, duration - MOVE_LEAD_SEC - MOVE_TAIL_SEC);
  const token = ++moveToken;
  const step = () => {
    if (moveToken !== token) return;
    const t = el.currentTime || 0;
    let x = pm.startX;
    if (t > MOVE_LEAD_SEC && t < duration - MOVE_TAIL_SEC) {
      x = pm.startX + (pm.targetX - pm.startX) * ((t - MOVE_LEAD_SEC) / travelWindow);
    } else if (t >= duration - MOVE_TAIL_SEC) {
      x = pm.targetX;
    }
    // 窗口移动:Y 保持贴底,只动 X(走主进程 setPosition,渲染进程 moveTo 无效)
    winX = Math.round(x - PET_W / 2);
    api.action('pet-move', { x: winX, y: winY });
    if (t < duration - MOVE_TAIL_SEC) {
      moveRef = requestAnimationFrame(step);
    } else {
      moveRef = null;
    }
  };
  moveRef = requestAnimationFrame(step);
}

function stopMove() {
  pendingMove = null;
  moveToken += 1;
  if (moveRef) {
    cancelAnimationFrame(moveRef);
    moveRef = null;
  }
}

// ---------- 点击穿透(改为主进程轮询命中检测) ----------
// 主进程每 100ms 用 screen.getCursorScreenPoint() 判断光标是否在人物 HIT_BOX 内,
// 在 → 关穿透正常交互;移出 → 开穿透直达下层。渲染进程不再做 mousemove 命中
// (鼠标静止时无事件,穿透永远关不掉导致拖不动)。
// 拖拽期间 pointerdown/up 通知主进程加/解锁,强制穿透关闭,防快速甩动闪断。
// ---------- 点击 vs 拖拽(移植 dsh-pet:5px 阈值 + 按下点偏移 + 幽灵点击抑制) ----------
const DRAG_THRESHOLD = 5;

// 事件日志:记录鼠标事件是否真正到达渲染进程(穿透是否生效的关键证据)
function evtLog(tag, e) {
  dbg(`[pet-ev] ${tag}`, {
    mouse: [e && e.screenX, e && e.screenY],
    win: [winX, winY],
    rel: [e && e.screenX - winX, e && e.screenY - winY],
    dragging: drag.dragging,
    active: drag.active,
  });
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  evtLog('pointerdown', e);
  hit.classList.add('dragging');
  stopMove(); // 交互打断移动
  hit.setPointerCapture(e.pointerId);
  // 拖拽锁:强制穿透关闭(否则 pointermove 可能因轮询误判中断)
  api.action('pet-drag', { lock: true });
  // 记录鼠标点相对窗口中心的偏移:从人物任意位置抓起都不瞬移到鼠标下
  drag = {
    active: true,
    dragging: false,
    sx: e.screenX,
    sy: e.screenY,
    offX: e.screenX - (winX + PET_W / 2),
    offY: e.screenY - (winY + PET_H / 2),
  };
}

function onPointerMove(e) {
  const d = drag;
  if (!d.active) return;
  const dx = e.screenX - d.sx;
  const dy = e.screenY - d.sy;
  if (!d.dragging) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return; // 未超阈值:仍是点击候选
    d.dragging = true;
    evtLog('drag-start', e);
    setAnim(DRAG); // 进入拖拽:播放拖拽动画
  }
  // 跟手:窗口中心 = 鼠标点 - 按下偏移(走主进程 setPosition)
  winX = Math.round(e.screenX - d.offX - PET_W / 2);
  winY = Math.round(e.screenY - d.offY - PET_H / 2);
  api.action('pet-move', { x: winX, y: winY });
}

function onPointerUp(e) {
  const d = drag;
  if (!d.active) return;
  const wasDragging = d.dragging;
  evtLog(wasDragging ? 'pointerup-drag' : 'pointerup-click', e);
  d.active = false;
  d.dragging = false;
  hit.classList.remove('dragging');
  // 解锁拖拽:恢复主进程轮询穿透(光标仍在人物上会立即关穿透,不影响后续点击)
  api.action('pet-drag', { lock: false });
  if (wasDragging) {
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 100); // 抑制拖拽后的幽灵点击
    setAnim(IDLE); // 回待机缓冲
  }
}

// ---------- 单击/双击/右键 ----------
// 单击:点击回应动画;双击:toggle 主窗口(240ms 内二次 click 判定为双击)
function onClick(e) {
  evtLog('click', e);
  if (justDragged) return;
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    api.action('toggle-main'); // 双击
    return;
  }
  clickTimer = setTimeout(() => {
    clickTimer = null;
    // 正在播一次性动画(点击回应/拖拽/移动)时不打断,仅待机可响应
    if (anim === IDLE || anim === TURN) setAnim(pick(CLICKS));
  }, 240);
}

hit.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.action('ball-menu', { wx: winX, wy: winY, mx: e.screenX, my: e.screenY });
});

// ---------- 事件绑定 ----------
hit.addEventListener('pointerdown', onPointerDown);
hit.addEventListener('pointermove', onPointerMove);
hit.addEventListener('pointerup', onPointerUp);
hit.addEventListener('pointercancel', onPointerUp);
hit.addEventListener('click', onClick);

// ---------- 启动 ----------
stage.style.transform = 'translateY(' + bottomPad + 'px)';
// 命中层覆盖 HIT_BOX 区域
hit.style.left = HIT.x + 'px';
hit.style.top = HIT.y + 'px';
hit.style.width = HIT.w + 'px';
hit.style.height = HIT.h + 'px';
// 穿透由主进程轮询控制,渲染进程无需初始设置

setAnim(IDLE); // 首次加载即播待机
dbg('pet init', { HIT, bottomPad, screen: { w: window.screen.availWidth, h: window.screen.availHeight }, pos: [winX, winY] });
