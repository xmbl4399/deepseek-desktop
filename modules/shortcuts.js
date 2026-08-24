// 窗口内快捷键:基于 before-input-event 实现,不注册系统级全局键(避免抢键/冲突,且历史教训:全局快捷键易误触)
// 主窗(壳 + 各标签页 webview):Ctrl+R 刷新当前标签 · Ctrl+W 隐藏到托盘 · Ctrl+T 新标签 · Ctrl+Tab/Ctrl+Shift+Tab 切换标签
// 多标签快捷键通过 tabs:action 事件转发给壳渲染层执行(标签管理在 ui/main.js 渲染层)
function create({ log, state, actions }) {
  // register(wcOrWin, tabsTargetWc):wcOrWin 是要监听的 webContents(或含 webContents 的窗口);
  // tabsTargetWc 是壳层 webContents(tabs:action 发往它;缺省=监听对象自身)
  function register(wcOrWin, tabsTargetWc) {
    const wc = wcOrWin && wcOrWin.webContents ? wcOrWin.webContents : wcOrWin;
    const target = tabsTargetWc || wc;
    if (!wc) return;
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const ctrl = input.control || input.meta;
      const alt = input.alt;
      const shift = input.shift;
      const key = (input.key || '').toLowerCase();

      // F5 刷新(无修饰键,需在 ctrl 判断前处理)
      if (!ctrl && !alt && input.key === 'F5') {
        event.preventDefault();
        target.send('tabs:action', { action: 'reload' });
        return;
      }

      if (!ctrl) return;

      switch (key) {
        case 'r': // Ctrl+R 刷新当前标签
          event.preventDefault();
          target.send('tabs:action', { action: 'reload' });
          log('[shortcut] reload tab');
          break;
        case 'w': // Ctrl+W:隐藏主窗到托盘
          event.preventDefault();
          actions.hideMain();
          log('[shortcut] hide main');
          break;
        case 't': // Ctrl+T 新标签
          event.preventDefault();
          target.send('tabs:action', { action: 'new' });
          break;
        case 'tab': // Ctrl+Tab / Ctrl+Shift+Tab 切换标签
          event.preventDefault();
          target.send('tabs:action', { action: shift ? 'prev' : 'next' });
          break;
        default:
          break;
      }
    });
  }

  return { register };
}

module.exports = { create };
