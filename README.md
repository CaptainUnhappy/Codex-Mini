# Codex Mini

Codex Mini 是一个把手机浏览器连接到电脑上的 Codex Desktop 的轻量桥接工具。你可以在手机上发送文字、图片、视频和文件，并同步查看 Codex 的回复过程和结果。

> 📌 **说明**
>
> **重大更新：官方构建版现在支持 macOS 和 Windows。**
>
> macOS 用户下载 DMG 安装包；Windows 用户下载 EXE 安装包，在 Windows 电脑或 Windows 虚拟机内安装使用。
>
> 本仓库也保留开源维护版本，适合有开发能力的朋友自行部署、改造和二次开发。构建版会优先提供最新功能，源码可能不会第一时间同步全部能力。

## 🐛 反馈 Bug / 提建议

遇到问题或有建议？**[→ 点这里提交反馈](http://47.110.74.238/codex-mini-feedback/)** —— 发一张截图 + 写一段话，开发者会直接看到并处理；也可以加 **QQ 群：760669553**。

## 当前发布版本

- 版本：v4.5.1（macOS 与 Windows 已对齐）
- 🍎 macOS · Apple 芯片（M1/M2/M3/M4…）：[Codex Mini v4.5.1（Apple Silicon 版）](https://github.com/CoimgRain/Codex-Mini/releases/download/codex-mini-v4.5.1/CodexMini_v4.5.1_macOS_AppleSilicon.dmg)
- 💻 macOS · Intel 芯片（x86）：[Codex Mini v4.5.1（Intel Mac 版）](https://github.com/CoimgRain/Codex-Mini/releases/download/codex-mini-v4.5.1/CodexMini_v4.5.1_macOS_Intel.dmg)
- 🪟 Windows（10 / 11，64 位）：[Codex Mini v4.5.1（Windows 版）](https://github.com/CoimgRain/Codex-Mini/releases/download/codex-mini-v4.5.1/CodexMini_v4.5.1_Windows_Setup.exe)
- 图文安装说明：[macOS 版（PDF）](docs/Codex%20Mini%20Mac%20%E5%AE%89%E8%A3%85%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E.pdf) ｜ [Windows 版（PDF）](docs/Codex%20Mini%20Windows%20%E5%AE%89%E8%A3%85%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E.pdf)
- Release 页面：[codex-mini-v4.5.1](https://github.com/CoimgRain/Codex-Mini/releases/tag/codex-mini-v4.5.1)
- 安装方式：macOS 打开 DMG 并把 `Codex Mini.app` 拖进 `Applications`；Windows 双击 EXE 安装（无需管理员权限、无需自己装 Node），装完从桌面或开始菜单启动

### 最新版 V4.5.1

- **电脑守护助手设置**：Mac 版新增守护模式、超级守护模式和额外守护时间，MacBook 合盖后也能在任务运行时继续守护（仅 Mac，Pro 功能）
- **附件预览全面补齐**：图片、Markdown、Word、压缩包等文件都进入带「返回 / 下载」的详情页，Markdown 长文档支持当前页滚动预览
- **本机密码二次验证更稳定**：刷新页面或重新打开网页后重新验证，本次会话内不再反复打断
- **回复状态和内部过程更干净**：修复引导过程重复、内部摘要外露、完成回复被后续中断误标等问题，Windows 同步修复二维码、状态解析和控制面板显示

### V4.4.3

- **打开即见聊天记录**：打开 App 或线程标题刷新时，会自动把当前线程的聊天记录加载出来，不再出现「已选中线程、聊天区却空白」
- **待发送「引导」消息修复**：排队中的引导卡片现在会稳定显示，不再偶发不出现
- **Windows 控制面板任务栏图标与退出菜单**：托盘操作更顺手（仅 Windows）
- **Windows 远程 SSH 修复**：远程线程的主机匹配更稳定，远程连接更可靠（仅 Windows）

### V4.4.2

- **三平台安装包同步发布**：Apple Silicon、Intel 和 Windows 三个安装包已对齐到 4.4.2
- **线程列表可继续加载更早对话**：不再把较早会话隐藏在固定数量之后
- **SSH 远程线程显示修复**：远程线程不会被本机分页数量截掉
- **Windows 安装器更干净**：只保留运行必需内容，不包含内部文档、打包脚本或构建源码

### V4.3.1

- **兼容 Codex++**：检测到 Codex++ 后，手机端免点击直接控制同一个 Codex，无需为两者分别开启 Codex，两者可以同时共存协作
- 设置页新增「Bug 反馈」入口：遇到问题可以直接从手机提交截图和文字反馈
- 内置前端热更新机制：常用界面的小改进能更快、更稳地下发到你的 App
- 控制面板右下角显示版本号
- 优化 App 内「使用助手」与安装 / 排错指引

### V4.0 ～ V4.2 重点回顾

- **V4.0 全 CDP 控制链路**：响应和发送更快、后台静默运行更稳定；正式名称统一为 `Codex Mini.app`、安装包统一为拖拽式 DMG
- **V4.1**：新增附件能力与设置面板（外观、签名、顶部胶囊显示与顺序）
- **V4.2 · SSH 远程**：手机端可查看 / 接入远程服务器上的 Codex 线程，远程线程独立分区显示、可从 `~/.codex/sessions` 加载历史，长回复轮询与中断提示更稳更清晰
- **官方 Windows 版**：新增 Windows 安装包（独立版本线），桌面运行控制面板，保留手机网页控制、局域网与 Pro 外网入口
- **同步与稳定**：电脑 Codex 上直接发的消息会同步到手机端，手机线程列表与电脑端保持一致；降低轮询占用，多设备同时使用更流畅
- 安装 V4.x 前请完整删除旧 `Codex Mini Beta.app` 与残留文件；若在用 Codex++ 等 CDP 工具，旧版本可能冲突（**V4.3 起已支持与 Codex++ 共存**）

## 界面预览

<p>
  <img src="assets/screenshots/preview-thread-list.png" alt="Codex Mini 手机线程列表" width="220" />
  <img src="assets/screenshots/preview-chat.png" alt="Codex Mini 手机聊天同步" width="220" />
  <img src="assets/screenshots/mobile-reasoning-menu.png" alt="Codex Mini 推理模式菜单" width="220" />
</p>

<p>
  <img src="assets/screenshots/ipad-layout.png" alt="Codex Mini iPad 横屏布局" width="720" />
</p>

## 加入交流群

QQ 群：**760669553**

欢迎加入群里交流使用问题、反馈 bug、提出功能建议。后续有最新版本也会在群里及时沟通。

## Windows 版本

官方 Windows 安装包已经随最新 Release 一起发布，文件名是 `CodexMini_v4.5.1_Windows_Setup.exe`。Windows 版支持在 Windows 桌面环境中运行 Codex Mini 控制面板，并保留手机网页控制、线程列表、CDP 受控 Codex、局域网访问和 Pro 外网入口等核心能力。

社区项目 [atuizz/codex-max](https://github.com/atuizz/codex-max) 仍可作为另一个 Windows 方向参考。

## 安装与使用

1. 按系统下载对应的 `CodexMini_v4.5.1_macOS_AppleSilicon.dmg`、`CodexMini_v4.5.1_macOS_Intel.dmg` 或 `CodexMini_v4.5.1_Windows_Setup.exe`
2. macOS 安装前完整删除旧 `Codex Mini Beta.app`，建议用第三方卸载工具清理旧 App、旧 LaunchAgent 和旧运行目录
3. macOS 打开 DMG，把 `Codex Mini.app` 拖到 `Applications`；Windows 直接运行 EXE 安装
4. 打开 Codex Mini
5. 同一 Wi‑Fi 下可直接使用局域网入口；离开局域网可使用 Pro 外网入口
6. 建议把手机网页添加到主屏幕，体验更接近 App

## 添加到主屏幕

iPhone 上打开 Codex Mini 网页后，按下面三步操作：

1. 点浏览器底部或菜单里的“分享”
2. 如果没看到“添加到主屏幕”，先点“查看更多”
3. 点“添加到主屏幕”，之后从桌面图标打开 Codex Mini

> 第一次使用时，macOS 可能需要给 Codex Desktop 或 Codex Mini 相关自动化操作授予辅助功能/自动化权限，否则无法把手机输入粘贴并发送到 Codex Desktop。

<p>
  <img src="assets/install/add-to-home-step-2.jpg" alt="第 1 步：点击分享" width="220" />
  <img src="assets/install/add-to-home-step-3.jpg" alt="第 2 步：点击查看更多" width="220" />
  <img src="assets/install/add-to-home-step-1.jpg" alt="第 3 步：添加到主屏幕" width="220" />
</p>

## 当前版本实现原理

Codex Mini 不是云端聊天服务，真正的 Codex 登录状态、线程切换、输入和回复读取都发生在你自己的电脑上。

核心流程：

1. 电脑上由 Codex Mini 管理本地服务
2. 手机网页把文字或附件发送到这台电脑
3. 本地服务通过 CDP 控制 Codex Desktop，把内容发送到当前线程
4. 本地服务读取 Codex 会话状态和回复，并同步回手机网页
5. 同一 Wi‑Fi 优先走局域网入口；开启 Pro 后可走外网中转入口

## 本地免费与 Pro 会员

- 本地局域网功能永久免费：手机和电脑在同一个 Wi‑Fi / 局域网下即可使用
- Pro 会员解锁外网入口：通过服务器中转连接自己的电脑，不在同一个 Wi‑Fi 下也可以使用
- 当前支持 7 天免费试用、月度、季度和年度计划
- Pro 激活后请重新复制新的外网入口到手机上；旧的局域网入口只适合同一网络下使用

## 服务器中转与隐私安全

Codex Mini 的设计原则是：用户自己的电脑为主，服务器只做必要中转。

- Codex 登录状态、线程内容和本机访问令牌都保存在用户自己的电脑上
- 外网入口只把手机请求转回对应用户的电脑，不提供管理员远程打开用户电脑或查看线程的入口
- Pro 授权使用设备绑定和签名校验
- 请不要把自己的访问链接、令牌或电脑隐私信息发给陌生人

## 注意事项

- 请确保电脑上已经安装并登录 Codex Desktop
- 请保持 Codex Desktop 可正常使用
- 请不要把自己的访问链接、令牌或电脑隐私信息发给陌生人
- 当前 V4.x 采用全 CDP 控制方案；如果你使用 Codex++ 或其他 CDP 工具，请只保留一个，避免冲突。安装前请彻底删除旧 Codex Mini Beta，旧残留可能导致无法启用受控 Codex。欢迎进群反馈

## 源码说明

本仓库提供 Codex Mini 的开源维护版本，适合希望自行部署、接入自己的服务器或进行二次开发的用户。

如果你更希望开箱即用，或者想优先体验最新功能，建议直接下载 Releases 中的 DMG 构建版。构建版会持续维护，部分新功能可能会先在构建版中发布，再逐步同步到开源版本。

## License / 授权

Codex Mini is **source-available for non-commercial use only**. You may read, fork, modify, and publish derivative works for personal, educational, research, evaluation, and other non-commercial purposes.

Commercial use requires prior written authorization from the author. Without authorization, you may not sell this project, operate a paid hosted/SaaS/relay service based on it, charge for deployment or maintenance, resell access, or otherwise monetize this project or derivative works.

If you fork, modify, redistribute, or publish a derivative work, you must keep clear attribution to the original project and author: **Codex Mini by [CoimgRain](https://github.com/CoimgRain)**, with a link to the original repository: https://github.com/CoimgRain/Codex-Mini

This is not an OSI-approved open source license because it restricts commercial use. See [`LICENSE`](./LICENSE) for the full terms.

中文说明：Codex Mini 仅允许个人、学习、研究、评估等非商业用途使用。允许 fork、修改和继续公开发布，但必须保留对原项目和作者的清晰署名：**Codex Mini by [CoimgRain](https://github.com/CoimgRain)**，并附上原项目链接：https://github.com/CoimgRain/Codex-Mini。未经作者事先书面授权，不得用于商业服务、付费托管、SaaS、中转服务、代部署收费、转售访问权或其他商业化用途。
