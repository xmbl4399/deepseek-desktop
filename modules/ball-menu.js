// 悬浮球自绘右键菜单(独立小窗口):点击菜单项后菜单消失,由 main.js 的 onUiAction 执行动作
//
// 菜单内容不在这里硬编码 —— 由 modules/menu-model.js 生成后下发给渲染层(与托盘同一份模型),
// 因此两个入口的项序 / 分组永远一致,不会出现"托盘有、悬浮球没有"的漂移。
//
// 窗口尺寸是**动态**的:渲染层折叠组展开/收起后会通过 ui:resize 回报新内容尺寸,
// fitMenu() 按锚点(右键位置)重算位置与大小 —— 所以锚点必须记在模块里,不能只在 show 时局部算。
const { BrowserWindow, screen } = require('electron');
const path = require('path');
const menuModel = require('./menu-model');

const MENU_PAGE = path.join(__dirname, '..', 'ui', 'menu.html');
const UI_PRELOAD = path.join(__dirname, '..', 'ui', 'preload-ui.js');
const GAP = 8; // 菜单与锚点(手指/光标位置)的间距

function create({ log, state, getMenuContext }) {
  let anchor = { ax: 0, ay: 0 }; // 本次弹出时记录的锚点(客户区无关,屏幕坐标)

  function closeMenuWindow() {
    if (state.menuWindow && !state.menuWindow.isDestroyed()) state.menuWindow.destroy();
    state.menuWindow = null;
  }

  // 按内容尺寸摆窗口:优先在锚点左侧展开(球通常贴屏幕右侧),放不下就翻到右侧;
  // 垂直方向超出工作区时上移贴边。展开折叠组会反复调用这里,所以必须是幂等的。
  function fitMenu(w, h) {
    if (!state.menuWindow || state.menuWindow.isDestroyed()) return null;
    const wa = screen.getPrimaryDisplay().workArea;
    const mw = Math.ceil(w) + 2;
    const mh = Math.ceil(h) + 2;
    let x = anchor.ax - mw - GAP;
    let y = anchor.ay;
    if (x < wa.x) x = anchor.ax + GAP;
    if (y + mh > wa.y + wa.height) y = wa.y + wa.height - mh;
    if (y < wa.y) y = wa.y;
    state.menuWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: mw, height: mh });
    return { x: Math.round(x), y: Math.round(y), w: mw, h: mh };
  }

  function showBallMenu(pos) {
    closeMenuWindow();
    const wa = screen.getPrimaryDisplay().workArea;
    let ax = 0,
      ay = 0;
    if (pos && typeof pos.mx === 'number') {
      ax = pos.mx;
      ay = pos.my;
    } else if (pos && typeof pos.wx === 'number') {
      ax = pos.wx;
      ay = pos.wy;
    } else {
      const c = screen.getCursorScreenPoint();
      ax = c.x;
      ay = c.y;
    }
    anchor = { ax, ay };

    // 先创建窗口加载内容,再读取实际尺寸自适应定位
    state.menuWindow = new BrowserWindow({
      width: 220,
      height: 420,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: true, // 需要焦点才能用键盘操作(↑↓/Enter/Esc)
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: UI_PRELOAD,
      },
    });
    state.menuWindow.setAlwaysOnTop(true, 'pop-up-menu');
    state.menuWindow.loadFile(MENU_PAGE);

    // 加载后把菜单模型交给渲染层,并取回实际内容尺寸自适应窗口
    state.menuWindow.webContents.once('did-finish-load', () => {
      const groups = menuModel.build(getMenuContext ? getMenuContext() : {}, 'ball');
      state.menuWindow.webContents
        .executeJavaScript('window.__dsMenuRender(' + JSON.stringify(groups) + ')', true)
        .then(([mw, mh]) => {
          if (!state.menuWindow || state.menuWindow.isDestroyed()) return;
          const at = fitMenu(mw, mh);
          state.menuWindow.focus();
          log('[ball-menu] anchor=', [ax, ay], 'size=', [mw, mh], '-> menu at', at && [at.x, at.y]);
        })
        .catch((e) => log('[ball-menu] render failed:', e && e.message));
    });

    state.menuWindow.on('blur', () => closeMenuWindow());
    state.menuWindow.on('closed', () => {
      state.menuWindow = null;
    });
    log('[ball-menu] work area=', [wa.x, wa.y, wa.width, wa.height]);
  }

  return { closeMenuWindow, showBallMenu, fitMenu };
}

module.exports = { create };
