// 菜单模型:托盘(原生菜单)与悬浮球(自绘菜单)共用的**唯一**项序 / 分组来源。
//
// 为什么单独抽一层:两个菜单原先各写各的,于是出现"托盘有尺寸入口、悬浮球没有"这类漂移。
// 现在加一项只改这里,两个入口同时生效;渲染器只负责"怎么画",不负责"有哪些项"。
//
// 本模块是纯函数(无依赖、无状态),所以不套 create() 工厂 —— 直接导出 build。
//
// 结构:groups[] → group.blocks[] → block { kind, label, caption, items[] }
//   · 托盘渲染器    :group 之间出分隔线;submenu 块 → 原生子菜单(带 label)
//   · 悬浮球渲染器  :group 之间出分隔线;submenu 块 → 可折叠父行(带 caption),点击才展开子项
//     自绘菜单没有原生子菜单,早先是把子项平铺出来,结果 6 个选项常驻占掉半个屏幕;
//     现在改成"父行 + 就地折叠",初始高度只算一行 —— 与托盘子菜单的观感一致,也不挤
//
// item.act 是统一动作 id,由 main.js 的 onUiAction 单点分发 —— 托盘与球菜单发同一个 id,
// 所以同一项在两个入口的行为天然一致,不需要两套 handler。
'use strict';

const SUBMENU = 'submenu';
const ITEMS = 'items';

// ctx 由 main.js 的 menuContext() 提供:mainVisible / mode / size / mainOnTop /
// foregroundAware / autoStart / version。缺字段时一律按"默认态"渲染,不会抛错。
// entry 指定入口('tray' | 'ball'):trayOnly 项只在托盘出现 —— 过滤放在模型里而不是
// 渲染层,这样"球菜单究竟有哪些项"在纯 Node 里也能断言(不需要跑 DOM)。
function build(ctx, entry) {
  const c = ctx || {};
  const mode = c.mode === 'pet' || c.mode === 'off' ? c.mode : 'ball';
  const size = c.size || 'medium';
  const off = mode === 'off'; // 关闭显示时"尺寸"无从谈起 → 整组置灰

  const radio = (act, label, on, enabled) => {
    const it = { act, label, type: 'radio', checked: !!on };
    if (enabled === false) it.enabled = false;
    return it;
  };
  // 开关型(checkbox)一律只放托盘 —— 见 toggle 分组的说明,所以这里统一带上 trayOnly
  const toggle = (act, label, on) => ({ act, label, type: 'checkbox', checked: !!on, trayOnly: true });

  const groups = [
    {
      key: 'action',
      blocks: [
        {
          kind: ITEMS,
          items: [
            // 主窗可见时文案变"隐藏":托盘/球菜单各只有一个开关入口,不能只会开不会关
            { act: 'toggle-main', label: c.mainVisible ? '隐藏主窗口' : '打开主窗口' },
            { act: 'screenshot', label: '截图提问' },
          ],
        },
      ],
    },
    {
      key: 'pet',
      blocks: [
        {
          kind: SUBMENU,
          label: '桌宠显示', // 托盘子菜单标题
          caption: '显示模式', // 球菜单折叠父行文字(点击展开三个档位)
          items: [
            radio('mode-ball', '悬浮球', mode === 'ball'),
            radio('mode-pet', '鲸鱼娘', mode === 'pet'),
            radio('mode-off', '关闭显示', mode === 'off'),
          ],
        },
        {
          kind: SUBMENU,
          label: '桌宠尺寸',
          caption: '尺寸',
          items: [
            radio('size-small', '小', size === 'small', !off),
            radio('size-medium', '中', size === 'medium', !off),
            radio('size-large', '大', size === 'large', !off),
          ],
        },
      ],
    },
    {
      key: 'toggle',
      blocks: [
        {
          kind: ITEMS,
          // 三个开关只放托盘:悬浮球是"随手点一下"的入口,置顶/前台感知/开机启动
          // 属于"配置一次就不再动"的设置,摊在球菜单上只会挤掉高频项(且误触代价高)
          items: [
            toggle('toggle-main-top', '主窗置顶', c.mainOnTop),
            toggle('toggle-foreground', '前台感知开关', c.foregroundAware !== false),
            toggle('toggle-autostart', '开机启动', c.autoStart),
          ],
        },
      ],
    },
    {
      key: 'info',
      blocks: [
        {
          kind: ITEMS,
          items: [
            // 版本号直接写在菜单上:原先只有点开"关于"才看得到,而托盘/球菜单是最常打开的入口
            { act: 'about', label: '关于 DeepSeek' + (c.version ? ' v' + c.version : ''), trayOnly: true },
            // 排查用:日志就在数据目录里,省得用户自己摸 %APPDATA% 路径
            { act: 'open-data-dir', label: '打开数据目录', trayOnly: true },
          ],
        },
      ],
    },
    {
      key: 'end',
      blocks: [
        {
          kind: ITEMS,
          items: [
            // 卸载只放托盘:从悬浮球上误点卸载的代价太大
            { act: 'uninstall', label: '卸载 DeepSeek…', trayOnly: true },
            { act: 'quit', label: '退出', danger: true },
          ],
        },
      ],
    },
  ];

  if (entry !== 'ball') return groups;
  // 悬浮球菜单:滤掉托盘专属项,顺带去掉因此变空的分组(不留悬空分隔线)
  return groups
    .map((g) => ({
      key: g.key,
      blocks: (g.blocks || [])
        .map((b) => Object.assign({}, b, { items: (b.items || []).filter((it) => !it.trayOnly) }))
        .filter((b) => (b.items || []).length > 0),
    }))
    .filter((g) => (g.blocks || []).length > 0);
}

module.exports = { build, SUBMENU, ITEMS };
