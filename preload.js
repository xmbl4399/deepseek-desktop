// 对话浮框(加载 chat.deepseek.com)的 preload:只暴露最小动作通道
// 注:主窗口已不再加载本文件(远程页面无需任何本地 API)
const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // 对话浮框:隐藏(由浮框顶部 ✕ 调用)
  hidePopup: () => {
    ipcRenderer.send('ui:action', 'popup-hide');
  },
});
