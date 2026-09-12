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
  'ui/webview-preload.js',
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
  'modules/context-menu.js',
  'modules/menu-model.js',
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
    'modules/context-menu.js',
    'modules/menu-model.js',
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
  // Windows 平板触摸目标:.tab 行高与 + / 置顶按钮都要 ≥34px(鼠标时代的 26px 太窄)
  const barH = Number((mainHtml.match(/#tabbar\s*\{[\s\S]*?height:\s*(\d+)px/) || [])[1]);
  const tabH = Number((mainHtml.match(/\.tab\s*\{[\s\S]*?height:\s*(\d+)px/) || [])[1]);
  const pinH = Number((mainHtml.match(/#tab-pin\s*\{[\s\S]*?height:\s*(\d+)px/) || [])[1]);
  const addH = Number((mainHtml.match(/#tab-add\s*\{[\s\S]*?height:\s*(\d+)px/) || [])[1]);
  assert.ok(barH >= 44, `标签栏高度应 ≥44px(触摸),实际 ${barH}`);
  assert.ok(tabH >= 34, `标签页高度应 ≥34px(触摸),实际 ${tabH}`);
  assert.ok(pinH >= 34 && addH >= 34, `置顶/新建按钮应 ≥34px(触摸),实际 pin=${pinH} add=${addH}`);
  // 内容区顶部偏移必须跟着标签栏高度走,否则 webview 会被压住或被留白顶开
  assert.ok(
    mainHtml.includes(`inset: ${barH}px 0 0 0`),
    `#views 的 inset 顶部(${barH}px)与 #tabbar 高度不一致`,
  );
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

test('托盘菜单来自共用模型(项序/分组单一来源),弹出前重建保证勾选不过期', () => {
  const tray = read('modules/tray.js');
  const model = read('modules/menu-model.js');
  const main = read('main.js');
  // 项序/分组只在 menu-model.js 定义;tray.js 只负责"画",不得再硬编码 label
  assert.ok(tray.includes("require('./menu-model')"), '托盘应从共用菜单模型取项序');
  assert.ok(tray.includes('toTemplate'), '托盘缺少模型 → 原生模板的转换');
  assert.ok(!tray.includes("label: '开机启动'"), '托盘不应再硬编码菜单项(label 归 menu-model)');
  assert.ok(!tray.includes("label: '显示模式'"), '托盘不应再硬编码子菜单');
  // 模型侧:分组顺序 动作 → 桌宠 → 开关 → 信息 → 终结
  for (const key of ["key: 'action'", "key: 'pet'", "key: 'toggle'", "key: 'info'", "key: 'end'"]) {
    assert.ok(model.includes(key), `菜单模型缺少分组 ${key}`);
  }
  assert.ok(model.includes('trayOnly'), '模型缺少 trayOnly(托盘专属项过滤)');
  assert.ok(model.includes("caption: '尺寸'"), '球菜单缺少尺寸分组的标题');
  // 开关必须 checkbox(radio 单选语义关不掉);尺寸/模式 radio
  assert.ok(model.includes("type: 'checkbox'"), '开关项应使用 checkbox');
  assert.ok(model.includes("type: 'radio'"), '模式/尺寸应使用 radio');
  // 每次右键弹出前重建(勾选状态与真实设置一致)
  assert.ok(tray.includes("tray.on('right-click'"), '应在右键弹出前重建托盘菜单刷新状态');
  // 开机启动:显式传 path(Windows 下不传会因 exe 路径不一致误判状态)
  assert.ok(main.includes('path: process.execPath'), 'setLoginItemSettings 应显式传 path');
  // 两个入口共用同一动作分发入口
  assert.ok(main.includes('onMenuAction: onUiAction'), '托盘菜单项应走主进程统一动作分发');
  assert.ok(main.includes('getMenuContext'), '缺少菜单上下文(项序渲染依据)');
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
  // 站外链接点击:网页拦截点击导致守卫不触发 → 注入捕获器 + webview preload 通道
  assert.ok(main.includes('LINK_GUARD_SCRIPT'), '缺少站外链接点击捕获器');
  assert.ok(main.includes("'webview:open-external'"), '缺少 webview 外链通道');
  assert.ok(main.includes('WEBVIEW_PRELOAD'), '缺少 webview preload(外链通道)');
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
  // 菜单:显示模式 radio 三选一(含关闭显示),项序定义在共用模型里
  const menuModelSrc = read('modules/menu-model.js');
  assert.ok(menuModelSrc.includes("'关闭显示'"), '菜单模型缺少关闭显示项');
  assert.ok(menuModelSrc.includes("radio('mode-off'"), '关闭显示应为 radio 且按当前模式勾选');
  assert.ok(menuModelSrc.includes("radio('size-small'"), '菜单模型缺少尺寸档位(小/中/大)');
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
  // 悬浮球手势与鲸鱼娘对齐:双击(240ms 内两击)才开关主窗,单击不响应
  const uiBallSrc = read('ui/floating.js');
  assert.ok(!uiBallSrc.includes('dblclick'), '悬浮球不应再依赖 dblclick 事件(与鲸鱼娘统一为 240ms 二次点击判定)');
  const toggleHits = (uiBallSrc.match(/toggle-main/g) || []).length;
  assert.ok(toggleHits === 1, `悬浮球只应有一处 toggle-main(双击分支),实际 ${toggleHits}`);
  assert.ok(
    !/setTimeout\([\s\S]{0,80}toggle-main/.test(uiBallSrc),
    '悬浮球单击分支不得再调用 toggle-main(单击应完全不响应)',
  );
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
  // 自绘右键菜单:项序由模型渲染 + 支持键盘操作(原生菜单有整套键位,自绘的不能缺)
  const menuHtml = read('ui/menu.html');
  const menuJs = read('ui/menu.js');
  assert.ok(menuHtml.includes('id="menu"') && !menuHtml.includes('data-act='), '自绘菜单项应由模型渲染,不再硬编码在 HTML 里');
  assert.ok(menuJs.includes('__dsMenuRender'), '菜单渲染层缺少模型入口(__dsMenuRender)');
  assert.ok(menuJs.includes("'ArrowDown'") && menuJs.includes("'ArrowUp'"), '自绘菜单缺少 ↑↓ 导航');
  assert.ok(menuJs.includes("'Escape'"), '自绘菜单缺少 Esc 关闭');
  assert.ok(menuJs.includes("'Enter'"), '自绘菜单缺少 Enter 执行');
  // 触摸友好:行高必须比原来的 26px 大(12px 字 + 7px 内边距)
  assert.ok(/\.mi\s*\{[\s\S]*padding:\s*9px/.test(menuHtml), '自绘菜单行高应加大(触摸点选命中率)');
  // 可折叠子菜单:显示模式+尺寸合计 6 项,平铺会把高频项挤出屏幕 → 父行 + 就地展开
  assert.ok(menuJs.includes('buildSubmenu') && menuJs.includes('toggleSub'), '自绘菜单缺少可折叠子菜单');
  assert.ok(menuHtml.includes('.subwrap.open .sub'), '子项应默认收起(展开才显示)');
  assert.ok(menuJs.includes('api.resize'), '折叠组展开后应回报新尺寸(否则窗口高度不跟着变)');
  assert.ok(menuJs.includes('offsetParent'), '键盘导航应跳过收起中的子项');
  // 模型 → 渲染层的下发链路
  assert.ok(read('modules/ball-menu.js').includes("'ball'"), '悬浮球菜单应按 ball 入口取模型(过滤托盘专属项)');
  // 尺寸重设必须绕开 ui:action —— onUiAction 会先关掉菜单窗口,展开折叠组不能触发那套语义
  assert.ok(main.includes("on('ui:resize'"), '主进程缺少菜单尺寸重设通道(ui:resize)');
  assert.ok(!read('ui/preload-ui.js').includes("resize: (w, h) => ipcRenderer.send('ui:action'"), '折叠组尺寸回报不应走 ui:action');
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
  // 菜单:截图提问入口(与托盘共用同一份模型)
  assert.ok(read('modules/menu-model.js').includes("act: 'screenshot'"), '菜单缺少截图提问');
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

test('v1.1.3 品牌统一:标题栏/托盘名/卸载文案 + Windows 应用标识', () => {
  // 窗口标题:壳页面必须有 <title>,否则 Electron 回退 app.name(= deepseek-desktop)
  assert.ok(read('ui/main.html').includes('<title>DeepSeek</title>'), '壳页面缺少 <title>DeepSeek</title>');
  const main = read('main.js');
  assert.ok(main.includes("title: 'DeepSeek'"), '主窗缺少 title 兜底(首帧不闪旧名)');
  assert.ok(main.includes("app.setAppUserModelId('com.deepseek.desktop')"), '缺少 Windows 应用标识(任务栏/通知)');
  assert.ok(main.includes("title: '卸载 DeepSeek'"), '卸载确认框标题未统一');
  // 卸载程序实际文件名来自 productName,不能跟着显示文案改
  assert.ok(main.includes("'Uninstall', 'DeepSeek Desktop.exe'"), '卸载器路径不应改动(安装目录实际产物)');
  const tray = read('modules/tray.js');
  assert.ok(tray.includes("setToolTip('DeepSeek')"), '托盘悬浮名应为 DeepSeek');
  assert.ok(tray.includes('displayBalloon'), '缺少首次"关闭到托盘"提示');
  // "关于"带版本号(原先只有点开对话框才看得到版本,而菜单是最常打开的入口)
  const modelSrc = read('modules/menu-model.js');
  assert.ok(modelSrc.includes("'关于 DeepSeek'"), '菜单缺少"关于"入口(版本号可见性)');
  assert.ok(modelSrc.includes("' v' + c.version"), '关于项应带上当前版本号');
  // 只改显示名:name / productName 牵动 userData 目录与安装路径,不得改动
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.name, 'deepseek-desktop', 'package.json name 不可改(userData 目录派生自它)');
  assert.strictEqual(pkg.build.productName, 'DeepSeek Desktop', 'productName 不可改(安装目录/卸载器路径派生自它)');
});

test('右键/长按菜单 + 站内判定按 origin 精确比较', () => {
  const ctx = read('modules/context-menu.js');
  assert.ok(ctx.includes("on('context-menu'"), '缺少 context-menu 事件注册(右键与长按触摸共用)');
  assert.ok(ctx.includes('copyImageAt'), '图片右键缺少"复制图片"');
  assert.ok(ctx.includes('openExternalSafe'), '链接右键必须走外链白名单');
  assert.ok(read('main.js').includes('contextMenu.attach'), '主进程未给标签页挂右键菜单');
  // 长按时序:首次长按只选中、再次长按才弹菜单(靠手势起点选区快照区分)
  assert.ok(ctx.includes('selectionBeforeGesture'), '右键菜单缺少手势起点选区快照依赖');
  assert.ok(ctx.includes('首次长按仅选中'), '右键菜单缺少"首次长按只选中"分支');
  assert.ok(read('main.js').includes('webview:selection-snapshot'), '主进程未接收选区快照 IPC');
  const wvPreload = read('ui/webview-preload.js');
  assert.ok(wvPreload.includes('webview:selection-snapshot'), 'preload 未上报选区快照');
  assert.ok(wvPreload.includes("'pointerdown'"), 'preload 未在 pointerdown(手势起点)取样');
  // 菜单必须显式定位:不传 x/y 时 Electron 弹在鼠标光标处,触摸长按会跑到跟手指无关的位置
  assert.ok(ctx.includes('refreshHostOffset'), '右键菜单缺少 webview 偏移获取(菜单定位)');
  assert.ok(ctx.includes('getBoundingClientRect'), '缺少壳层 webview 元素位置探测');
  assert.ok(ctx.includes('opts.x') && ctx.includes('opts.y'), '弹菜单时未显式传 x/y');
  // 安全:站内判定必须 origin 精确比较(前缀匹配会被 *.evil.tld / userinfo 骗过)
  const security = read('modules/security.js');
  assert.ok(security.includes('function isAppUrl'), '缺少 isAppUrl(origin 精确比较)');
  assert.ok(!security.includes('url.startsWith(APP_ORIGIN)'), '不应再用前缀匹配判定站内');
  assert.ok(!read('main.js').includes('params.src.startsWith(security.APP_ORIGIN)'), 'webview 白名单应走 isAppUrl');
  assert.ok(!read('main.js').includes('href.startsWith(ORIGIN)'), '注入脚本应走 origin 比较');
});

test('交互补齐:中文应用菜单 / 页内查找 / 缩放 / 标签右键与崩溃兜底', () => {
  const main = read('main.js');
  assert.ok(main.includes('Menu.setApplicationMenu'), '缺少中文应用菜单(否则 Alt 弹 Electron 英文默认菜单)');
  assert.ok(main.includes('setupAppMenu'), '缺少应用菜单装配');
  assert.ok(main.includes('findInPage') && main.includes("wc.on('found-in-page'"), '缺少页内查找与结果回传');
  assert.ok(main.includes('zoomActive') && main.includes('setZoomLevel'), '缺少缩放');
  const shortcuts = read('modules/shortcuts.js');
  assert.ok(shortcuts.includes("case 'f'"), '缺少 Ctrl+F');
  assert.ok(shortcuts.includes("'in'") && shortcuts.includes("'out'"), '缺少 Ctrl+=/- 缩放');
  assert.ok(shortcuts.includes('reopen'), '缺少 Ctrl+Shift+T 恢复标签');
  assert.ok(shortcuts.includes("action: 'close'"), '缺少 Ctrl+Shift+W 关闭标签');
  const shellUi = read('ui/main.js');
  assert.ok(shellUi.includes('openTabMenu') && shellUi.includes('closeOtherTabs'), '壳层缺少标签右键菜单');
  assert.ok(shellUi.includes('auxclick'), '壳层缺少中键关闭标签');
  assert.ok(shellUi.includes('reorderTab'), '壳层缺少标签拖拽排序');
  assert.ok(shellUi.includes('render-process-gone'), '壳层缺少标签崩溃兜底');
  assert.ok(shellUi.includes('reopenTab'), '壳层缺少恢复已关闭标签');
  assert.ok(read('ui/main.html').includes('id="findbar"'), '壳页面缺少查找条');
  assert.ok(read('ui/main.html').includes('id="tabmenu"'), '壳页面缺少标签菜单容器');
});

test('悬浮球默认位置:右缘贴边 + 高度 2/3 处(不再垂直居中)', () => {
  const floating = read('modules/floating.js');
  assert.ok(floating.includes('BALL_Y_RATIO'), '缺少默认停靠高度常量');
  assert.ok(!floating.includes('Math.round(wa.height / 2)'), '默认位不应再垂直居中');
});

test('鲸鱼娘默认位置:右缘贴边 + 人物中心落在下三分之一(与悬浮球同款)', () => {
  const pet = read('modules/pet.js');
  assert.ok(pet.includes('PET_Y_RATIO'), '缺少默认停靠高度常量');
  assert.ok(!pet.includes('Math.round(wa.height / 2)'), '默认位不应再垂直居中');
  // 锚定的是 HIT 区(人物)中心,不是窗口中心 —— 窗口顶部有透明留白
  assert.ok(pet.includes('hitCenterY'), '应按人物命中区中心定位,否则人物会偏上');
});
