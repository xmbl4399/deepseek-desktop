// 主窗口多标签壳渲染层:标签栏 + webview 管理 + 页内查找条 + 标签右键菜单
// 标签页 = <webview src="https://chat.deepseek.com/">(共享默认会话,登录态一致)
// 快捷键(Ctrl+T/Ctrl+Tab/Ctrl+R/Ctrl+F/Ctrl+Shift+T/Ctrl+Shift+W)由主进程 before-input-event
// 捕获后经 tabs:action 转发到本页;标签管理、自绘菜单、查找条 UI 都在这一层。
const api = window.ds;
const tabbar = document.getElementById('tabbar');
const views = document.getElementById('views');
const addBtn = document.getElementById('tab-add');
const pinBtn = document.getElementById('tab-pin');
const findbar = document.getElementById('findbar');
const findInput = document.getElementById('find-input');
const findCount = document.getElementById('find-count');
const tabmenuEl = document.getElementById('tabmenu');

const APP_URL = 'https://chat.deepseek.com/';
const TITLE_MAX = 12;
const CLOSED_MAX = 10; // 可恢复的已关闭标签上限

let tabs = [];         // {id, btn, view, crash, title, crashed}
let activeId = null;
let seq = 0;
let closedStack = [];  // 已关闭标签的 URL 栈(供 Ctrl+Shift+T 恢复)
let draggingId = null; // 拖拽排序:被拖动的标签

function tabById(id) {
  return tabs.find((t) => t.id === id);
}

function createTab(url) {
  const id = 'tab-' + (++seq);
  // 标签按钮
  const btn = document.createElement('div');
  btn.className = 'tab';
  btn.draggable = true;
  const title = document.createElement('span');
  title.className = 'tab-title';
  title.textContent = '新对话';
  const close = document.createElement('span');
  close.className = 'tab-close';
  close.textContent = '×';
  close.title = '关闭标签';
  btn.appendChild(title);
  btn.appendChild(close);
  btn.addEventListener('click', () => switchTab(id));
  // 中键关闭(浏览器习惯)
  btn.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      closeTab(id);
    }
  });
  // 右键菜单:壳层自绘(网页内容的右键菜单由主进程承接,两者互不干扰)
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openTabMenu(id, e.clientX, e.clientY);
  });
  // 拖拽排序
  btn.addEventListener('dragstart', (e) => {
    draggingId = id;
    btn.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', id); } catch (err) { /* ignore */ }
  });
  btn.addEventListener('dragend', () => {
    draggingId = null;
    btn.classList.remove('dragging');
  });
  btn.addEventListener('dragover', (e) => {
    if (!draggingId || draggingId === id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    reorderTab(draggingId, id, e.clientX);
  });
  close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
  tabbar.insertBefore(btn, addBtn);

  // webview(共享默认会话 = 同一登录态)
  const view = document.createElement('webview');
  view.setAttribute('src', url || APP_URL);
  view.className = 'tab-view';
  view.addEventListener('page-title-updated', (e) => {
    const t = (e.title || 'DeepSeek').trim();
    title.textContent = t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) + '…' : t;
  });
  // 附加完成后上报活动标签(getWebContentsId 在附加前不可用,新建标签须等 did-attach)
  view.addEventListener('did-attach', () => {
    const tab = tabById(id);
    if (tab) reportActiveTab(tab);
  });
  // 崩溃/无响应兜底:否则标签白屏且毫无提示,只能整窗重启
  view.addEventListener('render-process-gone', () => {
    const tab = tabById(id);
    if (tab) showCrash(tab, '页面已崩溃');
    api.log('[shell] render-process-gone, tab=' + id);
  });
  view.addEventListener('unresponsive', () => {
    const tab = tabById(id);
    if (tab) showCrash(tab, '页面无响应');
    api.log('[shell] unresponsive, tab=' + id);
  });
  views.appendChild(view);

  // 崩溃遮罩(同一层叠区,盖住对应 webview)
  const crash = document.createElement('div');
  crash.className = 'tab-crash';
  const crashText = document.createElement('div');
  crashText.textContent = '页面已崩溃';
  const crashBtn = document.createElement('button');
  crashBtn.textContent = '重新加载';
  crashBtn.addEventListener('click', () => {
    const tab = tabById(id);
    if (!tab) return;
    hideCrash(tab);
    try { tab.view.reload(); } catch (e) { /* ignore */ }
  });
  crash.appendChild(crashText);
  crash.appendChild(crashBtn);
  views.appendChild(crash);

  tabs.push({ id, btn, view, crash, crashText, title, crashed: false });
  switchTab(id);
  return view; // 供截图粘贴等场景取 webview
}

// 崩溃态:遮罩盖住 webview(同时摘掉 active,防遮罩被 webview 图层压住)
function showCrash(tab, reason) {
  tab.crashed = true;
  tab.crashText.textContent = reason;
  tab.crash.classList.add('show');
  tab.view.classList.remove('active');
}

function hideCrash(tab) {
  tab.crashed = false;
  tab.crash.classList.remove('show');
  if (tab.id === activeId) tab.view.classList.add('active');
}

function switchTab(id) {
  activeId = id;
  for (const t of tabs) {
    const active = t.id === id;
    t.btn.classList.toggle('active', active);
    t.view.classList.toggle('active', active && !t.crashed);
  }
  // 激活标签聚焦,键盘输入直达聊天页
  const t = tabById(id);
  if (t && t.view.focus && !t.crashed) t.view.focus();
  reportActiveTab(t);
  // 查找条开着时切换标签:在新标签重新检索一次
  if (findbar.classList.contains('show') && findInput.value) {
    api.action('find', { text: findInput.value });
  }
}

// 上报当前活动标签给主进程(截图粘贴/查找/缩放都以此定位)
function reportActiveTab(t) {
  if (!t || !t.view || typeof t.view.getWebContentsId !== 'function') return;
  try {
    api.action('tab-active', { id: t.view.getWebContentsId() });
  } catch (e) { /* ignore */ }
}

function pushClosed(url) {
  if (!url) return;
  closedStack.push(url);
  if (closedStack.length > CLOSED_MAX) closedStack.shift();
}

function closeTab(id) {
  if (tabs.length <= 1) {
    showToast('至少保留一个标签页');
    return;
  }
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const [t] = tabs.splice(idx, 1);
  try { pushClosed(t.view.getURL()); } catch (e) { /* ignore */ }
  t.btn.remove();
  t.crash.remove();
  t.view.remove();
  if (activeId === id) switchTab(tabs[Math.max(0, idx - 1)].id);
}

function closeOtherTabs(id) {
  for (const t of tabs.slice()) {
    if (t.id !== id) closeTab(t.id);
  }
  switchTab(id);
}

function reopenTab() {
  const url = closedStack.pop();
  createTab(url || APP_URL);
}

function reloadTab(id) {
  const t = tabById(id || activeId);
  if (!t) return;
  hideCrash(t);
  if (t.view.reload) t.view.reload();
}

function reorderTab(fromId, overId, clientX) {
  const from = tabById(fromId);
  const over = tabById(overId);
  if (!from || !over || from === over) return;
  const rect = over.btn.getBoundingClientRect();
  const insertAfter = clientX > rect.left + rect.width / 2;
  const fromIdx = tabs.indexOf(from);
  let toIdx = tabs.indexOf(over);
  tabs.splice(fromIdx, 1);
  if (toIdx > fromIdx) toIdx -= 1;
  tabs.splice(insertAfter ? toIdx + 1 : toIdx, 0, from);
  for (const t of tabs) tabbar.insertBefore(t.btn, addBtn); // DOM 顺序同步数组顺序
}

// ---------------- 标签栏右键菜单(自绘) ----------------
function closeTabMenu() {
  tabmenuEl.classList.remove('show');
}

function openTabMenu(id, x, y) {
  const t = tabById(id);
  if (!t) return;
  const only1 = tabs.length <= 1;
  const entries = [
    { label: '刷新', act: () => reloadTab(id) },
    { label: '复制标签标题', act: () => copyText(t.title.textContent) },
    { sep: true },
    { label: '新建标签', act: () => createTab() },
    { label: '关闭标签', act: () => closeTab(id), off: only1 },
    { label: '关闭其他标签', act: () => closeOtherTabs(id), off: only1 },
  ];
  tabmenuEl.innerHTML = '';
  for (const it of entries) {
    if (it.sep) {
      const hr = document.createElement('div');
      hr.style.cssText = 'height:1px;margin:4px 6px;background:var(--bar-border)';
      tabmenuEl.appendChild(hr);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'mi' + (it.off ? ' off' : '');
    el.textContent = it.label;
    if (!it.off) {
      el.addEventListener('click', () => {
        closeTabMenu();
        it.act();
      });
    }
    tabmenuEl.appendChild(el);
  }
  // 先显示再量尺寸,保证贴边时不出界
  tabmenuEl.classList.add('show');
  const rect = tabmenuEl.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  tabmenuEl.style.left = Math.max(4, Math.min(x, maxX)) + 'px';
  tabmenuEl.style.top = Math.max(4, Math.min(y, maxY)) + 'px';
}

function copyText(text) {
  api.action('copy-text', { text: text || '' });
  showToast('已复制');
}

document.addEventListener('click', () => closeTabMenu());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTabMenu();
});
window.addEventListener('blur', () => closeTabMenu());
// 拖拽过程中不弹出菜单
tabbar.addEventListener('dragstart', () => closeTabMenu());

// ---------------- 查找条(Ctrl+F,作用于当前标签) ----------------
function openFindBar() {
  findbar.classList.add('show');
  findInput.focus();
  findInput.select();
}

function closeFindBar() {
  findbar.classList.remove('show');
  findCount.textContent = '';
  api.action('find', { text: '' }); // 清空高亮
  const t = tabById(activeId);
  if (t && t.view.focus && !t.crashed) t.view.focus();
}

let findTimer = null;
findInput.addEventListener('input', () => {
  if (findTimer) clearTimeout(findTimer);
  findTimer = setTimeout(() => {
    findCount.textContent = '';
    api.action('find', { text: findInput.value });
  }, 180);
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    api.action('find', { text: findInput.value, findNext: true, backward: e.shiftKey });
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFindBar();
  }
});
document.getElementById('find-next').addEventListener('click', () => api.action('find', { text: findInput.value, findNext: true }));
document.getElementById('find-prev').addEventListener('click', () => api.action('find', { text: findInput.value, findNext: true, backward: true }));
document.getElementById('find-close').addEventListener('click', closeFindBar);
api.on('find-open', () => openFindBar());
api.on('find-closed', () => findbar.classList.remove('show'));
api.on('find-result', (r) => {
  if (!r) return;
  findCount.textContent = r.matches ? r.active + '/' + r.matches : '无结果';
});

// ---------------- 主进程快捷键转发:new / next / prev / reload / close / reopen ----------------
api.on('tabs:action', (msg) => {
  if (!msg || !msg.action) return;
  if (msg.action === 'new') {
    createTab();
  } else if (msg.action === 'close') {
    closeTab(activeId);
  } else if (msg.action === 'reopen') {
    reopenTab();
  } else if (msg.action === 'next' || msg.action === 'prev') {
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((t) => t.id === activeId);
    const next = (idx + (msg.action === 'next' ? 1 : tabs.length - 1)) % tabs.length;
    switchTab(tabs[next].id);
  } else if (msg.action === 'reload') {
    reloadTab(activeId);
  }
});

addBtn.addEventListener('click', () => createTab());

// 主窗置顶:主窗内按钮切换(主进程持久化 + 广播状态;托盘同源)
pinBtn.addEventListener('click', () => api.action('toggle-main-top'));
api.on('main-top', (s) => {
  pinBtn.classList.toggle('active', !!(s && s.on));
});

// 提示条(截图/操作反馈)
const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(text) {
  if (!toastEl || !text) return;
  toastEl.textContent = text;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3500);
}
api.on('toast', (s) => showToast(s && s.text));

// 截图粘贴:主进程框选完成 → 不新建标签,粘贴到当前(活动)标签;
// 就绪后回发 screenshot-paste-loaded 并**携带活动标签的 webContents id**(主进程按 id 精确定位,
// 不依赖此前 tab-active 上报,彻底消除竞态)
api.on('screenshot-paste', () => {
  api.log('[ss] shell screenshot-paste -> active tab, tabs=', tabs.length);
  const t = tabById(activeId);
  if (!t) return;
  const done = () => {
    let id = null;
    try { id = t.view.getWebContentsId(); } catch (e) { /* ignore */ }
    api.log('[ss] shell paste-ready, wcId=', id);
    api.action('screenshot-paste-loaded', { id });
  };
  let loading = false;
  try { loading = !!(t.view.isLoading && t.view.isLoading()); } catch (e) { loading = true; }
  if (loading) {
    t.view.addEventListener('did-finish-load', done, { once: true });
  } else {
    done();
  }
});

createTab(); // 启动默认一个标签
