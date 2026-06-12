# Codex Mini

Codex Mini 是一个把手机浏览器连接到电脑上的 Codex Desktop 的轻量桥接工具。你可以在手机上发送文字、图片、视频和文件，并同步查看 Codex 的回复过程和结果。

> 📌 **说明**
>
> **重大更新：官方构建版现在支持 macOS 和 Windows。**
>
> macOS 用户下载 DMG 安装包；Windows 用户下载 EXE 安装包，在 Windows 电脑或 Windows 虚拟机内安装使用。
>
> 本仓库也保留开源维护版本，适合有开发能力的朋友自行部署、改造和二次开发。构建版会优先提供最新功能，源码可能不会第一时间同步全部能力。

## 当前发布版本

- 版本：macOS v4.2.3 / Windows v4.0.0
- macOS 安装包：[下载 Codex Mini v4.2.3.dmg](https://github.com/CoimgRain/Codex-Mini/releases/download/codex-mini-v4.2.3/Codex.Mini.v4.2.3.dmg)
- Windows 安装包：[下载 Codex Mini Windows v4.0.0.exe](https://github.com/CoimgRain/Codex-Mini/releases/download/codex-mini-v4.2.3/CodexMiniWindowsSetup-v4.0.0.exe)
- Release 页面：[codex-mini-v4.2.3](https://github.com/CoimgRain/Codex-Mini/releases/tag/codex-mini-v4.2.3)
- 安装方式：macOS 打开 DMG 并把 `Codex Mini.app` 拖进 `Applications`；Windows 直接运行 EXE 安装

### 最新版 V4.2.3

- 电脑 Codex 上直接发送的消息，现在会同步显示到手机端聊天记录，并像正常收发消息一样自然逐条出现
- 手机端线程列表与电脑 Codex 界面保持一致，SSH 远程线程也只显示电脑端当前可见的会话
- 线程菜单分区顺序调整为「项目 → SSH 服务器 → 对话」
- 线程列表更稳定：连接瞬时波动时不再清空列表或自动跳到其他线程
- 降低手机端轮询对电脑的占用，多设备同时使用时电脑 Codex 更流畅
- 修复切换模型时偶发误入「速度」菜单的问题，聊天记录不再显示内部接续说明文本

### V4.2.2

- **重大更新：新增官方 Windows 版安装包，Windows 版按 v4.0.0 独立版本线发布**
- 优化启动稳定性
- 减少重复完成提醒
- 修复已知 bug

### V4.2 重点回顾

- 新增 SSH 服务器连接：手机端可以查看和接入远程 SSH 服务器上的 Codex 线程
- 远程 SSH 线程支持独立分区显示，项目列表会自动展开并归类到“SSH 服务器”区域
- 远程线程聊天记录可从服务器 `~/.codex/sessions` 读取，手机端可直接加载历史和回复过程
- 优化远程 SSH 线程回复轮询，长回复不会因为轮询次数到头而强制刷新
- 远程回复中断或网络异常时提示更清楚，减少误以为任务停止的情况

### V4.0～V4.1 重点回顾

- **V4.0 重大升级**：改为全 CDP 控制链路，响应速度更快，发送更快，后台静默运行更稳定
- 正式名称统一为 `Codex Mini.app`，安装包统一为拖拽式 `Codex.Mini.v<version>.dmg`
- V4.1 增加附件能力和设置面板，可管理外观、签名、顶部胶囊显示与顺序等
- 安装 V4.x 前请完整删除旧 `Codex Mini Beta.app` 和残留运行文件，建议使用第三方卸载工具删干净
- 如果正在使用 Codex++ 或其他 CDP 控制工具，可能会冲突，只能保留一个；V3.0 的 GUI 自动化链路不受影响

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

官方 Windows 安装包已经随最新 Release 一起发布，文件名是 `CodexMiniWindowsSetup-v4.0.0.exe`。Windows 版支持在 Windows 桌面环境中运行 Codex Mini 控制面板，并保留手机网页控制、线程列表、CDP 受控 Codex、局域网访问和 Pro 外网入口等核心能力。

社区项目 [atuizz/codex-max](https://github.com/atuizz/codex-max) 仍可作为另一个 Windows 方向参考。

## 安装与使用

1. 按系统下载 `Codex.Mini.v4.2.3.dmg` 或 `CodexMiniWindowsSetup-v4.0.0.exe`
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
