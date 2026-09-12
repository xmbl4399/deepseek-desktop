// 本地 UI 页面(悬浮球/鲸鱼娘/菜单/主窗壳)的 preload:只暴露最小动作通道
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ds', {
  // 向主进程发送动作:show-main / toggle-main / ball-move / quit ...
  action: (name, payload) => ipcRenderer.send('ui:action', name, payload),
  // 自绘菜单折叠组展开/收起后内容尺寸变化 → 请主进程按新尺寸重设窗口(不走 action,否则会被当成菜单点击而关窗)
  resize: (w, h) => ipcRenderer.send('ui:resize', w, h),
  // 调试日志:转发到主进程写入 ds-debug.log
  log: (...args) => ipcRenderer.send('ui:log', ...args),
  // 订阅主进程广播(前台上下文 / 标签快捷键等)
  on: (channel, cb) => {
    ipcRenderer.on(channel, (_e, ...args) => cb(...args));
  },
});
