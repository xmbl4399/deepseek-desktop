// 悬浮球:JS 拖拽(目标坐标发主进程 setPosition 驱动,与鲸鱼娘一致——
// 渲染进程 window.moveTo 被 Chromium 钳制,无法悬出屏幕贴边;主进程 setPosition 可)
// 单击弹浮框 / 双击主窗 / 右键菜单
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

// ---------- 状态徽标(前台上下文:焦点在 DeepSeek = 蓝点呼吸,其余无徽标) ----------
const badge = document.getElementById('badge');
api.on('pet-context', (c) => {
  const category = c && typeof c.category === 'string' ? c.category : '';
  badge.className = '';
  if (category === 'deepseek') badge.classList.add('busy');
  // 其他类别/other → 无徽标
});

// ---------- 球体事件 ----------
// 单击 → 打开主窗口(切换显示/隐藏);双击 → 同样开关主窗口
ball.addEventListener('click', (e) => {
  dbg('click', { moved });
  if (moved) { moved = false; return; }
  if (clickTimer) clearTimeout(clickTimer);
  clickTimer = setTimeout(() => api.action('toggle-main'), 240);
});

// 双击 → 打开/关闭主窗口
ball.addEventListener('dblclick', () => {
  dbg('dblclick');
  if (clickTimer) clearTimeout(clickTimer);
  clickTimer = null;
  api.action('toggle-main');
});

// 右键 → 自绘菜单
ball.addEventListener('contextmenu', (e) => {
  dbg('contextmenu', { sx: e.screenX, sy: e.screenY });
  e.preventDefault();
  if (clickTimer) clearTimeout(clickTimer);
  api.action('ball-menu', { wx: ballX, wy: ballY, mx: e.screenX, my: e.screenY });
});
