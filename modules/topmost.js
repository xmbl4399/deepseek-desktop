// 置顶守护:把桌宠/悬浮球钉回最上层带
//
// 背景(Windows 实测):浮窗创建时已 setAlwaysOnTop(true,'screen-saver'),WS_EX_TOPMOST
// 位也一直在,但运行一段时间后整个窗口会掉出"最上层带"——任务栏仍在最上层、桌宠却被
// 最大化窗口(Edge/浏览器)盖住,EnumWindows 里它排在普通窗口中间(实测从 z 序第 1 位掉到
// 第 9 位,而它上面是一堆 topmost=false 的窗口)。手动再 SetWindowPos(HWND_TOPMOST) 一次
// 就立刻回到最上层且此后稳定,所以是"某次 z 序重排后没再断言",不是标志位丢失。
//
// Electron 没有 z 序查询 API,isAlwaysOnTop() 只读标志位(掉下来时依然是 true),无法
// "检测到被盖住再补救"。因此这里用两条廉价兜底:
//   1) 低频周期性重新断言(SetWindowPos(HWND_TOPMOST) 幂等,代价可忽略);
//   2) 由隐转显的那一拍立刻断言(全屏联动恢复、截图提问结束等 show() 之后不必等周期)。
// 菜单/截图遮罩打开时跳过,避免把浮窗抬到我们自己的临时窗口之上。

const PIN_LEVEL = 'screen-saver'; // Electron 里 Windows 只认"是否 topmost",level 仅为语义
const PIN_INTERVAL_MS = 5000; // 周期兜底
const VISIBLE_TICK_MS = 500; // 可见性采样(用于捕获 hide→show 的那一拍)

function create({ log, state }) {
  const wasVisible = new Map(); // win.id → 上次可见性
  let pinTimer = null;
  let visTimer = null;

  // 我们自己的临时置顶窗口(右键菜单、框选遮罩)开着时不要抢它们的上层
  function transientOpen() {
    for (const key of ['menuWindow', 'overlayWindow']) {
      const w = state[key];
      if (w && !w.isDestroyed() && w.isVisible()) return true;
    }
    return false;
  }

  function pin(win) {
    if (!win || win.isDestroyed() || !win.isVisible()) return false;
    try {
      win.setAlwaysOnTop(true, PIN_LEVEL);
      return true;
    } catch (e) {
      log('[topmost] pin failed:', e.message);
      return false;
    }
  }

  function pinWidgets(reason) {
    if (transientOpen()) return false;
    const okPet = pin(state.petWindow);
    const okBall = pin(state.floatingWindow);
    if ((okPet || okBall) && reason) log('[topmost] re-pinned (' + reason + ')');
    return okPet || okBall;
  }

  function start() {
    if (pinTimer) return;
    pinTimer = setInterval(() => pinWidgets(), PIN_INTERVAL_MS);
    visTimer = setInterval(() => {
      for (const w of [state.petWindow, state.floatingWindow]) {
        if (!w || w.isDestroyed()) continue;
        const vis = w.isVisible();
        const key = w.id;
        if (vis && wasVisible.get(key) === false) pin(w); // hide→show:立刻断言,不等周期
        wasVisible.set(key, vis);
      }
    }, VISIBLE_TICK_MS);
    // 定时器不因守护而阻止退出
    if (pinTimer.unref) pinTimer.unref();
    if (visTimer.unref) visTimer.unref();
    log('[topmost] watchdog started');
  }

  function stop() {
    if (pinTimer) clearInterval(pinTimer);
    if (visTimer) clearInterval(visTimer);
    pinTimer = null;
    visTimer = null;
    wasVisible.clear();
  }

  return { pin, pinWidgets, start, stop };
}

module.exports = { create };
