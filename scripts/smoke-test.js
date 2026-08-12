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
  'index.html',
  'ui/floating.html',
  'ui/floating.js',
  'ui/menu.html',
  'ui/menu.js',
  'ui/overlay.html',
  'ui/overlay.js',
  'ui/preload-ui.js',
  'ui/ui.css',
  'ui/logo.png',
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
});

test('main.js 包含关键修复', () => {
  const main = read('main.js');
  assert.ok(main.includes('requestSingleInstanceLock'), '缺少单实例锁');
  assert.ok(!main.includes('globalShortcut'), '快捷键应已删除');
  assert.ok(main.includes('setWindowOpenHandler'), '缺少 window.open 拦截');
  assert.ok(main.includes('FS_CHECK_SCRIPT'), '缺少内嵌全屏检测脚本');
  assert.ok(main.includes('autoUpdater'), '缺少自动更新');
  assert.ok(!main.includes('check-fullscreen.ps1') || main.includes('内嵌'), '不应依赖外部 ps1 文件');
});

test('主窗口不使用 preload', () => {
  const main = read('main.js');
  // createMainWindow 的 webPreferences 中不应出现 preload 属性
  const seg = main.split('function createMainWindow')[1].split('mainWindow.loadURL(APP_URL);')[0];
  assert.ok(!seg.includes('preload:'), '主窗口不应加载 preload');
});
