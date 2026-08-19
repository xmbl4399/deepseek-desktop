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

// ---------- 尺寸(对齐 dsh-pet thumb:640x360 画布,脚底 y=330) ----------
// 主进程按 DIP 桌面宽自适应(≤2560 保持 320,超出放大封顶 640),随 pet-pos 下发;
// 命中区/落地偏移按比例跟随
let PET_W = 320;
let PET_H = 180;
// 命中矩形(640x360 画布像素坐标,dsh-pet 实测 41 个动画站立帧 bbox 并集)
const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };
// 换算为窗口像素(随 PET_W/H 更新)
let HIT = {
  x: (HIT_BOX.x0 / 640) * PET_W,
  y: (HIT_BOX.y0 / 360) * PET_H,
  w: ((HIT_BOX.x1 - HIT_BOX.x0) / 640) * PET_W,
  h: ((HIT_BOX.y1 - HIT_BOX.y0) / 360) * PET_H,
};
// 落地对齐:脚底距画布底 30/360,舞台下移让脚贴窗口底(窗口底=屏幕底)
let bottomPad = PET_H * ((360 - 330) / 360);

// 尺寸变化后重算命中区/落地偏移并应用到 DOM;
// 舞台钉死为设定尺寸(px):GPU 禁用环境下窗口可能被移动撑大,舞台不跟随 → 鲸鱼娘视觉不变大;
// 气泡字号按窗口尺寸缩放(其余 em 自动跟随)
function applySize() {
  HIT = {
    x: (HIT_BOX.x0 / 640) * PET_W,
    y: (HIT_BOX.y0 / 360) * PET_H,
    w: ((HIT_BOX.x1 - HIT_BOX.x0) / 640) * PET_W,
    h: ((HIT_BOX.y1 - HIT_BOX.y0) / 360) * PET_H,
  };
  bottomPad = PET_H * ((360 - 330) / 360);
  stage.style.width = PET_W + 'px';
  stage.style.height = PET_H + 'px';
  stage.style.transform = 'translateY(' + bottomPad + 'px)';
  hit.style.left = HIT.x + 'px';
  hit.style.top = HIT.y + 'px';
  hit.style.width = HIT.w + 'px';
  hit.style.height = HIT.h + 'px';
  // 气泡随鲸鱼娘大小缩放:12px @ 320 宽为基准
  const bubbleScale = PET_W / 320;
  bubbleEl.style.fontSize = Math.max(9, Math.round(12 * bubbleScale)) + 'px';
}

// ---------- 动画目录(全量 51 个素材) ----------
const IDLE = '待机呼吸休闲';       // 主体待机
const TURN = '东张西望';           // 转向(内容本身是"偏左看到偏右",播完翻转 facing)
const ACTS = [                     // 随机动作池(全量 42 个)
  '被落叶淹没', '被吓一跳（炸毛）', '超大伸懒腰', '吃白饭', '吃冰淇淋融化',
  '吃晚餐', '吃午餐', '吃早餐', '吃Token', '吹气球', '打瞌睡被惊醒',
  '大口吃零食', '动物环绕', '堆雪人', '放风筝', '哈欠连天', '鲸鱼吐泡泡特效',
  '可爱宅舞', '蓝鲸现世', '女仆屈膝礼仪', '轻快记录', '轻快摇摆舞',
  '深度思考碎碎念', '偷吃零食被抓住', '玩水枪', '玩游戏气急败坏',
  '小幅度原地 360 度旋转展示', '小提琴演奏', '写代码', '摇扇纳凉',
  '用鲸鱼尾巴拍打地面', '优雅女仆舞', '悠闲哼歌', '原地蹲下玩玩具汽车',
  '原地敲击桌面互动', '原地跳跃抓碎头顶物品', '原地小憩沉眠',
  '原地重力下蹲压缩', '原地专心玩魔方', '照镜子', '整体换装试色', '中秋赏月吃月饼',
];
const CLICKS = [ // 点击回应(12 选 1):前缀三件 + 其他适合"被戳一下"的活泼短动画
  '点击回应 - 开心跃动',
  '点击回应 - 害羞惊讶',
  '点击回应 - 傲娇生气（侧身展示）',
  '被吓一跳（炸毛）',
  '鲸鱼吐泡泡特效',
  '原地跳跃抓碎头顶物品',
  '吹气球',
  '玩水枪',
  '小幅度原地 360 度旋转展示',
  '女仆屈膝礼仪',
  '打瞌睡被惊醒',
  '偷吃零食被抓住',
];
const DRAG = '被鼠标拖拽悬空反馈';  // 拖拽动画
const MOVES = ['螃蟹走路', '原地漂浮踏步', '原地左转奔跑']; // 移动动画池

// 特定前台上下文 → 提高概率的动作(60% 从偏好池选,否则全池均匀;other 全均匀)
const CONTEXT_ACTS = {
  ide: ['写代码', '深度思考碎碎念', '轻快记录'],
  terminal: ['深度思考碎碎念', '写代码', '原地敲击桌面互动'],
  office: ['轻快记录', '写代码', '深度思考碎碎念'],
  design: ['轻快记录', '写代码', '照镜子'],
  browser: ['照镜子', '轻快摇摆舞', '悠闲哼歌'],
  chat: ['悠闲哼歌', '轻快摇摆舞', '吹气球'],
  meeting: ['女仆屈膝礼仪', '优雅女仆舞', '摇扇纳凉'],
  media: ['原地小憩沉眠', '哈欠连天', '摇扇纳凉'],
  game: ['玩游戏气急败坏', '被吓一跳（炸毛）', '原地跳跃抓碎头顶物品'],
  explorer: ['照镜子', '轻快记录', '悠闲哼歌'],
};

// 随机动作:按前台上下文提高特定动作概率
function pickAct() {
  const pref = CONTEXT_ACTS[contextCategory];
  if (pref && pref.length && Math.random() < 0.6) return pick(pref, anim);
  return pick(ACTS, anim);
}

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

// ---------- 趣味气泡(抄 dsh-dafeiyu 的气泡思路:轻量文字气泡,定时/事件触发) ----------
const bubbleEl = document.getElementById('bubble');
let bubbleTimer = null;
function showBubble(text, ms) {
  if (!text || !bubbleEl) return;
  bubbleEl.textContent = text;
  bubbleEl.classList.add('show');
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubbleEl.classList.remove('show'), ms || 3500);
}

const GREETINGS = ['你好呀~', '我在这儿哦~', '今天也要加油鸭!', '来啦来啦~'];
const DRINK_MSGS = ['该喝水啦~', '喝口水休息一下吧~', '水水时间到~'];
const MOVE_MSGS = ['起来活动一下吧~', '久坐啦,伸个懒腰~', '走动走动吧~'];
const MEAL_MSGS = ['快到饭点啦,准备吃饭~', '马上要吃饭咯~'];
const NIGHT_MSGS = ['夜深了,早点休息哦~', '都这么晚啦,该睡啦~'];
const QUIPS = ['发呆中…', '好无聊呀~', '偷偷看你~', '今天天气不错呢~'];

const MIN = 60 * 1000;

// 启动问好
setTimeout(() => showBubble(pick(GREETINGS)), 2500);

// 喝水提醒:每 45 分钟
setInterval(() => showBubble(pick(DRINK_MSGS)), 45 * MIN);

// 久坐活动提醒:每 30 分钟
setInterval(() => showBubble(pick(MOVE_MSGS)), 30 * MIN);

// 饭点提醒(饭点前 15 分钟,每天各一次)与夜间休息提醒(23:00 后一次)
const MEAL_TIMES = [
  { label: 'breakfast', m: 7 * 60 + 30 },
  { label: 'lunch', m: 11 * 60 + 30 },
  { label: 'dinner', m: 17 * 60 + 30 },
];
const MEAL_WINDOW_MIN = 15;
const NIGHT_HOUR = 23;
let remindedDay = '';
let remindedMeals = new Set();
let nightReminded = false;
setInterval(() => {
  const now = new Date();
  const day = now.toDateString();
  if (day !== remindedDay) { remindedDay = day; remindedMeals.clear(); nightReminded = false; } // 跨天重置
  const minutes = now.getHours() * 60 + now.getMinutes();
  for (const t of MEAL_TIMES) {
    if (minutes >= t.m - MEAL_WINDOW_MIN && minutes < t.m && !remindedMeals.has(t.label)) {
      remindedMeals.add(t.label);
      showBubble(pick(MEAL_MSGS));
      break;
    }
  }
  if (!nightReminded && now.getHours() >= NIGHT_HOUR) {
    nightReminded = true;
    showBubble(pick(NIGHT_MSGS));
  }
}, MIN); // 每分钟检查一次时间窗口

// 偶尔随机小感叹(每 6 分钟 30% 概率)
setInterval(() => {
  if (Math.random() < 0.3) showBubble(pick(QUIPS));
}, 6 * MIN);

// ---------- 状态感知(前台上下文驱动;焦点在 DeepSeek 时触发工作动画) ----------
// 前台上下文由"前台感知开关"驱动:焦点在 DeepSeek=deepseek(吐泡泡循环,醒目),
// 其余按程序类型播对应小动作,other 保持待机链
let contextCategory = 'other';
// 前台上下文 → 动画(仅用现有基础素材;deepseek 单独处理,other 保持待机链)
const CONTEXT_ANIM = {
  browser: '东张西望',         // 浏览器:东张西望(浏览)
  explorer: '东张西望',        // 文件管理器:东张西望(翻找)
  ide: '原地漂浮踏步',         // 编辑器:稳稳步子(写代码)
  office: '原地漂浮踏步',      // 办公:稳稳步子(干活)
  design: '原地漂浮踏步',      // 设计:稳稳步子(创作)
  terminal: '螃蟹走路',        // 终端:横步忙碌(跑命令)
  chat: '点击回应 - 害羞惊讶', // 聊天:害羞(消息来了)
  meeting: '点击回应 - 害羞惊讶', // 视频会议:害羞(被看着)
  media: '待机呼吸休闲',       // 影音:一起放松
  game: '点击回应 - 开心跃动', // 游戏:开心跃动(玩得开心)
  other: '',
};

api.on('pet-context', (c) => {
  if (!c || typeof c.category !== 'string') return;
  contextCategory = c.category;
  dbg('pet-context', contextCategory);
  applyPerception();
});

// 状态感知落地:拖拽/点击中不打断;焦点在 DeepSeek 用循环"忙碌"动画,其余用一次性上下文动画
function applyPerception() {
  if (drag.active) return; // 拖拽/点击中不打断
  stopMove(); // 打断自动移动
  dbg('perception ->', contextCategory, 'anim=', anim, 'once=', once);
  if (contextCategory === 'deepseek') {
    // 焦点在 DeepSeek:持续"忙碌"动画(循环),直到焦点离开
    if (anim === '鲸鱼吐泡泡特效' && !once) return; // 已在循环播放中
    setAnimLoop('鲸鱼吐泡泡特效');
    return;
  }
  // 焦点离开 DeepSeek:退出感知循环动画(链式模型里只有感知用循环,once=false),
  // 回待机链,否则鲸鱼娘会永远卡在循环动画里(之前"没看见变化"的根因之一);
  // 之后继续应用上下文动画(若 setAnim 连续调用,后续切换会顶掉前面的)
  if (!once) setAnim(IDLE);
  // 正在播一次性点击动画时不打断(让脉冲播完自然回链)
  if (once && CLICKS.includes(anim)) return;
  const ctxAnim = CONTEXT_ANIM[contextCategory] || '';
  if (ctxAnim) { setAnim(ctxAnim); return; }
  // other/无上下文:不打断当前动画链
}

// 窗口位置本地追踪:Electron 中渲染进程 window.moveTo 无效,移动全走主进程
// setPosition(IPC pet-move),window.screenX 不会随主进程移动更新,故用本地值。
let winX = 0;
let winY = 0;
api.on('pet-pos', (pos) => {
  if (!pos || typeof pos.x !== 'number') return;
  // 尺寸随位置一并下发(自适应 DIP 宽),变化时重算命中区/落地偏移
  if (pos.w && pos.h && (pos.w !== PET_W || pos.h !== PET_H)) {
    PET_W = pos.w;
    PET_H = pos.h;
    applySize();
    dbg('pet-size set', [PET_W, PET_H]);
  }
  if (pos.x !== winX || pos.y !== winY) {
    winX = pos.x;
    winY = pos.y;
    dbg('pet-pos set', [winX, winY]);
  }
});

// ---------- 移动状态(已禁用自动移动:鲸鱼娘原地奔跑,不移动窗口;stopMove 仅作防御) ----------
let moveRef = null;       // rAF id

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
    next = pickAct();            // 40% 随机动作(按前台上下文加权)
  } else {
    next = pick(MOVES);          // 20% 移动动画(原地奔跑,不移动窗口)
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
    clickBusy = false; // 点击回应播完,允许下一次单击响应
    if (clickBusyTimer) { clearTimeout(clickBusyTimer); clickBusyTimer = null; }
    setAnim(IDLE);
    applyPerception(); // 交互动画播完恢复状态感知(焦点在 DeepSeek 时回到吐泡泡循环)
    return;
  }
  pickNext(); // 自主链:按概率选下一个
}

function setAnim(next) {
  anim = next;
  once = true;
  switchTo(anim, once); // 无 React 依赖:每次调用直接触发切换(含同名重播,由 pending 检查去重)
}

// 循环播放变体(状态感知的持续态用:生成中保持工作姿态,状态变化时被一次性动画打断)
function setAnimLoop(next) {
  anim = next;
  once = false;
  switchTo(anim, false);
}

// ---------- 移动(已禁用自动移动:移动动画原地播放,窗口不动) ----------
function stopMove() {
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
    clickBusy = false; // 进入真实拖拽:打断点击回应,允许后续交互
    if (clickBusyTimer) { clearTimeout(clickBusyTimer); clickBusyTimer = null; }
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
    clickBusy = false; // 拖拽结束解除点击回应忙碌
    if (clickBusyTimer) { clearTimeout(clickBusyTimer); clickBusyTimer = null; }
    setAnim(IDLE); // 回待机缓冲
    applyPerception(); // 拖拽结束恢复状态感知(生成中/出错/前台上下文)
  }
}

// ---------- 单击/双击/右键 ----------
// 单击:点击回应动画(任何时刻都响应,但回应前 3s 内不重复打断,之后可再点);
// 双击:打开对话浮窗(与悬浮球统一,240ms 内二次 click 判定为双击)
const CLICK_FREEZE_MS = 3000; // 点击回应开始后的冻结时长(只冻结前 3s,避免动画全程锁死)
let clickBusy = false;        // 冻结期内:单击不重复播放
let clickBusyTimer = null;    // 冻结计时
function onClick(e) {
  evtLog('click', e);
  if (justDragged) return;
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    api.action('popup'); // 双击:打开对话浮窗
    return;
  }
  clickTimer = setTimeout(() => {
    clickTimer = null;
    if (clickBusy) return; // 上一段点击回应刚开头:本次单击先不响应
    clickBusy = true;
    if (clickBusyTimer) clearTimeout(clickBusyTimer);
    clickBusyTimer = setTimeout(() => { clickBusy = false; clickBusyTimer = null; }, CLICK_FREEZE_MS);
    stopMove(); // 打断自动移动
    setAnim(pick(CLICKS)); // 单击:点击回应动画(任何状态都播放)
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
applySize(); // 应用命中区/落地偏移(尺寸可能随后随 pet-pos 更新)
// 穿透由主进程轮询控制,渲染进程无需初始设置

setAnim(IDLE); // 首次加载即播待机
dbg('pet init', { HIT, bottomPad, screen: { w: window.screen.availWidth, h: window.screen.availHeight }, pos: [winX, winY] });
