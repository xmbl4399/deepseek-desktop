// 鲸鱼娘:透明动画桌宠窗口(320x180,动画链由 ui/pet.js 驱动)
// 与悬浮球(floating.js)同级:窗口本身只负责创建/销毁/穿透控制/定位,
// 行为逻辑(动画链/拖拽/命中检测)全部在渲染进程 ui/pet.js 内。
// 点击穿透:Windows setIgnoreMouseEvents(true, {forward:true}) 初始全穿透,
// 渲染进程用 forward 转发的 mousemove 做 HIT_BOX 命中检测,命中才关穿透。
const { BrowserWindow, screen } = require('electron');
const path = require('path');

const PET_W = 320;
const PET_H = 180;
const PET_PAGE = path.join(__dirname, '..', 'ui', 'pet.html');
const UI_PRELOAD = path.join(__dirname, '..', 'ui', 'preload-ui.js');

function create({ log, state }) {
  function createPetWindow() {
    state.petWindow = new BrowserWindow({
      width: PET_W,
      height: PET_H,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: UI_PRELOAD,
      },
    });

    state.petWindow.setAlwaysOnTop(true, 'screen-saver');
    // 初始全穿透:透明区不挡下层应用(forward 转发 mousemove 供命中检测)
    state.petWindow.setIgnoreMouseEvents(true, { forward: true });
    state.petWindow.loadFile(PET_PAGE);
    positionPet();
    log('[pet] window created at', state.petWindow.getPosition());

    state.petWindow.on('closed', () => {
      state.petWindow = null;
    });
  }

  // 默认位置:主屏右下角贴底(落地对齐由渲染进程 translateY 完成)
  function positionPet() {
    if (!state.petWindow) return;
    const wa = screen.getPrimaryDisplay().workArea;
    state.petWindow.setPosition(wa.x + wa.width - PET_W - 24, wa.y + wa.height - PET_H);
  }

  function destroyPetWindow() {
    if (state.petWindow && !state.petWindow.isDestroyed()) state.petWindow.close();
  }

  // 渲染进程命中检测结果 → 切换点击穿透
  // ignore=true: 窗口不接收鼠标(forward 转发 mousemove);false: 正常接收
  function setIgnore(ignore) {
    if (!state.petWindow || state.petWindow.isDestroyed()) return;
    state.petWindow.setIgnoreMouseEvents(!!ignore, ignore ? { forward: true } : undefined);
  }

  return {
    createPetWindow,
    destroyPetWindow,
    positionPet,
    setIgnore,
    PET_W,
    PET_H,
  };
}

module.exports = { create };
