// 跨模块共享状态(单例):所有窗口引用集中管理,避免模块间循环依赖
module.exports = {
  mainWindow: null,
  tray: null,
  floatingWindow: null,
  petWindow: null,
  menuWindow: null,
  overlayWindow: null,
  pendingShot: null,
};
