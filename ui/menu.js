// 右键菜单:点击项 → 向主进程发动作(主进程会关闭菜单窗口并执行)
const api = window.ds;

document.querySelectorAll('.mi').forEach((el) => {
  el.addEventListener('click', () => api.action(el.dataset.act));
});
