// 注入脚本:在浮框加载的 chat.deepseek.com 页面顶部注入拖拽柄(拖动窗口) + 右上角关闭按钮
// 覆盖式:不占用/不挤压网页布局,默认事件穿透,只有手柄和关闭按钮可交互
// 由 main.js 在 popup 页面加载完成后 executeJavaScript 调用 __dsPopupInit()
window.__dsPopupInit = () => {
  if (document.getElementById('__ds-bar')) return;

  const bar = document.createElement('div');
  bar.id = '__ds-bar';
  bar.innerHTML = `
    <style>
      #__ds-bar {
        position: fixed; top: 0; left: 0; right: 0; height: 26px;
        z-index: 2147483647;
        pointer-events: none; /* 整条默认穿透,不挡网页内容 */
      }
      #__ds-handle {
        position: absolute; top: 0; left: 50%; transform: translateX(-50%);
        width: 132px; height: 13px;
        border-radius: 0 0 10px 10px;
        background: rgba(110, 125, 210, 0.38);
        -webkit-app-region: drag;
        cursor: grab;
        pointer-events: auto;
        transition: background .15s;
      }
      #__ds-handle:hover { background: rgba(110, 125, 210, 0.62); }
      #__ds-close {
        position: absolute; top: 3px; right: 5px;
        width: 24px; height: 24px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font: 13px/1 "Segoe UI", sans-serif;
        color: #c8cbe0;
        background: rgba(15, 17, 20, 0.5);
        cursor: pointer;
        pointer-events: auto;
        -webkit-app-region: no-drag;
        user-select: none;
      }
      #__ds-close:hover { background: rgba(255, 90, 90, 0.75); color: #fff; }
    </style>
    <div id="__ds-handle" title="拖动浮框"></div>
    <div id="__ds-close" title="隐藏浮框">✕</div>
  `;
  document.body.appendChild(bar);

  bar.querySelector('#__ds-close').addEventListener('click', () => {
    try {
      window.electron && window.electron.hidePopup && window.electron.hidePopup();
    } catch (e) {
      /* ignore */
    }
  });
};
