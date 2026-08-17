// 安全加固:站外链接白名单 + 导航守卫 + 私有/保留地址拦截(借鉴 Grok-Desktop 的 URL 校验)
// 拦截内网地址(防 DNS rebinding / 恶意页面诱导打开内网服务),站内导航只放行 chat.deepseek.com
const { shell } = require('electron');

const APP_ORIGIN = 'https://chat.deepseek.com';

// 私有/保留/链路本地地址段(hostname 字面量匹配;DNS rebinding 场景下远程页面拿不到内网域名字面量,
// 但能拦下"URL 直写内网 IP/localhost"的常见钓鱼形态,作为第一道防线)
const PRIVATE_HOST_RE =
  /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|::1|fe80:.*|fc00:.*|fd00:.*)$/i;

function isPrivateHostname(hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return false;
  return PRIVATE_HOST_RE.test(h);
}

function create({ log }) {
  // 站外链接白名单:只放行 http/https 交给系统浏览器,拦截内网/私有地址
  function openExternalSafe(url) {
    try {
      const u = new URL(String(url));
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        if (isPrivateHostname(u.hostname)) {
          log('[ds] blocked external open (private address):', url);
          return;
        }
        shell.openExternal(u.toString());
      } else {
        log('[ds] blocked external open (non-http):', url);
      }
    } catch (e) {
      log('[ds] blocked external open (invalid url):', url);
    }
  }

  // 远程窗口(主窗/浮窗)导航守卫:站内跳转放行,站外交给系统浏览器,避免开出裸 Electron 窗口
  function attachNavigationGuard(win, label) {
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(APP_ORIGIN)) return { action: 'allow' };
      openExternalSafe(url);
      return { action: 'deny' };
    });
    // 顶层导航到站外时同样交给系统浏览器
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(APP_ORIGIN)) {
        e.preventDefault();
        openExternalSafe(url);
      }
    });
    log('[security] navigation guard attached:', label);
  }

  return { openExternalSafe, attachNavigationGuard, isPrivateHostname, APP_ORIGIN };
}

module.exports = { create };
