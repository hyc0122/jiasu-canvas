# 佳速画布 桌面端

用 Electron 把 `web/` 打成桌面应用。主进程通过 `loadFile` 加载打包后的 `web/dist`，不依赖 `localhost`。

产品名：佳速画布  
包名：`jiasu-canvas`  
appId：`com.jiasuapi.jiasu-canvas`

## 本地再打一次包

需要 Node.js 20+。前端构建优先用仓库里的 bun（没有 bun 时脚本会退回 `npm run build`）。

在 Linux 上打 Windows NSIS 安装包和 portable 绿色包需要完整 Wine（含 32 位）：

```bash
sudo dpkg --add-architecture i386
sudo apt-get update
sudo apt-get install -y wine wine32:i386
```

打包脚本在找不到 wine、或 NSIS 失败时，会改为打 Windows zip 绿色包。

```bash
cd desktop
npm install
npm run pack
```

只打 Linux：

```bash
cd desktop
npm install
npm run pack:linux
```

只打 Windows：

```bash
cd desktop
npm install
npm run pack:win
```

产物写到仓库根目录 `release/`，不要提交该目录。

| 脚本 | 作用 |
| --- | --- |
| `npm run build:web` | 用相对路径 `base: ./` 和 Hash 路由构建 `web/`，拷到 `desktop/web-dist` |
| `npm run pack` | 先构建 web，再打当前环境能出的安装包和绿色包 |
| `npm run pack:linux` | Linux AppImage / deb（安装包）+ tar.gz（绿色包） |
| `npm run pack:win` | Windows NSIS（安装包）+ portable（绿色包）；失败则打 zip |
| `npm run start` | 在已有 `desktop/web-dist` 时本地启动 Electron（仍走 `loadFile`，不是开发服务器） |

版本号读仓库根目录 `VERSION`。

## 产物说明

| 文件（版本号随 `VERSION` 变化） | 用途 |
| --- | --- |
| `release/jiasu-canvas-<ver>-linux-x86_64.AppImage` | Linux 安装包 / 可执行包 |
| `release/jiasu-canvas-<ver>-linux-amd64.deb` | Linux deb 安装包 |
| `release/jiasu-canvas-<ver>-linux-x64.tar.gz` | Linux 绿色包，解压后运行 `jiasu-canvas` |
| `release/jiasu-canvas-<ver>-win-x64-setup.exe` | Windows NSIS 安装程序 |
| `release/jiasu-canvas-<ver>-win-x64-portable.exe` | Windows 绿色包（免安装） |
| `release/jiasu-canvas-<ver>-win-x64.zip` | Windows 绿色包（wine/NSIS 不可用时的后备） |

`release/linux-unpacked/`、`release/win-unpacked/` 是 electron-builder 的解压目录，也可直接运行，一般不用分发。

## 为什么 Electron 构建要改 Vite `base`

普通 Web 部署继续用 `base: '/'`（`cd web && bun run build` 行为不变）。

`file://` 加载绝对路径 `/assets/...` 会变成 `file:///assets/...`，页面白屏。桌面构建通过环境变量改为相对路径：

```bash
VITE_BASE=./ VITE_ROUTER_MODE=hash bun run build
```

`file://` 也无法使用 Browser History 路由，所以桌面构建额外打开 Hash 路由。这只影响 Electron 那一次构建，不影响网站和 Docker。

## 在 Windows 上打 NSIS / portable

若当前 Linux 环境没有 wine，或 wine 跑 NSIS 失败：

1. 在 Windows 上安装 Node.js 20+ 和 bun（或 npm）。
2. 克隆本仓库，进入 `desktop/`。
3. 执行 `npm install` 和 `npm run pack:win`。

不要把 `GH_TOKEN` 交给 electron-builder 自动发版；脚本使用 `--publish never`，发 GitHub Release 请用 `gh release`。
