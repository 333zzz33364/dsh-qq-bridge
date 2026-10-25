# 语音识别：为什么不用你填模型目录（0.8.6 起的做法）

## 以前（要手填，不合理）

- 装依赖只装了 `sherpa-onnx` + `numpy`，**模型得自己准备**；
- 设置里那栏「语音模型目录」还要自己填 —— 别人根本不知道填什么；
- 填不对就报「没给模型目录」。

## 现在（点一下，全自动）

点「自动装依赖」→ 按这个顺序跑，每一步都显示 ✓ / ⋯ / ✗：

1. **找 Python**（`py -3` 或 `python`）
2. **建独立环境** `~/.dsh/qq-bridge-asr/.venv`（不碰系统 Python）
3. **装依赖** `sherpa-onnx` + `numpy` + `imageio-ffmpeg`（自带一个静态 ffmpeg，用来把 silk/amr 转 wav）
4. **自检** `import sherpa_onnx`
5. **下载语音模型**（约 230 MB）—— 只下 `model.int8.onnx` + `tokens.txt` 两个文件（官方整包里还塞了 fp32，有 999MB，不下）
6. **解压**到 `~/.dsh/qq-bridge-asr/models/<模型名>/`
7. **写进配置**：`转写命令` 和 `语音模型目录` 两栏由插件自己填好

装完插件页显示「环境 + 语音模型都就绪」，然后手动把「转写语音」打开保存即可。

## 出问题时会怎样

| 情况 | 表现 |
|---|---|
| 模型没下完（网络断） | 那一步标 ✗，并写「再点一次会接着下」；环境不用重装 |
| 已有模型 | 第 5 步显示「已经有了」，跳过 |
| 想用别的模型（whisper 等） | 自己把「语音模型目录」改成你的目录，命令模板里 `{file}` 别动 |

## 目录结构

```
%USERPROFILE%\.dsh\qq-bridge-asr\
├── .venv\                    # 独立 Python 环境
├── models\
│   └── sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17\
│       ├── model.int8.onnx
│       └── tokens.txt
└── install.log               # 安装日志（插件页只显示最后几行）
```
