// 选区截图:desktopCapturer 抓鼠标所在显示器 → 遮罩窗口框选 → 裁剪注入浮窗
const { BrowserWindow, desktopCapturer, screen, app } = require('electron');
const path = require('path');
const fs = require('fs');

const OVERLAY_PAGE = path.join(__dirname, '..', 'ui', 'overlay.html');
const UI_PRELOAD = path.join(__dirname, '..', 'ui', 'preload-ui.js');

function create({ log, state, floating, popup }) {
  async function startScreenshot() {
    if (state.overlayWindow && !state.overlayWindow.isDestroyed()) return;
    // 隐藏悬浮球,避免拍进截图
    if (state.floatingWindow && !state.floatingWindow.isDestroyed()) state.floatingWindow.hide();

    try {
      // 截鼠标所在显示器(支持多屏)。用整个屏幕 bounds 而非 workArea:
      // desktopCapturer 只能抓整屏,若遮罩只盖 workArea,图片会被拉伸,选区坐标与实际裁剪错位
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const bounds = display.bounds;
      const sf = display.scaleFactor || 1;
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        // 按物理像素抓图保证清晰;渲染层再按 CSS 缩放,overlay.js 裁剪时按 naturalWidth 换算回原图坐标
        thumbnailSize: { width: Math.round(bounds.width * sf), height: Math.round(bounds.height * sf) },
      });
      let src = sources.find((s) => String(s.display_id) === String(display.id));
      if (!src) src = sources[0];
      if (!src) throw new Error('no screen source');

      state.pendingShot = { dataUrl: src.thumbnail.toDataURL(), area: bounds };
      createOverlay(bounds);
    } catch (err) {
      log('[ds] screenshot failed:', err.message);
      floating.restoreFloating();
    }
  }

  function createOverlay(area) {
    state.overlayWindow = new BrowserWindow({
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
      frame: false,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: UI_PRELOAD,
      },
    });
    state.overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    state.overlayWindow.loadFile(OVERLAY_PAGE);
    state.overlayWindow.on('closed', () => {
      state.overlayWindow = null;
      state.pendingShot = null;
      floating.restoreFloating();
    });
  }

  function closeOverlay() {
    if (state.overlayWindow && !state.overlayWindow.isDestroyed()) state.overlayWindow.close();
  }

  function handleCrop({ dataUrl }) {
    const file = path.join(app.getPath('temp'), 'ds-screenshot.png');
    const b64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    log('[ds] screenshot saved:', file, fs.statSync(file).size, 'bytes');
    closeOverlay();
    popup.injectToPopup(file); // 注入到对话浮框:图片上传预览,等待用户输入后自行发送
  }

  return { startScreenshot, closeOverlay, handleCrop };
}

module.exports = { create };
