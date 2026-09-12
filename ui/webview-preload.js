// webview(chat.deepseek.com)专用 preload:只暴露"外部链接交给主进程"一个通道
// 点击捕获器由主进程在 dom-ready 后注入主世界(隔离世界无法直接挂页面监听)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsWebview', {
  // 站外链接 → 主进程 security.openExternalSafe(默认浏览器打开)
  openExternal: (url) => ipcRenderer.send('webview:open-external', url),
});

// 手势开始前的选区快照:用于区分"这次长按/右键之前是否已有选中文字"。
// 触摸长按会先由 Chromium 原生手势选中词、再合成 context-menu,所以必须在手势起点(pointerdown)
// 记录快照,才能在 context-menu 阶段判断出"选区是这次手势刚创建的"→ 首次长按只选中、不弹菜单。
function snapshotSelection() {
  try {
    const sel = window.getSelection ? window.getSelection() : null;
    ipcRenderer.send('webview:selection-snapshot', sel ? String(sel.toString()) : '');
  } catch (e) { /* 忽略:快照失败时主进程会退回"直接弹菜单"的旧行为 */ }
}

// pointerdown 覆盖触摸/鼠标/触控笔;touchstart/mousedown 作为兜底(某些环境不派发 pointer 事件)
window.addEventListener('pointerdown', snapshotSelection, true);
window.addEventListener('touchstart', snapshotSelection, true);
window.addEventListener('mousedown', snapshotSelection, true);
