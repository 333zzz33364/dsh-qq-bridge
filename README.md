# 通到 QQ（dsh-qq-bridge）

让 DSH 里的 **AI 伙伴**和 QQ 连起来：它在 DSH 里说完话，自动发到 QQ。

> 现在两半都做出来了，而且**都不用 BOT**：
> - `DSH → QQ`：伙伴说话 → 发到 QQ。
> - `QQ → DSH`：你在 QQ 里发话，插件自己轮询那个 QQ 后端收进来 → 转进 DSH。只要一个后端就够。

## 现在的行为

- 盯**两间屋**（都可以选，也可以只选一间）：**私聊会话** 和 **群会话**。
  QQ 私聊进来的话进私聊那间，群里的话进群那间；**哪间屋说的话就只回那一边**（私聊的话不会跑到群里）。
  两行选了同一间屋也能用，但那就等于「两边都发」——设置页会当场提示。
- `DSH → QQ`：它在某**一整轮的最后一句**说完，就把这句原文发到 QQ（走 QQ 后端的 `3000`）。
- `QQ → DSH`：插件每 4 秒轮询 QQ 后端（`get_friend_msg_history` / `get_group_msg_history`），
  发现你在 QQ 里新发的消息 → 转进目标会话，让它照常开一轮。
- 发/收都只走这个 QQ 后端的 HTTP 接口（默认 `127.0.0.1:3000`）。
- **语音条也能变成字**（可选）：设置里填一条「读 `{file}` 打一行字」的命令，QQ 语音就会被转写成文字；插件本身不带模型，仓库里附了 `tools/asr_cli.py`（SenseVoice）。
- **收进来的东西不只有文字**：图片、表情包、`@某人`、**分享卡片**（B站 视频卡片会把标题和 BV 号写出来）、
  **合并转发的聊天记录**（会去取内容压成「谁：说了什么」几行；**里面还套着转发也会展开**，最多 2 层）都会变成文字转给它。
  转发里的图跟着「收图」开关走：开着就收**第一层**那几张（跟顶层图共用张数上限），关着只记 `[图片]`；第二层起一律只记 `[图片]`。
- **图片两个方向都能传**：你在 QQ 里发的图会转给它看；它这一轮里发的图也会发到 QQ。
  收进来的图会在 `~/.dsh/qq-bridge-inbox/` 存一份，文字里带上路径。
  回发同一张图时用的是这份**原图** —— DSH 自己那份副本会被重新编码，GIF 动图会变静态 webp。
- **正文里写的 markdown 图也算**：它写 `![小肥鱼](_stickers/feiyu-test.webp)`（贴纸就是这么发的），
  会被读成本地图片发到 QQ，那串 markdown 不会露出来。相对路径按「图片根目录」找 —— **留空就行**，会自动用目标会话所在的那个工作区。
  ⚠️ 它到底能不能**看见**图，取决于那个会话用的模型：能看图的模型直接看，纯文本模型只会收到一句占位文字。
- 安全默认：**总开关 = 关、试运行 = 开** —— 不手动打开，一句都不会真的发到 QQ。
- **回复门槛（可选，默认关）**：开着时 QQ 消息照常转进来，但会先让它判断「这条是不是在跟我说话」——
  不是就当场把这一轮停掉（`agent.cancel`），什么都不回。群里特别省心。工具只在「被 QQ 叫醒后的 10 分钟内」有效，
  她自己在 DSH 里聊天时关不掉自己那一轮。

## 适配哪个 DSH 版本（不用操心）

这个插件**跟着 DSH 一起更新**：作者这边跑的就是最新版的 DSH，**最新版插件永远是给最新版 DSH 写的**。

所以看到「不适配 / 不支持」之类的提示，基本都是**装到了旧版本** —— 升级到最新版、重启一次 DSH 就好。
真遇到新版对不上（比如 DSH 刚升级、插件还没跟上），提个 issue，作者会跟着改。

当前实测对照：插件 **1.0.3** ↔ DSH **0.2.1-rc.3**（2026-10-26）

## 装

> ⭐ 最省事的一条：把这个仓库的地址贴给你自己的 DSH，说「**帮我装这个插件**」。

### 一、在 DSH 里装（推荐）

打开 **设置 → 插件 → 安装**，把这一行填进去：

```
github:Yuuyuko-uu/dsh-qq-bridge
```

或者命令行（`--profile` 照你平时那个写，桌面端一般 `desktop`，网页端 `web`）：

```bash
dsh plugin --profile desktop add github:Yuuyuko-uu/dsh-qq-bridge
```

装完**重启一次 DSH**，然后进 **设置 → 通到 QQ**。

> 光装插件还不够：还得有一个 QQ 后端（默认 `127.0.0.1:3000`），见下面「它依赖什么」那一节。

### 二、装完起不来？先看这个

如果 DSH 弹「The application could not start」，错误里有 `Unexpected token '﻿'`、`is not valid JSON`、
`readProfileManifest` —— 那是 profile 的 `package.json` 被存成了 **UTF-8 带 BOM**。
**跟插件无关**：文件内容都是对的，只是开头多了三个看不见的字节，DSH 读它就崩。

**先找出来**（不同装法位置不一样，别猜 —— 真正的 profile 目录里同时有 `cordis.yml`、`cordis.patch.yml`、`package.json`；机器上别处那些同名的都不算）：

```powershell
Get-ChildItem C:\,D:\,E:\ -Directory -Filter profiles -Recurse -Depth 4 -ErrorAction SilentlyContinue |
  ForEach-Object {
    Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $p = Join-Path $_.FullName 'package.json'
      if ((Test-Path (Join-Path $_.FullName 'cordis.patch.yml')) -and (Test-Path $p)) {
        $b = [System.IO.File]::ReadAllBytes($p)
        $bom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
        "{0}   BOM={1}" -f $p, $bom
      }
    }
  }
```

**输出里 `BOM=True` 的那一行，就是要修的文件**（标准安装在 `C:\Users\<你>\.dsh\profiles\<档名>\package.json`）。
去掉 BOM（路径换成上面那一行）：

```powershell
$p = "把上面 BOM=True 那一行的路径粘到这里"
[System.IO.File]::WriteAllText($p, [System.IO.File]::ReadAllText($p), (New-Object System.Text.UTF8Encoding($false)))
```

然后重启 DSH 就好，**数据一点没丢**。

实在进不去时，那个错误框里的
**「Disable third-party plugins, back up profile patch, and restart」**
能先起来（它先备份再停插件），再一个个开回去定位。

> ⚠️ 手动改 profile 里的文件，一律存 **UTF-8 无 BOM**。让 AI 帮你改时，别让它用
> `Set-Content -Encoding UTF8` 或 `Out-File -Encoding utf8`（Windows 自带的这两个默认**带 BOM**），
> 用上面那行 .NET 的写法就不会。

## 更新到最新版

**最省事**：把这个仓库的地址丢给你自己的 DSH，说「**帮我更新这个插件**」。装完**重启一次 DSH**。

也可以点 **设置 → 通到 QQ 最上面的「检查更新」** —— 有新版会提示，还能一键复制更新命令。

命令行（`--profile` 照你平时那个写，桌面端一般 `desktop`、网页端 `web`）：

```bash
dsh plugin --profile desktop remove dsh-qq-bridge
dsh plugin --profile desktop add github:Yuuyuko-uu/dsh-qq-bridge
```

> ⚠️ **必须先卸再装**：直接装可能拿到缓存里的旧副本，装完还是老的。
> ⚠️ 装完**重启一次 DSH**才会用新代码。

### 我的设置会不会丢？

**不会。** 设置存在 DSH 家目录（`%USERPROFILE%\.dsh\`）里，不在插件代码里；卸载只删代码：

```
.dsh\qq-bridge-config.json   （还有 qq-bridge-inbox\ 里收到的图）
```

所以卸载 → 重装，设置、收到的图片、转发记录 都还在。

三件小事提醒：

- **别用「重装 DSH」来更新插件** —— 那是两件事，重装可能动到 profile。
- **新版本新加的设置项**会用默认值（以前没这一项），想要自己的值就再填一次。
- 设置项改名或换单位时，旧值会按规则自动换算，不用你管。

## 配置（设置页里点就行，不用改文件）

**设置 → 通到 QQ**，从上到下：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 总开关 | 关 | 关着 = 一句都不发 |
| 试运行 | 开 | 开着只记账，不真发 |
| 目标会话 | （没选） | 下拉里选**你自己**要的那一间，**不用手填 id** |
| 转私聊 / 私聊 QQ 号 | 开 / 空 | 发到哪个私聊 |
| 转群 / 群号 | 关 / 空 | 发到哪个群 |
| 收图（QQ → 它） | 开 | 你在 QQ 里发的图也转给它。文字里带本地备份路径 |
| 发图（它 → QQ） | 开 | 它这一轮里发的图也发到 QQ |
| 一条最多收几张 | 4 | 1–10，多出来的不转 |
| 单张最大（MB） | 5 | 超过就跳过，两个方向共用 |
| 测试一句 | — | **真发**一条测试句到已填的私聊/群（绕过试运行） |

配置文件落在 `%USERPROFILE%\.dsh\qq-bridge-config.json`（一般不用碰它）。

## 现在就能用的接口

- `GET /dsh-qq-bridge/state` —— 配置、日志、会话清单、以及「连着的 QQ 是哪个号/昵称」。
- `POST /dsh-qq-bridge/save` —— 存配置（body 里给要改的键）。
- `POST /dsh-qq-bridge/test-send` —— **真发**测试句（绕过试运行）。

## 自测（不装插件也能跑）

```bash
node tests/宿主半边.mjs
node tests/网页半边.mjs
```

## 想让它发语音？（可选附加件）

主插件只管**文字**。想让 AI「念」出来的声音变成 QQ 语音条，`tools\语音\` 里放了整套：

| 文件 | 干什么 |
|---|---|
| `录语音.mjs` | 看门狗：盯着朗读桥，念的时候录音、录到就发 QQ |
| `录音回环.ps1` | 录音器（录系统声音回环，不要麦克风） |
| `朗读信号哨兵/` | Chrome 扩展：看到朗读桥面板的「🔊 点朗读」就通知看门狗开录 |

**两种发法，自己选**（双击 `启动-录语音.bat` 会让你输 1 或 2）：

| 模式 | 什么样 |
|---|---|
| **1 = 切断发** | 边录边发，念一段发一段（响应快，会连着几条） |
| **2 = 完整发** | 整段念完，把所有分段**拼成一条**再发 |

前提：Windows + 装了朗读桥（`dsh-tts-bridge`）+ QQ 后端支持发语音。
详细步骤见 [`tools/语音/README.md`](tools/语音/README.md)。

> 不装这一套也完全能用主插件。

## 它依赖什么：一个 QQ 后端（SnowLuma 或 NapCat，二选一）

插件本身**不碰 QQ 协议**，它只会说 **OneBot 11 的 HTTP**。所以你要在本机跑一个「QQ 接口」程序，
让插件通过 `http://127.0.0.1:3000` 跟它说话。

### 选哪个

| 后端 | 说明 |
|---|---|
| [**SnowLuma**](https://github.com/SnowLuma/SnowLuma) | **测过，能用**（本插件一直在用的就是这个）。 |
| [**NapCat**](https://github.com/NapNeko/NapCatQQ) | **也测过，能用**。自带网页后台（默认 `http://127.0.0.1:6099`）扫码登录，比自己配一端省事 |

### 插件实际用到的接口（换后端时照这个核对）

```
send_private_msg            发私聊
send_group_msg              发群消息
get_login_info              看登录的 QQ 是哪个（设置页显示"✓ 连着的 QQ"）
get_friend_msg_history      收私聊（QQ → DSH）
get_group_msg_history       收群消息（QQ → DSH）
```

只要你的后端把这 6 个接口开在 HTTP 上，插件就能用。

### 装 NapCat 的步骤

1. 从 [NapCat 的 Releases](https://github.com/NapNeko/NapCatQQ/releases) 下 Windows 版，解压到任意目录
2. 双击启动，它会弹一个**网页后台**（默认 `http://127.0.0.1:6099`）
3. 在网页里**扫码登录**你要用的 QQ 号
4. 确认 **HTTP 服务**开着、端口是 `3000`（不是的话，在插件设置里把「NapCat 地址」改成你的）
5. 回到 DSH → 设置 → 通到 QQ → 点「测一下」，应该显示 `✓ 连着的 QQ：<昵称>（<号>）`

### 装 SnowLuma 的步骤

同样思路：跑起来 → 登录 QQ → **开启 OneBot 11 的 HTTP 服务** → 端口对上（或改插件里的地址）。
具体菜单名以它的文档为准：[SnowLuma 仓库](https://github.com/SnowLuma/SnowLuma)。

> 两个后端作者都实测过，接口对得上就能用。挑一个顺手的即可。

> ⚠️ 只有 **HTTP** 模式够用（插件不连 WebSocket）。开了 WS 但没开 HTTP 的话，插件连不上。

### 其它

- 桌面只留这个后端 + 本插件 + DSH。
- `/receive` 路由还留着，是想用别的方式（比如另一个程序）把 QQ 消息灌进来的备用入口，不依赖它也能跑。

## 改动记录

见 [CHANGELOG.md](CHANGELOG.md)。版本号规矩：每改一次 +0.0.1，末位满 10 进位。