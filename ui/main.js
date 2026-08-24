// 主窗口多标签壳渲染层:标签栏 + webview 管理
// 标签页 = <webview src="https://chat.deepseek.com/">(共享默认会话,登录态一致)
// 快捷键(Ctrl+T/Ctrl+Tab/Ctrl+R)由主进程 before-input-event 捕获后经 tabs:action 转发到本页
const api = window.ds;
const tabbar = document.getElementById('tabbar');
const views = document.getElementById('views');
const addBtn = document.getElementById('tab-add');
const pinBtn = document.getElementById('tab-pin');

const APP_URL = 'https://chat.deepseek.com/';
const TITLE_MAX = 12;

let tabs = [];      // {id, btn, view}
let activeId = null;
let seq = 0;

function createTab() {
  const id = 'tab-' + (++seq);
  // 标签按钮
  const btn = document.createElement('div');
  btn.className = 'tab';
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
  close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
  tabbar.insertBefore(btn, addBtn);

  // webview(共享默认会话 = 同一登录态)
  const view = document.createElement('webview');
  view.setAttribute('src', APP_URL);
  view.className = 'tab-view';
  view.addEventListener('page-title-updated', (e) => {
    const t = (e.title || 'DeepSeek').trim();
    title.textContent = t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) + '…' : t;
  });
  // 附加完成后上报活动标签(getWebContentsId 在附加前不可用,新建标签须等 did-attach)
  view.addEventListener('did-attach', () => {
    const tab = tabs.find((x) => x.id === id);
    if (tab) reportActiveTab(tab);
  });
  views.appendChild(view);

  tabs.push({ id, btn, view, title });
  switchTab(id);
  return view; // 供截图粘贴等场景取 webview
}

function switchTab(id) {
  activeId = id;
  for (const t of tabs) {
    const active = t.id === id;
    t.btn.classList.toggle('active', active);
    t.view.classList.toggle('active', active);
  }
  // 激活标签聚焦,键盘输入直达聊天页
  const t = tabs.find((x) => x.id === id);
  if (t && t.view.focus) t.view.focus();
  reportActiveTab(t);
}

// 上报当前活动标签给主进程(截图粘贴兜底定位)
function reportActiveTab(t) {
  if (!t || !t.view || typeof t.view.getWebContentsId !== 'function') return;
  try {
    api.action('tab-active', { id: t.view.getWebContentsId() });
  } catch (e) { /* ignore */ }
}

function closeTab(id) {
  if (tabs.length <= 1) return; // 至少保留一个标签
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const [t] = tabs.splice(idx, 1);
  t.btn.remove();
  t.view.remove();
  if (activeId === id) switchTab(tabs[Math.max(0, idx - 1)].id);
}

function reloadActive() {
  const t = tabs.find((x) => x.id === activeId);
  if (t && t.view.reload) t.view.reload();
}

// 主进程快捷键转发:new / next / prev / reload
api.on('tabs:action', (msg) => {
  if (!msg || !msg.action) return;
  if (msg.action === 'new') {
    createTab();
  } else if (msg.action === 'next' || msg.action === 'prev') {
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((t) => t.id === activeId);
    const next = (idx + (msg.action === 'next' ? 1 : tabs.length - 1)) % tabs.length;
    switchTab(tabs[next].id);
  } else if (msg.action === 'reload') {
    reloadActive();
  }
});

addBtn.addEventListener('click', createTab);

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
  const t = tabs.find((x) => x.id === activeId);
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
