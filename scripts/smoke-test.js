// 冒烟测试:验证关键文件存在、JS 语法、package.json 元数据一致性
// 运行:npm test(不依赖 Electron 运行时,CI 可直接跑)
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}

// 关键文件必须存在
const REQUIRED_FILES = [
  'main.js',
  'preload.js',
  'inject.js',
  'popup-inject.js',
  'ui/floating.html',
  'ui/floating.js',
  'ui/menu.html',
  'ui/menu.js',
  'ui/overlay.html',
  'ui/overlay.js',
  'ui/preload-ui.js',
  'ui/ui.css',
  'ui/logo.png',
  'ui/offline.html',
  'ui/pet.html',
  'ui/pet.js',
  'ui/pet-assets/待机呼吸休闲.webm',
  'modules/logger.js',
  'modules/state.js',
  'modules/security.js',
  'modules/offline.js',
  'modules/ball-menu.js',
  'modules/floating.js',
  'modules/popup.js',
  'modules/screenshot.js',
  'modules/tray.js',
  'modules/updater.js',
  'modules/shortcuts.js',
  'modules/pet.js',
  'modules/mode.js',
];

test('关键文件存在', () => {
  for (const f of REQUIRED_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `缺少文件: ${f}`);
  }
});

test('JS 语法检查(node --check)', () => {
  const jsFiles = [
    'main.js',
    'preload.js',
    'inject.js',
    'popup-inject.js',
    'ui/floating.js',
    'ui/menu.js',
    'ui/overlay.js',
    'ui/preload-ui.js',
    'ui/pet.js',
    'modules/logger.js',
    'modules/state.js',
    'modules/security.js',
    'modules/offline.js',
    'modules/ball-menu.js',
    'modules/floating.js',
    'modules/popup.js',
    'modules/screenshot.js',
    'modules/tray.js',
    'modules/updater.js',
    'modules/shortcuts.js',
    'modules/pet.js',
    'modules/mode.js',
  ];
  for (const f of jsFiles) {
    execFileSync(NODE, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
  }
});

test('package.json 元数据', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.name, 'deepseek-desktop');
  // repository 必须指向当前仓库,而非 fork 源
  assert.match(pkg.repository.url, /xmbl4399\/deepseek-desktop/);
  assert.strictEqual(pkg.author, 'xmbl4399');
  // 构建配置:icon 必须指向仓库内文件(可复现构建)
  assert.strictEqual(pkg.build.win.icon, 'build/icon.ico');
  assert.ok(fs.existsSync(path.join(ROOT, pkg.build.win.icon)), 'win.icon 文件不存在');
  // 自动更新依赖
  assert.ok(pkg.dependencies && pkg.dependencies['electron-updater'], '缺少 electron-updater');
  assert.ok(pkg.publish && pkg.publish.provider === 'github', '缺少 publish 配置');
  // 打包白名单必须覆盖 main.js 依赖的模块目录(漏了会导致 asar 内缺模块,启动即崩)
  const files = pkg.build.files || [];
  for (const req of ['main.js', 'preload.js', 'inject.js', 'popup-inject.js', 'modules/**/*', 'ui/**/*']) {
    assert.ok(files.includes(req), `build.files 缺少 ${req}`);
  }
});

test('main.js 与模块包含关键修复', () => {
  const main = read('main.js');
  const security = read('modules/security.js');
  const updater = read('modules/updater.js');
  const allJs = REQUIRED_FILES.filter((f) => f.endsWith('.js')).map(read).join('\n');
  assert.ok(main.includes('requestSingleInstanceLock'), '缺少单实例锁');
  assert.ok(!allJs.includes('globalShortcut'), '不应使用全局快捷键(易冲突,用窗口内 before-input-event)');
  assert.ok(security.includes('setWindowOpenHandler'), '缺少 window.open 拦截');
  assert.ok(main.includes('FS_CHECK_SCRIPT'), '缺少内嵌全屏检测脚本');
  assert.ok(updater.includes('autoUpdater'), '缺少自动更新');
  assert.ok(!main.includes('check-fullscreen.ps1') || main.includes('内嵌'), '不应依赖外部 ps1 文件');
});

test('主窗口不使用 preload', () => {
  const main = read('main.js');
  // createMainWindow 的 webPreferences 中不应出现 preload 属性
  const seg = main.split('function createMainWindow')[1].split('mainWindow.loadURL(APP_URL);')[0];
  assert.ok(!seg.includes('preload:'), '主窗口不应加载 preload');
});

test('内嵌全屏检测脚本与 check-fullscreen.ps1 保持同步', () => {
  const main = read('main.js');
  const m = main.match(/const FS_CHECK_SCRIPT = `([\s\S]*?)`;/);
  assert.ok(m, '未找到内嵌 FS_CHECK_SCRIPT');
  // 去掉注释行和空白后逐行对比,防止改了 ps1 忘改内嵌副本
  const norm = (s) =>
    s.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).join('\n');
  assert.strictEqual(norm(m[1]), norm(read('check-fullscreen.ps1')), '内嵌脚本与 ps1 文件不一致');
});

test('开机启动为 checkbox 且托盘菜单弹出前重建(可正常关闭/状态不过期)', () => {
  const tray = read('modules/tray.js');
  // radio 仅允许出现在"显示模式"子菜单(单选语义正确);开机启动区不得用 radio
  const autoStartSeg = tray.split("label: '开机启动'")[1].split('});')[0];
  assert.ok(!autoStartSeg.includes("type: 'radio'"), '开机启动不应使用 radio(单选语义关不掉)');
  assert.ok(tray.includes("type: 'checkbox'"), '开机启动应使用 checkbox');
  assert.ok(tray.includes("tray.on('right-click'"), '应在右键弹出前重建托盘菜单刷新状态');
  assert.ok(tray.includes('path: process.execPath'), 'setLoginItemSettings 应显式传 path');
  // 显示模式子菜单:悬浮球/鲸鱼娘 radio 二选一
  assert.ok(tray.includes("label: '显示模式'"), '托盘应提供显示模式子菜单');
  assert.ok(tray.includes("label: '悬浮球'"), '显示模式子菜单缺少悬浮球项');
  assert.ok(tray.includes("label: '鲸鱼娘'"), '显示模式子菜单缺少鲸鱼娘项');
  assert.ok(tray.includes('setDisplayMode'), '显示模式切换应走 setDisplayMode');
});

test('安全加固:远程窗口启用 sandbox,外链走 http/https 白名单,拦截内网地址', () => {
  const main = read('main.js');
  const security = read('modules/security.js');
  const seg = main.split('function createMainWindow')[1].split('mainWindow.loadURL(APP_URL);')[0];
  assert.ok(seg.includes('sandbox: true'), '主窗口应启用 sandbox');
  assert.ok(security.includes('function openExternalSafe'), '应存在外链白名单函数');
  assert.ok(!security.includes('shell.openExternal(url)'), '不应再有直接 openExternal(url) 调用');
  assert.ok(security.includes('PRIVATE_HOST_RE'), '应拦截私有/内网地址(防 DNS rebinding)');
});

test('本地 UI 页面均带 CSP,离线兜底与快捷键模块存在', () => {
  for (const f of ['ui/floating.html', 'ui/menu.html', 'ui/overlay.html', 'ui/offline.html', 'ui/pet.html']) {
    assert.ok(read(f).includes('Content-Security-Policy'), `${f} 缺少 CSP`);
  }
  const shortcuts = read('modules/shortcuts.js');
  assert.ok(shortcuts.includes('before-input-event'), '快捷键应走窗口内 before-input-event');
  assert.ok(read('modules/offline.js').includes('attachOfflineFallback'), '离线兜底模块缺失');
});

test('显示模式(悬浮球/鲸鱼娘)装配完整', () => {
  const mode = read('modules/mode.js');
  const pet = read('modules/pet.js');
  const main = read('main.js');
  // mode 模块:状态记忆 + 切换 + 全屏联动 + 活动窗口
  assert.ok(mode.includes('ds-settings.json'), '显示模式应持久化到 userData/ds-settings.json');
  assert.ok(mode.includes('loadMode') && mode.includes('saveMode'), '缺少模式读写');
  assert.ok(mode.includes('hideForFs') && mode.includes('restoreFromFs'), '缺少全屏联动');
  assert.ok(mode.includes('toggleMode') && mode.includes('setDisplayMode'), '缺少模式切换');
  assert.ok(mode.includes('getActiveWindow'), '缺少活动窗口查询(全屏检测依赖)');
  // pet 模块:透明窗口 + 点击穿透
  assert.ok(pet.includes('transparent: true'), '鲸鱼娘窗口应透明');
  assert.ok(pet.includes('setIgnoreMouseEvents'), '鲸鱼娘窗口应支持点击穿透');
  assert.ok(pet.includes('setInterval'), '鲸鱼娘应有轮询命中检测(鼠标静止也能命中)');
  assert.ok(pet.includes('setDragLock'), '鲸鱼娘缺少拖拽锁');
  assert.ok(pet.includes('moveWindow'), '鲸鱼娘缺少主进程移动方法');
  assert.ok(pet.includes('screen.getCursorScreenPoint'), '应轮询光标位置做命中检测');
  // 主进程装配
  assert.ok(main.includes("require('./modules/mode')"), 'main.js 未装配 mode 模块');
  assert.ok(main.includes("require('./modules/pet')"), 'main.js 未装配 pet 模块');
  assert.ok(main.includes("mode.loadMode()"), '启动未读取持久化显示模式');
  assert.ok(main.includes("mode.createActiveWindow()"), '启动未按模式建窗');
  assert.ok(main.includes("case 'pet-drag'"), '缺少 pet-drag 动作(拖拽锁)');
  assert.ok(main.includes("case 'pet-move'"), '缺少 pet-move 动作(主进程移动)');
  assert.ok(main.includes("case 'toggle-mode'"), '缺少 toggle-mode 动作(循环切换)');
});
