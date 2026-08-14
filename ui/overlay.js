// 选区截图遮罩:请求全屏图 → 拖拽框选 → 裁剪发送给主进程
const api = window.ds;

const img = document.getElementById('shot-img');
const sel = document.getElementById('sel');
const maskT = document.getElementById('mask-t');
const maskL = document.getElementById('mask-l');
const maskR = document.getElementById('mask-r');
const maskB = document.getElementById('mask-b');
const tip = document.getElementById('tip');
const toolbar = document.getElementById('toolbar');
const sizeInfo = document.getElementById('size-info');

let fullImage = null; // 完整截图 dataURL(画布裁剪用)
let drag = null; // { sx, sy, x, y, w, h }
let selecting = false;

// ---------- 请求全屏截图(主进程在收到 overlay:ready 后回传) ----------
api.action('overlay:ready');
api.on('overlay:image', (dataUrl) => {
  fullImage = dataUrl;
  img.src = dataUrl;
});

// ---------- 选区拖拽 ----------
function toSelPos(e) {
  const r = img.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  // 工具栏/按钮上的点击不启动选区,否则会覆盖已有选区导致无法发送
  if (e.target.closest && e.target.closest('#toolbar')) return;
  e.preventDefault(); // 阻止截图 img 的原生拖拽(配合 draggable=false)
  selecting = true;
  const p = toSelPos(e);
  drag = { sx: p.x, sy: p.y, x: p.x, y: p.y, w: 0, h: 0 };
  sel.classList.remove('hidden');
  updateSel();
});

document.addEventListener('mousemove', (e) => {
  if (!selecting || !drag) return;
  const p = toSelPos(e);
  drag.x = Math.min(drag.sx, p.x);
  drag.y = Math.min(drag.sy, p.y);
  drag.w = Math.abs(p.x - drag.sx);
  drag.h = Math.abs(p.y - drag.sy);
  updateSel();
});

document.addEventListener('mouseup', () => {
  if (!selecting) return;
  selecting = false;
  if (drag && drag.w >= 4 && drag.h >= 4) {
    showToolbar();
  } else {
    // 点击未拖出选区 → 清空
    drag = null;
    sel.classList.add('hidden');
    hideToolbar();
  }
});

function updateSel() {
  if (!drag) return;
  const { x, y, w, h } = drag;
  sel.style.left = x + 'px';
  sel.style.top = y + 'px';
  sel.style.width = w + 'px';
  sel.style.height = h + 'px';
  // 四块遮罩
  const W = window.innerWidth;
  const H = window.innerHeight;
  maskT.style.cssText = `left:0;top:0;width:100%;height:${y}px;display:block;`;
  maskL.style.cssText = `left:0;top:${y}px;width:${x}px;height:${h}px;display:block;`;
  maskR.style.cssText = `left:${x + w}px;top:${y}px;width:${W - x - w}px;height:${h}px;display:block;`;
  maskB.style.cssText = `left:0;top:${y + h}px;width:100%;height:${H - y - h}px;display:block;`;
  sizeInfo.textContent = `${Math.round(w)} × ${Math.round(h)}`;
}

// ---------- 工具栏 ----------
function showToolbar() {
  toolbar.classList.remove('hidden');
  tip.classList.add('hidden');
}

function hideToolbar() {
  toolbar.classList.add('hidden');
  tip.classList.remove('hidden');
}

// ---------- 确认 / 取消 ----------
function doCrop() {
  if (!drag || !fullImage) return;
  // 截图按物理像素抓取,显示时被 CSS 缩放到窗口尺寸:裁剪必须按原图像素换算,否则选区与实际裁剪错位
  const k = img.naturalWidth / img.getBoundingClientRect().width;
  const w = Math.round(drag.w * k);
  const h = Math.round(drag.h * k);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, drag.x * k, drag.y * k, drag.w * k, drag.h * k, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/png');
  api.action('crop', { dataUrl, width: w, height: h });
}

function doCancel() {
  api.action('cancel');
}

document.getElementById('btn-ok').addEventListener('click', doCrop);
document.getElementById('btn-cancel').addEventListener('click', doCancel);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doCrop();
  if (e.key === 'Escape') doCancel();
});
