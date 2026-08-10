// 悬浮球/浮框等本地 UI 页面的 preload:只暴露最小动作通道
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ds', {
  // 向主进程发送动作:show-main / popup / screenshot / quit / popup-hide ...
  action: (name, payload) => ipcRenderer.send('ui:action', name, payload),
  // 调试日志:转发到主进程写入 ds-debug.log
  log: (...args) => ipcRenderer.send('ui:log', ...args),
  // 订阅主进程广播(如浮框显示/隐藏状态)
  on: (channel, cb) => {
    ipcRenderer.on(channel, (_e, ...args) => cb(...args));
  },
});
