# DeepSeek Desktop

**DeepSeek Desktop** 是 [DeepSeek](https://chat.deepseek.com/) 的第三方 Windows 桌面客户端，在 Electron 壳基础上加入了**悬浮球 + 鲸鱼娘桌宠 + 对话小浮窗 + 选区截图提问**等实用功能。

## 借鉴说明

本项目在开发中参考/借鉴了以下开源项目，在此对原作者表示感谢：

| 项目 | 借鉴内容 |
|---|---|
| [doxdk/deepseek-desktop](https://github.com/doxdk/deepseek-desktop) | Electron 壳基础（本项目 fork 自该仓库） |
| [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | 鲸鱼娘**动画素材**（51 个透明 webm，MIT 许可）+ **动画链模型**（双缓冲交叉淡入、概率链、命中区、拖拽手感） |
| [QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) | **气泡思路**（轻量文字气泡，问候/提醒/台词） |
| Grok-Desktop | 模块化拆分、窗口内快捷键、安全加固思路 |

---

## 截图

| 鲸鱼娘桌宠（全量动画 + 台词气泡） | 悬浮球 + 对话浮窗 | 托盘菜单 | 右键菜单 |
|:---:|:---:|:---:|:---:|
| ![pet](screenshot-pet.png) | ![screenshot-1](screenshot-1.png) | ![screenshot-2](screenshot-2.png) | ![screenshot-3](screenshot-3.png) |

---

## 功能特性（v1.0.16）

### 桌宠：悬浮球 / 鲸鱼娘（托盘一键切换，状态记忆）

- **鲸鱼娘** — 51 个全量动画（待机/转向/动作/移动/点击回应），动画链概率驱动，双击开浮窗、单击随时回应
- **动作台词气泡** — 每个动画配台词（写代码="这个 bug 在哪…"、吃Token="嗯，这 Token 好吃!"、拖拽="喂喂，别拽我!"），随机变体
- **趣味提醒气泡** — 启动问好 / 喝水（45 分钟）/ 久坐运动（30 分钟）/ 饭点前提醒（7:30·11:30·17:30）/ 夜间休息（23 点）/ 随机感叹
- **尺寸三档** — 托盘"尺寸"可选 小/中/大，原地缩放即时生效（悬浮球 40/46/70px，鲸鱼娘 240×135/320×180/480×270）
- **前台感知开关**（默认开）— 全屏自动隐藏（看视频/游戏不遮挡）+ 按前台程序类型适配动画（焦点在 DeepSeek 吐泡泡、IDE 里多演"写代码"、游戏里"气急败坏"…）；关闭则完全不读取前台窗口
- **对话状态徽标** — 悬浮球焦点在 DeepSeek 时显示蓝点呼吸

### 对话与交互

- **对话小浮窗** — 360×720（9:18 竖屏），默认屏幕宽 4/5 处垂直居中，独立窗口可拖动、支持上传图片/文件
- **主窗口** — 768×576（4:3），按需加载，关闭隐藏到托盘
- **选区截图提问** — 区域截图后直接注入对话提问
- **快捷键** — 主窗 Ctrl+R/F5 刷新、Ctrl+W 隐藏、Ctrl+Alt+P 切换浮窗、Ctrl+Alt+S 截图提问；浮窗 Esc/Ctrl+W 关闭
- **自动更新** — 托盘检查更新，后台下载后一键重启安装

---

## 安装

### 下载安装包

[**下载 DeepSeek Desktop 安装包 (Windows)**](https://github.com/xmbl4399/deepseek-desktop/releases)

### 从源码构建

```bash
git clone https://github.com/xmbl4399/deepseek-desktop.git
cd deepseek-desktop
npm install
npm start        # 开发模式运行
npm test         # 冒烟测试
npm run build    # 打包安装包
```

---

## 系统要求

- Windows 10 或更高版本

---

## 致谢

- [doxdk/deepseek-desktop](https://github.com/doxdk/deepseek-desktop) — Electron 壳基础
- [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) — 鲸鱼娘动画素材与动画链模型（MIT）
- [QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) — 气泡思路

---

## 许可证

MIT License
