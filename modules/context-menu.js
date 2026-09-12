// 右键菜单:网页内容(选中文字 / 可编辑框 / 链接 / 图片 / 媒体)的右键菜单
// 背景:Electron 不为网页内容提供默认右键菜单 —— 不注册 context-menu 事件,右键与长按都毫无反应。
// Windows 下触摸长按会合成同一个 context-menu 事件,因此鼠标右键与长按触摸共用这一条路径。
// 剪贴板动作直接调 webContents.copy()/paste() 等方法(不走 role),不依赖菜单项焦点归属,更确定。
//
// 长按时序(触摸):Chromium 原生手势先选中词、再合成 context-menu。为了让"首次长按只选中文字、
// 再次长按才弹菜单",这里用 selectionBeforeGesture 取手势起点(pointerdown)的选区快照:
//   手势前后选区**不一致**(含手势前没有选区)→ 选区是这次手势刚创建的 → 只选中,不弹菜单;
//   手势前后一致(在已选中的内容上再长按)/ 现在也没选区 / 快照不可用 → 照常弹菜单。
// 鼠标右键不会创建选区,所以右键行为完全不受影响。
const { Menu, clipboard, BrowserWindow, app } = require('electron');

const SEARCH_FALLBACK = 'https://www.bing.com/search?q=';
const resizeHooked = new WeakSet(); // 宿主窗口的 resize 只需挂一次(多标签共用一个窗口)

function create({ log, security, selectionBeforeGesture }) {
  let lastShownAt = 0; // 长按/右键可能连发同一位置事件,150ms 内只弹一次,避免双菜单叠影
  // webview 元素在壳层内容区里的偏移(CSS px)。菜单不传 x/y 时 Electron 会弹在"鼠标光标"处,
  // 而触摸长按的手指位置与光标毫无关系(光标可能停在别的窗口甚至屏幕外),所以必须显式定位。
  // 取偏移是异步的,但只在挂载/窗口尺寸变化时刷新,事件回调里同步读取缓存值,避免给菜单加延迟。
  let hostOffset = null;

  function refreshHostOffset(wc) {
    const hostWc = wc && wc.hostWebContents;
    if (!hostWc || hostWc.isDestroyed()) return;
    const win = hostWindow(wc);
    hostWc
      .executeJavaScript(
        '(function(){var w=document.querySelector("webview");if(!w)return null;' +
          'var b=w.getBoundingClientRect();' +
          'return {x:Math.round(b.x),y:Math.round(b.y),innerH:window.innerHeight};})()',
        true,
      )
      .then((r) => {
        if (!r || typeof r.x !== 'number' || typeof r.y !== 'number') return;
        // Menu.popup 的 x/y 相对"窗口客户区",而壳层页面原点还在客户区内的原生应用菜单栏下方
        // (webview 元素 rect 是相对壳层页面量的,不含这段)。不补偿菜单会整体下偏,这里按
        // 客户区高度 - 页面视口高度 反推菜单栏占位。
        // 注:即便补偿后菜单仍会落在手指下方约 30px —— 这是原生菜单的正常下落姿态(菜单从触点向下展开),
        // 只要"跟着手指而不是跟着鼠标光标"就已经达到目的。
        let dx = 0;
        let dy = 0;
        try {
          const bounds = win && win.getBounds ? win.getBounds() : null;
          const content = win && win.getContentBounds ? win.getContentBounds() : null;
          if (bounds && content) {
            dx = content.x - bounds.x;
            dy = Math.max(0, (content.height || 0) - (r.innerH || 0));
          }
        } catch (e) { /* 取不到就按 0 处理(菜单会略偏,但仍锚定在手指附近) */ }
        hostOffset = { x: dx + r.x, y: dy + r.y };
      })
      .catch(() => { /* 取不到就回退到"鼠标光标位置" */ });
  }

  function popupAt(wc, p) {
    const win = hostWindow(wc);
    const opts = win ? { window: win } : {};
    if (hostOffset && typeof p.x === 'number' && typeof p.y === 'number') {
      opts.x = Math.round(hostOffset.x + p.x);
      opts.y = Math.round(hostOffset.y + p.y);
    }
    Menu.buildFromTemplate(buildMenu(wc, p)).popup(opts);
  }

  // 手势起点快照取文本;返回 null 表示"未知/不支持"(此时退回旧行为,保证不会把菜单卡死)
  function beforeText(wc) {
    if (typeof selectionBeforeGesture !== 'function') return null;
    try {
      const v = selectionBeforeGesture(wc);
      return v === null || v === undefined ? null : String(v);
    } catch (e) {
      return null;
    }
  }

  // webview 的 webContents 不属于任何 BrowserWindow,需经由 hostWebContents 找到宿主窗口
  function hostWindow(wc) {
    try {
      return BrowserWindow.fromWebContents(wc.hostWebContents || wc) || undefined;
    } catch (e) {
      return undefined;
    }
  }

  function alive(wc) {
    return wc && !wc.isDestroyed();
  }

  function buildMenu(wc, params) {
    const p = params || {};
    const flags = p.editFlags || {};
    const selection = String(p.selectionText || '');
    const hasSelection = selection.trim().length > 0;
    const link = String(p.linkURL || '');
    const isHttpLink = /^https?:\/\//i.test(link);
    const items = [];

    if (p.isEditable) {
      // 可编辑区(聊天输入框):完整编辑动作
      items.push(
        { label: '撤销', enabled: flags.canUndo !== false, click: () => alive(wc) && wc.undo() },
        { label: '重做', enabled: flags.canRedo !== false, click: () => alive(wc) && wc.redo() },
        { type: 'separator' },
        { label: '剪切', enabled: hasSelection && flags.canCut !== false, click: () => alive(wc) && wc.cut() },
        { label: '复制', enabled: hasSelection && flags.canCopy !== false, click: () => alive(wc) && wc.copy() },
        { label: '粘贴', enabled: flags.canPaste !== false, click: () => alive(wc) && wc.paste() },
        { label: '全选', enabled: flags.canSelectAll !== false, click: () => alive(wc) && wc.selectAll() },
      );
    } else if (hasSelection) {
      // 只读区(回答正文/搜索结果):复制选中 + 全选整页 + 外部搜索
      items.push(
        { label: '复制', click: () => alive(wc) && wc.copy() },
        { label: '全选', click: () => alive(wc) && wc.selectAll() },
        { type: 'separator' },
        {
          label: '用浏览器搜索所选文字',
          click: () => security.openExternalSafe(SEARCH_FALLBACK + encodeURIComponent(selection.trim().slice(0, 120))),
        },
      );
    }

    if (isHttpLink) {
      if (items.length) items.push({ type: 'separator' });
      items.push(
        { label: '在浏览器中打开链接', click: () => security.openExternalSafe(link) },
        { label: '复制链接地址', click: () => clipboard.writeText(link) },
      );
    }

    if (p.mediaType === 'image') {
      if (items.length) items.push({ type: 'separator' });
      items.push({ label: '复制图片', click: () => alive(wc) && wc.copyImageAt(p.x, p.y) });
      if (isHttpLink) {
        items.push({ label: '在浏览器中打开图片', click: () => security.openExternalSafe(link) });
      }
    } else if (p.mediaType === 'video' || p.mediaType === 'audio') {
      if (items.length) items.push({ type: 'separator' });
      items.push({ label: '复制媒体地址', click: () => clipboard.writeText(link || p.srcURL || '') });
    }

    if (items.length) items.push({ type: 'separator' });
    items.push(
      { label: '后退', enabled: alive(wc) && wc.canGoBack(), click: () => alive(wc) && wc.goBack() },
      { label: '重新加载', click: () => alive(wc) && wc.reload() },
    );
    // 开发者工具只在开发/调试模式出现,打包版默认不暴露
    if (!app.isPackaged || process.env.DS_DEBUG === '1') {
      items.push({ type: 'separator' });
      items.push({ label: '检查元素', click: () => alive(wc) && wc.inspectElement(p.x, p.y) });
    }

    return items;
  }

  // 给 webContents 挂右键菜单(壳层不挂:标签栏走渲染层自绘菜单,避免两套菜单叠加)
  function attach(wc, label) {
    if (!wc) return;
    refreshHostOffset(wc);
    // 宿主窗口尺寸变化(最大化/全屏/拖动改变宽度)后布局可能变,重新取一次 webview 偏移
    const win = hostWindow(wc);
    if (win && typeof win.on === 'function' && !resizeHooked.has(win)) {
      resizeHooked.add(win);
      win.on('resize', () => refreshHostOffset(wc));
    }
    wc.on('context-menu', (_event, params) => {
      const p = params || {};
      const selected = String(p.selectionText || '').trim();
      const before = beforeText(wc);

      // 首次长按:本次手势**新选中**了内容(与手势前的选区不同,含手势前无选区)→ 只保留这次选中,不弹菜单;
      // 手势前选区与现在一致 → 用户在已选中的内容上再长按 → 弹菜单。
      // 判据必须是"选区是否变化",不能只看"手势前有无选区":否则用户在 A 处选过字之后,
      // 到 B 处长按(本意是框选 B 的文字)会直接弹菜单 —— 表现就是"长按不框选、直接弹菜单"。
      if (before !== null && selected && before.trim() !== selected) {
        log(
          '[ctxmenu]', label, '首次长按仅选中(不弹菜单)',
          'selection=' + selected.length,
          'beforeSel=' + before.trim().length,
        );
        return;
      }

      const now = Date.now();
      if (now - lastShownAt < 150) return;
      lastShownAt = now;
      try {
        popupAt(wc, p);
      } catch (e) {
        log('[ctxmenu] build/popup failed:', e && e.message);
      }
      log(
        '[ctxmenu]', label,
        'selection=' + selected.length,
        'editable=' + !!p.isEditable,
        'link=' + !!p.linkURL,
        'media=' + (p.mediaType || '-'),
        'beforeSel=' + (before === null ? '?' : before.trim().length),
        'at=' + p.x + ',' + p.y,
      );
    });
    log('[ctxmenu] attached:', label);
  }

  return { attach, buildMenu };
}

module.exports = { create };
