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
  'ui/floating.html',
  'ui/floating.js',
  'ui/menu.html',
  'ui/menu.js',
  'ui/main.html',
  'ui/main.js',
  'ui/overlay.html',
  'ui/overlay.js',
  'ui/preload-ui.js',
  'ui/ui.css',
  'ui/logo.png',
  'ui/offline.html',
  'ui/pet.html',
  'ui/pet.js',
  'ui/pet-assets/待机呼吸休闲.webm',
  'ui/pet-assets/原地左转奔跑.webm',
  'ui/pet-assets/写代码.webm',
  'ui/pet-assets/打瞌睡被惊醒.webm',
  'modules/logger.js',
  'modules/state.js',
  'modules/security.js',
  'modules/offline.js',
  'modules/ball-menu.js',
  'modules/floating.js',
  'modules/tray.js',
  'modules/screenshot.js',
  'modules/updater.js',
  'modules/shortcuts.js',
  'modules/pet.js',
  'modules/mode.js',
  'modules/focus.js',
];

test('关键文件存在', () => {
  for (const f of REQUIRED_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `缺少文件: ${f}`);
  }
});

test('JS 语法检查(node --check)', () => {
  const jsFiles = [
    'main.js',
    'ui/floating.js',
    'ui/menu.js',
    'ui/main.js',
    'ui/preload-ui.js',
    'ui/pet.js',
    'modules/logger.js',
    'modules/state.js',
    'modules/security.js',
    'modules/offline.js',
    'modules/ball-menu.js',
    'modules/floating.js',
    'modules/tray.js',
    'modules/updater.js',
    'modules/shortcuts.js',
    'modules/pet.js',
    'modules/mode.js',
    'modules/focus.js',
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
  for (const req of ['main.js', 'modules/**/*', 'ui/**/*']) {
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

test('主窗口为多标签壳(webview 标签栏 + 安全校验)', () => {
  const main = read('main.js');
  const seg = main.split('function createMainWindow')[1].split('function showMain')[0];
  assert.ok(seg.includes('webviewTag: true'), '主窗口应启用 webviewTag(多标签)');
  assert.ok(seg.includes('preload: UI_PRELOAD'), '主窗口壳应加载本地 preload');
  assert.ok(seg.includes('loadFile(MAIN_PAGE)'), '主窗口应加载本地壳页面');
  assert.ok(seg.includes('MAIN_W') && seg.includes('MAIN_H'), '缺少主窗默认尺寸常量');
  assert.ok(seg.includes('will-attach-webview'), '缺少 webview 附加白名单校验');
  assert.ok(seg.includes('mainSizeFor'), '缺少按分辨率分档的主窗尺寸');
  assert.ok(seg.includes('wa.width / 2'), '主窗应默认屏幕居中');
  // 壳渲染层:标签管理 + 置顶按钮
  const uiMain = read('ui/main.js');
  assert.ok(uiMain.includes("webview") && uiMain.includes("'tabs:action'"), '壳渲染层缺少标签管理');
  assert.ok(uiMain.includes('createTab') && uiMain.includes('closeTab'), '缺少新建/关闭标签');
  assert.ok(uiMain.includes('tab-pin') && uiMain.includes('toggle-main-top'), '壳渲染层缺少主窗置顶按钮');
  const mainHtml = read('ui/main.html');
  assert.ok(mainHtml.includes('id="tab-pin"'), '主窗壳缺少置顶按钮元素');
  // 快捷键转发
  const shortcuts = read('modules/shortcuts.js');
  assert.ok(shortcuts.includes("'tabs:action'"), '快捷键应转发 tabs:action');
  assert.ok(shortcuts.includes("'t'"), '缺少 Ctrl+T 新标签');
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
  assert.ok(tray.includes("label: '主窗置顶'"), '托盘缺少主窗置顶开关');
  assert.ok(tray.includes('getMainOnTop') && tray.includes('setMainOnTop'), '主窗置顶应走持久化设置');
  assert.ok(tray.includes("label: '前台感知开关'"), '托盘缺少前台感知开关');
  assert.ok(tray.includes("label: '截图提问'"), '托盘缺少截图提问');
  assert.ok(tray.includes('卸载 DS 客户端'), '托盘缺少卸载入口');
  assert.ok(tray.includes('getForegroundAware'), '前台感知开关状态应来自持久化设置');
  assert.ok(tray.includes('setForegroundAware'), '前台感知开关应走 setForegroundAware');
  assert.ok(tray.includes("tray.on('right-click'"), '应在右键弹出前重建托盘菜单刷新状态');
  assert.ok(tray.includes('path: process.execPath'), 'setLoginItemSettings 应显式传 path');
  // 显示模式子菜单:悬浮球/鲸鱼娘 radio 二选一
  assert.ok(tray.includes("label: '显示模式'"), '托盘应提供显示模式子菜单');
  assert.ok(tray.includes("label: '悬浮球'"), '显示模式子菜单缺少悬浮球项');
  assert.ok(tray.includes("label: '鲸鱼娘'"), '显示模式子菜单缺少鲸鱼娘项');
  assert.ok(tray.includes('setDisplayMode'), '显示模式切换应走 setDisplayMode');
  // 尺寸子菜单:小/中/大
  assert.ok(tray.includes("label: '尺寸'"), '托盘应提供尺寸子菜单');
  assert.ok(tray.includes("label: '小'") && tray.includes("label: '中'") && tray.includes("label: '大'"), '尺寸子菜单缺少 小/中/大');
  assert.ok(tray.includes('setWidgetSize'), '尺寸切换应走 setWidgetSize');
});

test('安全加固:外链走 http/https 白名单,拦截内网地址,webview 挂守卫', () => {
  const main = read('main.js');
  const security = read('modules/security.js');
  assert.ok(main.includes('web-contents-created'), '应监听 web-contents-created(webview 挂守卫)');
  assert.ok(main.includes('attachNavigationGuard(fakeWin'), 'webview 应挂导航守卫');
  assert.ok(main.includes('attachOfflineFallback(fakeWin'), 'webview 应挂离线兜底');
  assert.ok(security.includes('function openExternalSafe'), '应存在外链白名单函数');
  assert.ok(!security.includes('shell.openExternal(url)'), '不应再有直接 openExternal(url) 调用');
  assert.ok(security.includes('PRIVATE_HOST_RE'), '应拦截私有/内网地址(防 DNS rebinding)');
});

test('本地 UI 页面均带 CSP,离线兜底与快捷键模块存在', () => {
  for (const f of ['ui/floating.html', 'ui/menu.html', 'ui/main.html', 'ui/overlay.html', 'ui/offline.html', 'ui/pet.html']) {
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
  // mode 模块:状态记忆 + 切换 + 全屏联动 + 活动窗口 + 三态(含"关闭显示"off)
  assert.ok(mode.includes('ds-settings.json'), '显示模式应持久化到 userData/ds-settings.json');
  assert.ok(mode.includes('loadMode') && mode.includes('saveMode'), '缺少模式读写');
  assert.ok(mode.includes('hideForFs') && mode.includes('restoreFromFs'), '缺少全屏联动');
  assert.ok(mode.includes('toggleMode') && mode.includes('setDisplayMode'), '缺少模式切换');
  assert.ok(mode.includes('getActiveWindow'), '缺少活动窗口查询(全屏检测依赖)');
  assert.ok(mode.includes("'off'"), '显示模式应支持"关闭显示"(off)');
  // 托盘:显示模式 radio 三选一(含关闭显示)
  const tray = read('modules/tray.js');
  assert.ok(tray.includes("label: '关闭显示'"), '托盘显示模式子菜单缺少关闭显示项');
  assert.ok(tray.includes("checked: currentMode === 'off'"), '关闭显示 radio 未按当前模式勾选');
  // pet 模块:透明窗口 + 点击穿透
  assert.ok(pet.includes('transparent: true'), '鲸鱼娘窗口应透明');
  assert.ok(pet.includes('setIgnoreMouseEvents'), '鲸鱼娘窗口应支持点击穿透');
  assert.ok(pet.includes('setInterval'), '鲸鱼娘应有轮询命中检测(鼠标静止也能命中)');
  assert.ok(pet.includes('setDragLock'), '鲸鱼娘缺少拖拽锁');
  assert.ok(pet.includes('moveWindow'), '鲸鱼娘缺少主进程移动方法');
  assert.ok(pet.includes('screen.getCursorScreenPoint'), '应轮询光标位置做命中检测');
  // floating 模块:主进程移动 + 位置回传 + 尺寸档位(拖拽与鲸鱼娘对齐)
  const floating = read('modules/floating.js');
  assert.ok(floating.includes('moveWindow'), '悬浮球缺少主进程移动方法');
  assert.ok(floating.includes("'ball-pos'"), '悬浮球缺少位置回传 ball-pos');
  assert.ok(floating.includes('widgetBallSize') && floating.includes('setWidgetSize'), '悬浮球缺少尺寸档位(小/中/大)');
  // 鲸鱼娘尺寸档位 + 页面 100% 填充
  assert.ok(pet.includes('widgetPetSize') && pet.includes('setWidgetSize'), '鲸鱼娘缺少尺寸档位(小/中/大)');
  const petHtml = read('ui/pet.html');
  assert.ok(petHtml.includes('width: 100%') && petHtml.includes('height: 100%'), 'pet.html 应 100% 填充窗口');
  const uiCss = read('ui/ui.css');
  assert.ok(/#ball\s*\{[\s\S]*width: 100%/.test(uiCss), '悬浮球应随窗口尺寸缩放');
  // 尺寸档位设置:mode 持久化 + main 动作 + 托盘子菜单
  assert.ok(mode.includes('widgetSize') && mode.includes('getWidgetSize') && mode.includes('setWidgetSize'), 'mode 缺少尺寸档位');
  assert.ok(mode.includes('rebuildActiveWindow'), 'mode 缺少重建窗口(尺寸档位生效)');
  assert.ok(main.includes('setWidgetSize'), 'main 缺少尺寸档位动作');
  assert.ok(main.includes('rebuildActiveWindow'), 'main 未接重建窗口');
  // 主窗置顶:mode 持久化 + main 动作 + 壳内按钮/托盘
  assert.ok(mode.includes('getMainOnTop') && mode.includes('setMainOnTop'), 'mode 缺少主窗置顶设置');
  assert.ok(main.includes('setMainOnTop') && main.includes('getMainOnTop'), 'main 缺少主窗置顶动作');
  assert.ok(main.includes('toggle-main-top') && main.includes('broadcastMainTop'), '主窗置顶应可壳内切换并广播');
  // 开机启动默认开:首次启动自动设置 + 初始化标记
  assert.ok(mode.includes('isAutoStartInit') && mode.includes('markAutoStartInit'), 'mode 缺少开机启动初始化标记');
  assert.ok(main.includes('setLoginItemSettings'), 'main 缺少开机启动设置');
  // 尺寸联动:悬浮球/鲸鱼娘档位 → 主窗同步缩放(保留标签页)
  assert.ok(main.includes('resizeMainWindow'), 'main 缺少主窗尺寸联动(换档时缩放主窗)');
  // 悬浮球渲染层:拖拽走 IPC,不再依赖渲染进程 moveTo
  const uiFloating = read('ui/floating.js');
  assert.ok(uiFloating.includes("'ball-move'"), '悬浮球拖拽应走 ball-move IPC');
  // 鲸鱼娘渲染层:移动动画池(原地奔跑,自动移动已禁用)
  const petUi = read('ui/pet.js');
  assert.ok(petUi.includes('原地左转奔跑'), '移动池应含跑步动画(原地左转奔跑)');
  // 右键菜单:显示模式三项(勾选高亮)+ 退出
  const menuHtml = read('ui/menu.html');
  assert.ok(menuHtml.includes('data-act="mode-ball"') && menuHtml.includes('data-act="mode-pet"') && menuHtml.includes('data-act="mode-off"'), '右键菜单缺少显示模式三项');
  assert.ok(menuHtml.includes('data-act="quit"'), '右键菜单缺少退出项');
  // 主进程装配
  assert.ok(main.includes("require('./modules/mode')"), 'main.js 未装配 mode 模块');
  assert.ok(main.includes("require('./modules/pet')"), 'main.js 未装配 pet 模块');
  assert.ok(main.includes("mode.loadMode()"), '启动未读取持久化显示模式');
  assert.ok(main.includes("mode.createActiveWindow()"), '启动未按模式建窗');
  assert.ok(main.includes("case 'pet-drag'"), '缺少 pet-drag 动作(拖拽锁)');
  assert.ok(main.includes("case 'pet-move'"), '缺少 pet-move 动作(主进程移动)');
  assert.ok(main.includes("case 'toggle-mode'"), '缺少 toggle-mode 动作(循环切换)');
  assert.ok(main.includes("case 'ball-move'"), '缺少 ball-move 动作(主进程移动悬浮球)');
  assert.ok(main.includes("case 'mode-ball'") && main.includes("case 'mode-off'"), '缺少显式模式动作(mode-ball/mode-off)');
});

test('前台感知:焦点在 DeepSeek 触发 + 程序分类 + 开关门控装配完整', () => {
  const mode = read('modules/mode.js');
  const main = read('main.js');
  const focus = read('modules/focus.js');
  const petUi = read('ui/pet.js');
  const floatingUi = read('ui/floating.js');
  // mode:前台感知开关设置(默认开,持久化)
  assert.ok(mode.includes('foregroundAware'), 'mode 应管理 foregroundAware 设置');
  assert.ok(mode.includes('getForegroundAware') && mode.includes('setForegroundAware'), '缺少前台感知读写');
  // 主进程:装配 focus;全屏脚本 DS_FG_MODE 门控;上下文广播
  assert.ok(main.includes("require('./modules/focus')"), 'main.js 未装配 focus 模块');
  assert.ok(main.includes('DS_FG_MODE'), '全屏脚本缺少 DS_FG_MODE 门控(关=不读前台)');
  assert.ok(main.includes("'pet-context'"), '缺少前台上下文广播 pet-context');
  // focus:进程名分类(含本应用 deepseek)
  assert.ok(focus.includes('function classify'), '缺少前台进程分类');
  assert.ok(focus.includes('deepseek'), '前台分类应识别本应用(deepseek)');
  // 渲染层:鲸鱼娘订阅上下文(deepseek=工作动画)+ 移动动画原地播放;悬浮球订阅上下文徽标
  assert.ok(petUi.includes("'pet-context'"), '鲸鱼娘未订阅前台上下文');
  assert.ok(petUi.includes('deepseek') && petUi.includes('setAnimLoop'), '鲸鱼娘缺少 deepseek 工作动画(循环)');
  assert.ok(petUi.includes('applyPerception'), '鲸鱼娘缺少状态感知落地');
  assert.ok(petUi.includes('原地奔跑'), '移动动画应原地播放(已禁用自动移动)');
  assert.ok(petUi.includes('showBubble') && petUi.includes('DRINK_MSGS'), '鲸鱼娘缺少趣味气泡');
  assert.ok(petUi.includes('ANIM_BUBBLES'), '鲸鱼娘缺少动作台词气泡');
  assert.ok(petUi.includes('BUBBLE_COOLDOWN_MS'), '鲸鱼娘缺少气泡冷却(防轰炸)');
  assert.ok(petUi.includes('showBubble(pick(GREETINGS), 0, true)'), '欢迎语应绕过气泡冷却(force)');
  assert.ok(petUi.includes('SLEEP_AFTER_MS') && petUi.includes('goSleep') && petUi.includes('wakeUp'), '鲸鱼娘缺少入睡/唤醒机制');
  // 悬浮右键菜单:截图提问入口
  assert.ok(read('ui/menu.html').includes('data-act="screenshot"'), '悬浮右键菜单缺少截图提问');
  // 主进程:选区截图 + 粘贴到当前标签 + 卸载 + 置顶联动刷新
  assert.ok(main.includes('overlay:ready') && main.includes("'crop'"), '缺少框选截图事件');
  assert.ok(main.includes('pasteToActiveWebview') && main.includes("'tab-active'"), '缺少截图粘贴(活动标签)驱动');
  assert.ok(main.includes('webviewWcs') && main.includes('activeWcId'), '缺少活动标签 webContents 定位');
  assert.ok(main.includes('uninstallApp') && main.includes('dialog.showMessageBox'), '缺少卸载流程(二次确认)');
  assert.ok(main.includes('tray.refresh()'), '置顶切换应刷新托盘菜单');
  // 框选遮罩:交互与载荷
  const overlayUi = read('ui/overlay.js');
  assert.ok(overlayUi.includes("api.action('overlay:ready')") && overlayUi.includes("'crop'"), '遮罩缺少框选流程');
  // 壳:粘贴到当前标签(不新建)+ 上报活动标签
  const shellUi = read('ui/main.js');
  const pasteSeg = shellUi.split("'screenshot-paste'")[1].split("'screenshot-paste-loaded'")[0];
  assert.ok(pasteSeg && !pasteSeg.includes('createTab()'), '壳截图粘贴应作用于当前标签(不新建)');
  assert.ok(shellUi.includes('reportActiveTab'), '壳缺少活动标签上报');
  assert.ok(floatingUi.includes("'pet-context'"), '悬浮球未订阅前台上下文');
  assert.ok(floatingUi.includes('badge'), '悬浮球缺少状态徽标');
});
