// DSH「通到 QQ」· 宿主半边
//
// 这一半只做一件事（先只做 DSH → QQ）：
//   伙伴在「目标会话」里说完一句话（一整轮的最后一句），就自动把它发到 QQ（私聊 / 群）。
//   发 QQ 走 NapCat 的 OneBot HTTP 接口（127.0.0.1:3000），走标准的 OneBot 11 HTTP。
//
// 反过来（QQ → DSH）是下一半，放到另一个插件/进程里做，不在这里混。
//
// ⚠ 安全默认：总开关 = false、试运行 = true —— 不手动打开，一句都不会真的发到 QQ。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createSelfUpdate } from './selfupdate.mjs'

export const name = 'qq-bridge'

/** 需要宿主提供：webServer（路由）+ sessions/sessionTitle（目标会话清单 + 标题）+ agents（followup）+ timer（轮询收消息）+ attachments（图片）。 */
export const inject = ['agents', 'sessions', 'sessionTitle', 'webServer', 'timer', 'workspaceRegistry', 'attachments']

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
  NapCat: 'http://127.0.0.1:3000', // OneBot HTTP 接口（无 token）
  // ⭐ 2026-10-22：图片两个方向
  收图: true, // QQ → DSH：她发的图片也转进来
  收图最多: 4, // 一条消息最多转几张
  发图: true, // DSH → QQ：伙伴发的图片也发过去
  图上限MB: 5, // 单张最大多少 MB（两个方向共用）
  图片根目录: '', // 正文里 `![名字](相对路径)` 按哪个目录去找（留空 = 自动猜）
  称呼: '对方', // ⭐ 私聊时怎么称呼跟它说话的那个人（写进转给它的文案里，比如「小明发来了图片」）
  群称呼: '群里的人', // ⭐ 群聊时怎么称呼（群里不止一个人，一般别填某个人的名字）
}

/** 版本从 package.json 读。 */
const 版本 = (() => {
  try {
    const p = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
    return String(p.version || '?')
  } catch (error) {
    return '?'
  }
})()

// ---------- 配置读写 ----------

function 布(值, 兜) {
  if (值 === true || 值 === 'true' || 值 === 1 || 值 === '1') return true
  if (值 === false || 值 === 'false' || 值 === 0 || 值 === '0') return false
  return 兜
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
  return {
    总开关: 布(混.总开关, 默认配置.总开关),
    试运行: 布(混.试运行, 默认配置.试运行),
    // ⭐ 私聊 / 群各一间屋（2026-10-25）：老配置只有 目标会话，自动当成「私聊会话」
    私聊会话: 字(混.私聊会话) || 字(混.目标会话),
    群会话: 字(混.群会话),
    目标会话: 字(混.私聊会话) || 字(混.目标会话), // 老代码还看这个，永远等于私聊会话
    私聊QQ: 字(混.私聊QQ),
    群号: 字(混.群号),
    转私聊: 布(混.转私聊, 默认配置.转私聊),
    转群: 布(混.转群, 默认配置.转群),
    NapCat: 字(混.NapCat) || 默认配置.NapCat,
    收图: 布(混.收图, 默认配置.收图),
    发图: 布(混.发图, 默认配置.发图),
    收图最多: 数(混.收图最多, 默认配置.收图最多, 1, 10),
    图上限MB: 数(混.图上限MB, 默认配置.图上限MB, 1, 30),
    图片根目录: 字(混.图片根目录),
    称呼: 字(混.称呼) || 默认配置.称呼,
    群称呼: 字(混.群称呼) || 默认配置.群称呼,
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
  let 上次私聊时间 = Math.floor(Date.now() / 1000) // 从这一刻起只认新消息，不补旧的
  let 上次群时间 = Math.floor(Date.now() / 1000)

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

  async function 发一个(base, action, 体) {
    try {
      const r = await fetch(`${base}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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

    // ⭐ 方向只给一边：私聊那间屋的话只发私聊、群那间屋只发群；
    //    两边选了同一间屋（方向 = ''）才照老行为两边都发 —— 界面上会提示这一点。
    const 要私聊 = 方向 !== '群'
    const 要群 = 方向 !== '私聊'
    if (要私聊 && 配置.转私聊 && 配置.私聊QQ) {
      for (let i = 0; i < 段们.length; i++) {
        const 体 = 私人消息体(段们[i])
        体.user_id = Number(配置.私聊QQ)
        出.push(await 发一个(配置.NapCat, 'send_private_msg', 体))
        if (i < 段们.length - 1) await new Promise((r) => setTimeout(r, 发段延迟))
      }
      for (const x of 图数据) {
        出.push(await 发一个(配置.NapCat, 'send_private_msg', { user_id: Number(配置.私聊QQ), message: [一段图(x)] }))
        await new Promise((r) => setTimeout(r, 发段延迟))
      }
    }
    if (要群 && 配置.转群 && 配置.群号) {
      for (let i = 0; i < 段们.length; i++) {
        const 体 = 群消息体(段们[i])
        体.group_id = Number(配置.群号)
        出.push(await 发一个(配置.NapCat, 'send_group_msg', 体))
        if (i < 段们.length - 1) await new Promise((r) => setTimeout(r, 发段延迟))
      }
      for (const x of 图数据) {
        出.push(await 发一个(配置.NapCat, 'send_group_msg', { group_id: Number(配置.群号), message: [一段图(x)] }))
        await new Promise((r) => setTimeout(r, 发段延迟))
      }
    }
    return 出
  }

  /** 一轮真正落地：总开关 / 试运行 在这儿把关。 */
  async function 落地一发(配置, 文字, 图们, 方向 = '') {
    if (已发轮.size > 300) 已发轮.clear() // 防 Set 无限长
    // ⭐ 方向：'私聊' / '群' / ''（两边选了同一间屋 → 照老行为两边都发）
    const 这份会话 = 方向 === '群' ? 配置.群会话 : (方向 === '私聊' ? 配置.私聊会话 : 配置.目标会话)
    if (!这份会话) return 记账('还没选会话（私聊 / 群），不知道该盯哪个，这轮不转')
    配置 = { ...配置, 目标会话: 这份会话 }   // 下游（图片根目录、归档检查）都看这一个
    // ⭐ 盯的会话已经归档了：别转（人已经不在这儿说话了）
    try {
      const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
      const 归档 = new Set((((登记 && 登记.archivedSessionIds) || [])).map(String))
      if (归档.has(会话键(这份会话))) return 记账('「' + (方向 || '目标') + '会话」已经归档了，这轮不转（去设置里重新挑一个）')
    } catch (error) {}
    if (!配置.总开关) return 记账('总开关关着，这轮该转但没转')
    const 抠过 = 配置.发图 ? 抠正文图(文字) : { 净文字: 文字, 图: [] }
    const 几张 = (Array.isArray(图们) ? 图们.length : 0) + 抠过.图.length
    const 图标 = 几张 ? `（还有 ${几张} 张图）` : ''
    const 净文 = String(抠过.净文字 || '')
    if (配置.试运行) {
      return 记账(`试运行：本来要发到 QQ →「${净文.slice(0, 40)}${净文.length > 40 ? '…' : ''}」${图标}`)
    }
    const 结果 = await 发到QQ(配置, 文字, 图们, 方向)
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
    if (!配置.私聊会话 && !配置.群会话) return
    const 键 = 会话键(session && session.id)
    // ⭐ 2026-10-25：私聊和群各有一间屋 —— 哪间屋说的话，就回哪边（不再两边都发）
    const 是私聊 = Boolean(配置.私聊会话) && 键 === 会话键(配置.私聊会话)
    const 是群 = Boolean(配置.群会话) && 键 === 会话键(配置.群会话)
    if (!是私聊 && !是群) return
    const 方向 = 是群 && !是私聊 ? '群' : (是私聊 && !是群 ? '私聊' : '')   // '' = 两边选了同一间屋
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
        void 落地一发(配置, 上一轮.文本, 上一轮.图们, 方向)
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
      const r = await fetch(`${配置.NapCat}/get_login_info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const j = await r.json()
      if (j && j.status === 'ok') NapCat状态 = { 用户: j.data.user_id, 昵称: j.data.nickname }
    } catch (error) {
      NapCat状态 = { 错: String((error && error.message) || error) }
    }
    const 在清单里 = (id) => (id && 清单.length ? 清单.filter((x) => 会话键(x.id) === 会话键(id)) : [])
    return {
      ok: true, 版本, 配置, 配置文件, NapCat状态, 活着的会话: 清单, 日志,
      // ⭐ 2026-10-25：私聊 / 群两个方向各自的会话（老字段 目标情况 还留着 = 私聊那份）
      私聊情况: 在清单里(配置.私聊会话),
      群情况: 在清单里(配置.群会话),
      目标情况: 在清单里(配置.私聊会话),
      同一个会话: Boolean(配置.私聊会话 && 配置.群会话 && 会话键(配置.私聊会话) === 会话键(配置.群会话)),
    }
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
    记账(`设置已保存：私聊会话 ${洗好.私聊会话 || '（没填）'}｜群会话 ${洗好.群会话 || '（没填）'}｜私聊QQ ${洗好.私聊QQ || '（没填）'}｜群号 ${洗好.群号 || '（没填）'}｜${状态}`
      + (洗好.私聊会话 && 洗好.群会话 && 洗好.私聊会话 === 洗好.群会话 ? '（私聊和群选了同一个会话：回话会两边都发）' : ''))
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
  async function 转发文字(段, 拉任意) {
    const d = (段 && 段.data) || {}
    const id = String(d.id != null ? d.id : (d.message_id != null ? d.message_id : (d.content != null ? d.content : '')))
    if (!id) return '[合并转发的聊天记录（没有 id，读不出来）]'
    let 节点们 = []
    for (const 体 of [{ message_id: id }, { id }]) {
      const 结果 = await 拉任意('get_forward_msg', 体)
      const 候选 = (结果 && (结果.messages || 结果.message)) || null
      if (Array.isArray(候选) && 候选.length) { 节点们 = 候选; break }
    }
    if (!节点们.length) return '[合并转发的聊天记录（内容取不到）]'
    const 行 = []
    for (const 节 of 节点们.slice(0, 12)) {
      const 谁 = String((节 && 节.sender && (节.sender.card || 节.sender.nickname)) || (节 && 节.nickname) || '某人')
      const 段们 = Array.isArray(节 && 节.content) ? 节.content : (Array.isArray(节 && 节.message) ? 节.message : [])
      const 话 = 段们.map((x) => {
        if (!x) return ''
        const 型 = String(x.type || '')
        if (型 === 'text') return String((x.data && x.data.text) || '')
        if (型 === 'image' || 型 === 'mface') return '[图片]'
        if (型 === 'face') return '[表情]'
        if (型 === 'record') return '[语音]'
        if (型 === 'video') return '[视频]'
        if (型 === 'json' || 型 === 'xml') return '[卡片]'
        if (型 === 'forward') return '[又一层转发]'
        if (型 === 'at') return '@' + String((x.data && (x.data.name || x.data.qq)) || '')
        return ''
      }).join('').trim()
      if (话) 行.push('  ' + 掐短(谁, 20) + '：' + 掐短(话, 120))
    }
    return '[合并转发的聊天记录 · 共 ' + 节点们.length + ' 条]'
      + (行.length ? String.fromCharCode(10) + 行.join(String.fromCharCode(10)) : '')
  }

  async function 转入一条(文字, 图们, 消息id, 会话id, 方向 = '私聊') {
    const 配置 = 读配置()
    // ⭐ 2026-10-25：私聊 / 群各进各的会话 —— 不传就用私聊那间（老调用点行为不变）
    const 这间 = String(会话id || 配置.私聊会话 || 配置.目标会话 || '')
    if (!这间) return { ok: false, 说: '还没选会话（私聊 / 群）' }
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
    // ⭐ 2026-10-25：群聊有群聊的称呼 —— 群里不止一个人，拿私聊的名字去写会不对
    const 谁 = String((方向 === '群' ? 配置.群称呼 : 配置.称呼) || (方向 === '群' ? '群里的人' : '对方'))
    const 说明 = 收下.length
      ? String.fromCharCode(10) + '（' + 谁 + '发了 ' + 收下.length + ' 张图：'
        + 收下.map((x, i) => `第${i + 1}张 ${Math.round(x.字节 / 1024)}KB` + (x.存 ? `，要发回去就用 ${x.存}` : '')).join('；')
        + '）'
      : ''
    const 文案 = (原话 || (收下.length ? '（' + 谁 + '发来了图片，没有配字）' : '')) + 说明
    if (!文案) return { ok: false, 说: '这条既没文字也没图，不转' }

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

  /**
   * 轮询 NapCat 的 HTTP 历史接口，把「她新发的私聊 / 群消息」一条条转进 DSH。
   * ⚠ 纯 HTTP 轮询：不连 WebSocket、不依赖 BOT。
   * ⚠ 只认 `私聊QQ` 这个人发的（群也一样按这个号过滤），自己的回话不会自我繁殖。
   */
  async function 轮询收消息() {
    const 配置 = 读配置()
    // 总开关关 / 没选会话：只把「上次时间」推到此刻，别开的时候就补一大串旧的
    if (!配置.总开关 || (!配置.私聊会话 && !配置.群会话)) {
      上次私聊时间 = Math.floor(Date.now() / 1000)
      上次群时间 = Math.floor(Date.now() / 1000)
      return
    }
    const 她的号 = Number(配置.私聊QQ) || 0

    const 拉 = async (action, 体) => {
      try {
        const r = await fetch(`${配置.NapCat}/${action}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(体),
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
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(体 || {}),
        })
        const j = await r.json()
        return (j && j.status === 'ok' && j.data) || null
      } catch (error) {
        return null
      }
    }
    // ⚠️ 2026-10-25（用户报「读不了 B站 卡片 / 转发记录」）：以前这里只看 text / image / mface，
    //    卡片和合并转发既没文字也没图 ⇒ 整条被当成空消息丢掉。现在它们也会变成文字。
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
          try { 文们.push(await 转发文字(段, 拉任意)) }
          catch (error) { 文们.push('[合并转发的聊天记录（读失败了）]') }
          continue
        }
        if (型 === 'at') { 文们.push('@' + String((段.data && (段.data.name || 段.data.qq)) || '')); continue }
        if (型 === 'face') { 文们.push('[表情]'); continue }
        if (型 === 'record') { 文们.push('[语音]'); continue }
        if (型 === 'video') { 文们.push('[视频]'); continue }
      }
      return { 文字: 文们.join(String.fromCharCode(10)).trim(), 图们 }
    }

    if (配置.转私聊 && 配置.私聊QQ) {
      const 列表 = await 拉('get_friend_msg_history', { user_id: 她的号, count: 10 })
      for (const 条 of 列表.sort((a, b) => (a.time || 0) - (b.time || 0))) {
        if (!条 || Number(条.user_id) !== 她的号) continue
        if ((条.time || 0) < 上次私聊时间) continue           // 旧的，跳过
        if (已转消息.has(条.message_id)) continue             // 转过了
        上次私聊时间 = 条.time || 上次私聊时间
        const { 文字, 图们 } = await 条转片段(条)
        已转消息.add(条.message_id)
        // 纯表情（没图没字）就别转了，记掉别再反复拉
        if (!文字 && !图们.length) continue
        await 转入一条(文字, 图们, 条.message_id, 配置.私聊会话, '私聊')
      }
    }

    if (配置.转群 && 配置.群号) {
      const 列表 = await 拉('get_group_msg_history', { group_id: Number(配置.群号), count: 30 })
      for (const 条 of 列表.sort((a, b) => (a.time || 0) - (b.time || 0))) {
        if (!条 || Number(条.user_id) !== 她的号) continue     // 群里只认她
        if ((条.time || 0) < 上次群时间) continue
        if (已转消息.has(条.message_id)) continue
        上次群时间 = 条.time || 上次群时间
        const { 文字, 图们 } = await 条转片段(条)
        已转消息.add(条.message_id)
        if (!文字 && !图们.length) continue
        await 转入一条(文字, 图们, 条.message_id, 配置.群会话, '群')
      }
    }

    if (已转消息.size > 300) 已转消息.clear()
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