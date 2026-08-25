// webview(chat.deepseek.com)专用 preload:只暴露"外部链接交给主进程"一个通道
// 点击捕获器由主进程在 dom-ready 后注入主世界(隔离世界无法直接挂页面监听)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsWebview', {
  // 站外链接 → 主进程 security.openExternalSafe(默认浏览器打开)
  openExternal: (url) => ipcRenderer.send('webview:open-external', url),
});
