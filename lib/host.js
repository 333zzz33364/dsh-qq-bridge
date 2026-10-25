// DSH「通到 QQ」· 宿主半边
//
// 这一半只做一件事（先只做 DSH → QQ）：
//   伙伴在「目标会话」里说完一句话（一整轮的最后一句），就自动把它发到 QQ（私聊 / 群）。
//   发 QQ 走 NapCat 的 OneBot HTTP 接口（127.0.0.1:3000），走标准的 OneBot 11 HTTP。
//
// 反过来（QQ → DSH）是下一半，放到另一个插件/进程里做，不在这里混。
//
// ⚠ 安全默认：总开关 = false、试运行 = true —— 不手动打开，一句都不会真的发到 QQ。

import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createSelfUpdate } from './selfupdate.mjs'

export const name = 'qq-bridge'

/** 需要宿主提供：webServer（路由）+ sessions/sessionTitle（目标会话清单 + 标题）+ agents（followup）+ timer（轮询收消息）+ attachments（图片）。 */
export const inject = ['agents', 'sessions', 'sessionTitle', 'webServer', 'timer', 'workspaceRegistry', 'attachments', 'tools']

// ---------- 常量 ----------

const 目录 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置文件 = join(目录, 'qq-bridge-config.json')
const 路由前缀 = '/dsh-qq-bridge'
const 日志上限 = 60

const 默认配置 = {
  总开关: false, // 关着 = 一句都不发（安全默认）
  试运行: true, // 开着 = 只记账、不真发到 QQ
  目标会话: '', // ⚠️ 老字段（= 私聊会话）。还认，读的时候会搬进「私聊会话」
  私聊会话: '', // ⭐ QQ 私聊那一路进哪一间（2026-10-25 拆开）
  群会话: '', //   ⭐ QQ 群里那一路进哪一间（可以留空 = 不看群）
  私聊QQ: '', // 发到哪个私聊（QQ 号，字符串）
  群号: '', // 发到哪个群（可空）
  转私聊: true,
  转群: false,
  NapCat: 'http://127.0.0.1:3000', // OneBot HTTP 接口
  令牌: '', // ⭐ access_token（2026-10-25）：NapCat / SnowLuma 开了鉴权就填这里，留空 = 不鉴权
  // ⭐ 2026-10-22：图片两个方向
  收图: true, // QQ → DSH：她发的图片也转进来
  收图最多: 4, // 一条消息最多转几张
  发图: true, // DSH → QQ：伙伴发的图片也发过去
  图上限MB: 5, // 单张最大多少 MB（两个方向共用）
  图片根目录: '', // 正文里 `![名字](相对路径)` 按哪个目录去找（留空 = 自动猜）
  称呼: '对方', // ⭐ 私聊时怎么称呼跟它说话的那个人（写进转给它的文案里，比如「小明发来了图片」）
  回复门槛: false, // ⚠ 已废弃（2026-10-25）：门槛改成「按绑定行走」——老配置里是 true 的会在迁移时变成那一行的门槛
  // ⭐ 0.7.0（用户 GAME-66 的建议，issue #2）出站两个闸，默认都关
  只发标记内: false, // 开着 = 只发正文里 [QQ]…[/QQ] 那一段（块外的解释/路径/思考留在本地）
  只回QQ唤醒: false, // 开着 = 只有「这一轮是被 QQ 消息叫醒的」才发（你在 DSH 里自己聊的不推到手机）
  // ⭐ 0.8.0：语音转写（QQ 语音条 → 文字）。插件自己不带模型，只负责把音频交给「你指定的命令」。
  语音转写: false,
  转写命令: '', // 模板，里面必须带 {file}；例如：python D:sr.py "{file}"
  语音模型目录: '', // 语音模型放哪（SenseVoice 的 model.int8.onnx + tokens.txt 所在目录）
  转写超时秒: 60,
  补投窗口分: 10, // 会话关着期间攒下的消息，超过这么多分钟就不再补投
  // ⭐⭐ 2026-10-25：绑定列表 —— 一行 = 一个聊天（私聊/群）→ 一间 DSH 会话
  //   { 类型: '私聊' | '群', 号码: 'QQ号或群号', 会话: 'session-…', 称呼: '小明', 门槛: false }
  绑定: [],
  群称呼: '群里的人', // ⭐ 群聊时怎么称呼（群里不止一个人，一般别填某个人的名字）
}

/** 包根目录（用它读自己包里的东西，比如 tools/asr_cli.py） */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 版本从 package.json 读。 */
const 版本 = (() => {
  try {
    const p = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
    return String(p.version || '?')
  } catch (error) {
    return '?'
  }
})()

/** 跑一条外部命令（异步、带超时、拿 stdout）。
 *  ⭐ 语音转写用：插件自己**不带 ASR 模型**，只负责「把音频文件交给用户指定的命令，拿回文字」。
 *  这样本机 whisper / SenseVoice / 云端 API 都能接，插件也不会因为塞模型变成几百 MB。 */
function 跑命令(模板, 文件, 超时秒) {
  return new Promise((resolve) => {
    const 命令 = String(模板 || '').replace(/\{file\}/g, 文件)
    let 出 = ''
    let 错 = ''
    let 收过 = false
    const 收 = (v) => { if (收过) return; 收过 = true; resolve(v) }
    let 子 = null
    try {
      子 = spawn(命令, {
        shell: true, windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      })
    } catch (error) {
      return 收({ ok: false, 错: String((error && error.message) || error) })
    }
    const 定时 = setTimeout(() => {
      try { 子.kill() } catch (error) {}
      收({ ok: false, 错: '超时（' + 超时秒 + ' 秒）' })
    }, Math.max(5, Number(超时秒) || 60) * 1000)
    子.stdout.on('data', (c) => { 出 += c })
    子.stderr.on('data', (c) => { 错 += c })
    子.on('error', (error) => { clearTimeout(定时); 收({ ok: false, 错: String((error && error.message) || error) }) })
    子.on('close', (码) => {
      clearTimeout(定时)
      收({ ok: 码 === 0, 文字: 出.trim(), 错: (错.trim() || ('退出码 ' + 码)) })
    })
  })
}

/** 把「语音段」里的东西落成本地文件（QQ 给的有三种形态：http 链接 / base64:// / 本地文件名）
 *  ⚠️ 2026-10-25 修（她实测报的）：以前直接把 `file` 丢给转写命令 —— 那个值经常是
 *     `https://multimedia.nt.qq.com.cn/download?appid=...` 这种**网络地址**，
 *     命令当然找不到文件，就报「找不到音频文件」。现在先下载/解码到本地再交给它。 */
async function 语音落文件(段, 拉任意, 家目录, 名) {
  const d = (段 && 段.data) || {}
  const 原 = String(d.file || d.url || '')
  const 直链 = String(d.url || '') || (/^https?:/i.test(原) ? 原 : '')
  const 落盘 = (字节, 扩展) => {
    try {
      const 目录 = join(家目录, 'audio')
      mkdirSync(目录, { recursive: true })
      const 文件 = join(目录, String(名).replace(/[^a-zA-Z0-9_-]/g, '') + '.' + 扩展)
      writeFileSync(文件, 字节)
      return 文件
    } catch (error) { return '' }
  }
  const 从地址取扩展 = (u) => {
    const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(String(u || ''))
    const e = m ? m[1].toLowerCase() : ''
    return ['wav', 'mp3', 'amr', 'silk', 'ogg', 'm4a', 'flac'].includes(e) ? e : 'amr'
  }
  // ① 先问后端：get_record 能直接给 wav（它自己会解 silk）—— 这是最省事的一条路
  if (原) {
    try {
      const r = await 拉任意('get_record', { file: 原, out_format: 'wav' })
      if (r) {
        const 本地 = r.file || r.path
        if (本地 && existsSync(String(本地))) return String(本地)
        if (r.base64) {
          try {
            const f = 落盘(Buffer.from(String(r.base64).replace(/^data:[^,]*,/, ''), 'base64'), 'wav')
            if (f) return f
          } catch (error) {}
        }
      }
    } catch (error) {}
  }
  // ② 网络地址 → 下载
  const 拿地址 = 直链 || (/^https?:/i.test(原) ? 原 : '')
  if (拿地址) {
    try {
      const r = await fetch(拿地址)
      if (r && r.ok) {
        const 字节 = Buffer.from(await r.arrayBuffer())
        const f = 落盘(字节, 从地址取扩展(拿地址))
        if (f) return f
      }
    } catch (error) {}
  }
  // ③ base64:// 或本来就是本地文件
  if (原.startsWith('base64://')) {
    try {
      const f = 落盘(Buffer.from(原.slice('base64://'.length), 'base64'), 'amr')
      if (f) return f
    } catch (error) {}
  }
  if (原 && existsSync(原)) return 原
  return ''
}

/** 不是 wav 就转成 16k 单声道 wav（用 ffmpeg；找不到就原样交给命令，让命令自己想办法） */
async function 转成wav(路径, ffmpeg, 家目录, 名) {
  if (!路径 || /\.wav$/i.test(路径)) return 路径
  if (!ffmpeg) return 路径
  try {
    const 目录 = join(家目录, 'audio')
    mkdirSync(目录, { recursive: true })
    const 出 = join(目录, String(名).replace(/[^a-zA-Z0-9_-]/g, '') + '.wav')
    const 结果 = await new Promise((resolve) => {
      let 子 = null
      try {
        子 = spawn(ffmpeg, ['-y', '-i', 路径, '-ar', '16000', '-ac', '1', 出], { windowsHide: true })
      } catch (error) { return resolve(false) }
      子.on('error', () => resolve(false))
      子.on('close', (码) => resolve(码 === 0 && existsSync(出)))
    })
    return 结果 ? 出 : 路径
  } catch (error) { return 路径 }
}

/** 一条 QQ 语音 → 文字。插件只做三件事：拿到音频 → 交给命令 → 拿回文字。
 *  ⚠️ 没配命令、或者没开开关，就退化成 `[语音]` 三个字（跟以前一样）。 */
async function 转写语音(段, 拉任意, 配置, 选项 = {}) {
  const 模板 = String((配置 && 配置.转写命令) || '')
  if (!配置 || !配置.语音转写 || !模板.includes('{file}')) return '[语音]'
  const 家目录 = 选项.家目录 || ''
  const 名 = 'qq-voice-' + (选项.消息id || Date.now())
  const 本地 = await 语音落文件(段, 拉任意, 家目录, 名)
  if (!本地) return '[语音（没下到音频）]'
  const 就绪 = await 转成wav(本地, 选项.ffmpeg || '', 家目录, 名)
  const 结果 = await 跑命令(模板, 就绪, 配置.转写超时秒)
  if (结果.ok && 结果.文字) return '（语音）' + 结果.文字
  return '[语音（转写失败：' + String(结果.错 || '没输出').slice(0, 60) + '）]'
}

/** 找 ffmpeg：环境变量 → PATH → 装依赖时随手装的那份 imageio-ffmpeg。
 *  语音要转成 wav 才能喂给识别命令，没有 ffmpeg 就只能把原始文件交出去。 */
let ffmpeg缓存 = null
async function 找ffmpeg() {
  if (ffmpeg缓存 !== null) return ffmpeg缓存
  const 试 = async (命令, 参数) => {
    try {
      const 码 = await new Promise((resolve) => {
        let 子 = null
        try { 子 = spawn(命令, 参数, { windowsHide: true }) } catch (error) { return resolve(-1) }
        子.on('error', () => resolve(-1))
        子.on('close', (c) => resolve(c === null ? -1 : c))
      })
      return 码 === 0
    } catch (error) { return false }
  }
  if (process.env.FFMPEG && await 试(process.env.FFMPEG, ['-version'])) return (ffmpeg缓存 = process.env.FFMPEG)
  if (await 试('ffmpeg', ['-version'])) return (ffmpeg缓存 = 'ffmpeg')
  // 装依赖时装了 imageio-ffmpeg 的话，它自带一个静态 ffmpeg
  try {
    const 脚本 = 'import imageio_ffmpeg,sys;sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())'
    const r = await 跑命令('"' + ASRpython + '" -c "' + 脚本.replace(/"/g, '\\"') + '"', '', 20)
    if (r && r.ok && r.文字 && existsSync(r.文字)) return (ffmpeg缓存 = r.文字.trim())
  } catch (error) {}
  return (ffmpeg缓存 = '')
}

// ---------- 配置读写 ----------

function 布(值, 兜) {
  if (值 === true || 值 === 'true' || 值 === 1 || 值 === '1') return true
  if (值 === false || 值 === 'false' || 值 === 0 || 值 === '0') return false
  return 兜
}

/** 把「绑定」整成干净的清单：类型只能是私聊/群；号码和会话都要有；
 *  **同一个会话只能绑一条**、**同一个聊天也只能绑一条**（串消息就是从这里来的）。
 *  老配置（只有一个私聊会话 + 一个群会话）会自动变成两行，不用手动搬。 */
function 规整绑定(raw, 混, 字, 布) {
  const 出 = []
  const 见会话 = new Set()
  const 见聊天 = new Set()
  const 收一条 = (x) => {
    const t = String((x && x.类型) || '').trim()
    const 类型 = t === '私聊' ? '私聊' : (t === '群' ? '群' : '')
    if (!类型) return null
    const 号码 = 字(x && x.号码)
    const 会话 = 字(x && x.会话)
    if (!号码 || !会话) return null
    const 称呼 = (字(x && x.称呼) || (类型 === '群' ? '群里的人' : '对方')).slice(0, 16)
    const 聊天键 = 类型 + ':' + 号码
    if (见聊天.has(聊天键)) return null
    if (见会话.has(会话)) return null          // 一个会话只绑一条
    见聊天.add(聊天键)
    见会话.add(会话)
    return { 类型, 号码, 会话, 称呼, 门槛: 布(x && x.门槛, false) }
  }
  if (Array.isArray(raw)) {
    for (const x of raw.slice(0, 30)) {
      const r = 收一条(x)
      if (r) 出.push(r)
    }
  }
  if (!出.length) {
    // 老配置迁移：私聊会话 / 群会话 → 两行
    const 私会话 = 字(混.私聊会话) || 字(混.目标会话)
    const 私号 = 字(混.私聊QQ)
    const 群会话 = 字(混.群会话)
    const 群号2 = 字(混.群号)
    if (私会话 && 私号) 出.push({ 类型: '私聊', 号码: 私号, 会话: 私会话, 称呼: (字(混.称呼) || '对方').slice(0, 16), 门槛: false })
    if (群会话 && 群号2) 出.push({ 类型: '群', 号码: 群号2, 会话: 群会话, 称呼: (字(混.群称呼) || '群里的人').slice(0, 16), 门槛: false })
  }
  return 出
}

function 归一化(原始) {
  const 是对象 = 原始 && typeof 原始 === 'object' && !Array.isArray(原始)
  const 混 = 是对象 ? { ...默认配置, ...原始 } : { ...默认配置 }
  const 字 = (v) => (typeof v === 'string' ? v.trim() : '')
  const 数 = (v, 兜, 低, 高) => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n)) return 兜
    return Math.max(低, Math.min(n, 高))
  }
  const 绑定 = 规整绑定(混.绑定, 混, 字, 布)
  // 老配置迁移：以前是「总开关」带动全部，现在按行走 —— 总开关开过的话，把群那几行补上
  if (布(混.回复门槛, false)) {
    for (const 行 of 绑定) if (行.类型 === '群' && !行.门槛) 行.门槛 = true
  }
  const 私聊行 = 绑定.find((x) => x.类型 === '私聊') || null
  const 群行 = 绑定.find((x) => x.类型 === '群') || null
  return {
    总开关: 布(混.总开关, 默认配置.总开关),
    试运行: 布(混.试运行, 默认配置.试运行),
    // ⭐ 下面这几个老字段现在**从绑定反推**（只留一份真数据，避免两套说法打架）：
    //    私聊会话/群会话 = 绑定里第一条私聊 / 第一条群；老代码还看它们，行为不变。
    私聊会话: 私聊行 ? 私聊行.会话 : '',
    群会话: 群行 ? 群行.会话 : '',
    目标会话: 私聊行 ? 私聊行.会话 : '',
    私聊QQ: 私聊行 ? 私聊行.号码 : 字(混.私聊QQ),
    群号: 群行 ? 群行.号码 : '',
    // ⚠️ 2026-10-25（她报的「群里没收到它的回复」）：这两个老开关界面上已经不显示了，
    //    却还在拦发送 —— 她加了群绑定、但 转群 还是默认 false，于是群里一条都收不到。
    //    现在**有那一行就代表要发**：直接从绑定推。
    转私聊: 绑定.some((b) => b.类型 === '私聊'),
    转群: 绑定.some((b) => b.类型 === '群'),
    NapCat: 字(混.NapCat) || 默认配置.NapCat,
    令牌: 字(混.令牌),
    绑定,
    收图: 布(混.收图, 默认配置.收图),
    发图: 布(混.发图, 默认配置.发图),
    收图最多: 数(混.收图最多, 默认配置.收图最多, 1, 10),
    图上限MB: 数(混.图上限MB, 默认配置.图上限MB, 1, 30),
    图片根目录: 字(混.图片根目录),
    称呼: (私聊行 ? 私聊行.称呼 : (字(混.称呼) || 默认配置.称呼)),
    // ⚠ 老字段，只用来迁移：以前「总开关 + 每行」两个一起管太难懂，
    //    现在**只认每一行自己的门槛**；老配置里总开关是开的，就给群那几行默认打开。
    回复门槛: 布(混.回复门槛, 默认配置.回复门槛),
    只发标记内: 布(混.只发标记内, 默认配置.只发标记内),
    只回QQ唤醒: 布(混.只回QQ唤醒, 默认配置.只回QQ唤醒),
    语音转写: 布(混.语音转写, 默认配置.语音转写),
    转写命令: 字(混.转写命令).slice(0, 400),
    语音模型目录: 字(混.语音模型目录).slice(0, 400),
    转写超时秒: 数(混.转写超时秒, 默认配置.转写超时秒, 5, 600),
    补投窗口分: 数(混.补投窗口分, 默认配置.补投窗口分, 1, 240),
    群称呼: (群行 ? 群行.称呼 : (字(混.群称呼) || 默认配置.群称呼)),
  }
}

// ---------- 图片小工具（两个方向共用）----------
// ⭐ 2026-10-22 加：QQ 的图片段（OneBot）可能给 http url、本地路径、base64 三种形态，
//    这里统一成字节；大小和类型都在收的时候判，判不了就当 jpeg。

/** 收进来的图存一份到这儿（纯文本模型看不见图，至少能从文字里找到路径） */
/**
 * ⭐ 2026-10-23：会话 id 有两种写法（`xxx` / `session-xxx`）。找agent 两种都认，
 *    但事件过滤、归档判断、设置页高亮这些地方原来是**字面比较** ⇒ 存的是裸 id 时就对不上。
 *    统一用「去掉 session- 前缀」的键来比。
 */
const 会话键 = (v) => {
  const s = String(v == null ? '' : v).trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

const 收图目录 = join(目录, 'qq-bridge-inbox')

/**
 * ⭐ 2026-10-22：DSH 存图时会留一份「归一化副本」（官方文档原话：may be resized or re-encoded），
 *    GIF 到这一步就变成静态 webp 了 —— 所以回发时必须用**我们自己留的原图**。
 *    这张表记「附件 id → 我们存的原图路径」，回发时先查它。
 */
const 收图表 = join(目录, 'qq-bridge-received.json')

function 读收图表() {
  try {
    const j = JSON.parse(readFileSync(收图表, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch (error) {
    return {}
  }
}

/** 路径统一：去掉两头引号/空格，Windows 下大小写不敏感 */
const 清路径 = (p) => String(p || '').trim().replace(/^["']+|["']+$/g, '').trim()

/**
 * 记「附件 / DSH 那份只读副本 → 我们存的原图」。
 * ⚠ 两个键都要记：伙伴回发时可能用附件 id（附件块），也可能照抄 DSH 给的那条
 *   只读副本路径（正文里的 markdown 图）—— 后者是常见情况，第一次就漏了。
 */
function 记收图(附件id, 副本路径, 原图路径) {
  const 原 = String(原图路径 || '').trim()
  if (!原) return
  const id = String(附件id || '').trim()
  const 副 = 清路径(副本路径)
  if (!id && !副) return
  try {
    const 表 = 读收图表()
    const 记 = { p: 原, t: Date.now() }
    if (id) 表['id:' + id] = 记
    if (副) 表['p:' + 副.toLowerCase()] = 记
    // 只留最近 200 条，别让这个文件无限长
    const 留 = Object.entries(表).sort((a, b) => Number((b[1] && b[1].t) || 0) - Number((a[1] && a[1].t) || 0)).slice(0, 200)
    writeFileSync(收图表, JSON.stringify(Object.fromEntries(留)), 'utf8')
  } catch (error) {}
}

/** 这张图能不能换回原图？键可以是 `id:<附件id>`，也可以是 `p:<副本路径>` */
function 原图路径(键) {
  const k = String(键 || '').trim()
  if (!k) return ''
  const 表 = 读收图表()
  const 记 = 表[k] || 表[k.toLowerCase()] || 表[String(k).replace(/^id:/, '')]
  const p = 记 && typeof 记.p === 'string' ? 记.p : ''
  if (!p) return ''
  try { return existsSync(p) ? p : '' } catch (error) { return '' }
}

const 扩展 = (类) => (类 === 'image/png' ? 'png' : 类 === 'image/gif' ? 'gif' : 类 === 'image/webp' ? 'webp' : 'jpg')

function 看图类(字节) {
  try {
    if (字节[0] === 0x89 && 字节[1] === 0x50) return 'image/png'
    if (字节[0] === 0x47 && 字节[1] === 0x49) return 'image/gif'
    if (字节[0] === 0x52 && 字节[1] === 0x49 && 字节[8] === 0x57) return 'image/webp'
  } catch (error) {}
  return 'image/jpeg'
}

/** 从 OneBot 的图片段里把字节抠出来：url → file(本地/base64://) 依次试 */
async function 取图字节(数据) {
  const d = 数据 || {}
  const url = typeof d.url === 'string' ? d.url.trim() : ''
  if (url) {
    if (url.startsWith('file://')) {
      try { return readFileSync(new URL(url)) } catch (error) {}
    } else if (/^https?:/i.test(url)) {
      try {
        const r = await fetch(url)
        if (r.ok) return Buffer.from(await r.arrayBuffer())
      } catch (error) {}
    }
  }
  const f = typeof d.file === 'string' ? d.file.trim() : ''
  if (f.startsWith('base64://')) {
    try { return Buffer.from(f.slice('base64://'.length), 'base64') } catch (error) {}
  }
  if (f && (f.includes('\\') || f.includes('/'))) {
    try { return readFileSync(f) } catch (error) {}
  }
  return null
}

/** 存一份到收图目录，返回路径（存不下就返回空串，不影响转图） */
function 存一张(名字, 字节, 类) {
  try {
    mkdirSync(收图目录, { recursive: true })
    const p = join(收图目录, `${名字}.${扩展(类)}`)
    writeFileSync(p, 字节)
    return p
  } catch (error) {
    return ''
  }
}

function 读配置() {
  try {
    return 归一化(JSON.parse(readFileSync(配置文件, 'utf8')))
  } catch (error) {
    return 归一化(null)
  }
}

function 写配置(配置) {
  try {
    mkdirSync(目录, { recursive: true })
    writeFileSync(配置文件, JSON.stringify(配置, null, 2), 'utf8')
    return true
  } catch (error) {
    return false
  }
}

// ---------- 纯函数（导出给冒烟测试喂） ----------

/** 从一条 assistant 消息里只抽出正文（text 块拼起来；reasoning / image 都不要）。 */
export function 提取正文(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** 拼一个 OneBot「私聊 text 段」消息体。 */
export function 私人消息体(text) {
  return { user_id: 0, message: [{ type: 'text', data: { text } }] }
}

/** 拼一个 OneBot「群 text 段」消息体。 */
export function 群消息体(text) {
  return { group_id: 0, message: [{ type: 'text', data: { text } }] }
}

/** ⭐ 2026-10-22：从一条 assistant 消息里挑出图片块（要发到 QQ 的那几张）。 */
export function 提取图块(message) {
  if (!message || !Array.isArray(message.content)) return []
  return message.content.filter((b) => b && b.type === 'image' && b.attachment).slice(0, 10)
}

/** 拼一个 OneBot「图片段」（base64 直接塞，不依赖 QQ 那边能不能访问本地文件）。 */
export function 图片段(base64) {
  return { type: 'image', data: { file: 'base64://' + String(base64) } }
}

/**
 * ⭐ 2026-10-22：正文里那种 markdown 图片 `![名字](路径)` 也当图片发。
 *    伙伴发贴纸就是这么发的（`![小肥鱼](_stickers/feiyu-test.webp)`）——
 *    以前只认附件块，这种一律被当成普通文字发过去，QQ 那边看到的是一串 markdown。
 * @returns {净文字, 图: [{kind:'url'|'path', value}]}
 */
export function 抠正文图(文字) {
  const 图 = []
  const 净文字 = String(文字 || '')
    .replace(/!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g, (全, 路径) => {
      const p = String(路径 || '').trim()
      if (!p) return ''
      if (/^https?:\/\//i.test(p)) {
        if (!图.some((x) => x.value === p)) 图.push({ kind: 'url', value: p })
        return ''
      }
      if (!图.some((x) => x.value === p)) 图.push({ kind: 'path', value: p })
      return ''
    })
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { 净文字, 图 }
}

// 包根：用来读自己的 package.json（版本 + 仓库地址）
const 包根 = join(dirname(fileURLToPath(import.meta.url)), '..')

export function apply(ctx) {
  // ⭐ 设置页那个「检查更新」：查这个插件自己的仓库
  createSelfUpdate({ packageRoot: 包根, diag: 记账 }).register(ctx, 路由前缀)
  // ---------- 状态 ----------

  const 日志 = []
  // ⚠ 2026-10-23 修（反馈：换过「目标会话」之后，新会话第 2 轮起就静默不发）
  //   真因：这两个表原来都是**全局一份**，只认「轮号」，不认「哪个会话」。
  //     从 A 换到 B 之后，B 的轮号一旦跟 A 撞上，就被当成「这轮已经发过了」跳过；
  //     而调用处是 `void 落地一发(...)`，没有日志 → 日志里一片空白，很难查。
  //   → 现在都按会话分开：上一轮按会话键存一份；已发的键是「会话键:轮号」。
  const 空轮 = () => ({ 轮号: -1, 文本: '', 图们: [] })
  const 上一轮们 = new Map() // 会话键 -> { 轮号, 文本, 图们 }
  const 已发轮 = new Set() // 「会话键:轮号」
  const 已转消息 = new Set() // 已经转发进 DSH 的 QQ 消息 id（防重复转）
  // ⚠️ 2026-10-25（她报的「我没发新消息，它却自己回了一条」）：
  //   这两个东西以前**只存在内存里** —— 插件一重启（今天改了鱼的心情 / 换插件都要重启），
  //   「看到哪儿了」就归零 ⇒ 最近那十几条历史消息会**被当成新消息重投一遍**，
  //   于是她一点开会话就冒出一条自动回复。现在落盘到 qq-bridge-state.json，重启接着上次。
  const 状态文件 = join(dirname(配置文件), 'qq-bridge-state.json')
  const 读水位 = () => {
    try {
      const j = JSON.parse(readFileSync(状态文件, 'utf8'))
      if (j && j.上次 && typeof j.上次 === 'object') for (const [k, v] of Object.entries(j.上次)) 上次时间.set(String(k), Number(v) || 0)
      if (j && Array.isArray(j.已转)) for (const id of j.已转.slice(-300)) 已转消息.add(id)
    } catch (error) { /* 没有就算了，第一次跑 */ }
  }
  读水位()
  const 存水位 = () => {
    try {
      writeFileSync(状态文件, JSON.stringify({
        上次: Object.fromEntries([...上次时间].map(([k, v]) => [k, Number(v) || 0])),
        已转: [...已转消息].slice(-300),
      }, null, 2), 'utf8')
    } catch (error) { /* 存不下不影响转消息 */ }
  }
  // ⭐ 0.6.0：每个「聊天」各自记「看到哪儿了」（键 = 类型:号码）—— 多群多私聊才不会互相串
  const 上次时间 = new Map()

  function 记账(文本) {
    const d = new Date()
    const 补 = (n) => String(n).padStart(2, '0')
    const 时间 = `${补(d.getMonth() + 1)}-${补(d.getDate())} ${补(d.getHours())}:${补(d.getMinutes())}:${补(d.getSeconds())}`
    日志.push({ 时间, 文本 })
    if (日志.length > 日志上限) 日志.shift()
    try {
      ctx.logger?.info(`qq-bridge: ${文本}`)
    } catch (error) {}
  }

  /** 请求头：填了「令牌」就带 Bearer；没填就照旧（老 NapCat 不鉴权，零变化） */
  const 请求头 = (配置, 带体 = true) => {
    const h = 带体 ? { 'content-type': 'application/json', 'user-agent': 'dsh-qq-bridge' } : { 'user-agent': 'dsh-qq-bridge' }
    const t = String((配置 && 配置.令牌) || '').trim()
    if (t) h.authorization = 'Bearer ' + t
    return h
  }

  async function 发一个(base, action, 体, 配置) {
    try {
      const r = await fetch(`${base}/${action}`, {
        method: 'POST',
        headers: 请求头(配置),
        body: JSON.stringify(体),
      })
      const j = await r.json()
      return { action, ok: !!(j && j.status === 'ok' && j.retcode === 0), 数据: j }
    } catch (error) {
      return { action, ok: false, 数据: { 错: String((error && error.message) || error) } }
    }
  }

  /** 把一段长文字按空行拆成自然段（没有空行就整段）。 */
  function 按段拆(文字) {
    const 段 = String(文字 || '')
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    return 段
  }

  /**
   * 相对路径的图按哪儿找：
   *   ① 设置里的「图片根目录」（填了就以它为准）
   *   ② **目标会话所在的那个工作区**（自动的，一般不用填）
   *   ③ 其它登记过的工作区
   *   ④ 进程当前目录 ⑤ <DSH_HOME>/workspace ⑥ 用户主目录
   * 找到就返回绝对路径。
   */
  function 找本地图(p, 配置) {
    const 原 = String(p || '').trim()
    if (!原) return ''
    const 试 = []
    if (/^[a-zA-Z]:[\\/]/.test(原) || 原.startsWith('\\\\') || 原.startsWith('/')) 试.push(原)
    else {
      const 根们 = []
      const 设 = String(配置.图片根目录 || '').trim()
      if (设) 根们.push(设)
      try {
        const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
        const 列表 = (登记 && typeof 登记.list === 'function' ? 登记.list() : []) || []
        const 目标 = String(配置.目标会话 || '')
        // ⭐ 先把「目标会话所在的工作区」排到前面 —— 这个才是它平时待的地方
        const 排 = 列表.slice().sort((a, b) => {
          const A = a && Array.isArray(a.sessionIds) && a.sessionIds.map(String).indexOf(目标) >= 0 ? 0 : 1
          const B = b && Array.isArray(b.sessionIds) && b.sessionIds.map(String).indexOf(目标) >= 0 ? 0 : 1
          return A - B
        })
        for (const w of 排) {
          const d = w && (typeof w.path === 'string' ? w.path : (w.directory || w.dir || w.root))
          if (typeof d === 'string' && d) 根们.push(d)
        }
      } catch (error) {}
      根们.push(process.cwd(), join(目录, 'workspace'), homedir())
      for (const r of 根们) 试.push(join(String(r), 原))
    }
    for (const 全 of 试) {
      try { if (existsSync(全)) return 全 } catch (error) {}
    }
    记账('找不到这张图：' + 原 + '（试过：' + 试.slice(0, 4).join(' ｜ ') + ' 等 ' + 试.length + ' 个位置；可在设置里填「图片根目录」）')
    return ''
  }

  /** 把一句正文发到该发的地方（私聊 / 群）；按空行拆段，一段一条连发。⭐ 末尾再加上图片。 */
  async function 发到QQ(配置, 原文字, 图们, 方向 = '') {
    // ⭐ 0.6.0：方向 = 会话键；拿它反查「这条绑的是哪个聊天」，然后只发那一个
    const 行 = (配置.绑定 || []).find((b) => 会话键(b.会话) === 会话键(方向)) || null
    const 出 = []
    // ⭐ 正文里的 markdown 图（贴纸就是这么发的）也当图片发；抠掉之后正文更干净
    const 抠过 = 配置.发图 ? 抠正文图(原文字) : { 净文字: String(原文字 || ''), 图: [] }
    const 文字 = 抠过.净文字
    const 段们 = 按段拆(文字).length ? 按段拆(文字) : [String(文字 || '').trim()].filter((s) => s.length > 0)
    const 发段延迟 = 450 // 每段之间隔一下，像真人一条条发
    const 最大 = Math.max(1, Math.min(Number(配置.图上限MB) || 5, 30)) * 1024 * 1024
    // ⭐ 图片：base64 或网络地址，QQ 那边直接收，不用访问本机文件
    const 图数据 = []
    const 加图 = (源) => {
      if (!源 || 图数据.length >= 4) return
      if (源.kind === 'url') { 图数据.push({ url: 源.value }); return }
      let 值 = 源.value
      // ⭐ 伙伴回发时常常照抄 DSH 给的那条「只读副本」路径（webp）——
      //    先反查一次表，能换回我们存的原图就换（GIF 才是动的）
      const 换 = 原图路径('p:' + 清路径(值).toLowerCase())
      if (换) 值 = 换
      const 全 = 找本地图(值, 配置) || 值
      try {
        const buf = readFileSync(全)
        if (buf.length > 最大) { 记账(`这张图太大（${Math.round(buf.length / 1048576)}MB），跳过`); return }
        图数据.push({ b64: buf.toString('base64') })
      } catch (error) {
        记账('读图失败，跳过：' + String((error && error.message) || error))
      }
    }
    if (配置.发图) {
      for (const 源 of 抠过.图) 加图(源)
      if (Array.isArray(图们) && 图们.length) {
        const 附件 = ctx.attachments || ctx.get('attachments')
        for (const 块 of 图们) {
          try {
            // ⭐ 优先用我们收下来的**原图**（DSH 那份副本会被转码，GIF 会变静态）
            const 原 = 原图路径('id:' + String((块.attachment && 块.attachment.attachmentId) || ''))
            if (原) { 加图({ kind: 'path', value: 原 }); continue }
            const p = 附件 && typeof 附件.imageHostPath === 'function' ? 附件.imageHostPath(块.attachment) : undefined
            if (!p) { 记账('这张图拿不到本地文件，跳过'); continue }
            加图({ kind: 'path', value: p })
          } catch (error) {
            记账('读图失败，跳过：' + String((error && error.message) || error))
          }
        }
      }
    }
    // 一条 OneBot 图片段：本地图走 base64，网络图直接把 url 交给 QQ
    const 一段图 = (x) => (x.url ? { type: 'image', data: { file: x.url, url: x.url } } : 图片段(x.b64))

    if (!行) {
      记账('这间会话没绑任何 QQ 聊天，这一轮不发出去（去设置里加一条绑定）')
      return 出
    }
    const 要私聊 = 行.类型 !== '群' && 配置.转私聊
    const 要群 = 行.类型 === '群' && 配置.转群
    if (要私聊) {
      for (let i = 0; i < 段们.length; i++) {
        const 体 = 私人消息体(段们[i])
        体.user_id = Number(行.号码)
        出.push(await 发一个(配置.NapCat, 'send_private_msg', 体, 配置))
        if (i < 段们.length - 1) await new Promise((r) => setTimeout(r, 发段延迟))
      }
      for (const x of 图数据) {
        出.push(await 发一个(配置.NapCat, 'send_private_msg', { user_id: Number(行.号码), message: [一段图(x)] }, 配置))
        await new Promise((r) => setTimeout(r, 发段延迟))
      }
    }
    if (要群) {
      for (let i = 0; i < 段们.length; i++) {
        const 体 = 群消息体(段们[i])
        体.group_id = Number(行.号码)
        出.push(await 发一个(配置.NapCat, 'send_group_msg', 体, 配置))
        if (i < 段们.length - 1) await new Promise((r) => setTimeout(r, 发段延迟))
      }
      for (const x of 图数据) {
        出.push(await 发一个(配置.NapCat, 'send_group_msg', { group_id: Number(行.号码), message: [一段图(x)] }, 配置))
        await new Promise((r) => setTimeout(r, 发段延迟))
      }
    }
    return 出
  }

  /** 一轮真正落地：总开关 / 试运行 在这儿把关。 */
  async function 落地一发(配置, 文字, 图们, 方向 = '', 是QQ唤醒 = false) {
    if (已发轮.size > 300) 已发轮.clear() // 防 Set 无限长
    // ⭐ 0.6.0：方向就是「哪一间会话」—— 下面按它去绑定里反查该发到哪个聊天
    const 这份会话 = String(方向 || '')
    if (!这份会话) return 记账('这一轮认不出是哪间会话，这轮不转')
    配置 = { ...配置, 目标会话: 这份会话 }   // 下游（图片根目录、归档检查）都看这一个
    // ⭐ 盯的会话已经归档了：别转（人已经不在这儿说话了）
    try {
      const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
      const 归档 = new Set((((登记 && 登记.archivedSessionIds) || [])).map(String))
      if (归档.has(会话键(这份会话))) return 记账('这间会话已经归档了，这轮不转（去绑定里换一间）')
    } catch (error) {}
    if (!配置.总开关) return 记账('总开关关着，这轮该转但没转')
    // ⭐ 0.7.0 出站闸一：只发 [QQ]…[/QQ] 里的那一段（块外的解释/路径/思考留在本地）
    let 待发文字 = 文字
    if (配置.只发标记内) {
      const 块 = /\[QQ\]([\s\S]*?)\[\/QQ\]/.exec(String(文字 || ''))
      if (!块 || !String(块[1] || '').trim()) {
        记账('这一轮没写 [QQ]…[/QQ] 块（「只发标记内」开着）—— 这轮不往 QQ 发')
        return
      }
      待发文字 = String(块[1]).trim()
    }
    // ⭐ 0.7.0 出站闸二：只发「被 QQ 消息叫醒的那一轮」（你坐在 DSH 里自己聊的不推到手机）
    if (配置.只回QQ唤醒) {
      if (!是QQ唤醒) {
        记账('这一轮不是 QQ 消息叫醒的（「只回 QQ 唤醒」开着）—— 只在 DSH 里说，不推 QQ')
        return
      }
    }
    const 抠过 = 配置.发图 ? 抠正文图(待发文字) : { 净文字: 待发文字, 图: [] }
    const 几张 = (Array.isArray(图们) ? 图们.length : 0) + 抠过.图.length
    const 图标 = 几张 ? `（还有 ${几张} 张图）` : ''
    const 净文 = String(抠过.净文字 || '')
    if (配置.试运行) {
      return 记账(`试运行：本来要发到 QQ →「${净文.slice(0, 40)}${净文.length > 40 ? '…' : ''}」${图标}`)
    }
    const 结果 = await 发到QQ(配置, 待发文字, 图们, 方向)
    const 全过 = 结果.length > 0 && 结果.every((r) => r.ok)
    if (结果.length === 0) {
      记账('这一边（' + (方向 || '私聊+群') + '）没开或没填号，或者这轮既没有文字也没有图（而且图都没转成）：没地方发')
      return
    }
    记账(`${全过 ? '✅ 已发到 QQ：' : '⚠ 发 QQ 有问题：'}「${净文.slice(0, 50)}${净文.length > 50 ? '…' : ''}」${图标}`)
    for (const r of 结果) {
      if (!r.ok) 记账(`   ${r.action} 失败：${JSON.stringify(r.数据).slice(0, 140)}`)
    }
  }

  /** 盯会话事件：记住这一轮最后一句，在 turn/end 时落地。 */
  function 收到事件(session, event) {
    const 配置 = 读配置()
    if (!(配置.绑定 || []).length) return
    const 键 = 会话键(session && session.id)
    // ⭐ 0.6.0：哪一间会话说的话，就按它的绑定只回那一个聊天
    const 是这条 = (配置.绑定 || []).find((b) => 会话键(b.会话) === 键) || null
    if (!是这条) return
    const 方向 = 键
    // 这一轮的「最后一句」按会话分开记（两个会话同时说话时不会串）
    const 上一轮 = 上一轮们.get(键) || 空轮()
    const 记上一轮 = (v) => 上一轮们.set(键, v)

    if (event && event.type === 'assistant/message') {
      const d = event.data || {}
      if (d.interrupted) {
        记上一轮(空轮())
        return
      }
      const 文 = String(提取正文(d.message) || '').trim()
      const 图们 = 提取图块(d.message)
      if (文) 记上一轮({ 轮号: d.turn, 文本: 文, 图们 })
      // ⭐ 有的回合是先出图、后出字（或只出图）：别把图丢了
      else if (图们.length) 记上一轮({ 轮号: d.turn, 文本: 上一轮.轮号 === d.turn ? 上一轮.文本 : '', 图们: (上一轮.轮号 === d.turn ? 上一轮.图们 : []).concat(图们).slice(0, 10) })
      return
    }

    if (event && event.type === 'turn/end') {
      const d = event.data || {}
      const 完成 = !!(d.reason && d.reason.kind === 'completed')
      const 有东西 = 上一轮.文本 || (上一轮.图们 && 上一轮.图们.length)
      // ⚠ 去重的键必须是「会话 + 轮号」：只按轮号的话，换过目标会话就会静默漏发
      const 轮标 = 键 + ':' + String(d.turn)
      if (完成 && 上一轮.轮号 === d.turn && 有东西 && !已发轮.has(轮标)) {
        已发轮.add(轮标)
        // ⚠️ 「这轮是不是 QQ 叫的」在**这里**算一次就消费掉 —— 不然 10 分钟的窗口会把
        //    后面别的轮次也当成 QQ 叫的（实测踩过：群里一条旧消息叫醒之后，之后几轮都往外发）。
        const 醒 = 唤醒时间.get(键) || 0
        const 是QQ唤醒 = 醒 > 0 && Date.now() - 醒 < QqWalake窗口
        唤醒时间.delete(键)
        void 落地一发(配置, 上一轮.文本, 上一轮.图们, 方向, 是QQ唤醒)
      }
      记上一轮(空轮())
    }
  }

  // ---------- 路由（将来给设置页用；现在也能用来手动试） ----------

  const 回 = (res, o) => {
    try {
      res.setHeader?.('content-type', 'application/json; charset=utf-8')
      res.end?.(JSON.stringify(o))
    } catch (error) {}
  }

  const 读体 = async (req) => {
    let body = ''
    try {
      for await (const chunk of req) body += chunk
    } catch (error) {}
    try {
      return JSON.parse(body || '{}')
    } catch (error) {
      return {}
    }
  }

  const 短id = (id) => {
    const s = String(id)
    return s.length <= 8 ? s : s.slice(-8)
  }

  /* 拿目标会话活着的 agent：带 / 不带 `session-` 前缀两个方向都试（照 speak-up 的写法）。 */
  const 找agent = (id) => {
    const 原 = String(id == null ? '' : id).trim()
    if (原 === '') return undefined
    const 候选 = [原]
    if (原.startsWith('session-')) 候选.push(原.slice('session-'.length))
    else 候选.push('session-' + 原)
    for (const 一个 of 候选) {
      try {
        const a = ctx.agents.get(一个)
        if (a !== undefined) return a
      } catch (error) {}
    }
    return undefined
  }

  const 新id = () => {
    try {
      return randomUUID()
    } catch (error) {
      return 'qq-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    }
  }

  /** 手搓一条 user 消息（跟 speak-up 一样：role=user，source.kind 标成 qq，不冒充她亲手打的）。 */
  const 手搓用户消息 = (文案) => ({
    id: 新id(),
    role: 'user',
    content: [{ type: 'text', text: String(文案) }],
    source: { kind: 'qq' },
  })

  /** 现在开着的会话清单（id + 标题），给设置页挑「目标会话」用 —— 不手填。 */
  const 会话清单 = () => {
    const 出 = []
    // ⭐ 归档的会话不列（归档只是藏起来，list() 里还在 —— 得单独查 workspaceRegistry 的名单）
    //   2026-10-20 修：以前完全不看归档，设置页里挑会话时混着一堆已经归档的
    const 归档 = new Set()
    try {
      const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
      for (const x of (登记 && 登记.archivedSessionIds) || []) 归档.add(String(x))
    } catch (error) {}
    try {
      const 会话服务 = ctx.get('sessions')
      const 标题服务 = ctx.get('sessionTitle')
      if (会话服务 && typeof 会话服务.list === 'function') {
        for (const s of 会话服务.list()) {
          if (归档.has(String(s.id))) continue
          let 标题 = ''
          try {
            const 快照 = 标题服务 && typeof 标题服务.get === 'function' ? 标题服务.get(s) : undefined
            标题 = 快照 && 快照.title ? String(快照.title) : ''
          } catch (error) {}
          出.push({ id: String(s.id), 标题 })
        }
      }
    } catch (error) {}
    return 出
  }

  const 概况 = async () => {
    const 配置 = 读配置()
    const 清单 = 会话清单()
    let NapCat状态 = null
    try {
      const r = await fetch(`${配置.NapCat}/get_login_info`, { method: 'POST', headers: 请求头(配置), body: '{}' })
      const j = await r.json()
      if (j && j.status === 'ok') NapCat状态 = { 用户: j.data.user_id, 昵称: j.data.nickname }
    } catch (error) {
      NapCat状态 = { 错: String((error && error.message) || error) }
    }
    const 在清单里 = (id) => (id && 清单.length ? 清单.filter((x) => 会话键(x.id) === 会话键(id)) : [])
    const 标题表 = new Map(清单.map((x) => [会话键(x.id), x.标题 || ('…' + 短id(x.id))]))
    const 绑定们 = (配置.绑定 || []).map((x) => ({
      ...x,
      会话标题: 标题表.get(会话键(x.会话)) || '',
      活着: 清单.some((y) => 会话键(y.id) === 会话键(x.会话)),
    }))
    return {
      ok: true, 版本, 配置, 配置文件, NapCat状态, 活着的会话: 清单, 日志,
      // ⭐ 2026-10-25：私聊 / 群两个方向各自的会话（老字段 目标情况 还留着 = 私聊那份）
      私聊情况: 在清单里(配置.私聊会话),
      群情况: 在清单里(配置.群会话),
      目标情况: 在清单里(配置.私聊会话),
      绑定: 绑定们,
    }
  }

  // ── 语音转写依赖：一键装（2026-10-25）─────────────────────────────
  //  她说的对：不能「我替她装就装了」—— 插件页里要有开关 + 一个按钮，点了才装，
  //  装的时候能看见进度和报错。这里只负责**起进程 + 记日志**，前端轮询看进度。
  const ASR家 = join(dirname(配置文件), 'qq-bridge-asr')
  const ASR日志 = join(ASR家, 'install.log')
  const ASRvenv = join(ASR家, '.venv')
  const ASRpython = process.platform === 'win32'
    ? join(ASRvenv, 'Scripts', 'python.exe')
    : join(ASRvenv, 'bin', 'python')
  let ASR装 = { 进行中: false, 步骤: [], 开始于: 0, 结束于: 0, 失败: '', 完成: false, 下载: null }

  const ASR写 = (行) => {
    try {
      mkdirSync(ASR家, { recursive: true })
      writeFileSync(ASR日志, '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + 行 + String.fromCharCode(10), { flag: 'a' })
    } catch (error) {}
  }
  const ASR读日志 = (行数 = 40) => {
    try {
      const 全部 = readFileSync(ASR日志, 'utf8').split(String.fromCharCode(10))
      return 全部.slice(-行数).join(String.fromCharCode(10)).trim()
    } catch (error) { return '' }
  }
  const ASR就绪 = () => existsSync(ASRpython)
  // ⭐ 2026-10-25（她说的「别人哪知道模型目录填什么」）：模型由插件自己下、自己放，
  //   用户不需要知道任何路径。「语音模型目录」那一栏只是**给你看/改**的，不该让人手填。
  const ASR模型根 = join(ASR家, 'models')
  const ASR模型名 = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
  const ASR模型目录 = () => join(ASR模型根, ASR模型名)
  const ASR模型就绪 = () => existsSync(join(ASR模型目录(), 'model.int8.onnx')) && existsSync(join(ASR模型目录(), 'tokens.txt'))
  // ⚠️ 2026-10-25（她实测）：官方那个 tar.bz2 有 **999MB** —— 因为把 fp32 模型也打进去了。
  //    我们只需要 int8 的 model.int8.onnx + tokens.txt（约 230MB + 1MB），
  //    所以改成**按文件下**（HuggingFace 上单个文件，另配 hf-mirror 兜底）。
  const ASR文件 = [
    { 名: 'model.int8.onnx', 约MB: 230 },
    { 名: 'tokens.txt', 约MB: 1 },
  ]
  const ASR文件地址们 = (名) => [
    'https://huggingface.co/csukuangfj/' + ASR模型名 + '/resolve/main/' + 名,
    'https://hf-mirror.com/csukuangfj/' + ASR模型名 + '/resolve/main/' + 名,
  ]

  /** 起一条命令，输出追加进日志；返回 {码} */
  const ASR跑 = (命令, 参数, 说明) => new Promise((resolve) => {
    ASR写('▶ ' + 说明 + '：' + 命令 + ' ' + 参数.join(' '))
    let 子 = null
    try {
      子 = spawn(命令, 参数, { cwd: ASR家, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
    } catch (error) {
      ASR写('✗ 起不来：' + String((error && error.message) || error))
      return resolve({ 码: -1 })
    }
    子.stdout.on('data', (c) => ASR写(String(c).trim().slice(-400)))
    子.stderr.on('data', (c) => ASR写(String(c).trim().slice(-400)))
    子.on('error', (e) => { ASR写('✗ ' + String((e && e.message) || e)); resolve({ 码: -1 }) })
    子.on('close', (码) => resolve({ 码: 码 === null ? -1 : 码 }))
  })

  async function 装语音依赖() {
    if (ASR装.进行中) return { ok: false, 说: '正在装，别急' }
    ASR装 = { 进行中: true, 步骤: [], 开始于: Date.now(), 结束于: 0, 失败: '', 完成: false, 下载: null }
    const 推 = (名, 态, 附) => {
      const 已 = ASR装.步骤.find((x) => x.名 === 名)
      if (已) { 已.态 = 态; if (附) 已.附 = 附 } else ASR装.步骤.push({ 名, 态, 附: 附 || '' })
    }
    const 找python = async () => {
      for (const 候选 of (process.platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]])) {
        const r = await ASR跑(候选[0], [...候选[1], '-V'], '看看有没有 ' + 候选[0])
        if (r.码 === 0) return 候选
      }
      return null
    }
    try {
      mkdirSync(ASR家, { recursive: true })
      ASR写('== 开始装语音识别依赖 ==')
      推('找 Python', '进行中')
      const py = await 找python()
      if (!py) {
        推('找 Python', '失败', '没找到 python / py')
        ASR装.失败 = '这台机器上没找到 Python（装它：https://www.python.org/downloads/）'
        return
      }
      推('找 Python', '完成', py[0])
      if (!ASR就绪()) {
        推('建独立环境', '进行中')
        const r1 = await ASR跑(py[0], [...py[1], '-m', 'venv', ASRvenv], '建 venv')
        if (r1.码 !== 0) {
          推('建独立环境', '失败', '退出码 ' + r1.码)
          ASR装.失败 = '建 venv 失败，看下面日志'
          return
        }
        推('建独立环境', '完成')
      } else 推('建独立环境', '完成', '已经有了')
      推('装 sherpa-onnx', '进行中')
      const r2 = await ASR跑(ASRpython, ['-m', 'pip', 'install', '--no-input', 'sherpa-onnx>=2', 'numpy', 'imageio-ffmpeg'], 'pip install')
      if (r2.码 !== 0) {
        推('装 sherpa-onnx', '失败', '退出码 ' + r2.码)
        ASR装.失败 = '装依赖失败（可能是网速/镜像问题，看日志最后几行）'
        return
      }
      推('装 sherpa-onnx', '完成')
      推('自检', '进行中')
      const r3 = await ASR跑(ASRpython, ['-c', 'import sherpa_onnx, numpy, imageio_ffmpeg; print("sherpa_onnx ok")'], '自检 import')
      if (r3.码 !== 0) {
        推('自检', '失败')
        ASR装.失败 = '装完了但 import 不进来，看日志'
        return
      }
      推('自检', '完成')
      // ④ 语音模型：按文件下（约 230MB + 1MB）—— 有就跳过
      if (ASR模型就绪()) 推('下载语音模型', '完成', '已经有了')
      else {
        mkdirSync(ASR模型目录(), { recursive: true })
        let 全好 = true
        for (const f of ASR文件) {
          const 目标 = join(ASR模型目录(), f.名)
          if (existsSync(目标)) { ASR写('已有 ' + f.名 + '，跳过'); continue }
          推('下载 ' + f.名, '进行中', '约 ' + f.约MB + 'MB')
          let 好 = false
          for (const 地址 of ASR文件地址们(f.名)) {
            ASR写('下载 ' + f.名 + ' ← ' + 地址)
            好 = await (async () => {
              let 写流 = null
              try {
                const r = await fetch(地址, { redirect: 'follow' })
                if (!r || !r.ok) { ASR写('  ✗ HTTP ' + (r && r.status)); return false }
                const 总 = Number(r.headers.get('content-length') || 0)
                写流 = createWriteStream(目标 + '.part')
                let 收 = 0
                const 起2 = Date.now()
                ASR装.下载 = { 文件: f.名, 已收: 0, 总, 百分比: 0, 速度KB: 0 }
                for await (const 块 of r.body) {
                  收 += 块.length
                  if (!写流.write(Buffer.from(块))) await new Promise((res) => 写流.once('drain', res))
                  const 秒 = Math.max(0.5, (Date.now() - 起2) / 1000)
                  ASR装.下载 = { 文件: f.名, 已收: 收, 总, 百分比: 总 ? Math.min(100, Math.round((收 / 总) * 100)) : 0, 速度KB: Math.round(收 / 1024 / 秒), 用时秒: Math.round(秒) }
                  if (收 % (16 * 1024 * 1024) < 块.length) ASR写('  已下 ' + Math.round(收 / 1048576) + 'MB' + (总 ? ' / ' + Math.round(总 / 1048576) + 'MB' : '') + '（' + (ASR装.下载.百分比 || 0) + '%）')
                }
                await new Promise((res) => 写流.end(res))
                写流 = null
                renameSync(目标 + '.part', 目标)
                ASR写('  ✓ ' + f.名 + ' 完成（' + Math.round(收 / 1048576) + 'MB）')
                return true
              } catch (error) {
                try { if (写流) 写流.destroy() } catch (error2) {}
                ASR写('  ✗ ' + String((error && error.message) || error))
                return false
              }
            })()
            if (好) break
          }
          if (!好) { 推('下载 ' + f.名, '失败', '两个源都没成功'); ASR装.失败 = '语音模型没下下来（' + f.名 + '）—— 再点一次会接着下已完成的'; 全好 = false; break }
          推('下载 ' + f.名, '完成')
        }
        if (全好) 推('下载语音模型', ASR模型就绪() ? '完成' : '失败', ASR模型就绪() ? '' : '下完了但文件不对')
        if (!全好 || !ASR模型就绪()) {
          if (!ASR装.失败) ASR装.失败 = '语音模型没下完 —— 再点一次「自动装依赖」会接着下（已完成的会跳过）'
          return
        }
      }
      // ⑤ 把配置里那两栏写好（用户不用知道路径）
      try {
        const 现 = 读配置()
        const 新 = { ...现, 转写命令: ASR命令(ASR模型目录()), 语音模型目录: ASR模型目录() }
        写配置(新)
        ASR写('已把「转写命令 / 语音模型目录」写进配置')
      } catch (error) { ASR写('写配置失败（不影响使用）：' + String((error && error.message) || error)) }
      ASR装.完成 = true
      ASR写('== 装完了 ==')
    } catch (error) {
      ASR装.失败 = String((error && error.message) || error)
      ASR写('✗ 意外错误：' + ASR装.失败)
    } finally {
      ASR装.进行中 = false
      ASR装.结束于 = Date.now()
    }
  }

  /** 装好的那套要用的命令（前端「一键填好」也用这个） */
  const ASR命令 = (模型目录) => {
    const 脚本 = join(PACKAGE_ROOT, 'tools', 'asr_cli.py')
    const 模 = String(模型目录 == null ? (读配置().语音模型目录 || '') : 模型目录).trim()
    return '"' + ASRpython + '" "' + 脚本 + '" "{file}"' + (模 ? ' --模型目录 "' + 模 + '"' : '')
  }

  const 路线 = (路径, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: 路径,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            回(res, { ok: false, 说: String((error && error.message) || error) })
          }
        },
      }),
    )

  // ── 语音转写：装依赖 / 看进度 / 一键填命令 ──────────────────────
  路线(`${路由前缀}/asr-status`, async (req, res) => {
    return 回(res, {
      ok: true,
      就绪: ASR就绪(),
      模型就绪: ASR模型就绪(),
      模型目录: ASR模型目录(),
      进行中: ASR装.进行中,
      步骤: ASR装.步骤,
      完成: ASR装.完成,
      失败: ASR装.失败,
      下载: ASR装.下载,
      用时秒: ASR装.开始于 ? Math.round(((ASR装.结束于 || Date.now()) - ASR装.开始于) / 1000) : 0,
      日志: ASR读日志(40),
      命令: ASR命令(ASR模型就绪() ? ASR模型目录() : ''),
      python: ASR就绪() ? ASRpython : '',
    })
  })

  路线(`${路由前缀}/asr-install`, async (req, res) => {
    await 读体(req)
    记账('点了「装语音识别依赖」—— 后台开始，进度看设置页')
    void 装语音依赖()          // ⚠ 不等它：装依赖可能几分钟，不能把请求挂住（bili 那边踩过这个坑）
    return 回(res, { ok: true, 说: '开始装了，进度会显示在下面（可以关掉设置页，装完日志还在）' })
  })

  路线(`${路由前缀}/state`, async (req, res) => {
    await 读体(req)
    回(res, await 概况())
  })

  路线(`${路由前缀}/save`, async (req, res) => {
    const 来 = await 读体(req)
    const 现在 = 读配置()
    const 新 = { ...现在, ...(来 && typeof 来 === 'object' ? 来 : {}) }
    const 洗好 = 归一化(新)
    if (!写配置(洗好)) return 回(res, { ok: false, 说: `写不进配置文件：${配置文件}` })
    const 状态 = 洗好.总开关 ? (洗好.试运行 ? '（只记账）' : '（真发）') : '（总开关关着）'
    // ⭐ 0.6.0：报「几条绑定」＋ 挡掉了几个重复（同一个会话 / 同一个聊天只能绑一条）
    const 想绑 = Array.isArray(来 && 来.绑定) ? 来.绑定.filter((x) => x && x.会话 && x.号码).length : 0
    const 实绑 = (洗好.绑定 || []).length
    记账(`设置已保存：绑定 ${实绑} 条${想绑 > 实绑 ? '（挡掉 ' + (想绑 - 实绑) + ' 条重复：同一间会话/同一个聊天只能绑一条）' : ''}｜${状态}`
      + (洗好.令牌 ? '｜带接口令牌' : ''))
    回(res, { ...(await 概况()), 说: '保存好了' })
  })

  // 收到 QQ 里你发来的话 → 喂进目标会话，让它照常开一轮。
  // ⚠ 这是「QQ → DSH」那半的**入口函数**：一句正文（+ 图）→ agent.followup 走 DSH 自己的回合。
  // ⭐ 2026-10-22：加了图片。图会先落一份到 `~/.dsh/qq-bridge-inbox/`，再把图交给 DSH 的
  //    attachments；模型能看图就直接看，纯文本模型拿到的是一句占位文字 —— 所以文字里也写上本地路径。
  // ── QQ 里的「分享卡片」和「合并转发的聊天记录」也读成文字（2026-10-25）──────────
  //   以前只认 text / image / mface ⇒ 她一发 B站 卡片、或者转发一段聊天记录，
  //   段里没有文字、也没有图，整条被当成「空消息」丢掉 —— 看着就是「QQ 桥读不了」。
  const 掐短 = (s2, n = 120) => {
    const t = String(s2 == null ? '' : s2).replace(/\s+/g, ' ').trim()
    return t.length > n ? t.slice(0, n) + '…' : t
  }
  const 反斜 = (t) => String(t || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  const 抽BV号 = (文) => {
    const m = /BV[0-9A-Za-z]{10}/.exec(String(文 || ''))
    return m ? m[0] : ''
  }
  /** 从分享卡片段（json / xml）里抽标题、描述、链接 —— 抽不到也给一句看得懂的话 */
  function 卡片文字(段) {
    const d = (段 && 段.data) || {}
    let 原 = d.data != null ? d.data : (d.content != null ? d.content : (d.xml != null ? d.xml : ''))
    if (原 && typeof 原 === 'object') 原 = JSON.stringify(原)
    原 = 反斜(String(原 || ''))
    const 题们 = []
    let 链接 = ''
    try {
      const j = JSON.parse(原)
      const 摸 = (o, 层 = 0) => {
        if (!o || typeof o !== 'object' || 层 > 6) return
        for (const [k, v] of Object.entries(o)) {
          if (typeof v === 'string') {
            const 值 = 反斜(v).trim()
            if (/^(title|desc|summary|prompt)$/i.test(k) && 值) 题们.push(值)
            if (/^(jumpUrl|qqdocurl|url)$/i.test(k) && /^https?:/i.test(值) && !链接) 链接 = 值
          } else 摸(v, 层 + 1)
        }
      }
      摸(j)
    } catch (e) { /* 不是 JSON 就按 xml 抓 */ }
    if (!题们.length || !链接) {
      const 标题 = /<title>([\s\S]{0,100}?)<\/title>/i.exec(原)
      if (标题 && 反斜(标题[1]).trim()) 题们.push(反斜(标题[1]).trim())
      const 摘要 = /<summary>([\s\S]{0,140}?)<\/summary>/i.exec(原)
      if (摘要 && 反斜(摘要[1]).trim()) 题们.push(反斜(摘要[1]).trim())
      const 链 = /(https?:\/\/[^\s"'<>&]+)/.exec(原)
      if (链 && !链接) 链接 = 链[1]
    }
    const 题 = [...new Set(题们)].slice(0, 2).join(' —— ')
    const bv = 抽BV号(原 + ' ' + 链接)
    const 尾 = [链接 ? '链接 ' + 链接 : '', bv ? 'BV号 ' + bv : ''].filter(Boolean).join('　')
    if (!题 && !尾) return '[分享卡片（里面没抓到内容）]'
    const 头 = bv ? '[分享视频卡片]' : '[分享卡片]'
    return 头 + ' ' + (题 || '（没标题）') + (尾 ? String.fromCharCode(10) + '  ' + 尾 : '')
  }
  /** 合并转发的聊天记录：拿 id 去 NapCat 取节点，压成几行 */
  /**
   * 合并转发的聊天记录：拿 id 去 NapCat 取节点，压成「一行一句」。
   * ⭐ 2026-10-25：分两层处理 —— **外层几句话就几行**，里面那层转发**另起一段、缩进一层**，
   *    不再把内层整段塞进同一行（上一版会挤成一大坨，人看着不直观）。
   *    一条转发里套好几个转发也照样各起一段。
   * ⚠️ 只展开 2 层；第一层里的图可以在「收图」开着时顺手收进来（第二层起只标 [图片]）。
   */
  async function 转发行们(段, 拉任意, 图袋, 层, 预算) {
    const 缩 = '  '.repeat(层 + 1)
    const d = (段 && 段.data) || {}
    const id = String(d.id != null ? d.id : (d.message_id != null ? d.message_id : (d.content != null ? d.content : '')))
    if (!id) return [缩 + '[合并转发的聊天记录（没有 id，读不出来）]']
    let 节点们 = []
    for (const 体 of [{ message_id: id }, { id }]) {
      const 结果 = await 拉任意('get_forward_msg', 体)
      const 候选 = (结果 && (结果.messages || 结果.message)) || null
      if (Array.isArray(候选) && 候选.length) { 节点们 = 候选; break }
    }
    if (!节点们.length) return [缩 + '[合并转发的聊天记录（内容取不到）]']
    const 行 = [缩 + '[合并转发的聊天记录 · 共 ' + 节点们.length + ' 条]']
    for (const 节 of 节点们.slice(0, 12)) {
      if (预算.行 <= 0) { 行.push(缩 + '  …（后面的没展开）'); break }
      预算.行--
      const 谁 = String((节 && 节.sender && (节.sender.card || 节.sender.nickname)) || (节 && 节.nickname) || '某人')
      const 段们 = Array.isArray(节 && 节.content) ? 节.content : (Array.isArray(节 && 节.message) ? 节.message : [])
      const 文本块 = []
      const 内层 = []
      for (const x of 段们) {
        if (!x) continue
        const 型 = String(x.type || '')
        if (型 === 'text') { 文本块.push(String((x.data && x.data.text) || '')); continue }
        if (型 === 'image' || 型 === 'mface') {
          if (层 === 0 && Array.isArray(图袋)) 图袋.push(x)   // 只收第一层的图
          文本块.push('[图片]')
          continue
        }
        if (型 === 'face') { 文本块.push('[表情]'); continue }
        if (型 === 'record') { 文本块.push('[语音]'); continue }
        if (型 === 'video') { 文本块.push('[视频]'); continue }
        if (型 === 'json' || 型 === 'xml') { 文本块.push('[卡片]'); continue }
        if (型 === 'at') { 文本块.push('@' + String((x.data && (x.data.name || x.data.qq)) || '')); continue }
        if (型 === 'forward') { 内层.push(x); continue }
      }
      const 头 = 缩 + '  ' + 掐短(谁, 20) + '：'
      const 文本 = 文本块.join('').replace(/[ 	]+/g, ' ').replace(/[\r\n]+/g, ' ').trim()
      if (文本) 行.push(头 + 掐短(文本, 240))
      // 这个人的消息**只有一段转发**、没有别的话：也得让人看出是谁转的
      else if (内层.length && 层 === 0) 行.push(头 + '（转发的聊天记录）')
      for (const 内 of 内层) {
        if (层 >= 1) { 行.push(头 + '[里面还套了一层转发（不再展开）]'); continue }
        行.push(...(await 转发行们(内, 拉任意, 图袋, 层 + 1, 预算)))
      }
      if (!文本 && !内层.length) 行.push(头 + '（这条没内容）')
    }
    return 行
  }

  /** 一条合并转发 → 整段文字（行数 / 字数都有上限，别把上下文吃光） */
  async function 转发文字(段, 拉任意, 图袋) {
    const 行们 = await 转发行们(段, 拉任意, 图袋, 0, { 行: 40 })
    let 文 = 行们.join(String.fromCharCode(10))
    if (文.length > 2500) 文 = 文.slice(0, 2500) + String.fromCharCode(10) + '…（太长，剩下的没展开）'
    return 文
  }

  async function 转入一条(文字, 图们, 消息id, 行, 发送者) {
    const 配置 = 读配置()
    // ⭐ 2026-10-25（0.6.0）：传「绑定行」进来 —— 每一行自带类型 / 号码 / 会话 / 称呼
    const 这条 = 行 || (配置.绑定 || [])[0] || null
    const 这间 = String((这条 && 这条.会话) || 配置.私聊会话 || '')
    if (!这间) return { ok: false, 说: '还没绑任何聊天（私聊或群）' }
    if (!配置.总开关) return { ok: false, 说: '总开关关着，先打开' }
    const agent = 找agent(这间)
    if (!agent) return { ok: false, 说: `那间会话现在没活着（${短id(这间)}），先把它打开` }

    // ── 收图：限量、限重，失败就跳过，不挡住文字 ──
    const 收下 = []
    if (配置.收图 && Array.isArray(图们) && 图们.length) {
      const 上限 = Math.max(1, Math.min(Number(配置.收图最多) || 4, 10))
      const 最大 = Math.max(1, Math.min(Number(配置.图上限MB) || 5, 30)) * 1024 * 1024
      let 序 = 0
      for (const 段 of 图们.slice(0, 上限)) {
        序 += 1
        const buf = await 取图字节(段 && 段.data ? 段.data : 段)
        if (!buf || !buf.length) { 记账(`第 ${序} 张图下载失败，跳过`); continue }
        if (buf.length > 最大) { 记账(`第 ${序} 张图太大（${Math.round(buf.length / 1048576)}MB），跳过`); continue }
        const 类 = 看图类(buf)
        收下.push({ 类, b64: buf.toString('base64'), 存: 存一张(`${消息id || 'qq'}-${序}`, buf, 类), 字节: buf.length })
      }
    }

    const 原话 = String(文字 || '').trim()
    // 称呼跟着这一行走（群里不止一个人，别拿私聊的名字去叫）
    const 谁 = String((这条 && 这条.称呼) || ((这条 && 这条.类型 === '群') ? '群里的人' : '对方'))
    const 说明 = 收下.length
      ? String.fromCharCode(10) + '（' + 谁 + '发了 ' + 收下.length + ' 张图：'
        + 收下.map((x, i) => `第${i + 1}张 ${Math.round(x.字节 / 1024)}KB` + (x.存 ? `，要发回去就用 ${x.存}` : '')).join('；')
        + '）'
      : ''
    // ⚠️ 2026-10-25（她报的）：群消息以前只有正文，**看不出是谁说的**。
    //    群里必须标清楚「昵称（QQ号）：」；私聊不用（就对面那一个人）。
    const 署名 = (这条 && 这条.类型 === '群' && 发送者 && (发送者.昵称 || 发送者.号码))
      ? String(发送者.昵称 || '某人') + '（' + String(发送者.号码 || '?') + '）：'
      : ''
    const 基础 = (原话 ? 署名 + 原话 : (收下.length ? 署名 + '（' + 谁 + '发来了图片，没有配字）' : '')) + 说明
    if (!基础) return { ok: false, 说: '这条既没文字也没图，不转' }
    // ⭐ 这一行开了门槛时，顺手告诉它「先判断这条是不是在跟你说话」
    const 门槛提示 = Boolean(这条 && 这条.门槛 && 这条.类型 === '群')
      ? String.fromCharCode(10) + String.fromCharCode(10)
        + '（这条是从 QQ 转进来的：先判断是不是在跟你说话 —— 不是就调 `qq_reply_gate` 传 reply=false，这一轮直接停；'
        + '是冲你来的就正常回。）'
      : ''
    // ⭐ 开了「只发 [QQ] 块」时，必须告诉它这个约定 —— 不然它压根不会写这个块，一开开关就一条都发不出去
    const 块提示 = 配置.只发标记内
      ? String.fromCharCode(10) + String.fromCharCode(10)
        + '（这台机器只把正文里 `[QQ]…[/QQ]` 中间那段发到 QQ —— 想让手机收到的就写在里面；'
        + '块外的话只在本机看，不会发出去。）'
      : ''
    const 文案 = 基础 + 门槛提示 + 块提示

    let content = [{ type: 'text', text: 文案 }]
    if (收下.length) {
      const 附件 = ctx.attachments || ctx.get('attachments')
      if (附件 && typeof 附件.admitPromptContent === 'function') {
        try {
          const 待 = content.concat(收下.map((x, i) => ({
            type: 'image', data: x.b64, mediaType: x.类, name: `qq-${消息id || 'x'}-${i + 1}.${扩展(x.类)}`,
          })))
          content = await 附件.admitPromptContent(待)
          // ⭐ 记下「附件 id / DSH 那份只读副本 → 我们存的原图」，回发时换回原图（GIF 不会变静态 webp）
          const 图块 = content.filter((x) => x && x.type === 'image' && x.attachment)
          for (let i = 0; i < 图块.length && i < 收下.length; i++) {
            let 副本 = ''
            try { 副本 = typeof 附件.imageHostPath === 'function' ? String(附件.imageHostPath(图块[i].attachment) || '') : '' } catch (error) {}
            记收图(图块[i].attachment && 图块[i].attachment.attachmentId, 副本, 收下[i].存)
          }
        } catch (error) {
          记账('图交给 DSH 没成功（这轮只转文字）：' + String((error && error.message) || error))
          content = [{ type: 'text', text: 文案 }]
        }
      } else {
        记账('宿主没有 attachments 服务，图只能存本地（文字里已经给了路径）')
      }
    }

    try {
      // ⚠⚠ 必须 await：followup 返回 Promise。不接住的话，它 reject 时（会话半死 / agent 已释放）
      //   catch 根本看不到（try 早就退出了）⇒ 未处理的 rejection ⇒ **整个 DSH 宿主退出**
      //   （2026-10-21：speak-up 同一个坑已经被用户报成"装了鱼就死了"，这里一并修）
      await agent.followup({ id: 新id(), role: 'user', content, source: { kind: 'qq' } })
      唤醒时间.set(会话键(这间), Date.now())   // 记一下「这间是被 QQ 叫起来的」
      try {
        if (ctx.sessions && typeof ctx.sessions.flush === 'function') await ctx.sessions.flush(agent.session)
      } catch (error) {}
      const 图话 = 收下.length ? `（含 ${收下.length} 张图）` : ''
      记账(`收到 QQ 里的${收下.length ? '图片' : '话'}${图话} → 转进 DSH：「${(原话 || '（没配字）').slice(0, 50)}${原话.length > 50 ? '…' : ''}」`)
      return { ok: true, 说: '转进去了，它会照常开一轮' }
    } catch (error) {
      return { ok: false, 说: `followup 失败：${String((error && error.message) || error)}` }
    }
  }

  /** 只要文字的那条老入口（给 /receive 路由和测试用） */
  async function 转入文字(文字) {
    return 转入一条(文字, [], '')
  }

  // ── 回复门槛（2026-10-25）─────────────────────────────────────────
  //  口径（她定的）：**消息照常进来、照常叫醒**；判断放在"思考的时候" ——
  //  模型调 `qq_reply_gate` 看这条是不是在跟它说话：
  //    · reply = true  → 正常接话；
  //    · reply = false → 我们调 agent.cancel()，这一轮立刻停（界面上会显示成一次中断/报错）。
  //  ⭐ 一个天然的好处：我们的回发**只在 turn/end=completed 时才发**，
  //     被 cancel 的那轮不是 completed ⇒ 一个字都不会漏到 QQ，不用另写抑制。
  //  ⚠️ 工具只在「被 QQ 叫醒后的一小段时间内」有效 —— 她自己在 DSH 界面上聊天时，
  //     模型就算想关闸也关不掉（避免把自己的一轮聊没了）。
  // ⚠️ 2026-10-25：以前是**全局一个时间戳** —— A 群刚被 QQ 叫醒，B 群这轮也会被当成「QQ 叫的」。
  //    现在按会话记：哪个聊天叫醒的，只有那一间算。
  const 唤醒时间 = new Map()   // 会话键 -> 时间戳
  const 闸门挂着 = new Map()   // sid -> disposer（DSH 的 tools.register 返回的就是一个收尾函数）
  const QqWalake窗口 = 10 * 60 * 1000

  const 做闸门工具 = (agent, sid) => ({
    name: 'qq_reply_gate',
    description:
      '只在「这一轮是被 QQ 消息叫醒的」时候用。先判断这条消息是不是在跟你说话：' +
      '是在跟别人聊、跟你没关系、或者只是别人之间的对话 —— 就传 reply=false，这一轮会立刻停下，什么都不会发出去。' +
      '如果是冲你来的（叫你的名字、问你、跟你撒娇、@ 你、引用你），传 reply=true 正常接话。',
    parameters: {
      reply: { type: 'boolean', required: true, description: 'true = 这条是在跟我说话，正常回；false = 不关我的事，停掉这一轮' },
      reason: { type: 'string', description: '一句话理由（只写进日志，群里/私聊都看不到）' },
    },
    // ⚠️ 2026-10-25（她报的「门槛没生效」）：DSH 要求每个工具**必须声明 output**，
    //    缺了就注册失败（日志里那句 `tool "qq_reply_gate" must declare output`），
    //    于是门槛工具一直没挂上、面板也看不出来。补上。
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const 配置 = 读配置()
      const 这行 = (配置.绑定 || []).find((b) => 会话键(b.会话) === sid) || null
      if (!这行 || !这行.门槛 || 这行.类型 !== '群') return { ok: false, 说: '这个聊天没开门槛，不用调这个工具' }
      const 醒 = 唤醒时间.get(sid) || 0
      if (!(醒 > 0 && Date.now() - 醒 < QqWalake窗口)) {
        return { ok: false, 说: '这一轮不是 QQ 消息叫起来的，不能用它停轮 —— 正常回就行' }
      }
      if (!args || args.reply !== false) {
        唤醒时间.delete(sid)
        return { ok: true, 说: '好，这条是冲我来的，正常回' }
      }
      唤醒时间.delete(sid)
      const 理由 = String((args && args.reason) || '').trim()
      记账('回复门槛：判定这条不是在跟我说话 → 停掉这一轮（' + 短id(sid) + '）' + (理由 ? '，理由：' + 理由 : ''))
      try {
        if (typeof agent.cancel === 'function') await agent.cancel({ kind: 'user' })
        else 记账('   ⚠ agent.cancel 不在这台宿主上 —— 这一轮停不下来（会照常回）')
      } catch (error) {
        记账('   取消失败：' + String((error && error.message) || error))
      }
      return { ok: true, 说: '已停，这一轮不会回 QQ' }
    },
  })

  /** 每一小跳：门槛开着就给「绑了 QQ 的那几间屋」挂上这个工具，关掉就卸下来 */
  function 闸门心跳() {
    try {
      const 配置 = 读配置()
      const 该挂 = new Set()
      // ⭐ 只认每一行自己的门槛（0.8.2 去掉了那个让人犯晕的总开关）
      for (const 行 of (配置.绑定 || [])) {
        if (行.类型 !== '群') continue     // 私聊不判（自己私聊本来就是在跟它说话）
        if (!行.门槛) continue
        const id = String(行.会话 || '').trim()
        if (id) 该挂.add(id)
      }
      // 挂
      for (const id of 该挂) {
        const agent = 找agent(id)
        if (!agent) continue
        const sid = 会话键((agent.session && agent.session.id) || id)
        if (闸门挂着.has(sid)) continue
        try {
          const off = agent.ctx.tools.register(做闸门工具(agent, sid))
          闸门挂着.set(sid, off)
          记账('回复门槛已挂上（' + 短id(sid) + '）')
        } catch (error) {
          记账('回复门槛挂不上（' + 短id(sid) + '）：' + String((error && error.message) || error))
        }
      }
      // 卸
      for (const [sid, off] of 闸门挂着) {
        const 还要 = [...该挂].some((id) => 会话键(id) === sid)
        if (还要) continue
        try { if (typeof off === 'function') off() } catch (error) {}
        闸门挂着.delete(sid)
        记账('回复门槛已卸下（' + 短id(sid) + '）')
      }
    } catch (error) {
      记账('回复门槛心跳出错：' + String((error && error.message) || error))
    }
  }

  /**
   * 轮询 NapCat 的 HTTP 历史接口，把「她新发的私聊 / 群消息」一条条转进 DSH。
   * ⚠ 纯 HTTP 轮询：不连 WebSocket、不依赖 BOT。
   * ⚠ 只认 `私聊QQ` 这个人发的（群也一样按这个号过滤），自己的回话不会自我繁殖。
   */
  async function 轮询收消息() {
    const 配置 = 读配置()
    // 总开关关 / 一条绑定都没有：只把「上次时间」推到此刻，别开的时候就补一大串旧的
    if (!配置.总开关 || !(配置.绑定 || []).length) {
      for (const k of [...上次时间.keys()]) 上次时间.set(k, Math.floor(Date.now() / 1000))
      return
    }
    // 群里只认「私聊那行绑的那个号」（就是你自己）；没绑私聊行的话，群里谁的话都不转
    const 本人号 = Number(((配置.绑定 || []).find((x) => x.类型 === '私聊') || {}).号码) || 0

    const 拉 = async (action, 体) => {
      try {
        const r = await fetch(`${配置.NapCat}/${action}`, {
          method: 'POST', headers: 请求头(配置), body: JSON.stringify(体),
        })
        const j = await r.json()
        return j && j.status === 'ok' && Array.isArray(j.data && j.data.messages) ? j.data.messages : []
      } catch (error) {
        return []
      }
    }
    // ⭐ 拉任意一个 NapCat 接口（合并转发要单独取一次内容；它的返回不是 data.messages 那种形状）
    const 拉任意 = async (action, 体) => {
      try {
        const r = await fetch(`${配置.NapCat}/${action}`, {
          method: 'POST', headers: 请求头(配置), body: JSON.stringify(体 || {}),
        })
        const j = await r.json()
        return (j && j.status === 'ok' && j.data) || null
      } catch (error) {
        return null
      }
    }
    // ⚠️ 2026-10-25（用户报「读不了 B站 卡片 / 转发记录」）：以前这里只看 text / image / mface，
    //    卡片和合并转发既没文字也没图 ⇒ 整条被当成空消息丢掉。现在它们也会变成文字。
    const 收图上限 = () => Math.max(1, Math.min(Number(配置.收图最多) || 4, 10))
    const 条转片段 = async (条) => {
      const 段们 = Array.isArray(条.message) ? 条.message : []
      const 图们 = []
      const 文们 = []
      for (const 段 of 段们) {
        if (!段 || !段.data) continue
        const 型 = String(段.type || '')
        if (型 === 'text') { 文们.push(String(段.data.text || '')); continue }
        if (型 === 'image' || 型 === 'mface') { 图们.push(段); continue }   // 表情包也带 url，能拿到字节
        if (型 === 'json' || 型 === 'xml') { 文们.push(卡片文字(段)); continue }
        if (型 === 'forward') {
          // ⭐ 转发里的图**跟着「收图」这个开关走**（不另加开关）：开着收几张，关着只标 [图片]
          const 袋 = 配置.收图 ? [] : null
          try {
            const 文 = await 转发文字(段, 拉任意, 袋)
            文们.push(文)
            if (Array.isArray(袋) && 袋.length) {
              const 余量 = Math.max(0, 收图上限() - 图们.length)
              for (const x of 袋.slice(0, 余量)) 图们.push(x)
            }
          } catch (error) { 文们.push('[合并转发的聊天记录（读失败了）]') }
          continue
        }
        if (型 === 'at') { 文们.push('@' + String((段.data && (段.data.name || 段.data.qq)) || '')); continue }
        if (型 === 'face') { 文们.push('[表情]'); continue }
        if (型 === 'record') {
          // ⭐ 0.8.0：开着「语音转写」且配了命令 → 把语音条变成文字；否则还是 [语音]
          文们.push(await 转写语音(段, 拉任意, 配置, {
            家目录: dirname(配置文件), ffmpeg: await 找ffmpeg(), 消息id: 条.message_id,
          }))
          continue
        }
        if (型 === 'video') { 文们.push('[视频]'); continue }
      }
      return { 文字: 文们.join(String.fromCharCode(10)).trim(), 图们 }
    }

    // ⭐ 0.6.0：一行一行地拉 —— 一个聊天 → 一间会话，各自记各自的「看到哪儿了」
    for (const 行 of 配置.绑定) {
      const 是群 = 行.类型 === '群'
      const 动作 = 是群 ? 'get_group_msg_history' : 'get_friend_msg_history'
      const 体 = 是群
        ? { group_id: Number(行.号码), count: 30 }
        : { user_id: Number(行.号码), count: 10 }
      const 列表 = await 拉(动作, 体)
      const 键2 = 行.类型 + ':' + 行.号码
      // ⚠️ 没记录过这个聊天（比如刚加绑定 / 第一次跑）时，从**此刻**开始算 ——
      //   否则历史消息会全被当成新的补投一遍（她报的那个「没发消息却自己回了」就有这一层）。
      let 上次 = 上次时间.has(键2) ? (上次时间.get(键2) || 0) : Math.floor(Date.now() / 1000)
      for (const 条 of 列表.sort((a, b) => (a.time || 0) - (b.time || 0))) {
        if (!条) continue
        // 私聊：只认对面那个号；群：只认你自己—— 别人的话不转（防噪音，也防被别人的话牵着走）
        if (是群 ? (本人号 && Number(条.user_id) !== 本人号) : (Number(条.user_id) !== Number(行.号码))) continue
        if (!是群 && !本人号) continue
        if ((条.time || 0) < 上次) continue           // 旧的，跳过
        if (已转消息.has(条.message_id)) continue     // 转过了
        const { 文字, 图们 } = await 条转片段(条)
        // 纯表情（没图没字）就别转了，记掉别再反复拉
        if (!文字 && !图们.length) { 已转消息.add(条.message_id); 上次 = 条.time || 上次; continue }
        // ⚠️ 2026-10-25（她问的）：那间会话要是**当时没开着**（死的），这条不能算「转过了」——
        //   否则她一会儿把它点活了，这条就永远丢了（还不会补）。
        //   所以：**真转进去了**才算数；没转进去就不动「上次」和「已转」，下一跳（4 秒后）自己再来一遍。
        // ⚠️ 2026-10-25（她报的「打开会话就被自动回一条」）：会话关着的时候攒下的旧消息，
        //    隔太久（默认 10 分钟）就别补投了 —— 否则她一点进那间屋，就会突然冒出一条「自动回复」。
        const 太旧 = (条.time || 0) > 0 && (Math.floor(Date.now() / 1000) - 条.time) > (Number(配置.补投窗口分) || 10) * 60
        if (太旧) {
          已转消息.add(条.message_id)
          上次 = 条.time || 上次
          记账('这条 QQ 消息已经是 ' + Math.round((Date.now() / 1000 - 条.time) / 60) + ' 分钟前的了，不再补投（怕一打开会话就冒出一条旧回复）')
          continue
        }
        const 发送者 = {
          昵称: String((条.sender && (条.sender.card || 条.sender.nickname)) || 条.nickname || (条.user_id ? 'QQ ' + 条.user_id : '')),
          号码: Number(条.user_id) || 0,
        }
        const 结果 = await 转入一条(文字, 图们, 条.message_id, 行, 发送者)
        if (结果 && 结果.ok) {
          已转消息.add(条.message_id)
          上次 = 条.time || 上次
        } else {
          记账('这条先没转进去（' + 短id(行.会话) + '：' + String((结果 && 结果.说) || '原因不明') + '），下一跳再试')
          break        // 这一行先停在这儿，等那间屋活过来
        }
      }
      上次时间.set(键2, 上次)
    }

    if (已转消息.size > 300) {
      // 别 clear（clear 会让下一跳把旧的又当新的）—— 只留最近 300 个
      const 全 = [...已转消息]
      for (const id of 全.slice(0, Math.max(0, 全.length - 300))) 已转消息.delete(id)
    }
    存水位()
  }

  路线(`${路由前缀}/receive`, async (req, res) => {
    const 来 = await 读体(req)
    const 文字 = typeof 来.text === 'string' ? 来.text.trim() : ''
    if (!文字) return 回(res, { ok: false, 说: '没有文字（body 里给 text）' })
    回(res, await 转入文字(文字))
  })

  // 手动试一发：**真发**（绕过试运行），只发一条固定测试句，动不了已发轮
  路线(`${路由前缀}/test-send`, async (req, res) => {
    await 读体(req)
    const 配置 = 读配置()
    if (!配置.私聊QQ && !配置.群号) return 回(res, { ok: false, 说: '私聊 QQ 和群号都是空的，先保存一个再试' })
    const 文字 = '（这是一条测试消息：DSH → QQ 通了）'
    const 结果 = await 发到QQ(配置, 文字)
    const 全过 = 结果.length > 0 && 结果.every((r) => r.ok)
    记账(`手动测试：${全过 ? '✅ 已发' : '⚠ 有问题'}「${文字}」`)
    for (const r of 结果) if (!r.ok) 记账(`   ${r.action} 失败：${JSON.stringify(r.数据).slice(0, 140)}`)
    回(res, { ok: 全过, 说: 全过 ? '测试句已经发到 QQ 了' : '有一步没发出去（看下面的记录）', 记录: 日志 })
  })

  // ---------- 挂监听 ----------

  ctx.effect(() => {
    const 摘 = ctx.on('session/event', (session, event) => {
      try {
        收到事件(session, event)
      } catch (error) {
        记账(`转发时出错：${String((error && error.message) || error)}`)
      }
    })
    return () => {
      try {
        if (typeof 摘 === 'function') 摘()
      } catch (error) {}
    }
  }, 'qq-bridge: 盯伙伴说话')

  // 轮询 NapCat 收「她新发的 QQ」→ 转进 DSH（QQ → DSH 这半，不赖 BOT）
  ctx.effect(() => {
    if (typeof ctx.interval !== 'function') {
      记账('拿不到 timer（ctx.interval 不在）—— QQ → DSH 的轮询收消息跑不起来，但 DSH → QQ 照常能用')
      return () => {}
    }
    const 停 = ctx.interval(() => {
      闸门心跳()
      void 轮询收消息().catch((error) => {
        try { ctx.logger?.info(`qq-bridge: 轮询出错：${String((error && error.message) || error)}`) } catch (e2) {}
      })
    }, 4000)
    return () => {
      try {
        if (typeof 停 === 'function') 停()
      } catch (error) {}
    }
  }, 'qq-bridge: 轮询收 QQ 消息')

  记账(`已装好 v${版本}：DSH↔QQ 两半都在｜总开关 ${读配置().总开关 ? '开' : '关'}｜试运行 ${读配置().试运行 ? '开（只记账）' : '关（真发）'}｜收消息 4 秒轮询一次`)

  return { 记账, 概况, 落地一发, 发到QQ, 收到事件, 日志 }
}