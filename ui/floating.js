// 悬浮球:JS 拖拽(目标坐标发主进程 setPosition 驱动,与鲸鱼娘一致——
// 渲染进程 window.moveTo 被 Chromium 钳制,无法悬出屏幕贴边;主进程 setPosition 可)
// 手势:拖拽移动 / 双击开关主窗(单击不响应) / 右键菜单
const api = window.ds;
const ball = document.querySelector('#ball');

let clickTimer = null;
let moved = false;
let dragging = false;
let dragSX = 0, dragSY = 0, dragBX = 0, dragBY = 0;

// 窗口位置本地追踪:主进程 setPosition 驱动,window.screenX 不随主进程移动更新
let ballX = 0, ballY = 0;
api.on('ball-pos', (pos) => {
  if (pos && typeof pos.x === 'number' && (pos.x !== ballX || pos.y !== ballY)) {
    ballX = pos.x;
    ballY = pos.y;
    dbg('ball-pos set', [ballX, ballY]);
  }
});

function dbg(...args) {
  try { api.log(...args); } catch (e) {}
}

dbg('ball init', { innerW: window.innerWidth, innerH: window.innerHeight, screenX: window.screenX, screenY: window.screenY });

// ---------- 拖拽:渲染进程算目标坐标 → 主进程 setPosition + 钳制(半身悬出贴边) ----------
// 用 pointer 事件 + setPointerCapture(与鲸鱼娘一致):mouse 事件 + movementX 过滤在
// 窗口跟随光标移动时 movementX≈0,真实拖动会被误判为幽灵事件 → 拖不动
ball.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  moved = false;
  dragSX = e.screenX;
  dragSY = e.screenY;
  dragBX = ballX;
  dragBY = ballY;
  ball.setPointerCapture(e.pointerId);
});

ball.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.screenX - dragSX;
  const dy = e.screenY - dragSY;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;
  ballX = Math.round(dragBX + dx);
  ballY = Math.round(dragBY + dy);
  api.action('ball-move', { x: ballX, y: ballY });
});

window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointercancel', () => { dragging = false; });

// 注:这里原先还有一个"焦点在 DeepSeek 时右上角蓝点呼吸"的状态徽标,已移除。
// 原因:球只有 48-67px,右上角 10px 的小点在 1.25x 缩放下几乎看不出呼吸,
// 却会在球体边缘形成一个常驻的视觉噪点;而且它只表达"焦点在这款应用里",
// 用户看一眼主窗口就知道,信息增益低于干扰成本。
// pet-context 订阅一并删掉 —— 球不再需要任何状态反馈。

// ---------- 球体事件 ----------
// 交互与鲸鱼娘对齐:240ms 内的第二次点击 = 双击 → 开关主窗口;
// 单击**不响应**(避免误触把主窗弹出来/收起来,球常贴在正文边缘,单击太容易碰到)
ball.addEventListener('click', () => {
  dbg('click', { moved });
  if (moved) { moved = false; return; } // 拖拽后的幽灵 click
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    api.action('toggle-main'); // 双击:打开/关闭主窗口
    return;
  }
  clickTimer = setTimeout(() => { clickTimer = null; }, 240); // 单击:只等第二击,不做任何事
});

// 右键 → 自绘菜单
ball.addEventListener('contextmenu', (e) => {
  dbg('contextmenu', { sx: e.screenX, sy: e.screenY });
  e.preventDefault();
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
  api.action('ball-menu', { wx: ballX, wy: ballY, mx: e.screenX, my: e.screenY });
});
