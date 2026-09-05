// 选区截图提问:desktopCapturer 抓鼠标所在显示器 → 遮罩窗口框选 → 裁剪入剪贴板
// → 打开主窗口并新建标签,聚焦输入框后 webContents.paste() 直接粘贴到新对话
// (恢复自 v1.0.16 的 overlay 框选流程;裁剪在 overlay 渲染层按原图像素换算)
const { BrowserWindow, desktopCapturer, screen, clipboard, nativeImage } = require('electron');
const path = require('path');

const OVERLAY_PAGE = path.join(__dirname, '..', 'ui', 'overlay.html');
const UI_PRELOAD = path.join(__dirname, '..', 'ui', 'preload-ui.js');

function create({ log, state }) {
  // 捕获超时兜底(ms):桌面捕获在 GPU 异常环境可能挂起(desktopCapturer.getSources 不返回),
  // 信号量确保遮罩未出现时桌宠一定恢复,避免"截图后悬浮球/鲸鱼娘永久消失"
  const CAPTURE_TIMEOUT_MS = 8000;

  async function startScreenshot() {
    if (state.overlayWindow && !state.overlayWindow.isDestroyed()) return;
    // 隐藏桌宠,避免拍进截图(悬浮球/鲸鱼娘都可能在前台)
    if (state.floatingWindow && !state.floatingWindow.isDestroyed()) state.floatingWindow.hide();
    if (state.petWindow && !state.petWindow.isDestroyed()) state.petWindow.hide();

    let overlayOpened = false;
    const guard = setTimeout(() => {
      if (!overlayOpened) {
        log('[screenshot] capture timeout -> restore pets');
        restorePets();
      }
    }, CAPTURE_TIMEOUT_MS);

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
      overlayOpened = true;
      createOverlay(bounds);
    } catch (err) {
      log('[screenshot] capture failed:', err.message);
      restorePets();
    } finally {
      clearTimeout(guard);
    }
  }

  function restorePets() {
    log('[screenshot] restore pets');
    if (state.floatingWindow && !state.floatingWindow.isDestroyed()) state.floatingWindow.show();
    if (state.petWindow && !state.petWindow.isDestroyed()) state.petWindow.show();
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
      restorePets();
    });
  }

  function closeOverlay() {
    if (state.overlayWindow && !state.overlayWindow.isDestroyed()) state.overlayWindow.close();
  }

  // 裁剪完成:入剪贴板(供粘贴);后续"打开主窗 + 新标签 + 自动粘贴"由调用方驱动
  function handleCrop({ dataUrl }) {
    if (!dataUrl) return false;
    clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
    log('[screenshot] cropped -> clipboard');
    closeOverlay();
    return true;
  }

  return { startScreenshot, closeOverlay, handleCrop };
}

module.exports = { create };
