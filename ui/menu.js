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

// 折叠组:一行父项 + 其下的子项容器(默认收起)。子项可以是普通项,也可以是
// **嵌套的折叠块**(三级菜单:播放动作 → 分类 → 动作),所以这里递归。
function buildSubmenu(block) {
  const wrap = el('div', 'subwrap');
  const parent = el('div', 'mi parent');
  parent.dataset.role = 'parent'; // activate() 据此区分"展开/收起"与"执行动作"
  parent.appendChild(el('span', 'tick'));
  const text = el('span', 'grow');
  text.textContent = block.caption || block.label; // 球菜单用短标题(caption),父行不宜太长
  parent.appendChild(text);
  parent.appendChild(el('span', 'arrow'));
  if (block.enabled === false) {
    // 整块置灰(例如"关闭显示"时没有窗口可播动作):父行不可点,子项也全部不可点
    parent.classList.add('disabled');
    wrap.classList.add('disabled');
  } else {
    parent.addEventListener('click', () => toggleSub(wrap));
    entries.push(parent); // 父行也是可交互项(键盘 Enter 展开)
  }
  wrap.appendChild(parent);

  const sub = el('div', 'sub');
  for (const it of block.items || []) {
    // 第三级:分类块本身也是 submenu → 递归展开,动作平铺在它下面
    sub.appendChild(it.kind === 'submenu' ? buildSubmenu(it) : buildItem(it));
  }
  wrap.appendChild(sub);
  return wrap;
}

// 单开:同一层级内展开一组时自动收起其它组,菜单不会越摊越长。
// 三级菜单下"同层级"是关键 —— 展开某个分类时不能把"播放动作"这个父组一起收起,
// 否则动作列表刚展开就跟着父行消失。所以只收起**同一个父容器下的兄弟**。
function toggleSub(wrap) {
  const willOpen = !wrap.classList.contains('open');
  const siblings = [];
  if (wrap.parentNode) {
    for (const n of wrap.parentNode.children) {
      if (n !== wrap && n.classList && n.classList.contains('subwrap')) siblings.push(n);
    }
  }
  siblings.forEach((w) => w.classList.remove('open'));
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
      // 有展开的折叠组时,Esc 先收起(与原生子菜单一致),再按一次才关菜单。
      // 三级菜单下收最内层:取"最深的那个展开组"——先收动作列表,再收分类,最后收起父组。
      const opened = root.querySelectorAll('.subwrap.open');
      if (opened.length) {
        const deepest = opened[opened.length - 1]; // querySelectorAll 是文档序,最后一个最深
        deepest.classList.remove('open');
        setActive(deepest.firstChild);
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
    case 'ArrowRight': {
      // 三级菜单的键盘展开:当前高亮在父行时 → 展开;已在展开的父行上 → 进入第一个子项
      e.preventDefault();
      if (activeNode && activeNode.dataset.role === 'parent') {
        const wrap = activeNode.parentNode;
        if (!wrap.classList.contains('open')) toggleSub(wrap);
        else {
          const first = [...wrap.children].find((n) => n.classList.contains('sub'));
          const children = first ? [...first.children] : [];
          if (children.length) setActive(children[0]);
        }
      }
      break;
    }
    case 'ArrowLeft': {
      // 收起当前分组,或从子项退回到父行
      e.preventDefault();
      if (!activeNode) break;
      const wrap = activeNode.closest('.subwrap');
      if (!wrap) break;
      if (activeNode !== wrap.firstChild) {
        setActive(wrap.firstChild); // 子项 → 退到父行
      } else if (wrap.classList.contains('open')) {
        toggleSub(wrap); // 父行 → 收起本组
      } else {
        // 已收起 → 跳到外层的父行
        const outer = wrap.parentNode && wrap.parentNode.closest ? wrap.parentNode.closest('.subwrap') : null;
        if (outer) setActive(outer.firstChild);
      }
      break;
    }
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
