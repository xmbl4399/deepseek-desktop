// 注入脚本:在 chat.deepseek.com 页面主世界执行,把截图文件注入上传并自动发送
// 由 main.js 通过 webContents.executeJavaScript 加载,文件末尾调用 __dsInjectImage(b64)
// 返回 { ok, reason, steps } 供主进程日志排查(DOM 改版时靠 steps 定位)
window.__dsInjectImage = async (b64) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, timeout = 12000, step = 300) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  };

  const report = { ok: false, reason: '', steps: [] };
  const log = (m) => report.steps.push(String(m));

  const BTN_SELECTORS = [
    'button[aria-label*="上传" i]',
    'button[aria-label*="图片" i]',
    'button[aria-label*="附件" i]',
    'button[aria-label*="attach" i]',
    'button[aria-label*="upload" i]',
    'button[title*="上传" i]',
    '[data-testid*="attach" i]',
  ];
  const SEND_SELECTORS = [
    'button[type="submit"]',
    'button[aria-label*="发送" i]',
    'button[aria-label*="send" i]',
    'button[title*="发送" i]',
  ];
  const INPUT_SELECTOR = 'input[type="file"]';

  const makeFile = (b64data) => {
    const bytes = Uint8Array.from(atob(b64data), (c) => c.charCodeAt(0));
    return new File([bytes], 'screenshot.png', { type: 'image/png' });
  };

  try {
    // 1. 优先注入到已存在的 file input
    let input = document.querySelector(INPUT_SELECTOR);
    if (input) {
      log('found existing file input');
    } else {
      // 2. 点击上传按钮,等待动态创建的 file input 出现
      let btn = null;
      for (const s of BTN_SELECTORS) {
        const hit = document.querySelector(s);
        if (hit) {
          btn = hit;
          log('upload button: ' + s);
          break;
        }
      }
      if (btn) {
        btn.click();
        log('clicked upload button');
        input = await waitFor(() => document.querySelector(INPUT_SELECTOR));
      }
      if (!input) {
        // 3. 兜底:向输入区派发 drop 事件
        const target = document.querySelector('textarea, [contenteditable="true"]');
        if (!target) {
          report.reason = '未找到上传按钮/文件输入框/输入区';
          return report;
        }
        const dt = new DataTransfer();
        dt.items.add(makeFile(b64));
        const rect = target.getBoundingClientRect();
        target.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: rect.x + 10,
          clientY: rect.y + 10,
          dataTransfer: dt,
        }));
        log('drop dispatched to input area');
      }
    }

    // 4. 注入文件
    if (input) {
      const dt = new DataTransfer();
      dt.items.add(makeFile(b64));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      log('file injected via input.files');
    }

    // 5. 等待上传预览出现(blob/data URL 图片或预览容器)
    const preview = await waitFor(
      () =>
        document.querySelector('img[src^="blob:"]') ||
        document.querySelector('img[src^="data:image"]') ||
        document.querySelector('[class*="preview" i] img') ||
        document.querySelector('[class*="image" i] img'),
      15000
    );
    if (!preview) {
      report.reason = '未检测到上传预览(可能上传失败或页面结构变化)';
      return report;
    }
    log('upload preview detected');

    // 6. 聚焦输入框,等待用户输入文字后自行发送(不自动发送)
    const inputEl = document.querySelector('textarea, [contenteditable="true"]');
    if (inputEl) {
      inputEl.focus();
      try {
        inputEl.scrollIntoView({ block: 'center' });
      } catch (e) {
        /* ignore */
      }
      log('input focused, waiting for user to type & send');
    } else {
      report.reason = '未找到输入区';
      return report;
    }
    report.ok = true;
  } catch (err) {
    report.reason = String((err && err.stack) || err);
  }
  return report;
};
