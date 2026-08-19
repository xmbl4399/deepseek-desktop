// 显示模式管理:悬浮球(ball) / 鲸鱼娘(pet,默认) 二选一
// 状态记忆:userData/ds-settings.json 持久化,重启后保持上次模式
// 全屏联动:全屏时隐藏当前模式窗口,退出全屏恢复(替换原 main.js 直操作 floatingWindow)
// 切换策略:销毁旧窗口 → 创建新窗口,两种模式互不冲突、不并存
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_MODE = 'pet';
const SETTINGS_FILE = 'ds-settings.json';

function create({ log, state, floating, pet }) {
  let displayMode = DEFAULT_MODE;
  let fsHidden = false; // 是否因全屏检测而隐藏(切换模式时新窗口保持隐藏)

  function settingsPath() {
    return path.join(app.getPath('userData'), SETTINGS_FILE);
  }

  // 同步读取(启动时调用,必须在建窗前执行)
  function loadMode() {
    try {
      const data = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
      if (data.displayMode === 'ball' || data.displayMode === 'pet') {
        displayMode = data.displayMode;
        log('[mode] loaded displayMode =', displayMode);
      }
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
      fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      log('[mode] save failed:', e.message);
    }
  }

  // 当前模式的活动窗口(供全屏检测/托盘状态使用)
  function getActiveWindow() {
    return displayMode === 'pet' ? state.petWindow : state.floatingWindow;
  }

  function getDisplayMode() {
    return displayMode;
  }

  // 确保当前模式的窗口存在(启动建窗 / 切换后建窗共用)
  function ensureWindow() {
    if (displayMode === 'pet') pet.createPetWindow();
    else floating.createFloatingWindow();
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

  // 切换到指定模式:先持久化,再销毁旧窗口、创建新窗口
  function setDisplayMode(next) {
    if (next !== 'ball' && next !== 'pet') return;
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

  // 循环切换(右键菜单"切换显示模式"用)
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

  return {
    loadMode,
    createActiveWindow: ensureWindow,
    getActiveWindow,
    getDisplayMode,
    setDisplayMode,
    toggleMode,
    hideForFs,
    restoreFromFs,
  };
}

module.exports = { create };
