# DeepSeek Harness 桌面版

> 一个个人 demo / 小玩意儿。

用 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 随手搓的桌面端实验品，
纯粹是自己折腾着玩，顺便记录一下思路：把 `dsh web` 服务包成一个真正的桌面应用，
双击图标就能用，不用再开终端手敲命令起服务。

## 它是什么 / 不是什么

- **是**：一个自娱自乐的小实验，验证一些想法——比如「把 `dsh web` 塞进桌面壳」到底顺不顺手。
- **不是**：生产级工具。不保证维护，也别指望它一直跟着上游变。

## 最快跑起来

```powershell
npm install     # 只需先装好 Node.js；这一条会连带装好 @deepseek-ai/dsh
npm run icon    # 生成图标
npm start
```

想再要桌面 / 开始菜单快捷方式，就补一条 `npm run shortcuts`。前置要求、镜像、
开机自启、端口等细节见下面「安装」和「使用」。

## 它能做什么

- **自动起服务**：启动时自动拉起本机 `dsh web`（`--no-open`，只监听 127.0.0.1），
等它打印出带 token 的地址后，直接在应用窗口里打开。
- **端口自适应**：默认用 3080；被占用时自动让系统分配一个空闲端口，不会和已有实例打架。
- **关窗不断服务**：点关闭只是收进托盘，服务继续跑；托盘里可以随时唤回窗口、重启服务、退出。
- **托盘 + 菜单**：显示窗口、浏览器打开、复制地址、重启/停止服务、打开日志、打开工作区、打开设置、开机自启。
- **内置日志窗口**：服务 stdout/stderr 和外壳自身的日志都有落盘（`logs/`），出问题一眼能看到原因。
- **自动定位 dsh**：在本地 `node_modules`、npm 全局目录、`npx` 缓存、`PATH` 里找 `@deepseek-ai/dsh`，
装有多份时取**最新**的一份；并用真正的 `node.exe` 启动（而不是 Electron 自带运行时，
避免原生模块 ABI 不一致）。

## 目录

```text
deepseek-harness-desktop\
├─ src\                 主进程、服务管理、窗口、日志窗口
├─ assets\              图标：logo.svg 入库，icon / tray 由 npm run icon 生成
├─ scripts\             图标生成、快捷方式安装
├─ logs\                运行日志（自动轮转，单文件上限 4 MB）
├─ user-data\           Electron 配置/缓存（可移植，删掉即重置界面状态）
├─ settings.json        你的设置（首次运行自动生成）
├─ window-state.json    窗口位置/大小记忆
└─ launch.cmd           命令行启动入口
```

`node_modules/`、`logs/`、`user-data/`、`settings.json`、`window-state.json`
以及生成出来的 `assets/icon.ico` / `icon.png` / `tray.png` 都在 `.gitignore` 里，
不会提交：它们要么能由 `npm install` 还原，要么是本机专有状态。
克隆下来按下面「安装」跑一遍，这些文件会重新生成。

> 注意：`logs/service.log` 会记录带访问 token 的地址（`http://127.0.0.1:端口/?token=…`），
> 所以日志目录不要手动 `git add -f` 提交。

## 安装

### 前置要求：Node.js

只需要先装好 **Node.js**（这也是官网 Quick start 的第一步）；装了它就有 `node` / `npm`。

**DeepSeek Harness 本身不需要单独下载安装**：它作为依赖写在 `package.json` 里，
下面那条 `npm install` 会把它装进本目录的 `node_modules/`，应用启动时自动找到并使用。

> - 官网（文档 / 下载）：[https://www.deepseek.com/harness/en/](https://www.deepseek.com/harness/en/)
> - 官方 Quick start 是 `npx @deepseek-ai/dsh web`；本项目相当于把这一步固化成桌面壳，
> 并用真正的 `node.exe` 去跑它。
> - 机器上若同时存在多份 `@deepseek-ai/dsh`（全局安装、`npx` 缓存等），应用会挑
> **最新的那一份**，不保证就是本目录这份。想固定用本目录的，在 `settings.json` 里把
> `dshBin` 设为本目录下 `node_modules\@deepseek-ai\dsh\lib\bin.js` 的绝对路径。

### 安装步骤

在本目录执行（已经装好了就跳过）：

```powershell
npm install          # 安装 Electron 与 @deepseek-ai/dsh
npm run icon         # 用官方标记生成 icon.ico / icon.png / tray.png
npm run shortcuts    # 在桌面和开始菜单创建快捷方式
```

网络慢的话先设置镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_CUSTOM_DIR="{{ version }}"
npm install
```

## 使用

- **双击桌面「DeepSeek Harness」**：自动起服务并打开界面。
- 也可以运行 `npm start`，或者双击本目录的 `launch.cmd`。
- 关闭窗口默认收进托盘；要彻底退出，用托盘菜单或 `Ctrl+Q`。
- 开机自启：托盘菜单勾选「开机自动启动」，或把
`settings.json` 里的 `openAtLogin` 改成 `true`。

### 关于启动速度

`dsh web` 冷启动本身要**几十秒**（dsh 每次启动都会重建
`%USERPROFILE%\.dsh\profiles\node_modules` 里约 190 个模块代理，再加载两百多个插件；）。所以：

- 启动时会有个转圈窗口，显示已等待时间和服务的最新输出，**不是卡死**。
- **关窗只是收进托盘，服务继续跑**：下次点图标是秒开。
- 只有托盘菜单里的「退出」才会真的停掉服务，下次启动重新预热。
- 想更省事：把「开机自动启动」打开，开机后服务在托盘里自己热好。

## 设置（`settings.json`）

改完保存，重启应用生效。


| 键                       | 默认值           | 说明                                                        |
| ----------------------- | ------------- | --------------------------------------------------------- |
| `dshBin`                | `""`          | 指定 `dsh` 入口（`.../@deepseek-ai/dsh/lib/bin.js`）或命令名；留空自动探测 |
| `nodePath`              | `""`          | 指定 `node.exe`；留空自动探测                                      |
| `workspace`             | 本目录的上级目录      | 服务的工作目录，也就是新会话的默认工作区                                      |
| `port`                  | `3080`        | 首选监听端口，`0` 表示完全交给系统分配                                     |
| `autoPort`              | `true`        | 端口被占用时自动换一个空闲端口                                           |
| `host`                  | `"127.0.0.1"` | 监听地址（dsh 只允许回环地址）                                         |
| `trustedHosts`          | `[]`          | 额外信任的 authority，透传给 `dsh web --trusted-host`              |
| `startupTimeoutSeconds` | `120`         | 等待服务就绪的超时时间                                               |
| `extraArgs`             | `[]`          | 追加到 `dsh web --no-open` 后面的参数                             |
| `env`                   | `{}`          | 传给服务进程的额外环境变量                                             |
| `closeToTray`           | `true`        | 关窗时收进托盘而不是退出                                              |
| `autoStartServer`       | `true`        | 启动应用时自动起服务                                                |
| `openAtLogin`           | `false`       | 开机自动启动应用                                                  |
| `openDevTools`          | `false`       | 打开窗口时同时打开开发者工具                                            |


换一份机器级设置：把 `DSH_DESKTOP_SETTINGS` 环境变量指向另一个 json 文件即可。

## 排错


| 现象          | 处理                                                                             |
| ----------- | ------------------------------------------------------------------------------ |
| 启动弹窗说服务没能启动 | 转盘菜单「打开服务日志」，里面是 `dsh web` 的原始输出                                               |
| 提示找不到 `dsh` | 在应用目录跑 `npm install`（会自动装好 `@deepseek-ai/dsh`），或在 `settings.json` 里手写 `dshBin` |
| 跑的版本不是本目录那份 | 机器上更新的副本被优先选中；清掉全局 / `npx` 缓存里的 `@deepseek-ai/dsh`，或用 `dshBin` 固定入口            |
| 端口被占用       | 默认会自动换端口；想固定端口就把 `autoPort` 设为 `false` 并先关掉占用者                                 |
| 界面白屏        | 菜单「视图 → 强制重新加载」；仍不行看日志与开发者工具                                                   |
| 想换回浏览器      | 托盘菜单「在浏览器中打开」（走带 token 的地址，能直接登录）                                              |


## 说明

- 服务只监听 `127.0.0.1`，不对外网暴露。
- 应用不修改 `dsh` 本身：它只是负责起进程、拿地址、显示界面、退出时收尾。
- 每次启动的访问 token 都由新进程生成，因此桌面应用总是自己起自己的服务，
不会去接管已经在跑的实例（旧的实例请另行关闭）。

## 卸载

```powershell
npm run shortcuts -- -Remove     # 删除桌面/开始菜单快捷方式
```

然后直接删掉本目录即可（设置、日志都在目录里，不写注册表）。

## 声明

个人项目，代码质量随缘。

- 只是自己折腾着玩的产物，**非官方项目**；不保证维护、更新或兼容。
- 没有 CI，也没有单元测试，只有一个 `npm run smoke` 自检（起服务、加载界面，把结果写进
`logs/smoke-report.json`）；稳定性与正确性请自行判断。
- `dsh` 自身的问题请走官方渠道：[官网](https://www.deepseek.com/harness/en/) ·
[GitHub](https://github.com/deepseek-ai/deepseek-harness)

