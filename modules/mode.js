// 显示模式管理:悬浮球(ball) / 鲸鱼娘(pet,默认) / 关闭显示(off) 三态
// 状态记忆:userData/ds-settings.json 持久化,重启后保持上次模式
// 全屏联动:全屏时隐藏当前模式窗口,退出全屏恢复(替换原 main.js 直操作 floatingWindow)
// 切换策略:销毁旧窗口 → 创建新窗口(off 则销毁后不创建),各模式互不冲突、不并存
// 前台感知开关(foregroundAware):默认开。开=全屏自动隐藏 + 前台上下文动画;
//   关=完全不读取前台窗口(全屏检测脚本 DS_FG_MODE 门控,隐私默认)
// 尺寸档位(widgetSize):小/中/大,默认中;托盘"尺寸"选项调整,重建当前窗口生效
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_MODE = 'pet';
const SETTINGS_FILE = 'ds-settings.json';
const VALID_MODES = ['ball', 'pet', 'off'];
const VALID_SIZES = ['small', 'medium', 'large'];

function create({ log, state, floating, pet }) {
  let displayMode = DEFAULT_MODE;
  let foregroundAware = true; // 前台感知开关(默认开)
  let widgetSize = 'medium'; // 尺寸档位(默认中)
  let fsHidden = false; // 是否因全屏检测而隐藏(切换模式时新窗口保持隐藏)

  function settingsPath() {
    return path.join(app.getPath('userData'), SETTINGS_FILE);
  }

  // 同步读取(启动时调用,必须在建窗前执行)
  function loadMode() {
    try {
      const data = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
      if (VALID_MODES.includes(data.displayMode)) {
        displayMode = data.displayMode;
        log('[mode] loaded displayMode =', displayMode);
      }
      // 前台感知默认开;只有显式存 false 才关闭
      if (data.foregroundAware === false) foregroundAware = false;
      // 尺寸档位默认中
      if (VALID_SIZES.includes(data.widgetSize)) widgetSize = data.widgetSize;
    } catch (e) {
      /* 首次运行/文件损坏:保持默认 */
    }
    return displayMode;
  }

  function saveMode() {
    try {
      const p = settingsPath();
      let data = {};
      try {
        data = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) { /* 空文件/损坏:重建 */ }
      data.displayMode = displayMode;
      data.foregroundAware = foregroundAware;
      data.widgetSize = widgetSize;
      fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      log('[mode] save failed:', e.message);
    }
  }

  function getForegroundAware() {
    return foregroundAware;
  }

  function setForegroundAware(value) {
    foregroundAware = value === true;
    saveMode();
    log('[mode] foregroundAware =', foregroundAware);
  }

  function getWidgetSize() {
    return widgetSize;
  }

  function setWidgetSize(level) {
    if (!VALID_SIZES.includes(level)) return;
    widgetSize = level;
    saveMode();
    // 同步给两个显示模块(窗口创建时按档位取尺寸)
    floating.setWidgetSize(level);
    pet.setWidgetSize(level);
    log('[mode] widgetSize =', widgetSize);
  }

  // 当前模式的活动窗口(供全屏检测/托盘状态使用);off 时无窗口
  function getActiveWindow() {
    if (displayMode === 'pet') return state.petWindow;
    if (displayMode === 'ball') return state.floatingWindow;
    return null;
  }

  function getDisplayMode() {
    return displayMode;
  }

  // 确保当前模式的窗口存在(启动建窗 / 切换后建窗共用);off 则确保两窗口都销毁
  function ensureWindow() {
    if (displayMode === 'pet') {
      pet.createPetWindow();
    } else if (displayMode === 'ball') {
      floating.createFloatingWindow();
    } else {
      destroyWindow(state.floatingWindow);
      destroyWindow(state.petWindow);
    }
    // 全屏隐藏中:新窗口创建后立即隐藏,保持全屏不被遮挡
    if (fsHidden) {
      const w = getActiveWindow();
      if (w && !w.isDestroyed()) w.hide();
    }
  }

  // 销毁窗口(带存活检查)
  function destroyWindow(w) {
    if (w && !w.isDestroyed()) w.close();
  }

  // 切换到指定模式:先持久化,再销毁旧窗口、创建新窗口(off 只销毁不创建)
  function setDisplayMode(next) {
    if (!VALID_MODES.includes(next)) return;
    if (next === displayMode) {
      ensureWindow(); // 同模式点击:仅兜底确保窗口存在
      return;
    }
    displayMode = next;
    saveMode();
    destroyWindow(state.floatingWindow);
    destroyWindow(state.petWindow);
    ensureWindow();
    log('[mode] switched to', displayMode);
  }

  // 循环切换(右键菜单旧项"切换显示模式"兜底用):ball ↔ pet 循环,off 不参与
  function toggleMode() {
    setDisplayMode(displayMode === 'pet' ? 'ball' : 'pet');
  }

  // 全屏联动:隐藏当前窗口
  function hideForFs() {
    const w = getActiveWindow();
    if (w && !w.isDestroyed() && w.isVisible()) {
      w.hide();
      fsHidden = true;
      log('[mode] hidden for fullscreen');
    }
  }

  // 全屏联动:恢复当前窗口
  function restoreFromFs() {
    const w = getActiveWindow();
    if (w && !w.isDestroyed()) w.show();
    fsHidden = false;
    log('[mode] restored from fullscreen');
  }

  // 尺寸档位生效:原地缩放现有窗口(不销毁重建——旧方案销毁+重建会因 closed 异步
  // 清掉新窗口引用,导致旧窗口不消失成为残影)
  function rebuildActiveWindow() {
    const w = getActiveWindow();
    if (!w || w.isDestroyed()) return;
    if (displayMode === 'pet') pet.applyWidgetSize();
    else if (displayMode === 'ball') floating.applyWidgetSize();
    log('[mode] widget resized');
  }

  return {
    loadMode,
    createActiveWindow: ensureWindow,
    getActiveWindow,
    getDisplayMode,
    setDisplayMode,
    toggleMode,
    getForegroundAware,
    setForegroundAware,
    getWidgetSize,
    setWidgetSize,
    hideForFs,
    restoreFromFs,
    rebuildActiveWindow,
  };
}

module.exports = { create };
