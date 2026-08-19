// 前台程序分类:进程名 → 上下文类别(供"前台感知开关"开启时桌宠行为参考)
// 隐私默认:只按进程名关键词匹配,不采集/不落盘窗口标题(标题可能含文档名等敏感信息)
// 类别: deepseek(本应用) / browser(浏览器) / ide(编辑器) / terminal(终端) / chat(聊天)
//       / meeting(视频会议) / media(影音) / office(办公) / design(设计) / game(游戏)
//       / explorer(文件管理器) / other(其他)
// 进程名来自 Get-Process .ProcessName(Windows 无扩展名);按顺序匹配,先命中先返回
function classify(processName) {
  const n = String(processName || '').toLowerCase().replace(/\.exe$/, '').trim();
  if (!n) return 'other';
  // 本应用:打包后进程名 deepseek-desktop,开发态 electron
  if (/(deepseek|electron)/.test(n)) return 'deepseek';
  // 浏览器
  if (/(chrome|msedge|\bedge\b|firefox|opera|brave|vivaldi|360se|360chrome|qqbrowser|2345explorer|maxthon|liebao|sogouexplorer|iexplore|waterfox|tor)/.test(n)) return 'browser';
  // 编辑器/IDE(含 AI 编辑器)
  if (/(code|cursor|windsurf|zed|pycharm|webstorm|goland|clion|rider|intellij|sublime|atom|notepad|vim|nvim|gvim|emacs|xed|kate)/.test(n)) return 'ide';
  // 终端
  if (/(windowsterminal|powershell|pwsh|^cmd$|conhost|openconsole|mintty|alacritty|wezterm|kitty|tabby|hyper|cmder|fluentterminal|gitbash|^bash$|^zsh$)/.test(n)) return 'terminal';
  // 视频会议(先于聊天判断:teams 归会议)
  if (/(zoom|wemeet|teams|webex|gotomeeting|bluejeans|^meeting)/.test(n)) return 'meeting';
  // 聊天
  if (/(^wechat$|weixin|^qq$|^qqnt$|^tim$|discord|telegram|slack|dingtalk|feishu|lark|whatsapp|skype|\bline\b)/.test(n)) return 'chat';
  // 影音
  if (/(spotify|wmplayer|^mpv$|vlc|potplayer|kodi|plex|itunes|bilibili|youku|iqiyi|cloudmusic|qqmusic|kugou|foobar2000|dandanplay|kmplayer|groove)/.test(n)) return 'media';
  // 办公
  if (/(winword|excel|powerpnt|outlook|^wps$|^et$|^wpp$|wpspdf|libreoffice|soffice)/.test(n)) return 'office';
  // 设计/创作
  if (/(photoshop|illustrator|indesign|premiere|afterfx|aftereffects|figma|sketch|krita|gimp|blender|davinci|paint|clipstudio|^sai\d*$)/.test(n)) return 'design';
  // 游戏平台/常见游戏(窗口化游戏进程名千差万别,平台+常见前缀兜底)
  if (/(steam|epicgames|origin|goggalaxy|battle\.net|riot|valorant|leagueclient|overwatch|^csgo$|^dota2$|^genshin|minecraft|^honkai|starrail|wuthering)/.test(n)) return 'game';
  // 文件管理器
  if (/^explorer$/.test(n)) return 'explorer';
  return 'other';
}

module.exports = { classify };
