// 悬浮球逻辑:
//   球体(#ball):单击/双击/右键(JS 事件)
//   托盘(#tray-handle):拖拽(系统原生 -webkit-app-region:drag,不膨胀)
//   右键菜单由主进程 webContents.on('context-menu') 拦截
const api = window.ds;
const ball = document.querySelector('#ball');
const tray = document.querySelector('#tray-handle');

let clickTimer = null;
let moved = false;

function dbg(...args) {
  try { api.log(...args); } catch (e) {}
}

dbg('ball init', { innerW: window.innerWidth, innerH: window.innerHeight, screenX: window.screenX, screenY: window.screenY });

// 托盘拖拽:系统原生处理(-webkit-app-region:drag),不膨胀
// 监听窗口位置变化判断是否拖拽了
let lastWinX = window.screenX;
let lastWinY = window.screenY;
setInterval(() => {
  if (window.screenX !== lastWinX || window.screenY !== lastWinY) {
    moved = true;
    lastWinX = window.screenX;
    lastWinY = window.screenY;
  }
}, 100);

// ---------- 球体事件 ----------

// 单击 → 打开/关闭对话浮框(toggle)
ball.addEventListener('click', (e) => {
  if (moved) { moved = false; return; }
  if (clickTimer) clearTimeout(clickTimer);
  clickTimer = setTimeout(() => api.action('popup'), 240);
});

// 双击 → 切换主窗
ball.addEventListener('dblclick', () => {
  if (clickTimer) clearTimeout(clickTimer);
  clickTimer = null;
  api.action('toggle-main');
});

// 右键 → 自绘菜单(fallback,主进程 context-menu 也会拦截)
ball.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (clickTimer) clearTimeout(clickTimer);
  api.action('ball-menu', { wx: window.screenX, wy: window.screenY, mx: e.screenX, my: e.screenY });
});
