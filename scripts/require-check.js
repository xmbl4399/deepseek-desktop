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
  shell: { openExternal: () => {}, openPath: () => Promise.resolve('') },
  desktopCapturer: { getSources: async () => [] },
  clipboard: { writeText: () => {}, writeImage: () => {}, readText: () => '' },
};
electronStub.Menu = {
  // 返回值仍是模板数组(与真实调用方的用法兼容),另挂一个 popup 以便统计"是否真的弹了菜单"
  buildFromTemplate: (t) => {
    t.popup = () => {
      popupCount += 1;
    };
    return t;
  },
  setApplicationMenu: () => {},
};
let popupCount = 0;
electronStub.BrowserWindow.fromWebContents = () => null;

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
const ballMenu = require(path.join(ROOT, 'modules', 'ball-menu')).create({
  log, state, getMenuContext: () => ({}),
});
const contextMenu = require(path.join(ROOT, 'modules', 'context-menu')).create({ log, security });
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
// 托盘项序/分组来自 modules/menu-model.js,装配时只注入"当前状态"与动作入口
const menuCtx = {
  mainVisible: false,
  mode: 'ball',
  size: 'medium',
  mainOnTop: false,
  foregroundAware: true,
  autoStart: false,
  version: '0.0.0-test',
};
const trayActions = []; // 记录菜单项点击发回的 act,用于断言两个入口动作 id 一致
const tray = require(path.join(ROOT, 'modules', 'tray')).create({
  log: () => {},
  state,
  onMenuAction: (act) => trayActions.push(act),
  getMenuContext: () => menuCtx,
});
const shortcuts = require(path.join(ROOT, 'modules', 'shortcuts')).create({ log, state, actions });
const menuModel = require(path.join(ROOT, 'modules', 'menu-model'));

// ---- 断言:工厂都返回了预期的 API 表面 ----
const expectations = [
  ['security', security, ['openExternalSafe', 'attachNavigationGuard']],
  ['offline', offline, ['attachOfflineFallback', 'waitLoadStop']],
  ['ball-menu', ballMenu, ['showBallMenu', 'closeMenuWindow', 'fitMenu']],
  ['context-menu', contextMenu, ['attach', 'buildMenu']],
  ['floating', floating, ['createFloatingWindow', 'toggleFloating', 'clampBall', 'moveWindow', 'setWidgetSize', 'applyWidgetSize', 'widgetBallSize']],
  ['pet', pet, ['createPetWindow', 'destroyPetWindow', 'setIgnore', 'setDragLock', 'moveWindow', 'setWidgetSize', 'applyWidgetSize', 'widgetPetSize']],
  ['mode', mode, ['loadMode', 'createActiveWindow', 'getActiveWindow', 'getDisplayMode', 'setDisplayMode', 'toggleMode', 'getForegroundAware', 'setForegroundAware', 'getWidgetSize', 'setWidgetSize', 'getMainOnTop', 'setMainOnTop', 'isAutoStartInit', 'markAutoStartInit', 'hideForFs', 'restoreFromFs', 'rebuildActiveWindow']],
  ['screenshot', screenshot, ['startScreenshot', 'closeOverlay', 'handleCrop']],
  ['updater', updater, ['checkForUpdates', 'setupAutoUpdater']],
  ['tray', tray, ['createTray', 'buildAppMenu', 'refresh', 'notify', 'toTemplate']],
  ['shortcuts', shortcuts, ['register']],
  ['menu-model', menuModel, ['build']],
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
// 站内判定:必须 origin 精确比较 —— 前缀伪装 URL 一律判为站外(防应用内无地址栏钓鱼)
{
  const cases = [
    ['https://chat.deepseek.com/', true],
    ['https://chat.deepseek.com/a/chat/s/abc', true],
    ['https://chat.deepseek.com.evil.tld/', false],
    ['https://chat.deepseek.com@evil.tld/', false],
    ['https://evil.tld/chat.deepseek.com', false],
    ['http://chat.deepseek.com/', false],
    ['javascript:alert(1)', false],
    ['', false],
  ];
  for (const [url, want] of cases) {
    const got = security.isAppUrl(url);
    if (got !== want) {
      console.error(`FAIL: security.isAppUrl("${url}") 应为 ${want}, 实得 ${got}`);
      failed += 1;
    }
  }
}

// 右键菜单:首次长按只选中文字、已有选区时再次长按才弹菜单
// 触摸长按的时序是"Chromium 原生手势先选中词 → 再合成 context-menu",
// 故用 pointerdown 时上报的手势起点选区快照来区分"选区是不是这次手势刚创建的"。
{
  const { EventEmitter } = require('events');
  const silent = () => {}; // 不写 ds-debug.log,避免测试污染仓库日志

  function makeWc(id) {
    const wc = new EventEmitter();
    wc.id = id;
    wc.isDestroyed = () => false;
    wc.canGoBack = () => false;
    wc.copy = () => {};
    wc.selectAll = () => {};
    wc.inspectElement = () => {};
    return wc;
  }

  // ① / ② 用同一个实例(150ms 去抖是实例级,故两条断言之间只发一次事件)
  let snap = '';
  const wcA = makeWc(9001);
  const cmA = require(path.join(ROOT, 'modules', 'context-menu')).create({
    log: silent,
    security,
    selectionBeforeGesture: () => snap,
  });
  cmA.attach(wcA, 'test');

  // ① 手势前无选区 + 现在有选区 → 首次长按:只选中,不弹菜单
  const n0 = popupCount;
  wcA.emit('context-menu', {}, { selectionText: '创造', isEditable: false, editFlags: {} });
  if (popupCount !== n0) {
    console.error('FAIL: 首次长按(手势前无选区)不应弹菜单');
    failed += 1;
  }

  // ② 手势前已有选区 → 再次长按:弹菜单
  snap = '创造';
  const n1 = popupCount;
  wcA.emit('context-menu', {}, { selectionText: '创造', isEditable: false, editFlags: {} });
  if (popupCount !== n1 + 1) {
    console.error('FAIL: 已有选区时再次长按应弹菜单');
    failed += 1;
  }

  // ③ 手势前在别处有选区,但本次长按选中了**新内容**(选区变了)→ 仍属"首次框选",不该弹菜单。
  //    旧判据只看"手势前有没有选区",这种情况会直接弹菜单 —— 用户感受就是"长按不框选、直接弹菜单"。
  //    用独立实例:150ms 去抖是实例级的,复用上面的实例会让"不弹"变成假通过。
  {
    const wcD = makeWc(9004);
    const cmD = require(path.join(ROOT, 'modules', 'context-menu')).create({
      log: silent,
      security,
      selectionBeforeGesture: () => '创造', // 之前在某处选过的字
    });
    cmD.attach(wcD, 'test');
    const nD = popupCount;
    wcD.emit('context-menu', {}, { selectionText: '求索', isEditable: false, editFlags: {} });
    if (popupCount !== nD) {
      console.error('FAIL: 在新位置长按框选出新文字时不应弹菜单(选区变了=本次手势新选中)');
      failed += 1;
    }
  }

  // ④ 快照不可用(null,如 preload 未上报)→ 退回旧行为,照常弹菜单(菜单不会被卡死)
  {
    const wcB = makeWc(9002);
    const cmB = require(path.join(ROOT, 'modules', 'context-menu')).create({
      log: silent,
      security,
      selectionBeforeGesture: () => null,
    });
    cmB.attach(wcB, 'test');
    const n2 = popupCount;
    wcB.emit('context-menu', {}, { selectionText: '创造', isEditable: false, editFlags: {} });
    if (popupCount !== n2 + 1) {
      console.error('FAIL: 选区快照不可用时应照常弹菜单(旧行为兜底)');
      failed += 1;
    }
  }

  // ⑤ 鼠标右键:不创建选区(selectionText 为空)→ 照常弹菜单
  {
    const wcC = makeWc(9003);
    const cmC = require(path.join(ROOT, 'modules', 'context-menu')).create({
      log: silent,
      security,
      selectionBeforeGesture: () => '', // 手势前确实无选区
    });
    cmC.attach(wcC, 'test');
    const n3 = popupCount;
    wcC.emit('context-menu', {}, { selectionText: '', isEditable: true, editFlags: { canPaste: true } });
    if (popupCount !== n3 + 1) {
      console.error('FAIL: 空白处右键(无选区)应照常弹菜单');
      failed += 1;
    }
  }
}

// 菜单模型:托盘(原生菜单)与悬浮球(自绘菜单)共用同一份项序 / 分组
// 抽这一层是为了根除"托盘有某项、球菜单没有"的漂移,所以这里把两个入口的项序与动作 id 都钉死。
{
  const silent = () => {};
  const baseCtx = {
    mainVisible: false,
    mode: 'ball',
    size: 'medium',
    mainOnTop: false,
    foregroundAware: true,
    autoStart: false,
    version: '1.1.3',
  };

  // 展开成"含子菜单项"的平铺列表,便于按标签查类型/勾选
  const flat = (tpl) => {
    const out = [];
    tpl.forEach((i) => {
      if (i.submenu) out.push(...i.submenu);
      else if (i.type !== 'separator') out.push(i);
    });
    return out;
  };
  // 顶层标签序列(子菜单压成 [a|b|c],便于一次断言顺序与分组)
  const labelsOf = (tpl) =>
    tpl
      .filter((i) => i.type !== 'separator')
      .map((i) => (i.submenu ? '[' + i.submenu.map((s) => s.label).join('|') + ']' : i.label));

  const mkTray = (onAct) =>
    require(path.join(ROOT, 'modules', 'tray')).create({
      log: silent,
      state,
      onMenuAction: onAct || (() => {}),
      getMenuContext: () => baseCtx,
    });

  // ① 分组顺序固定:动作 → 桌宠(显示/尺寸) → 开关 → 信息 → 终结
  const keys = menuModel.build(baseCtx).map((g) => g.key).join(',');
  if (keys !== 'action,pet,toggle,info,end') {
    console.error(`FAIL: 菜单分组顺序应为 action,pet,toggle,info,end, 实得 ${keys}`);
    failed += 1;
  }

  // ② 托盘项序:功能项在最上,开关居中,关于/目录/卸载/退出在最下
  const tpl = mkTray().toTemplate(baseCtx);
  const wantLabels = [
    '打开主窗口', '截图提问',
    '[悬浮球|鲸鱼娘|关闭显示]', '[小|中|大]',
    '主窗置顶', '前台感知开关', '开机启动',
    '关于 DeepSeek v1.1.3', '打开数据目录',
    '卸载 DeepSeek…', '退出',
  ];
  const gotLabels = labelsOf(tpl);
  if (gotLabels.join(' / ') !== wantLabels.join(' / ')) {
    console.error('FAIL: 托盘项序/分组不符');
    console.error('  期望:', wantLabels.join(' / '));
    console.error('  实得:', gotLabels.join(' / '));
    failed += 1;
  }

  // ③ 分隔线:5 组 → 4 条(原先 12 项被切成 5 段,碎片化)
  const seps = tpl.filter((i) => i.type === 'separator').length;
  if (seps !== 4) {
    console.error(`FAIL: 托盘分隔线应为 4 条, 实得 ${seps}`);
    failed += 1;
  }

  // ④ 类型:模式/尺寸 = radio,三个设置 = checkbox(radio 单选语义关不掉),其余不带 type
  const items = flat(tpl);
  const byLabel = (label, list) => (list || items).find((i) => i.label === label);
  for (const l of ['悬浮球', '鲸鱼娘', '关闭显示', '小', '中', '大']) {
    if (!byLabel(l) || byLabel(l).type !== 'radio') {
      console.error(`FAIL: ${l} 应为 radio`);
      failed += 1;
    }
  }
  for (const l of ['主窗置顶', '前台感知开关', '开机启动']) {
    if (!byLabel(l) || byLabel(l).type !== 'checkbox') {
      console.error(`FAIL: ${l} 应为 checkbox(radio 关不掉)`);
      failed += 1;
    }
  }
  if (byLabel('截图提问').type) {
    console.error('FAIL: 截图提问不应带 type');
    failed += 1;
  }

  // ⑤ 勾选状态来自实时 ctx,不是写死的
  if (!byLabel('悬浮球').checked || byLabel('鲸鱼娘').checked) {
    console.error('FAIL: 显示模式勾选未跟随 ctx.mode');
    failed += 1;
  }
  if (!byLabel('中').checked) {
    console.error('FAIL: 尺寸勾选未跟随 ctx.size');
    failed += 1;
  }
  if (byLabel('开机启动').checked) {
    console.error('FAIL: 开机启动勾选未跟随 ctx.autoStart');
    failed += 1;
  }

  // ⑥ 关闭显示(off)时"尺寸"整组不可点 —— 改一个看不见的桌宠尺寸没有意义
  const offItems = flat(mkTray().toTemplate(Object.assign({}, baseCtx, { mode: 'off' })));
  for (const l of ['小', '中', '大']) {
    if (byLabel(l, offItems).enabled !== false) {
      console.error(`FAIL: 关闭显示时"${l}"应置灰不可点`);
      failed += 1;
    }
  }
  if (byLabel('关闭显示', offItems).checked !== true) {
    console.error('FAIL: mode=off 时"关闭显示"应勾选');
    failed += 1;
  }

  // ⑦ 主窗可见时首项文案变"隐藏主窗口"(两个入口都只有一个开关项,不能只会开不会关)
  const visItems = flat(mkTray().toTemplate(Object.assign({}, baseCtx, { mainVisible: true })));
  if (!byLabel('隐藏主窗口', visItems)) {
    console.error('FAIL: 主窗可见时首项应为"隐藏主窗口"');
    failed += 1;
  }

  // ⑧ 悬浮球菜单:托盘专属项必须一项都不出现,且不因此留下空分组(会产生悬空分隔线)
  const ballGroups = menuModel.build(baseCtx, 'ball');
  const ballItems = [];
  ballGroups.forEach((g) => (g.blocks || []).forEach((b) => (b.items || []).forEach((it) => ballItems.push(it))));
  const ballLabels = ballItems.map((i) => i.label);
  // 开关类设置(置顶 / 前台感知 / 开机启动)与信息类(关于 / 数据目录 / 卸载)只在托盘:
  // 悬浮球是"随手点一下"的入口,配置项摊在这里既挤掉高频项,又容易被误触
  for (const banned of ['主窗置顶', '前台感知开关', '开机启动', '打开数据目录', '卸载 DeepSeek…']) {
    if (ballLabels.includes(banned)) {
      console.error(`FAIL: 悬浮球菜单不应出现"${banned}"`);
      failed += 1;
    }
  }
  if (ballLabels.some((l) => l.startsWith('关于 DeepSeek'))) {
    console.error('FAIL: 悬浮球菜单不应出现"关于"项');
    failed += 1;
  }
  if (ballGroups.some((g) => !(g.blocks || []).length)) {
    console.error('FAIL: 悬浮球菜单不应留下空分组(会产生悬空分隔线)');
    failed += 1;
  }
  // 球菜单必须有"尺寸"与勾选态(原先完全没有尺寸入口,只能绕去托盘)
  const ballById = (l) => ballItems.find((i) => i.label === l);
  for (const l of ['小', '中', '大']) {
    if (!ballById(l) || ballById(l).type !== 'radio') {
      console.error(`FAIL: 悬浮球菜单缺少尺寸项 ${l}`);
      failed += 1;
    }
  }
  // 模式/尺寸必须是 submenu 块:自绘菜单据此渲染成**可折叠父行**,不再把 6 个选项平铺出来
  const ballSubs = [];
  ballGroups.forEach((g) =>
    (g.blocks || []).forEach((b) => {
      if (b.kind === 'submenu') ballSubs.push(b);
    }));
  if (ballSubs.length !== 2) {
    console.error(`FAIL: 悬浮球菜单应有两个可折叠组(显示模式 / 尺寸), 实得 ${ballSubs.length}`);
    failed += 1;
  }
  if (ballSubs.some((b) => !b.caption || !(b.items || []).length)) {
    console.error('FAIL: 可折叠组缺少父行标题(caption)或子项');
    failed += 1;
  }
  // 球菜单最末一组只能是"退出"—— 卸载过滤掉后别把"退出"也带走
  const ballLast = (ballGroups[ballGroups.length - 1] || {}).blocks || [];
  if (!ballLast.some((b) => (b.items || []).some((i) => i.act === 'quit'))) {
    console.error('FAIL: 悬浮球菜单缺少"退出"');
    failed += 1;
  }
  // 球菜单项序(托盘开关/信息组被滤掉后,toggle 与 info 两组整体消失 → 3 组 2 条分隔线)
  if (ballGroups.map((g) => g.key).join(',') !== 'action,pet,end') {
    console.error(`FAIL: 悬浮球菜单分组应为 action,pet,end, 实得 ${ballGroups.map((g) => g.key).join(',')}`);
    failed += 1;
  }
  const wantBallLabels = ['打开主窗口', '截图提问', '悬浮球', '鲸鱼娘', '关闭显示', '小', '中', '大', '退出'];
  if (ballLabels.join(' / ') !== wantBallLabels.join(' / ')) {
    console.error('FAIL: 悬浮球菜单项序不符');
    console.error('  期望:', wantBallLabels.join(' / '));
    console.error('  实得:', ballLabels.join(' / '));
    failed += 1;
  }

  // ⑨ 两个入口的 act 必须逐项一致 —— 点托盘项发出的 act 序列 = 球菜单 act 序列 + 托盘专属项
  const trayOnlyActs = new Set();
  menuModel.build(baseCtx).forEach((g) =>
    (g.blocks || []).forEach((b) =>
      (b.items || []).forEach((it) => {
        if (it.trayOnly) trayOnlyActs.add(it.act);
      })));
  const trayActs = [];
  const tplForActs = mkTray((act) => trayActs.push(act)).toTemplate(baseCtx);
  flat(tplForActs).forEach((i) => i.click && i.click({}));
  const expectedActs = ballItems.map((i) => i.act);
  const actualActs = trayActs.filter((a) => !trayOnlyActs.has(a));
  if (actualActs.join(',') !== expectedActs.join(',')) {
    console.error('FAIL: 托盘与悬浮球菜单的动作 id 不一致');
    console.error('  托盘:', actualActs.join(','));
    console.error('  球  :', expectedActs.join(','));
    failed += 1;
  }
  // checkbox 点击必须回传"切换后的目标值"(main.js 据此决定设置成什么)
  let payloadSeen = null;
  const tplForPayload = mkTray((act, payload) => { payloadSeen = payload; }).toTemplate(baseCtx);
  const mainTopItem = flat(tplForPayload).find((i) => i.label === '主窗置顶');
  mainTopItem.click({});
  if (!payloadSeen || payloadSeen.checked !== true) {
    console.error('FAIL: checkbox 点击应回传切换后的目标值 { checked: true }, 实得', payloadSeen);
    failed += 1;
  }
  // 原生菜单项只带 Electron 认识的字段(act/type 之外的模型字段不能漏进模板)
  const leaked = flat(tplForPayload).filter((i) => 'act' in i || 'trayOnly' in i || 'danger' in i);
  if (leaked.length) {
    console.error('FAIL: 模型字段漏进原生菜单模板:', leaked.map((i) => i.label).join(','));
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`require-check: ${failed} 项失败`);
  process.exit(1);
}
console.log(`require-check: 全部模块装配成功(${expectations.length} 个模块, API 表面完整)`);
