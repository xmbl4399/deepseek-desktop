// 对话小浮框:380x620 无边框置顶窗,加载 chat.deepseek.com 并注入 UI
// 与主窗共用 preload(preload.js)+ 同一默认 session → 共享登录态
const { BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_URL = 'https://chat.deepseek.com/';
const POPUP_PRELOAD = path.join(__dirname, '..', 'preload.js');
const POPUP_INJECT = path.join(__dirname, '..', 'popup-inject.js');
const INJECT = path.join(__dirname, '..', 'inject.js');
const LOGO = path.join(__dirname, '..', 'ui', 'logo.png');

function create({ log, state, security, offline, onWindowCreated }) {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 注入图片到对话浮框:图片上传预览,等待用户输入后自行发送
  async function injectToPopup(imagePath) {
    try {
      const win = await getPopupReady();
      const b64 = fs.readFileSync(imagePath).toString('base64');
      const code = fs.readFileSync(INJECT, 'utf8');
      const result = await win.webContents.executeJavaScript(`${code}\n__dsInjectImage(${JSON.stringify(b64)});`);
      log('[ds] inject result:', JSON.stringify(result));
    } catch (err) {
      log('[ds] inject failed:', err.message);
    }
  }

  function togglePopup(text) {
    if (state.popupWindow && !state.popupWindow.isDestroyed() && state.popupWindow.isVisible()) {
      state.popupWindow.hide();
      return;
    }
    if (text) state.pendingPopupText = text;
    getPopupReady();
  }

  // 确保浮框存在、可见且页面加载完成;返回 popupWindow
  async function getPopupReady() {
    if (!state.popupWindow || state.popupWindow.isDestroyed()) {
      state.popupWindow = new BrowserWindow({
        width: 380,
        height: 620,
        minWidth: 340,
        minHeight: 460,
        icon: LOGO,
        frame: false,
        resizable: true,
        alwaysOnTop: true,
        skipTaskbar: false,
        hasShadow: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          preload: POPUP_PRELOAD,
        },
      });
      state.popupWindow.setAlwaysOnTop(true, 'screen-saver');
      state.popupWindow.loadURL(APP_URL);
      security.attachNavigationGuard(state.popupWindow, 'popup');
      offline.attachOfflineFallback(state.popupWindow, 'popup');
      if (onWindowCreated) onWindowCreated(state.popupWindow); // 由 main.js 注册窗口内快捷键
      state.popupWindow.once('ready-to-show', () => state.popupWindow.show());
      state.popupWindow.on('closed', () => {
        state.popupWindow = null;
        state.pendingPopupText = null;
      });
      positionPopup();
      await offline.waitLoadStop(state.popupWindow.webContents);
      await injectPopupUi();
      await sleep(800); // 等 SPA 交互就绪
      state.popupWindow.show();
      state.popupWindow.focus();
    } else {
      state.popupWindow.show();
      state.popupWindow.focus();
      if (state.popupWindow.webContents.isLoading()) {
        await offline.waitLoadStop(state.popupWindow.webContents);
        await sleep(800);
      }
    }
    // 浮层打开后自动聚焦输入框,方便键盘直接输入
    state.popupWindow.webContents
      .executeJavaScript(
        `(function() {
          const input = document.querySelector('textarea, input[type="text"], [contenteditable="true"]');
          if (input) input.focus();
        })();`
      )
      .catch(() => {});
    return state.popupWindow;
  }

  function positionPopup() {
    if (!state.popupWindow) return;
    // 在鼠标所在显示器上弹出(副屏用户也能用)
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const pw = state.popupWindow.getSize()[0];
    const ph = state.popupWindow.getSize()[1];
    // 屏幕右侧 1/4 处,高度居中
    const x = wa.x + Math.round((wa.width * 3) / 4) - Math.round(pw / 2);
    const y = wa.y + Math.round((wa.height - ph) / 2);
    state.popupWindow.setPosition(x, y);
  }

  async function injectPopupUi() {
    try {
      const code = fs.readFileSync(POPUP_INJECT, 'utf8');
      await state.popupWindow.webContents.executeJavaScript(`${code}\n__dsPopupInit();`);
      if (state.pendingPopupText) {
        fillPopupText(state.pendingPopupText);
        state.pendingPopupText = null;
      }
    } catch (err) {
      log('[ds] popup inject failed:', err.message);
    }
  }

  function fillPopupText(text) {
    if (!state.popupWindow || state.popupWindow.isDestroyed()) return;
    const safe = JSON.stringify(String(text));
    state.popupWindow.webContents
      .executeJavaScript(
        `(() => {
          const ta = document.querySelector('textarea, [contenteditable="true"]');
          if (!ta) return false;
          ta.focus();
          if (ta.tagName === 'TEXTAREA') {
            ta.value = ${safe};
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            document.execCommand('insertText', false, ${safe});
          }
          return true;
        })();`
      )
      .catch(() => {});
  }

  return { togglePopup, getPopupReady, injectToPopup };
}

module.exports = { create };
