// 模块装配验证:在纯 Node 下 mock electron,验证 modules 全部可 require 且工厂装配不抛错
// 覆盖 CI 盲区:CI 只跑 lint + 冒烟测试,require 链错误只有真实 electron 运行时才暴露
// 运行:node scripts/require-check.js (npm test 已纳入)
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const os = require('os');

// ---- electron stub(仅满足顶层引用,不创建真实窗口) ----
const electronStub = {
  app: {
    isPackaged: false,
    // 指向临时目录,防止 saveMode 等把 ds-settings.json 写进仓库
    getPath: () => path.join(os.tmpdir(), 'ds-require-check'),
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
const pet = require(path.join(ROOT, 'modules', 'pet')).create({ log, state });
const mode = require(path.join(ROOT, 'modules', 'mode')).create({ log, state, floating, pet });
const focus = require(path.join(ROOT, 'modules', 'focus'));
const screenshot = require(path.join(ROOT, 'modules', 'screenshot')).create({ log });
const updater = require(path.join(ROOT, 'modules', 'updater')).create({ log });
const actions = {
  showMain: () => {},
  hideMain: () => {},
  checkForUpdates: () => {},
  setDisplayMode: () => {},
  getDisplayMode: () => 'ball',
  setForegroundAware: () => {},
  getForegroundAware: () => true,
  setWidgetSize: () => {},
  getWidgetSize: () => 'medium',
  setMainOnTop: () => {},
  getMainOnTop: () => false,
  startScreenshot: () => {},
  uninstallApp: () => {},
};
const tray = require(path.join(ROOT, 'modules', 'tray')).create({ log, state, actions });
const shortcuts = require(path.join(ROOT, 'modules', 'shortcuts')).create({ log, state, actions });

// ---- 断言:工厂都返回了预期的 API 表面 ----
const expectations = [
  ['security', security, ['openExternalSafe', 'attachNavigationGuard']],
  ['offline', offline, ['attachOfflineFallback', 'waitLoadStop']],
  ['ball-menu', ballMenu, ['showBallMenu', 'closeMenuWindow']],
  ['floating', floating, ['createFloatingWindow', 'toggleFloating', 'clampBall', 'moveWindow', 'setWidgetSize', 'applyWidgetSize', 'widgetBallSize']],
  ['pet', pet, ['createPetWindow', 'destroyPetWindow', 'setIgnore', 'setDragLock', 'moveWindow', 'setWidgetSize', 'applyWidgetSize', 'widgetPetSize']],
  ['mode', mode, ['loadMode', 'createActiveWindow', 'getActiveWindow', 'getDisplayMode', 'setDisplayMode', 'toggleMode', 'getForegroundAware', 'setForegroundAware', 'getWidgetSize', 'setWidgetSize', 'getMainOnTop', 'setMainOnTop', 'isAutoStartInit', 'markAutoStartInit', 'hideForFs', 'restoreFromFs', 'rebuildActiveWindow']],
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
if (floating.BALL_SIZE !== 48) {
  console.error('FAIL: floating.BALL_SIZE 应保持 48');
  failed += 1;
}
// 尺寸档位:悬浮球/鲸鱼娘 小/中/大(托盘"尺寸"选项)
{
  const bs = [
    ['small', 40], ['medium', 48], ['large', 56], ['huge', 48],
  ];
  for (const [level, want] of bs) {
    if (floating.widgetBallSize(level) !== want) {
      console.error(`FAIL: floating.widgetBallSize(${level}) 应为 ${want}, 实得 ${floating.widgetBallSize(level)}`);
      failed += 1;
    }
  }
  const ps = [
    ['small', { w: 220, h: 124 }], ['medium', { w: 300, h: 169 }],
    ['large', { w: 400, h: 225 }], ['huge', { w: 300, h: 169 }],
  ];
  for (const [level, want] of ps) {
    const got = pet.widgetPetSize(level);
    if (got.w !== want.w || got.h !== want.h) {
      console.error(`FAIL: pet.widgetPetSize(${level}) 应为 ${JSON.stringify(want)}, 实得 ${JSON.stringify(got)}`);
      failed += 1;
    }
  }
}
// 贴边钳制逻辑验证(wa 1920x1080):
// 悬浮球:球心可到屏幕边缘,最多悬出半颗(48/2=24px)
{
  const c1 = floating.clampBall(-50, 500);
  const c2 = floating.clampBall(5000, 500);
  const c3 = floating.clampBall(500, -50);
  const c4 = floating.clampBall(500, 5000);
  if (c1.x !== -24 || c1.y !== 500) { console.error('FAIL: clampBall 左缘钳制(-50 → -24):', c1); failed += 1; }
  if (c2.x !== 1920 - 24 || c2.y !== 500) { console.error('FAIL: clampBall 右缘钳制(5000 → 1896):', c2); failed += 1; }
  if (c3.x !== 500 || c3.y !== -24) { console.error('FAIL: clampBall 上缘钳制(-50 → -24):', c3); failed += 1; }
  if (c4.x !== 500 || c4.y !== 1080 - 24) { console.error('FAIL: clampBall 下缘钳制(5000 → 1056):', c4); failed += 1; }
}
// 鲸鱼娘:人物 HIT 区(窗口 x 100-220, y 25-167.5)保持完整在屏幕内,
// 窗口透明边可悬出屏幕外(贴边站立)
{
  const calls = [];
  const sends = [];
  state.petWindow = {
    isDestroyed: () => false,
    // moveWindow 用 setBounds 钉尺寸(防环境尺寸漂移);默认中档 320x180
    setBounds: (b) => calls.push([b.x, b.y, b.width, b.height]),
    webContents: { send: (ch, data) => sends.push([ch, data]) },
  };
  pet.moveWindow(300, 400);   // 未钳制:原样落位
  pet.moveWindow(-500, 400);  // 左缘:人物左缘贴屏幕左(0-100=-100)
  pet.moveWindow(5000, 400);  // 右缘:人物右缘贴屏幕右(1920-220=1700)
  pet.moveWindow(300, -500);  // 上缘:人物顶缘贴屏幕顶(0-25=-25)
  pet.moveWindow(300, 5000);  // 下缘:人物脚底贴屏幕底(1080-167.5=912.5→913)
  state.petWindow = null;
  const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const ok =
    eq(calls[0], [300, 400, 320, 180]) &&
    eq(calls[1], [-100, 400, 320, 180]) &&
    eq(calls[2], [1700, 400, 320, 180]) &&
    eq(calls[3], [300, -25, 320, 180]) &&
    eq(calls[4], [300, 913, 320, 180]);
  if (!ok) { console.error('FAIL: pet.moveWindow 贴边钳制逻辑异常:', calls); failed += 1; }
  // 仅发生钳制时回传 pet-pos(漂移修复关键:渲染进程本地坐标与实际同步)
  if (sends.length !== 4 || sends.some(([ch]) => ch !== 'pet-pos')) {
    console.error('FAIL: pet.moveWindow 钳制回传 pet-pos 异常:', sends);
    failed += 1;
  }
}
// 悬浮球 moveWindow:球心钳制在屏幕内(最多半身悬出),setBounds 钉尺寸,钳制回传 ball-pos
{
  const calls = [];
  const sends = [];
  state.floatingWindow = {
    isDestroyed: () => false,
    setBounds: (b) => calls.push([b.x, b.y, b.width, b.height]),
    close: () => {},
    webContents: { send: (ch, data) => sends.push([ch, data]) },
  };
  floating.moveWindow(300, 400);   // 未钳制:原样落位
  floating.moveWindow(-500, 400);  // 左缘:球心贴屏幕左(0-24=-24)
  floating.moveWindow(5000, 400);  // 右缘:球心贴屏幕右(1920-24=1896)
  floating.moveWindow(300, -500);  // 上缘:0-24=-24
  floating.moveWindow(300, 5000);  // 下缘:1080-24=1056
  state.floatingWindow = null;
  const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const ok =
    eq(calls[0], [300, 400, 48, 48]) &&
    eq(calls[1], [-24, 400, 48, 48]) &&
    eq(calls[2], [1896, 400, 48, 48]) &&
    eq(calls[3], [300, -24, 48, 48]) &&
    eq(calls[4], [300, 1056, 48, 48]);
  if (!ok) { console.error('FAIL: floating.moveWindow 贴边钳制逻辑异常:', calls); failed += 1; }
  if (sends.length !== 4 || sends.some(([ch]) => ch !== 'ball-pos')) {
    console.error('FAIL: floating.moveWindow 钳制回传 ball-pos 异常:', sends);
    failed += 1;
  }
}
// 新用户默认显示模式:悬浮球(ball)
{
  if (mode.getDisplayMode() !== 'ball') {
    console.error('FAIL: 新用户默认显示模式应为 ball(悬浮球)');
    failed += 1;
  }
}
// 显示模式 off 态:关闭显示 = 销毁窗口且不创建(pet 当前态 → off)
{
  mode.setDisplayMode('off');
  if (mode.getDisplayMode() !== 'off') {
    console.error('FAIL: mode 切到 off 后 getDisplayMode 应为 off');
    failed += 1;
  }
}
// 前台感知开关:默认开,可切换并持久化
{
  mode.setForegroundAware(false);
  if (mode.getForegroundAware() !== false) {
    console.error('FAIL: setForegroundAware(false) 后应为 false');
    failed += 1;
  }
  mode.setForegroundAware(true);
  if (mode.getForegroundAware() !== true) {
    console.error('FAIL: setForegroundAware(true) 后应为 true');
    failed += 1;
  }
}
// 主窗置顶:默认关,可切换
{
  if (mode.getMainOnTop() !== false) {
    console.error('FAIL: 主窗置顶默认应为 false');
    failed += 1;
  }
  mode.setMainOnTop(true);
  if (mode.getMainOnTop() !== true) {
    console.error('FAIL: setMainOnTop(true) 后应为 true');
    failed += 1;
  }
  mode.setMainOnTop(false);
}
// focus 前台程序分类(含本应用 deepseek + 常用系统应用)
{
  const cases = [
    ['deepseek-desktop', 'deepseek'], ['electron', 'deepseek'],
    // 浏览器
    ['chrome', 'browser'], ['msedge', 'browser'], ['firefox', 'browser'], ['QQBrowser', 'browser'],
    // IDE/编辑器
    ['Code', 'ide'], ['pycharm64', 'ide'], ['Cursor', 'ide'], ['sublime_text', 'ide'], ['notepad++', 'ide'], ['notepad', 'ide'],
    // 终端
    ['WindowsTerminal', 'terminal'], ['powershell', 'terminal'], ['cmd', 'terminal'], ['conhost', 'terminal'],
    // 会议(teams 归会议)
    ['zoom', 'meeting'], ['Teams', 'meeting'], ['wemeet', 'meeting'],
    // 聊天
    ['WeChat', 'chat'], ['QQ', 'chat'], ['Discord', 'chat'], ['dingtalk', 'chat'],
    // 影音
    ['Spotify', 'media'], ['PotPlayerMini64', 'media'], ['bilibili', 'media'], ['qqmusic', 'media'],
    // 办公
    ['WINWORD', 'office'], ['EXCEL', 'office'], ['wps', 'office'],
    // 设计
    ['Photoshop', 'design'], ['Figma', 'design'], ['Blender', 'design'],
    // 游戏
    ['steam', 'game'], ['Valorant', 'game'], ['LeagueClient', 'game'],
    // 文件管理器/其他
    ['explorer', 'explorer'], ['DSH Desktop', 'other'], ['', 'other'],
  ];
  for (const [input, want] of cases) {
    const got = focus.classify(input);
    if (got !== want) {
      console.error(`FAIL: focus.classify("${input}") 应为 ${want}, 实得 ${got}`);
      failed += 1;
    }
  }
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
console.log('require-check: 全部模块装配成功(11 个模块, API 表面完整)');
