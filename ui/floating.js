// 悬浮球:JS 拖拽(window.moveTo 渲染进程直控,不经过主进程 setPosition,避免膨胀)
// 单击弹浮框 / 双击主窗 / 右键菜单
const api = window.ds;
const ball = document.querySelector('#ball');

let clickTimer = null;
let moved = false;
let dragging = false;
let dragSX = 0, dragSY = 0, dragWX = 0, dragWY = 0;

function dbg(...args) {
  try { api.log(...args); } catch (e) {}
}

dbg('ball init', { innerW: window.innerWidth, innerH: window.innerHeight, screenX: window.screenX, screenY: window.screenY });

// ---------- 拖拽:渲染进程 window.moveTo + resizeTo,不触发主进程膨胀 ----------
ball.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  moved = false;
  dragSX = e.screenX;
  dragSY = e.screenY;
  dragWX = window.screenX;
  dragWY = window.screenY;
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  // 过滤幽灵事件:窗口移动触发的假 mousemove, movement 为 0
  if (e.movementX === 0 && e.movementY === 0) return;
  const dx = e.screenX - dragSX;
  const dy = e.screenY - dragSY;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;
  window.moveTo(dragWX + dx, dragWY + dy);
  window.resizeTo(46, 46);
});

window.addEventListener('mouseup', () => {
  if (dragging) {
    dragging = false;
    if (moved) {
      // 只有真正移动了才通知主进程做钳制,无移动不浪费 IPC
      api.action('drag-end', { x: window.screenX, y: window.screenY });
    }
  }
});

// ---------- 球体事件 ----------
// 单击 → 打开/关闭对话浮框(toggle)
ball.addEventListener('click', (e) => {
  dbg('click', { moved });
  if (moved) { moved = false; return; }
  if (clickTimer) clearTimeout(clickTimer);
  clickTimer = setTimeout(() => api.action('popup'), 240);
});

// 双击 → 切换主窗
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
  api.action('ball-menu', { wx: window.screenX, wy: window.screenY, mx: e.screenX, my: e.screenY });
});
