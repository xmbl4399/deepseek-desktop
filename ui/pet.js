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
  // 轮廓投影(drop-shadow)半径:随窗口尺寸缩放,否则小档时投影相对太粗、大档时太细。
  // 基准 480 宽 → 9px / 27px,与 320 老基准的 6px / 18px 视觉厚度一致。
  // 写 :root 上的 CSS 变量,video.pv 的 filter 引用它们(两路 video 共用,一次更新即可)。
  const rimScale = PET_W / 480;
  document.documentElement.style.setProperty('--rim-near', Math.max(3, 9 * rimScale).toFixed(1) + 'px');
  document.documentElement.style.setProperty('--rim-far', Math.max(8, 27 * rimScale).toFixed(1) + 'px');
  // 脚下阴影:人物脚底处椭圆,宽 ≈ 人物宽的 1.4 倍
  shadowEl.style.top = (HIT.y + HIT.h - HIT.h * 0.06) + 'px';
  shadowEl.style.width = (HIT.w * 1.4) + 'px';
  shadowEl.style.height = (HIT.h * 0.12) + 'px';
}

// ---------- 动画目录(全量 51 个素材) ----------
const IDLE = '待机呼吸休闲';       // 主体待机
const TURN = '东张西望';           // 转向(内容本身是"偏左看到偏右",播完翻转 facing)
// 随机动作分类池(对齐上游 dsh-pet 的 categories 结构:分类 weighted,类内等概率)
// weight 为相对权重,抽签时先按 weight 选分类,再在该类内等概率选动作。
// noMirror: 该分类播放时不跟随 facing 镜像(文字类动画镜像后可读性反转)。
const ACT_CATEGORIES = [
  {
    id: '小动作',
    weight: 20,
    actions: [
      '悠闲哼歌', '超大伸懒腰', '原地敲击桌面互动', '原地重力下蹲压缩',
      '哈欠连天', '原地小憩沉眠', '女仆屈膝礼仪', '被吓一跳',
      '小幅度原地360度旋转展示', '偷吃零食被抓住', '用鲸鱼尾巴拍打地面',
      '打瞌睡被惊醒', '照镜子', '整体换装试色', '轻快记录', '写代码',
      '摇扇纳凉', '晨间刷牙',
    ],
  },
  {
    id: '玩耍',
    weight: 20,
    actions: [
      '原地专心玩魔方', '原地蹲下玩玩具汽车', '鲸鱼吐泡泡特效',
      '原地跳跃抓碎头顶物品', '玩游戏气急败坏', '玩水枪', '小提琴演奏',
      '蓝鲸现世', '优雅女仆舞', '轻快摇摆舞', '可爱宅舞', '吹气球',
      '动物环绕', '放风筝', '拆礼物', '变鸽子', '扑克魔术', '抽陀螺',
      '吹笛子', '蝴蝶蜜蜂环绕头顶开花', '撸猫', '凭空生花', '骑木马',
      '三球抛接', '踢毽子', '下五子棋', '荡秋千',
    ],
  },
  {
    id: '吃什么',
    weight: 16,
    actions: [
      '吃白饭', '大口吃零食', '吃Token', '吃早餐', '吃午餐', '吃晚餐',
      '吃冰淇淋融化', '吃大闸蟹', '吃糖葫芦', '吃长寿面', '吃西瓜', '涮火锅',
    ],
  },
  {
    id: '时节',
    weight: 14,
    actions: [
      '被落叶淹没', '中秋赏月吃月饼', '堆雪人', '放烟花', '吃粽子', '吃年糕',
      '吃青团', '吃腊八粥', '吃重阳糕', '收红包', '写福字', '穿针乞巧',
      '舞狮头', '讨糖南瓜灯', '插茱萸赏菊', '放河灯', '萌化小幽灵',
      '装点圣诞树', '放孔明灯', '吃汤圆', '吃饺子',
    ],
  },
  {
    id: '文字',
    weight: 10,
    noMirror: true,
    actions: ['是啊，吃什么', '深度思考碎碎念'],
  },
];

// 分类权重合计。与 upstream config.jsonc 一致:100 - idle(10) - turn(5) - move(5) = 80
const CATEGORY_WEIGHT_SUM = ACT_CATEGORIES.reduce((s, c) => s + c.weight, 0);

// 全量动作池(扁平视图,供上下文偏好池等场景复用)
const ACTS = ACT_CATEGORIES.reduce((acc, c) => acc.concat(c.actions), []);

// 动作名 → 所属分类(判断 noMirror)
const ACT_CATEGORY_OF = (() => {
  const m = new Map();
  for (const c of ACT_CATEGORIES) for (const a of c.actions) m.set(a, c);
  return m;
})();
// 点击回应池拆两档:
//   CLICK_RESPONSES = 专属"被戳一下"的回应(上游 点击回应-* 全 5 件 + 被吓一跳),
//                     单击时优先从这一档选,保证戳一下总是"有回应"的语义;
//   CLICK_FALLBACKS = 其他活泼短动画,作为补充档(与 RESPONSES 等权合并成 CLICKS)。
const CLICK_RESPONSES = [
  '点击回应-开心跃动',
  '点击回应-害羞惊讶',
  '点击回应-傲娇生气',
  '点击回应-挠痒咯咯笑',
  '点击回应-元气挥手',
  '被吓一跳',
];
const CLICK_FALLBACKS = [
  '鲸鱼吐泡泡特效',
  '原地跳跃抓碎头顶物品',
  '吹气球',
  '玩水枪',
  '小幅度原地360度旋转展示',
  '女仆屈膝礼仪',
  '打瞌睡被惊醒',
  '偷吃零食被抓住',
];
// 单击实际选取池:两档合并(RESPONSES 在前,FALLBACKS 在后)
const CLICKS = CLICK_RESPONSES.concat(CLICK_FALLBACKS);
const DRAG = '被鼠标拖拽悬空反馈';  // 拖拽动画
const MOVES = ['螃蟹走路', '原地漂浮踏步', '原地左转奔跑']; // 移动动画池

// ---------- 前台场景 → 动作池 ----------
// 之前每个场景只有 3 件动作,80 个素材里 64 个永远轮不到:新增素材几乎等于白加,
// 而"写代码"这种场景反复播同一件,看两分钟就腻。现在改为每场景一簇相关动作,
// 配合下面 pickAct 的 0.6/0.4 加权 —— 既有场景感,又不重复。
const CONTEXT_ACTS = {
  // 写代码/排查:坐着敲、思考、记录,偶尔抓狂和摸鱼
  ide: [
    '写代码', '深度思考碎碎念', '轻快记录', '原地敲击桌面互动',
    '超大伸懒腰', '哈欠连天', '打瞌睡被惊醒', '玩游戏气急败坏',
    '偷吃零食被抓住', '吃Token', '撸猫', '原地重力下蹲压缩',
    '小提琴演奏',
  ],
  // 终端:跑命令、等构建、出错抓狂
  terminal: [
    '写代码', '深度思考碎碎念', '原地敲击桌面互动', 
    '玩游戏气急败坏', '超大伸懒腰', '哈欠连天', '轻快记录',
    '原地重力下蹲压缩', '被吓一跳',
  ],
  // 办公文档:记录、敲键盘、礼仪性营业,枯燥到打瞌睡
  office: [
    '轻快记录', '写代码', '原地敲击桌面互动', '女仆屈膝礼仪',
    '深度思考碎碎念', '超大伸懒腰', '哈欠连天', '原地重力下蹲压缩',
    '摇扇纳凉', '晨间刷牙', '大口吃零食', '吃白饭',
  ],
  // 设计创作:看自己、换装试色、找灵感
  design: [
    '照镜子', '整体换装试色', '轻快记录', '凭空生花',
    '小幅度原地360度旋转展示', '悠闲哼歌', '蝴蝶蜜蜂环绕头顶开花', '写代码',
  ],
  // 浏览/管理文件:翻看、照镜子、随手玩点小东西
  browser: [
    '照镜子',  '悠闲哼歌', '轻快摇摆舞', '玩水枪',
    '原地专心玩魔方', '偷吃零食被抓住', '整体换装试色', '轻快记录',
    '是啊，吃什么', '拆礼物', '放风筝', '荡秋千', '骑木马', '吹笛子',
    '用鲸鱼尾巴拍打地面',
  ],
  explorer: [
    '照镜子',  '悠闲哼歌', '轻快记录', '原地专心玩魔方',
    '偷吃零食被抓住', '三球抛接', '轻快摇摆舞',
  ],
  // 聊天:歌舞助兴、吹气球、杂耍表演
  chat: [
    '悠闲哼歌', '轻快摇摆舞', '可爱宅舞', '吹气球', '三球抛接',
    '扑克魔术', '变鸽子', '女仆屈膝礼仪', '摇扇纳凉', '是啊，吃什么',
    '动物环绕', '鲸鱼吐泡泡特效',
  ],
  // 开会:端正、安静、别太吵
  meeting: [
    '女仆屈膝礼仪', '优雅女仆舞', '摇扇纳凉', '轻快记录',
    '打瞌睡被惊醒', '照镜子', '原地重力下蹲压缩',
    '下五子棋',
  ],
  // 看片听歌:一起放松、打瞌睡、摇扇子
  media: [
    '原地小憩沉眠', '哈欠连天', '摇扇纳凉', '悠闲哼歌',
    '打瞌睡被惊醒', '超大伸懒腰', 
  ],
  // 打游戏:自己也玩、气急败坏、兴奋
  game: [
    '玩游戏气急败坏', '被吓一跳', '原地跳跃抓碎头顶物品', '原地专心玩魔方',
    '原地蹲下玩玩具汽车', '抽陀螺', '踢毽子', '吹气球',
    '小幅度原地360度旋转展示', '偷吃零食被抓住', '三球抛接', '撸猫',
    '蓝鲸现世', '动物环绕',
  ],
};

// 一天中的时段 → 那个时段自然会做的事(吃饭档、节令档)。
// 这两簇动作共 22 件,占比不小,但和你在干什么无关,按软件场景塞进去会显得莫名其妙
// (写代码时突然拿出大闸蟹)。改成按真实时间走,任何场景下都有机会轮到:
// 中午在 IDE 前也会吃饭,过年时她会自己写福字。
function periodPool(now) {
  const d = now instanceof Date ? now : new Date();
  const h = d.getHours();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  // 节令优先:前后各留几天,免得一年只有一天能看见
  const festival = {
    '放烟花': m === 1 && day <= 7,          // 元旦
    '写福字': m === 2 && day <= 12,          // 春节前后
    '吃汤圆': m === 2 || m === 3,
    '吃饺子': m === 2 || m === 12,
    '吃青团': m === 4,
    '吃粽子': m === 6,
    '中秋赏月吃月饼': m === 9,
    '吃重阳糕': m === 10,
    '插茱萸赏菊': m === 10 || m === 11,
    '讨糖南瓜灯': m === 10 || m === 11,
    '萌化小幽灵': m === 10 || m === 11,
    '装点圣诞树': m === 12,
    '吃腊八粥': m === 12 || m === 1,
    '收红包': m === 1 || m === 2,
    '吃年糕': m === 1 || m === 2,
    '吃长寿面': m === 1 || m === 2,
    '穿针乞巧': m === 8,
    '放河灯': m === 7 || m === 8,
    '舞狮头': m === 1 || m === 2,
    '放孔明灯': m === 12 || m === 1,
    '堆雪人': m === 12 || m === 1 || m === 2,
    '被落叶淹没': m === 10 || m === 11,
  };
  const out = [];
  for (const [name, on] of Object.entries(festival)) {
    if (on && ACT_CATEGORY_OF.has(name)) out.push(name);
  }
  // 饭点:早 6-9 / 午 11-13 / 晚 17-19,饭点前后那件"吃"才有意义
  if (h >= 6 && h <= 9) out.push('吃早餐');
  if (h >= 11 && h <= 13) out.push('吃午餐');
  if (h >= 17 && h <= 19) out.push('吃晚餐');
  // 零嘴不看时间,但也没必要全天候,只在清醒时段给
  if (h >= 9 && h <= 22) out.push('吃冰淇淋融化', '吃糖葫芦', '吃西瓜', '涮火锅', '吃大闸蟹');
  return out.filter((n) => ACT_CATEGORY_OF.has(n));
}

// 池子里写错一个字 → 素材不存在 → 视频静默黑屏且无从排查,所以开发态直接喊出来。
for (const [ctx, pool] of Object.entries(CONTEXT_ACTS)) {
  for (const name of pool) {
    if (!ACT_CATEGORY_OF.has(name)) dbg('场景池引用了不存在的动作', ctx, name);
  }
}


// 按分类权重抽一个分类(weight 加权,类内等概率由 pickAct 处理)
function pickCategory(exclude) {
  const cats = exclude ? ACT_CATEGORIES.filter((c) => !c.actions.includes(exclude)) : ACT_CATEGORIES;
  if (!cats.length) return null;
  const total = cats.reduce((s, c) => s + c.weight, 0);
  let roll = Math.random() * total;
  for (const c of cats) {
    roll -= c.weight;
    if (roll < 0) return c;
  }
  return cats[cats.length - 1];
}

// 随机动作:按前台上下文提高特定动作概率
function pickAct() {
  // 时间/节令动作有独立的一档概率:跟你在用什么软件无关,但一天里的确该轮到。
  // 15% 看着不起眼,按每 5 秒一件动作算大约 40 秒来一次,存在感刚好。
  if (Math.random() < 0.15) {
    const period = periodPool();
    if (period.length) return pick(period, anim);
  }
  const pref = CONTEXT_ACTS[contextCategory];
  if (pref && pref.length && Math.random() < 0.6) return pick(pref, anim);
  // 上游语义:先按 weight 选分类,再在该分类内等概率选动作
  const cat = pickCategory(anim);
  if (!cat) return pick(ACTS, anim);
  return pick(cat.actions, anim);
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
const shadowEl = document.getElementById('shadow');
let bubbleTimer = null;
// 气泡冷却(借鉴 zealot00/dsh-pet 的提醒互斥):10s 内不连发,防通知轰炸;
// 重要气泡(欢迎/喝水/久坐/饭点/夜间)传 force=true 绕过冷却,不被台词气泡抢占
const BUBBLE_COOLDOWN_MS = 10000;
let lastBubbleAt = 0;
function showBubble(text, ms, force) {
  if (!text || !bubbleEl) return;
  const now = Date.now();
  if (!force && now - lastBubbleAt < BUBBLE_COOLDOWN_MS) return; // 冷却期内跳过
  lastBubbleAt = now;
  bubbleEl.textContent = text;
  bubbleEl.classList.add('show');
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubbleEl.classList.remove('show'), ms || 3500);
}

// ---------- 入睡机制(借鉴 zealot00/dsh-pet):交互闲置一段时间自动入睡,点击/拖拽/状态变化唤醒 ----------
const SLEEP_AFTER_MS = 60 * 1000; // 闲置 60s 入睡
const SLEEP_CHECK_MS = 5000;      // 每 5s 检查一次
const SLEEP_ANIM = '原地小憩沉眠';
let sleeping = false;
let lastInteractAt = Date.now();

function noteInteraction() {
  lastInteractAt = Date.now();
  wakeUp();
}

function goSleep() {
  if (sleeping) return;
  if (drag.active) return;                 // 拖拽中不睡
  if (contextCategory === 'deepseek') return; // 焦点在 DeepSeek(工作)不睡
  sleeping = true;
  stopMove();
  setAnimLoop(SLEEP_ANIM); // 循环睡眠动画,直到被交互唤醒
  dbg('sleep zzz');
}

function wakeUp() {
  if (!sleeping) return;
  sleeping = false;
  if (clickBusyTimer) { clearTimeout(clickBusyTimer); clickBusyTimer = null; }
  clickBusy = false;
  setAnim(IDLE);
  applyPerception(); // 唤醒后恢复状态感知
  dbg('wake up');
}

setInterval(() => {
  if (!sleeping && Date.now() - lastInteractAt > SLEEP_AFTER_MS) goSleep();
}, SLEEP_CHECK_MS);

const GREETINGS = ['你好呀~', '我在这儿哦~', '今天也要加油鸭!', '来啦来啦~'];
const DRINK_MSGS = ['该喝水啦~', '喝口水休息一下吧~', '水水时间到~'];
const MOVE_MSGS = ['起来活动一下吧~', '久坐啦,伸个懒腰~', '走动走动吧~'];
const MEAL_MSGS = ['快到饭点啦,准备吃饭~', '马上要吃饭咯~'];
const NIGHT_MSGS = ['夜深了,早点休息哦~', '都这么晚啦,该睡啦~'];
const QUIPS = ['发呆中…', '好无聊呀~', '偷偷看你~', '今天天气不错呢~'];

const MIN = 60 * 1000;

// 启动问好(force:不被台词气泡冷却抢占)
setTimeout(() => showBubble(pick(GREETINGS), 0, true), 2500);

// 喝水提醒:每 45 分钟(force)
setInterval(() => showBubble(pick(DRINK_MSGS), 0, true), 45 * MIN);

// 久坐活动提醒:每 30 分钟(force)
setInterval(() => showBubble(pick(MOVE_MSGS), 0, true), 30 * MIN);

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
      showBubble(pick(MEAL_MSGS), 0, true);
      break;
    }
  }
  if (!nightReminded && now.getHours() >= NIGHT_HOUR) {
    nightReminded = true;
    showBubble(pick(NIGHT_MSGS), 0, true);
  }
}, MIN); // 每分钟检查一次时间窗口

// 偶尔随机小感叹(每 6 分钟 30% 概率,受冷却节制)
setInterval(() => {
  if (Math.random() < 0.3) showBubble(pick(QUIPS));
}, 6 * MIN);

// ---------- 状态感知(前台上下文驱动;焦点在 DeepSeek 时触发工作动画) ----------
// 前台上下文由"前台感知开关"驱动:焦点在 DeepSeek=deepseek(吐泡泡循环,醒目),
// 其余按程序类型播对应小动作,other 保持待机链
let contextCategory = 'other';
// 前台上下文 → 切换场景时先播一下的"姿态"动作(一次性),之后交回动作链,
// 由 CONTEXT_ACTS 按场景抽动作。deepseek 也走这里 —— 以前它是唯一一个常驻循环态,
// 结果只要焦点在 DeepSeek 上,她就一直吐泡泡,同一个小动作无限重复。
// other 留空:不打断当前动画链。
const CONTEXT_ANIM = {
  browser: '东张西望',           // 浏览器:东张西望(浏览)
  explorer: '东张西望',          // 文件管理器:东张西望(翻找)
  ide: '原地漂浮踏步',           // 编辑器:稳稳步子(写代码)
  office: '原地漂浮踏步',        // 办公:稳稳步子(干活)
  design: '原地漂浮踏步',        // 设计:稳稳步子(创作)
  terminal: '螃蟹走路',          // 终端:横步忙碌(跑命令)
  chat: '点击回应-害羞惊讶',     // 聊天:害羞(消息来了)
  meeting: '点击回应-害羞惊讶',  // 视频会议:害羞(被看着)
  media: '待机呼吸休闲',         // 影音:一起放松
  game: '点击回应-开心跃动',     // 游戏:开心跃动(玩得开心)
  deepseek: '深度思考碎碎念',    // 陪着写:先碎碎念一下,后面按场景抽动作
  other: '',
};

// 焦点停在同一个软件里时,每隔这么久重新判定一次场景并换下个动作。
// 没有这个重新判定,她会一直把当前这一件动作循环到用户切走窗口为止 ——
// 上下文变化只在"切到别的软件"时触发,停在原地不动时是没有任何事件的。
const CONTEXT_RECHECK_MS = 45 * 1000;
let contextRecheckTimer = null;
function scheduleContextRecheck() {
  if (contextRecheckTimer) clearTimeout(contextRecheckTimer);
  contextRecheckTimer = setTimeout(() => {
    contextRecheckTimer = null;
    if (sleeping || drag.active) return; // 睡着的别自己醒,拖拽中别打断
    // 用户手动点播的动作让他播完,不抢
    if (!CLICKS.includes(anim) && !MOVES.includes(anim) && anim !== DRAG && anim !== IDLE) {
      pickContextAct();
    }
    scheduleContextRecheck();
  }, CONTEXT_RECHECK_MS);
}

// 当前场景是否有专属动作池(决定是走场景链还是全局权重链)
function hasContextPool() {
  const pool = CONTEXT_ACTS[contextCategory];
  return !!(pool && pool.length);
}

// 按当前场景抽一个动作(感知专用的入口,不走"播完自然回链"的权重)
function pickContextAct() {
  const next = pickAct();
  if (next) setAnim(next);
}

api.on('pet-context', (c) => {
  if (!c || typeof c.category !== 'string') return;
  contextCategory = c.category;
  dbg('pet-context', contextCategory);
  applyPerception();
});

// ---------- 手动播放动作(右键菜单「播放动作 → 分类 → 动作」) ----------
// 动作名来自主进程下发的菜单模型,与素材文件名一一对应(assetSrc 会做 encodeURIComponent)。
// 不认识的中间态(睡眠中的"原地小憩沉眠")也允许播,用户明确点了就该响应。
function playAction(name) {
  if (!name) return;
  if (!ACT_CATEGORY_OF.has(name)) {
    // 不是随机池里的动作:可能是点击回应等专属动画,ui/pet.js 里没有分布但素材存在。
    // 这里直接放行(setAnim 只按名字找素材),只记一条日志方便排查
    dbg('play-action(非池内)', name);
  }
  noteInteraction(); // 手动播放算一次交互:刷新入睡计时,睡眠中被点选会先醒
  stopMove();
  clickBusy = false;
  if (clickBusyTimer) {
    clearTimeout(clickBusyTimer);
    clickBusyTimer = null;
  }
  if (name === SLEEP_ANIM) {
    goSleep(); // 睡眠是循环态,走专门的入口(一次性播放会 3 秒就自己醒)
    return;
  }
  setAnim(name);
  dbg('play-action', name);
}

api.on('pet-play', (p) => {
  if (!p || typeof p.name !== 'string') return;
  playAction(p.name);
});

// 主进程查询用:把动作目录回给主进程(菜单模型据此生成分类与列表)。
// 放在 window 上而不是 API 里,是因为 preload 的 invoke 由主进程发起 executeJavaScript 读取。
window.__dsPetCatalog = () => ACT_CATEGORIES.map((c) => ({ id: c.id, actions: c.actions.slice() }));

// 状态感知落地:拖拽/点击中不打断;睡眠中不响应(感知不唤醒睡眠,仅交互唤醒);
// 焦点在 DeepSeek 用循环"忙碌"动画,其余用一次性上下文动画
function applyPerception() {
  if (sleeping) return; // 睡眠中:焦点/上下文变化不接管(不唤醒、不覆盖睡眠动画)
  if (drag.active) return; // 拖拽/点击中不打断
  stopMove(); // 打断自动移动
  dbg('perception ->', contextCategory, 'anim=', anim, 'once=', once);
  // 焦点离开 DeepSeek:退出旧的感知循环动画(老版本 deepseek 用的是循环态),
  // 否则鲸鱼娘会永远卡在循环动画里(之前"没看见变化"的根因之一)。
  // 之后继续应用上下文动画(若 setAnim 连续调用,后续切换会顶掉前面的)
  if (!once) setAnim(IDLE);
  // 正在播一次性点击动画时不打断(让脉冲播完自然回链)
  if (once && CLICKS.includes(anim)) return;
  const ctxAnim = CONTEXT_ANIM[contextCategory] || '';
  if (ctxAnim) {
    setAnim(ctxAnim);
  } else if (CONTEXT_ACTS[contextCategory] && Math.random() < 0.5) {
    // 没有固定姿态的场景(目前只有 other 之外的空项):一半概率直接抽个场景动作,
    // 一半概率不打断当前动画链 —— 切窗口太频繁时全部抢播会显得很急躁
    pickContextAct();
  }
  // 停在同一个软件里不会有新的上下文事件,靠定时器隔一阵换下个动作
  if (CONTEXT_ACTS[contextCategory]) scheduleContextRecheck();
  else if (contextRecheckTimer) { clearTimeout(contextRecheckTimer); contextRecheckTimer = null; }}

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
  const pendingName = next; // 本帧动画名(pending 会在 onReady 里清空,镜像判定需独立保留)

  const onReady = () => {
    el.removeEventListener('loadeddata', onReady);
    if (pending && pending.gen !== g) return; // 过期:期间又有更新的切换
    const old = front === 0 ? vA : vB;
    el.classList.add('is-front');
    if (old && old !== el) old.classList.remove('is-front');
    front = front === 0 ? 1 : 0;
    pending = null;
    // facing 镜像:新视频按当前朝向设置,旧视频保持自己的 transform 淡出
    // noMirror 分类(如"文字"类,含可读文案)不做镜像,否则画面里文字会左右反转
    const cat = ACT_CATEGORY_OF.get(pendingName || anim);
    el.style.transform = facing === 'right' && !(cat && cat.noMirror) ? 'scaleX(-1)' : '';
    el.play().catch(() => {});
  };
  el.addEventListener('loadeddata', onReady);
  if (el.readyState >= 2) onReady();
}

// ---------- 动画链:播完按权重选下一个 ----------
// 权重对齐上游 config.jsonc 的 animationWeights:idle 10 / turn 5 / move 5,
// 剩余 80 全给随机动作分类池(其内部再按分类 weight 加权)。
const W_IDLE = 10;
const W_TURN = 5;
const W_ACT = CATEGORY_WEIGHT_SUM; // 80
const W_MOVE = 5;
const W_SUM = W_IDLE + W_TURN + W_ACT + W_MOVE; // 100

function pickNext() {
  let roll = Math.random() * W_SUM;
  let next = '';
  if ((roll -= W_IDLE) < 0) next = IDLE;
  else if ((roll -= W_TURN) < 0) next = TURN;
  else if ((roll -= W_ACT) < 0) next = pickAct();
  else next = pick(MOVES);
  setAnim(next);
}

function handleEnded() {
  if (drag.active) return; // 拖拽中不打断
  // 睡眠中:旧动画(交叉淡入前的)ended 会迟到触发,必须忽略,否则动画链会覆盖睡眠
  if (sleeping) return;
  if (anim === TURN) {
    facing = facing === 'left' ? 'right' : 'left'; // 转向播完翻转朝向
  }
  // 点击回应/拖拽动画(用户打断触发)播完 → 先回待机缓冲
  if (anim === DRAG || CLICKS.includes(anim)) {
    clickBusy = false; // 点击回应播完,允许下一次单击响应
    if (clickBusyTimer) { clearTimeout(clickBusyTimer); clickBusyTimer = null; }
    setAnim(IDLE);
    applyPerception(); // 交互动画播完恢复状态感知(按当前场景重新抽动作)
    return;
  }
  // 上下文动作播完:人在哪个软件前面,就接着在那个场景的动作池里抽 ——
  // 不再掉回全局"待机 10/转向 5/动作池 80/移动 5"的无差别权重,
  // 否则场景感知只能在切窗口那一下生效一次,播完就散了。
  if (hasContextPool()) {
    pickContextAct();
    return;
  }
  pickNext(); // 自主链:按概率选下一个
}

function setAnim(next) {
  anim = next;
  once = true;
  switchTo(anim, once); // 无 React 依赖:每次调用直接触发切换(含同名重播,由 pending 检查去重)
  showAnimBubble(next); // 动作台词气泡(没配置的就不弹)
}

// 循环播放变体(状态感知的持续态用:生成中保持工作姿态,状态变化时被一次性动画打断)
function setAnimLoop(next) {
  anim = next;
  once = false;
  switchTo(anim, false);
  showAnimBubble(next);
}

// ---------- 动作台词气泡(给每个动作配对话框,没必要的省略) ----------
// 待机/转向太频繁不配(避免刷屏);拖拽/点击回应/动作池/移动有台词
const ANIM_BUBBLES = {
  // 点击回应
  '点击回应-开心跃动': ['耶!', '嘿嘿~'],
  '点击回应-害羞惊讶': ['呀!', '吓我一跳!'],
  '点击回应-傲娇生气': ['哼!', '才不理你!'],
  '点击回应-挠痒咯咯笑': ['咯咯咯…痒!', '别挠我啦~'],
  '点击回应-元气挥手': ['嗨嗨~我在这里!', '挥挥手!'],
  '被吓一跳': ['哇!!', '吓死了!'],
  '原地跳跃抓碎头顶物品': ['嘿!哈!'],
  '吹气球': ['呼——', '吹个大气球~'],
  '玩水枪': ['呲你一下!', 'biu~'],
  '小幅度原地360度旋转展示': ['转个圈看看~', '好看吗?'],
  '女仆屈膝礼仪': ['欢迎光临~', '请多关照~'],
  '打瞌睡被惊醒': ['唔!?我没睡着!', '啊!?怎么了!'],
  '偷吃零食被抓住': ['被抓到啦!', '呃…我什么都没吃!'],
  // 动作池
  '被落叶淹没': ['被叶子埋住啦!'],
  '超大伸懒腰': ['啊~伸个懒腰~'],
  '吃白饭': ['干饭干饭!', '米饭真香~'],
  '吃冰淇淋融化': ['冰淇淋要化啦!', '赶紧舔一口~'],
  '吃晚餐': ['晚餐时间~'],
  '吃午餐': ['午饭开动!'],
  '吃早餐': ['早餐要吃好~'],
  '吃Token': ['嗯,这 Token 好吃!', '再来一口~'],
  '哈欠连天': ['哈啊——好困…', '困困的…'],
  '鲸鱼吐泡泡特效': ['咕噜咕噜~'],
  '可爱宅舞': ['蹦蹦跳跳~'],
  '蓝鲸现世': ['蓝鲸登场!', '看我的真身!'],
  '轻快记录': ['记一笔~', '写写画画~'],
  '轻快摇摆舞': ['摇摇晃晃~'],
  '深度思考碎碎念': ['嗯…让我想想…', '唔…这样那样…'],
  '玩游戏气急败坏': ['可恶,又输了!', '再来一局!'],
  '小提琴演奏': ['拉一首小曲~'],
  '写代码': ['写写代码~', '这个 bug 在哪…'],
  '摇扇纳凉': ['扇扇风,凉快~'],
  '用鲸鱼尾巴拍打地面': ['不耐烦啦!', '咚咚咚!'],
  '优雅女仆舞': ['优雅~'],
  '悠闲哼歌': ['啦啦啦~', '哼着小曲~'],
  '原地蹲下玩玩具汽车': ['小车车跑起来~'],
  '原地敲击桌面互动': ['咚咚咚~', '有人吗?'],
  '原地小憩沉眠': ['zzz…', '呼…呼…'],
  '原地专心玩魔方': ['转魔方~', '就差一步…'],
  '照镜子': ['照照镜子,今天也很可爱~', '嗯,不错~'],
  '整体换装试色': ['换套衣服看看~', '哪件好看呢?'],
  '中秋赏月吃月饼': ['赏月吃月饼~'],
  '放风筝': ['风筝飞高高~'],
  '堆雪人': ['堆个雪人~'],
  // 移动(原地奔跑)
  '螃蟹走路': ['横着走~', '蟹蟹步~'],
  '原地漂浮踏步': ['小碎步~', '原地热身~'],
  '原地左转奔跑': ['冲鸭!', '跑起来!'],
  // 拖拽
  '被鼠标拖拽悬空反馈': ['喂喂,别拽我!', '放我下来!'],
};

function showAnimBubble(name) {
  const msgs = ANIM_BUBBLES[name];
  if (msgs && msgs.length) showBubble(pick(msgs));
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
  noteInteraction(); // 交互=唤醒+刷新闲置计时
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
// 双击:打开/关闭主窗口(240ms 内二次 click 判定为双击)
const CLICK_FREEZE_MS = 3000; // 点击回应开始后的冻结时长(只冻结前 3s,避免动画全程锁死)
let clickBusy = false;        // 冻结期内:单击不重复播放
let clickBusyTimer = null;    // 冻结计时
function onClick(e) {
  evtLog('click', e);
  if (justDragged) return;
  noteInteraction(); // 点击=唤醒+刷新闲置计时
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    api.action('toggle-main'); // 双击:打开/关闭主窗口
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
