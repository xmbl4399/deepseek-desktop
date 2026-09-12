// 右键菜单渲染层:把主进程下发的菜单模型渲染成 DOM,并回报实际尺寸供窗口自适应。
//
// 项序 / 分组唯一来源 = modules/menu-model.js(与托盘菜单共用),这里只负责"怎么画":
//   模型 group          → 一段(组间出分隔线)
//   模型 submenu 块     → 可折叠父行(默认收起,点击展开子项)
//   模型 items 块       → 直接铺开
// trayOnly 项(卸载/数据目录/置顶/前台感知/开机启动/关于)已由模型按入口过滤掉 ——
// 从球上能点到卸载太危险,开关类设置摊在随手入口上也太挤。
// 所以这里拿到的就是"球菜单该有的项",不需要再判一遍。
//
// 折叠组为什么不用"平铺":显示模式 + 尺寸 = 6 个选项,平铺时初始高度直接翻倍,
// 还会把"截图提问"这类高频项挤到屏幕外;折叠后初始只占两行,与托盘子菜单观感一致。
//
// 键盘:↑↓ 移动高亮(跳过收起中的子项) · Home/End 首尾 · Enter/Space 执行 · Esc 收起/关闭
const api = window.ds;
const root = document.getElementById('menu');

let entries = [];    // 可交互项,按 DOM 顺序
let activeNode = null; // 键盘高亮项(存节点而非下标:折叠会改变可见集合,下标会失效)

function el(tag, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

function buildItem(it) {
  const node = el('div', 'mi');
  if (it.danger) node.classList.add('danger');
  if (it.checked) node.classList.add('checked');
  node.appendChild(el('span', 'tick')); // 所有项都占勾选槽,文字才对齐
  const text = el('span');
  text.textContent = it.label; // textContent:标签来自本地模型,不走 innerHTML
  node.appendChild(text);

  node.dataset.act = it.act || '';
  node.dataset.type = it.type || 'normal';
  node.dataset.checked = it.checked ? '1' : '';

  if (it.enabled === false) {
    node.classList.add('disabled');
  } else {
    node.addEventListener('click', () => activate(node));
    entries.push(node);
  }
  return node;
}

// 折叠组:一行父项 + 其下的子项容器(默认收起)
function buildSubmenu(block) {
  const wrap = el('div', 'subwrap');
  const parent = el('div', 'mi parent');
  parent.dataset.role = 'parent'; // activate() 据此区分"展开/收起"与"执行动作"
  parent.appendChild(el('span', 'tick'));
  const text = el('span', 'grow');
  text.textContent = block.caption || block.label; // 球菜单用短标题(caption),父行不宜太长
  parent.appendChild(text);
  parent.appendChild(el('span', 'arrow'));
  wrap.appendChild(parent);

  const sub = el('div', 'sub');
  for (const it of block.items || []) sub.appendChild(buildItem(it));
  wrap.appendChild(sub);

  parent.addEventListener('click', () => toggleSub(wrap));
  entries.push(parent); // 父行也是可交互项(键盘 Enter 展开)
  return wrap;
}

// 单开:展开一组时自动收起其它组,菜单不会越摊越长
function toggleSub(wrap) {
  const willOpen = !wrap.classList.contains('open');
  document.querySelectorAll('.subwrap.open').forEach((w) => w.classList.remove('open'));
  if (willOpen) wrap.classList.add('open');
  // 收起后高亮若留在被藏起来的子项上,键盘会"看不见地在操作" → 交还给父行
  if (!willOpen && activeNode && wrap.contains(activeNode) && activeNode !== wrap.firstChild) {
    setActive(wrap.firstChild);
  }
  reportSize();
}

function activate(node) {
  if (!node || node.classList.contains('disabled')) return;
  if (node.dataset.role === 'parent') {
    toggleSub(node.parentNode);
    return;
  }
  const act = node.dataset.act;
  if (!act) return;
  if (node.dataset.type === 'normal') {
    api.action(act);
  } else {
    // radio / checkbox:发"切换后的目标值";radio 的动作自身知道要切到哪,会忽略该值
    api.action(act, { checked: node.dataset.checked !== '1' });
  }
}

function render(groups) {
  root.textContent = '';
  entries = [];
  activeNode = null;
  (groups || []).forEach((group, gi) => {
    if (gi > 0) root.appendChild(el('div', 'sep'));
    for (const block of group.blocks || []) {
      if (block.kind === 'submenu') {
        root.appendChild(buildSubmenu(block));
        continue;
      }
      if (block.caption) {
        const cap = el('div', 'cap');
        cap.textContent = block.caption;
        root.appendChild(cap);
      }
      for (const it of block.items || []) {
        root.appendChild(buildItem(it));
      }
    }
  });
}

// 实际尺寸:折叠后窗口要跟着变矮,所以每次都重报(主进程保持锚点重设 bounds)
function reportSize() {
  const w = document.body.scrollWidth;
  const h = document.body.scrollHeight;
  if (api.resize) api.resize(w, h);
  return [w, h];
}

// 键盘导航只在可见项之间走 —— 收起状态下的子项是 display:none,不能参与高亮
function visibleEntries() {
  return entries.filter((n) => n.offsetParent !== null);
}

function setActive(node) {
  if (activeNode) activeNode.classList.remove('hover');
  activeNode = node || null;
  if (activeNode) activeNode.classList.add('hover');
}

function move(step) {
  const list = visibleEntries();
  if (!list.length) return;
  const i = list.indexOf(activeNode);
  if (i < 0) {
    setActive(step > 0 ? list[0] : list[list.length - 1]);
    return;
  }
  setActive(list[(i + step + list.length) % list.length]);
}

document.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'Escape': {
      e.preventDefault();
      // 有展开的折叠组时,Esc 先收起(与原生子菜单一致),再按一次才关菜单
      const open = root.querySelector('.subwrap.open');
      if (open) {
        open.classList.remove('open');
        setActive(open.firstChild);
        reportSize();
        break;
      }
      api.action('menu-close'); // 主进程只关菜单窗口,不做别的
      break;
    }
    case 'ArrowDown':
      e.preventDefault();
      move(1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      move(-1);
      break;
    case 'Home':
      e.preventDefault();
      setActive(visibleEntries()[0] || null);
      break;
    case 'End':
      e.preventDefault();
      {
        const list = visibleEntries();
        setActive(list[list.length - 1] || null);
      }
      break;
    case 'Enter':
    case ' ':
      e.preventDefault();
      activate(activeNode);
      break;
    default:
      break;
  }
});

// 主进程加载完成后调用:渲染模型并回报 [宽, 高](主进程据此自适应窗口尺寸)
window.__dsMenuRender = function (groups) {
  render(groups);
  return reportSize();
};
