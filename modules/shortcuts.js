// 窗口内快捷键:基于 before-input-event 实现,不注册系统级全局键(避免抢键/冲突,且历史教训:全局快捷键易误触)
// 主窗:Ctrl+R/F5 刷新 · Ctrl+W 隐藏到托盘 · Ctrl+Alt+P 切换浮窗 · Ctrl+Alt+S 截图提问
// 浮窗:Esc 关闭 · Ctrl+W 关闭 · Ctrl+R 刷新
function create({ log, state, actions }) {
  function register(win) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const ctrl = input.control || input.meta;
      const alt = input.alt;
      const key = (input.key || '').toLowerCase();

      // 浮窗专用:Esc 关闭(浮窗顶部也有 ✕)
      if (win === state.popupWindow && !ctrl && !alt && input.key === 'Escape') {
        event.preventDefault();
        actions.hidePopup();
        return;
      }

      // F5 刷新(无修饰键,需在 ctrl 判断前处理)
      if (!ctrl && !alt && input.key === 'F5') {
        event.preventDefault();
        win.webContents.reload();
        log('[shortcut] reload', win === state.popupWindow ? 'popup' : 'main');
        return;
      }

      if (!ctrl) return;

      switch (key) {
        case 'r': // Ctrl+R 刷新(主窗/浮窗)
          event.preventDefault();
          win.webContents.reload();
          log('[shortcut] reload', win === state.popupWindow ? 'popup' : 'main');
          break;
        case 'w': // Ctrl+W:主窗隐藏到托盘,浮窗关闭
          event.preventDefault();
          if (win === state.popupWindow) actions.hidePopup();
          else actions.hideMain();
          log('[shortcut] close/hide', win === state.popupWindow ? 'popup' : 'main');
          break;
        case 'p': // Ctrl+Alt+P 切换浮窗
          if (alt) {
            event.preventDefault();
            actions.togglePopup();
          }
          break;
        case 's': // Ctrl+Alt+S 截图提问
          if (alt) {
            event.preventDefault();
            actions.startScreenshot();
          }
          break;
        default:
          break;
      }
    });
  }

  return { register };
}

module.exports = { create };
