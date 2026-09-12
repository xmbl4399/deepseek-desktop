// 托盘:图标 + 右键菜单(每次弹出前重建,保证勾选状态与真实设置一致)
//
// 项序 / 分组不在这里定义 —— 唯一来源是 modules/menu-model.js(与悬浮球菜单共用),
// 本文件只负责把模型画成原生菜单。加项/调顺序请改 menu-model.js。
const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const menuModel = require('./menu-model');

const LOGO = path.join(__dirname, '..', 'ui', 'logo.png');

function create({ log, state, onMenuAction, getMenuContext }) {
  // 模型项 → 原生菜单项。radio/checkbox 要带 type,其余是普通项。
  function toItem(it) {
    const mi = { label: it.label, enabled: it.enabled !== false };
    if (it.type === 'radio' || it.type === 'checkbox') {
      mi.type = it.type;
      mi.checked = !!it.checked;
      // checkbox 传"目标值"(=反值,即切换);radio 的动作自身知道要切到哪,payload 会被忽略
      mi.click = () => onMenuAction(it.act, { checked: !it.checked });
    } else {
      mi.click = () => onMenuAction(it.act);
    }
    return mi;
  }

  // 模型 → 原生模板:group 之间出分隔线;submenu 块出原生子菜单,items 块直接铺开
  function toTemplate(ctx) {
    const out = [];
    menuModel.build(ctx).forEach((group, gi) => {
      if (gi > 0) out.push({ type: 'separator' });
      for (const block of group.blocks || []) {
        if (block.kind === menuModel.SUBMENU) {
          out.push({ label: block.label, submenu: (block.items || []).map(toItem) });
        } else {
          for (const it of block.items || []) out.push(toItem(it));
        }
      }
    });
    return out;
  }

  function buildAppMenu() {
    const ctx = getMenuContext ? getMenuContext() : {};
    log(
      '[tray] menu rebuilt: mode =', ctx.mode,
      'size =', ctx.size,
      'autoStart =', ctx.autoStart,
      'mainVisible =', ctx.mainVisible,
    );
    return Menu.buildFromTemplate(toTemplate(ctx));
  }

  function createTray() {
    const trayIcon = nativeImage.createFromPath(LOGO).resize({ width: 16, height: 16 });
    state.tray = new Tray(trayIcon);
    // 悬浮提示:只显示产品名(与窗口标题、快捷方式名统一为 DeepSeek)
    state.tray.setToolTip('DeepSeek');

    state.tray.setContextMenu(buildAppMenu());
    // 每次弹出菜单前重建:保证"开机启动"勾选状态与注册表实际一致(只构建一次会显示过期状态)
    state.tray.on('right-click', () => state.tray.setContextMenu(buildAppMenu()));
    // 左键单击/双击:直接唤出主窗(原有行为,不改)。"隐藏"只在菜单首项里提供
    state.tray.on('click', () => onMenuAction('show-main'));
    state.tray.on('double-click', () => onMenuAction('show-main'));
  }

  // 置顶等状态变化时主动刷新托盘菜单(不依赖 right-click 事件重建,保证勾选状态实时一致)
  function refresh() {
    if (state.tray && !state.tray.isDestroyed()) {
      state.tray.setContextMenu(buildAppMenu());
    }
  }

  // 系统气泡提示(首次"关闭到托盘"、桌宠被隐藏时用;仅 Windows 支持,其他平台静默跳过)
  function notify(title, content) {
    if (process.platform !== 'win32') return;
    if (!state.tray || state.tray.isDestroyed()) return;
    try {
      state.tray.displayBalloon({ title, content });
    } catch (e) {
      log('[tray] balloon failed:', e && e.message);
    }
  }

  return { createTray, buildAppMenu, refresh, notify, toTemplate };
}

module.exports = { create };
