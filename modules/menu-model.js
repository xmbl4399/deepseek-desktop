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

// 动作分类(与 ui/pet.js 的 ACT_CATEGORIES 一一对应)。
// 为什么在菜单模型里再抄一份分类名:菜单模型是纯函数、跑在主进程,不能 require
// 渲染层脚本(ui/pet.js 依赖 DOM)。两边靠 smoke-test 校验一致性,不靠注释约定。
// 动作名必须与 ui/pet.js 的 ACT_CATEGORIES 完全一致 —— 播放时按名字查素材文件。
const ACT_CATEGORIES = [
  {
    id: '小动作',
    actions: [
      '悠闲哼歌', '超大伸懒腰', '原地敲击桌面互动', '原地重力下蹲压缩',
      '哈欠连天', '原地小憩沉眠', '女仆屈膝礼仪', '被吓一跳',
      '小幅度原地360度旋转展示', '偷吃零食被抓住', '用鲸鱼尾巴拍打地面',
      '打瞌睡被惊醒', '照镜子', '整体换装试色', '轻快记录', '写代码',
      '摇扇纳凉', '晨间刷牙',
    ],
  },
  {
    id: '玩耍',
    actions: [
      '原地专心玩魔方', '原地蹲下玩玩具汽车', '鲸鱼吐泡泡特效',
      '原地跳跃抓碎头顶物品', '玩游戏气急败坏', '玩水枪', '小提琴演奏',
      '蓝鲸现世', '优雅女仆舞', '轻快摇摆舞', '可爱宅舞', '吹气球',
      '动物环绕', '放风筝', '拆礼物', '变鸽子', '扑克魔术', '抽陀螺',
      '吹笛子', '蝴蝶蜜蜂环绕头顶开花', '撸猫', '凭空生花', '骑木马',
      '三球抛接', '踢毽子', '下五子棋', '荡秋千',
    ],
  },
  {
    id: '吃什么',
    actions: [
      '吃白饭', '大口吃零食', '吃Token', '吃早餐', '吃午餐', '吃晚餐',
      '吃冰淇淋融化', '吃大闸蟹', '吃糖葫芦', '吃长寿面', '吃西瓜', '涮火锅',
    ],
  },
  {
    id: '时节',
    actions: [
      '被落叶淹没', '中秋赏月吃月饼', '堆雪人', '放烟花', '吃粽子', '吃年糕',
      '吃青团', '吃腊八粥', '吃重阳糕', '收红包', '写福字', '穿针乞巧',
      '舞狮头', '讨糖南瓜灯', '插茱萸赏菊', '放河灯', '萌化小幽灵',
      '装点圣诞树', '放孔明灯', '吃汤圆', '吃饺子',
    ],
  },
  {
    id: '文字',
    actions: ['是啊，吃什么', '深度思考碎碎念'],
  },
];

// 动作 → 菜单 act id。act 里带动作名,onUiAction 直接按这个 id 查表播放,
// 不需要额外 payload(键盘 Enter 与鼠标点击走同一条路径)
function actId(name) {
  return 'pet-play:' + name;
}

// 动作目录:优先用渲染层实时上报的(鲸鱼娘窗口开着时),否则退回下面的兜底表。
// ACT_CATEGORIES 是静态副本,唯一的用途是"鲸鱼娘窗口没开时"的兜底(关闭显示状态
// 下整个「播放动作」组本来就置灰不可点),真正权威的来源是 ui/pet.js。
function petCatalog(ctx) {
  const live = ctx && Array.isArray(ctx.petCatalog) ? ctx.petCatalog : null;
  if (live && live.length) {
    return live
      .filter((c) => c && typeof c.id === 'string' && Array.isArray(c.actions))
      .map((c) => ({ id: c.id, actions: c.actions.filter((a) => typeof a === 'string' && a) }));
  }
  return ACT_CATEGORIES;
}

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
          // 球菜单折叠父行文案:明确只控制鲸鱼娘/悬浮球,
          // 否则用户会以为主窗口也跟着变(旧版确实是联动的,现在解耦了)
          caption: '桌宠大小',
          items: [
            radio('size-small', '小', size === 'small', !off),
            radio('size-medium', '中', size === 'medium', !off),
            radio('size-large', '大', size === 'large', !off),
          ],
        },
        {
          // 三级结构:父行「播放动作」→ 每个分类一项(同样是可展开的父行)→ 该类的动作列表。
          // 分类块用 SUBMENU 嵌套,渲染层递归展开;80 个动作平铺会让菜单长到出屏幕。
          kind: SUBMENU,
          label: '播放动作',
          caption: '播放动作',
          enabled: !off, // 关闭显示时没有窗口可播,整组置灰
          items: petCatalog(ctx).map((cat) => ({
            kind: SUBMENU, // 嵌套子菜单:渲染层据此递归建第三级
            label: cat.id,
            caption: cat.id,
            items: cat.actions.map((name) => ({ act: actId(name), label: name })),
          })),
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

// ACT_CATEGORIES 一并导出:只为 smoke-test 做"与 ui/pet.js 逐项一致"的校验,
// 生产代码取动作表请走 petCatalog(ctx)(优先用渲染层实时上报的权威目录)
module.exports = { build, SUBMENU, ITEMS, ACT_CATEGORIES, actId };
