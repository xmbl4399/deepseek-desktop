// 模块装配验证:在纯 Node 下 mock electron,验证 modules 全部可 require 且工厂装配不抛错
// 覆盖 CI 盲区:CI 只跑 lint + 冒烟测试,require 链错误只有真实 electron 运行时才暴露
// 运行:node scripts/require-check.js (npm test 已纳入)
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

// ---- electron stub(仅满足顶层引用,不创建真实窗口) ----
const electronStub = {
  app: {
    isPackaged: false,
    getPath: () => '',
    getVersion: () => '0.0.0-test',
    getName: () => 'deepseek-desktop',
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
    on: () => {},
  },
  BrowserWindow: class BrowserWindow {},
  Tray: function Tray() {},
  Menu: { buildFromTemplate: (t) => t },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1,
      id: 1,
    }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
  ipcMain: { on: () => {}, handle: () => {} },
  shell: { openExternal: () => {} },
  desktopCapturer: { getSources: async () => [] },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, parent, isMain);
};

// ---- 装配全部模块(模拟 main.js 的依赖注入顺序) ----
const { log } = require(path.join(ROOT, 'modules', 'logger'));
const state = require(path.join(ROOT, 'modules', 'state'));
const security = require(path.join(ROOT, 'modules', 'security')).create({ log });
const offline = require(path.join(ROOT, 'modules', 'offline')).create({ log });
const ballMenu = require(path.join(ROOT, 'modules', 'ball-menu')).create({ log, state });
const floating = require(path.join(ROOT, 'modules', 'floating')).create({ log, state });
const popup = require(path.join(ROOT, 'modules', 'popup')).create({
  log,
  state,
  security,
  offline,
  onWindowCreated: () => {},
});
const screenshot = require(path.join(ROOT, 'modules', 'screenshot')).create({ log, state, floating, popup });
const updater = require(path.join(ROOT, 'modules', 'updater')).create({ log });
const actions = {
  showMain: () => {},
  hideMain: () => {},
  togglePopup: () => {},
  hidePopup: () => {},
  startScreenshot: () => {},
  toggleFloating: () => {},
  checkForUpdates: () => {},
};
const tray = require(path.join(ROOT, 'modules', 'tray')).create({ log, state, actions });
const shortcuts = require(path.join(ROOT, 'modules', 'shortcuts')).create({ log, state, actions });

// ---- 断言:工厂都返回了预期的 API 表面 ----
const expectations = [
  ['security', security, ['openExternalSafe', 'attachNavigationGuard']],
  ['offline', offline, ['attachOfflineFallback', 'waitLoadStop']],
  ['ball-menu', ballMenu, ['showBallMenu', 'closeMenuWindow']],
  ['floating', floating, ['createFloatingWindow', 'toggleFloating', 'clampBall']],
  ['popup', popup, ['togglePopup', 'getPopupReady', 'injectToPopup']],
  ['screenshot', screenshot, ['startScreenshot', 'closeOverlay', 'handleCrop']],
  ['updater', updater, ['checkForUpdates', 'setupAutoUpdater']],
  ['tray', tray, ['createTray', 'buildAppMenu']],
  ['shortcuts', shortcuts, ['register']],
];

let failed = 0;
for (const [name, api, methods] of expectations) {
  for (const m of methods) {
    if (typeof api[m] !== 'function') {
      console.error(`FAIL: ${name}.${m} 缺失`);
      failed += 1;
    }
  }
}
// 关键常量
if (floating.BALL_SIZE !== 46) {
  console.error('FAIL: floating.BALL_SIZE 应保持 46');
  failed += 1;
}
if (security.APP_ORIGIN !== 'https://chat.deepseek.com') {
  console.error('FAIL: APP_ORIGIN 被改动');
  failed += 1;
}
// 私有地址拦截逻辑验证
if (!security.isPrivateHostname('192.168.1.1') || !security.isPrivateHostname('localhost') || security.isPrivateHostname('chat.deepseek.com')) {
  console.error('FAIL: 私有地址拦截逻辑异常');
  failed += 1;
}

if (failed > 0) {
  console.error(`require-check: ${failed} 项失败`);
  process.exit(1);
}
console.log('require-check: 全部模块装配成功(9 个模块, API 表面完整)');
