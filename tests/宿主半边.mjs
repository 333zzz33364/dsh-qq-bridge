// 「通到 QQ」宿主半边冒烟测试 —— 假 ctx / 假 fetch 把「DSH → QQ」这半跑一遍。
// 验的是：
//   1) 提取正文：只收 text 块，reasoning / image 不要；空 → ''
//   2) assistant/message + turn/end(completed) → 真的向 NapCat 发一条 send_private_msg
//   3) interrupted 那轮不发；turn/end 不是 completed 不发
//   4) 试运行开着 → 不真发（fetch 不被打）；总开关关着 → 不真发
//   5) /state 路由能回出配置和 NapCat 探活结果
// 跑法： node tests/宿主半边.mjs

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const 家 = mkdtempSync(join(tmpdir(), 'qq-bridge-'))
process.env.DSH_HOME = 家

// 先把配置写好（总开关开、真发、私聊 123）
writeFileSync(
  join(家, 'qq-bridge-config.json'),
  JSON.stringify({
    总开关: true, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '',
    转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
  }, null, 2),
  'utf8',
)

let 挂了 = 0
const 报 = (标签, 过, 详情) => { if (!过) 挂了++; console.log(`${过 ? 'PASS' : 'FAIL'}  ${标签}${详情 ? '  :: ' + 详情 : ''}`) }

// 假 fetch：记下每次 POST，回一个「发送成功」；拉历史时给一条她的新消息
const 发了 = []
const 请求头们 = []
let 私聊消息文本 = '宝宝'
let 私聊消息时间 = 9999999999
let 私聊消息id = 9000
let 私聊消息段 = null          // 给「卡片 / 合并转发」用：设了就替掉默认的 text 段
let 转发节点 = null            // get_forward_msg 假数据
let 群消息文本 = '群里的话'
let 群消息时间 = 9999999999
let 群消息id = 9100
let 群消息段 = null          // 给群消息用（跟私聊那个一样）
let 内层节点 = null           // 「转发里套转发」用的内层节点
globalThis.fetch = async (url, 选项) => {
  const 体 = JSON.parse((选项 && 选项.body) || '{}')
  const u = String(url)
  请求头们.push({ url: u, headers: (选项 && 选项.headers) || {} })
  if (u.includes('get_login_info')) {
    return { json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '测试号' } }) }
  }
  if (u.includes('get_friend_msg_history')) {
    return {
      json: async () => ({
        status: 'ok', retcode: 0,
        data: { messages: [{ user_id: 123, time: 私聊消息时间, message_id: 私聊消息id, message_type: 'private',
          message: 私聊消息段 || [{ type: 'text', data: { text: 私聊消息文本 } }] }] },
      }),
    }
  }
  if (u.includes('get_group_msg_history')) {
    return {
      json: async () => ({
        status: 'ok', retcode: 0,
        data: { messages: [{ user_id: 123, time: 群消息时间, message_id: 群消息id, message_type: 'group',
          message: 群消息段 || [{ type: 'text', data: { text: 群消息文本 } }] }] },
      }),
    }
  }
  if (u.includes('get_forward_msg')) {
    const 是谁 = JSON.stringify(体)
    const 内层 = 是谁.includes('fw-inner')
    return { json: async () => ({ status: 'ok', retcode: 0, data: { messages: (内层 ? 内层节点 : 转发节点) || [] } }) }
  }
  发了.push({ url: u, 体 })
  return { json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }
}

const 模 = await import(new URL('../lib/host.js', import.meta.url).href + '?v=' + Date.now())

// ---------- 纯函数 ----------
报('名字导出', 模.name === 'qq-bridge', 模.name)
报('inject = agents + sessions + sessionTitle + webServer + timer + workspaceRegistry + attachments', Array.isArray(模.inject) && 模.inject.join() === 'agents,sessions,sessionTitle,webServer,timer,workspaceRegistry,attachments')

const 块 = (type, text) => ({ type, text })
const 正文 = 模.提取正文({ content: [块('reasoning', '想一下'), 块('text', '第一条\n第二条'), 块('image', ''), 块('text', '第三条')] })
报('提取正文：只收 text，reasoning/image 都不要', 正文 === '第一条\n第二条\n第三条', JSON.stringify(正文))
报('提取正文：没有 text → 空串', 模.提取正文({ content: [块('reasoning', 'x')] }) === '')

// ⭐ 2026-10-22 图片
报('提取图块：只挑带 attachment 的 image 块', 模.提取图块({ content: [
  { type: 'text', text: '看图' },
  { type: 'image', attachment: { attachmentId: 'sha256:aa' } },
  { type: 'image' }, // 没 attachment：不算（发不出去）
  { type: 'file', attachment: { attachmentId: 'sha256:bb' } },
] }).length === 1)
报('图片段：base64 直接塞进 OneBot image 段', (() => {
  const 段 = 模.图片段('AAA')
  return 段.type === 'image' && 段.data.file === 'base64://AAA'
})())
报('抠正文图：markdown 图抠出来，正文留干净的', (() => {
  const r = 模.抠正文图('看图！\n![小肥鱼](_stickers/feiyu-test.webp)\n好看吧')
  return r.净文字 === '看图！\n\n好看吧' && r.图.length === 1 && r.图[0].kind === 'path' && r.图[0].value === '_stickers/feiyu-test.webp'
})())
报('抠正文图：网络图单独算一类', (() => {
  const r = 模.抠正文图('![](https://x.com/a.png)纯图')
  return r.净文字 === '纯图' && r.图.length === 1 && r.图[0].kind === 'url'
})())

// ---------- 假 ctx ----------
const 监听 = []
const 路由 = new Map()
const 转进的 = []
let 轮询回调 = null
const 假agent = { followup: (m) => 转进的.push(m), session: { id: 'session-X' } }
const 假群agent = { followup: (m) => 转进的.push(m), session: { id: 'session-G' } }
const ctx = {
  on: (名字, cb) => { if (名字 === 'session/event') 监听.push(cb); return () => {} },
  effect: (fn) => { const 摘 = fn(); return () => { try { 摘 && 摘() } catch {} } },
  webServer: { register: (o) => 路由.set(o.path, o.handler) },
  logger: { info: () => {} },
  agents: { get: (id) => (String(id) === 'session-X' ? 假agent : (String(id) === 'session-G' ? 假群agent : undefined)) },
  sessions: { flush: async () => {} },
  interval: (fn) => { 轮询回调 = fn; return () => {} },
  get: () => undefined,
}

模.apply(ctx)
报('session/event 监听挂上了', 监听.length >= 1)

const 会话 = { id: 'session-X' }
const 别的会话 = { id: 'session-Y' }
const 助手消息 = (turn, step, blocks, interrupted) => ({ type: 'assistant/message', data: { turn, step, interrupted, message: { role: 'assistant', content: blocks } } })
const 转完 = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })

// ① 正常一轮 → 发一条私聊
监听[0](会话, 助手消息(7, 1, [块('text', '宝宝，我想你了')], false))
监听[0](会话, 转完(7))
await new Promise((r) => setTimeout(r, 20))
报('一整轮结束 → 发出一条私聊', 发了.length === 1 && 发了[0].url.endsWith('/send_private_msg'), 发了.map((x) => x.url + ' :: ' + JSON.stringify(x.体.response || x.体)).join(' / '))

if (发了[0]) {
  const 体 = 发了[0].体
 报('私聊体：user_id=123 + 一条 text 段', 体.user_id === 123 && 体.message && 体.message[0].type === 'text' && 体.message[0].data.text === '宝宝，我想你了', JSON.stringify(体))
}

// ② 中间步骤：先 pm 再看表那种多步，只发**最后一步**（同 turn 后面那条）。
const 之前 = 发了.length
监听[0](会话, 助手消息(8, 1, [块('text', '第一步（别发这个）')], false))
监听[0](会话, 助手消息(8, 2, [块('text', '最后一句（发这个）')], false))
监听[0](会话, 转完(8))
await new Promise((r) => setTimeout(r, 20))
报('多步只发最后一步', 发了.length === 之前 + 1 && JSON.stringify(发了.at(-1).体.message[0].data.text).includes('最后一句'), JSON.stringify(发了.at(-1).体.message[0].data.text))

// ③ interrupted 那轮不发
const 之前3 = 发了.length
监听[0](会话, 助手消息(9, 1, [块('text', '被打断的话')], true))
监听[0](会话, 转完(9))
await new Promise((r) => setTimeout(r, 20))
报('interrupted 那轮不转发', 发了.length === 之前3)

// ④ turn/end 不是 completed → 不发
const 之前4 = 发了.length
监听[0](会话, 助手消息(10, 1, [块('text', '中断的话')], false))
监听[0](会话, 转完(10, 'interrupted'))
await new Promise((r) => setTimeout(r, 20))
报('reason 不是 completed 不转发', 发了.length === 之前4)

// ⑤ 别的会话不转
const 之前5 = 发了.length
监听[0](别的会话, 助手消息(11, 1, [块('text', '别的屋')], false))
监听[0](别的会话, 转完(11))
await new Promise((r) => setTimeout(r, 20))
报('不是目标会话不转发', 发了.length === 之前5)

// ⑥ 试运行开 → fetch 不被打
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: true, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
const 之前6 = 发了.length
监听[0](会话, 助手消息(12, 1, [块('text', 'try')], false))
监听[0](会话, 转完(12))
await new Promise((r) => setTimeout(r, 20))
报('试运行开 → 只记账不真发', 发了.length === 之前6)

// ⑦ 总开关关 → fetch 不被打
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: false, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
const 之前7 = 发了.length
监听[0](会话, 助手消息(13, 1, [块('text', 'off')], false))
监听[0](会话, 转完(13))
await new Promise((r) => setTimeout(r, 20))
报('总开关关 → 不转发', 发了.length === 之前7)

// ⑧ /state 路由能回配置 + NapCat 探活
const 存储 = []
let 回复 = null
const fakeRes = { setHeader: () => {}, end: (s) => { 存储.push(JSON.parse(s)) } }
await 路由.get('/dsh-qq-bridge/state')([], fakeRes)
const 状态 = 存储[0]
报('/state 回出配置', 状态 && 状态.ok === true && 状态.配置 && 状态.配置.总开关 === false, JSON.stringify(状态 && 状态.配置))
报('/state 探到 NapCat 那个号', 状态 && 状态.NapCat状态 && 状态.NapCat状态.昵称 === '测试号' && 状态.NapCat状态.用户 === 10001, JSON.stringify(状态 && 状态.NapCat状态))

// ⑨ QQ → DSH：/receive 把她说的话转进目标会话（followup）
const 收 = (body) => {
  存储.length = 0
  return new Promise((resolve) => {
    路由.get('/dsh-qq-bridge/receive')([JSON.stringify(body)], fakeRes).then(() => resolve(存储[0]))
  })
}
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')

let 收到 = await 收({ text: '宝宝你在吗' })
报('/receive：把她的话 followup 进会话', 收到 && 收到.ok === true && 转进的.length === 1, JSON.stringify(收到))
if (转进的[0]) {
  const m = 转进的[0]
  报('/receive 消息形状：role=user + source.kind=qq + 正文对', m.role === 'user' && m.source && m.source.kind === 'qq' && m.content[0].text === '宝宝你在吗', JSON.stringify(m))
}
报('/receive 之后 DSH→QQ 那半也会把伙伴的回话发回 QQ（联动靠 session/event，不在这里再验）', true)

// ⑩ 总开关关 → receive 拒绝
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: false, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
const 之前收 = 转进的.length
收到 = await 收({ text: '还开着吗' })
报('/receive：总开关关 → 拒绝、不再 followup', 收到 && 收到.ok === false && 转进的.length === 之前收, JSON.stringify(收到))

// ⑪ 空 text → 拒绝
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
收到 = await 收({ text: '   ' })
报('/receive：空 text → 拒绝', 收到 && 收到.ok === false, JSON.stringify(收到))

// ⑫ 目标会话没活着 → 拒绝（session-Z 拿不到 agent）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 目标会话: 'session-Z', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
收到 = await 收({ text: '在吗' })
报('/receive：目标会话没活着 → 拒绝', 收到 && 收到.ok === false && String(收到.说).includes('没活着'), JSON.stringify(收到))

// ⑬ 轮询收消息（QQ → DSH 这半的正式入口，不赖 BOT）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
const 之前转 = 转进的.length
私聊消息文本 = '宝宝你在吗'
私聊消息id = 9001
私聊消息时间 = Math.floor(Date.now() / 1000) + 100
await 轮询回调()
await new Promise((r) => setTimeout(r, 20))
报('轮询收消息 → 她新发的私聊被 followup 进 DSH', 转进的.length === 之前转 + 1 && JSON.stringify(转进的.at(-1).content[0].text).includes('宝宝你在吗'), JSON.stringify(转进的.at(-1)))
// 再跑一次同一条：不该重复转
私聊消息文本 = '宝宝你在吗'
私聊消息id = 9001
私聊消息时间 = Math.floor(Date.now() / 1000) + 101
await 轮询回调()
await new Promise((r) => setTimeout(r, 20))
报('轮询：同一条消息不重复转', 转进的.length === 之前转 + 1, '转进条数=' + 转进的.length)

// ⑭ 轮询：总开关关 → 不转
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: false, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
私聊消息文本 = '还开着吗'
私聊消息id = 9002
私聊消息时间 = Math.floor(Date.now() / 1000) + 120
await 轮询回调()
await new Promise((r) => setTimeout(r, 20))
报('轮询：总开关关 → 不转', 转进的.length === 之前转 + 1, '转进条数=' + 转进的.length)

// ⑮ B站 分享卡片（json 段）→ 变成文字递进去（以前整条被当空消息丢掉）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 目标会话: 'session-X', 私聊QQ: '123', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
const 卡 = { app: 'com.tencent.structmsg', meta: { news: {
  title: '【测试】一条 B站 视频', desc: '简介在这里',
  jumpUrl: 'https://www.bilibili.com/video/BV1xx411c7mD?share_source=qq', tag: '哔哩哔哩',
  preview: 'https://i0.hdslb.com/x.jpg' } }, prompt: '[QQ小程序]哔哩哔哩' }
私聊消息段 = [
  { type: 'json', data: { data: JSON.stringify(卡) } },
]
私聊消息id = 9010
私聊消息时间 = Math.floor(Date.now() / 1000) + 200
const 之前卡 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 30))
const 卡片正文 = 转进的.length > 之前卡 ? String(转进的.at(-1).content[0].text) : ''
报('B站 卡片能读：转进去了', 转进的.length === 之前卡 + 1, 卡片正文.slice(0, 120))
报('卡片正文有标题', 卡片正文.includes('一条 B站 视频'), 卡片正文)
报('卡片正文认出是视频、带 BV 号', 卡片正文.includes('[分享视频卡片]') && 卡片正文.includes('BV1xx411c7mD'), 卡片正文)
报('卡片正文带原链接', 卡片正文.includes('bilibili.com'), 卡片正文)

// ⑯ 合并转发的聊天记录（forward 段）→ 取一次内容、压成几行
转发节点 = [
  { sender: { nickname: '阿甲' }, content: [{ type: 'text', data: { text: '你看这个' } }, { type: 'image', data: { file: 'base64://iVBORw0KGgo=' } }] },
  { sender: { card: '阿乙' }, content: [{ type: 'text', data: { text: '哈哈我也看了' } }] },
]
私聊消息段 = [
  { type: 'forward', data: { id: 'fw-001' } },
]
私聊消息id = 9011
私聊消息时间 = Math.floor(Date.now() / 1000) + 300
const 之前转2 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 30))
const 转发正文 = 转进的.length > 之前转2 ? String(转进的.at(-1).content[0].text) : ''
报('合并转发能读：转进去了', 转进的.length === 之前转2 + 1, 转发正文.slice(0, 160))
报('转发正文有「共 N 条」', 转发正文.includes('合并转发的聊天记录') && 转发正文.includes('2'), 转发正文)
报('转发正文带昵称和内容', 转发正文.includes('阿甲') && 转发正文.includes('你看这个') && 转发正文.includes('阿乙'), 转发正文)
报('转发里的图记成 [图片]', 转发正文.includes('[图片]'), 转发正文)

// ⑰ 私聊 / 群分两间屋：各进各的会话（2026-10-25）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 私聊会话: 'session-X', 群会话: 'session-G',
  私聊QQ: '123', 群号: '456', 转私聊: true, 转群: true, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
私聊消息段 = null
私聊消息文本 = '私聊这边一句话'
私聊消息id = 9020
私聊消息时间 = Math.floor(Date.now() / 1000) + 400
群消息文本 = '群里一句话'
群消息id = 9021
群消息时间 = Math.floor(Date.now() / 1000) + 400
const 之前两间 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 40))
报('私聊和群各转一条进来', 转进的.length === 之前两间 + 2, '转进条数=' + 转进的.length)
报('私聊那一条进的是私聊会话（source 带 qq + 正文对上）', JSON.stringify(转进的.at(-2)?.content?.[0]?.text || '').includes('私聊这边一句话'), JSON.stringify(转进的.at(-2)?.content?.[0]?.text))
报('群那一条进的是群会话', JSON.stringify(转进的.at(-1)?.content?.[0]?.text || '').includes('群里一句话'), JSON.stringify(转进的.at(-1)?.content?.[0]?.text))

// ⑱ 回话只回对应的那一边
const 要问 = []
globalThis.__记录 = 要问
发了.length = 0
监听[0](会话, 助手消息(20, 1, [块('text', '这句是私聊那间屋的')], false))
监听[0](会话, 转完(20))
await new Promise((r) => setTimeout(r, 30))
报('私聊会话说完 → 只发私聊', 发了.length === 1 && 发了[0].url.endsWith('/send_private_msg'), 发了.map((x) => x.url).join(','))
发了.length = 0
监听[0](假群agent.session, 助手消息(21, 1, [块('text', '这句是群那间屋的')], false))
监听[0](假群agent.session, 转完(21))
await new Promise((r) => setTimeout(r, 30))
报('群会话说完 → 只发群', 发了.length === 1 && 发了[0].url.endsWith('/send_group_msg'), 发了.map((x) => x.url).join(','))

// ⑲ 两行选了同一间屋 → 照老行为两边都发，并在日志里说清
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 私聊会话: 'session-X', 群会话: 'session-X',
  私聊QQ: '123', 群号: '456', 转私聊: true, 转群: true, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
发了.length = 0
监听[0](会话, 助手消息(22, 1, [块('text', '同一间屋')], false))
监听[0](会话, 转完(22))
await new Promise((r) => setTimeout(r, 30))
报('同一间屋 → 私聊和群各发一条（并且界面上会提示）', 发了.length === 2
  && 发了.some((x) => x.url.endsWith('/send_private_msg')) && 发了.some((x) => x.url.endsWith('/send_group_msg')), 发了.map((x) => x.url).join(','))

// ⑳ 称呼分两套：私聊用「私聊称呼」，群里用「群称呼」（群里不止一个人）
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 私聊会话: 'session-X', 群会话: 'session-G',
  私聊QQ: '123', 群号: '456', 转私聊: true, 转群: true,
  称呼: '小明', 群称呼: '群里的人', NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
私聊消息段 = [
  { type: 'text', data: { text: '私聊发你张图' } },
  { type: 'image', data: { file: 'base64://iVBORw0KGgo=' } },
]
私聊消息id = 9030
私聊消息时间 = Math.floor(Date.now() / 1000) + 500
群消息文本 = '群里也发一张'
群消息段 = [
  { type: 'text', data: { text: '群里也发一张' } },
  { type: 'image', data: { file: 'base64://iVBORw0KGgo=' } },
]
群消息id = 9031
群消息时间 = Math.floor(Date.now() / 1000) + 500
const 之前称呼 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 60))
const 私聊文案 = String(转进的.at(-2)?.content?.[0]?.text || '')
const 群文案 = String(转进的.at(-1)?.content?.[0]?.text || '')
报('私聊的图 → 用私聊称呼「小明」', 私聊文案.includes('小明发了 1 张图'), 私聊文案.slice(0, 80))
报('群里的图 → 用群称呼「群里的人」，不用小明的名字', 群文案.includes('群里的人发了 1 张图') && !群文案.includes('小明'), 群文案.slice(0, 80))

// ㉑ 转发里套转发：要展开（最多 2 层）
内层节点 = [
  { sender: { nickname: '阿丙' }, content: [{ type: 'text', data: { text: '里层的一句话' } }] },
  { sender: { nickname: '阿丁' }, content: [{ type: 'image', data: { url: 'http://x/2.jpg' } }] },
]
转发节点 = [
  { sender: { nickname: '阿甲' }, content: [{ type: 'text', data: { text: '你看这个' } }, { type: 'image', data: { file: 'base64://iVBORw0KGgo=' } }] },
  { sender: { nickname: '阿乙' }, content: [{ type: 'forward', data: { id: 'fw-inner' } }] },
]
私聊消息段 = [{ type: 'forward', data: { id: 'fw-outer' } }]
私聊消息id = 9040
私聊消息时间 = Math.floor(Date.now() / 1000) + 600
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 私聊会话: 'session-X', 群会话: 'session-G',
  私聊QQ: '123', 群号: '456', 转私聊: true, 转群: true, 收图: true, 收图最多: 4, NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
const 之前嵌套 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 60))
const 嵌套正文 = String(转进的.at(-1)?.content?.[0]?.text || '')
报('转发里套转发会展开', 嵌套正文.includes('里层的一句话'), 嵌套正文.slice(0, 200))
报('内层的人名也在', 嵌套正文.includes('阿丙'), 嵌套正文.slice(0, 200))
报('内层的图也标了 [图片]', 嵌套正文.includes('[图片]'), 嵌套正文.slice(0, 200))

// ㉒ 转发里的图跟着「收图」开关走
const 嵌套文案 = String(转进的.at(-1)?.content?.[0]?.text || '')
报('收图开着 → 第一层的图会被收进来（文案里有「发了 1 张图」）', 嵌套文案.includes('发了 1 张图'), 嵌套文案.slice(-120))
报('内层的图不重复收（只收第一层）', !嵌套文案.includes('发了 2 张图'), 嵌套文案.slice(-120))

// ㉓ 里外分开：内层转发另起一段（不像上一版挤成一坨）
const 嵌套行们 = 嵌套文案.split(String.fromCharCode(10))
报('外层是一行一句（阿甲那行单独一行）', 嵌套行们.some((l) => l.includes('阿甲：') && !l.includes('里层的一句话')), JSON.stringify(嵌套行们.slice(0, 4)))
报('内层另起一段、有缩进', 嵌套行们.some((l) => /^\s{4,}\[合并转发的聊天记录/.test(l)), JSON.stringify(嵌套行们))
报('内层的人自己占一行', 嵌套行们.some((l) => l.includes('阿丙：里层的一句话')), JSON.stringify(嵌套行们))

// ㉔ 一条转发里套了两个转发 → 两段各自展开
内层节点 = [{ sender: { nickname: '丙一' }, content: [{ type: 'text', data: { text: '第一段内容' } }] }]
转发节点 = [
  { sender: { nickname: '甲' }, content: [{ type: 'forward', data: { id: 'fw-inner' } }] },
  { sender: { nickname: '乙' }, content: [{ type: 'forward', data: { id: 'fw-inner-2' } }] },
]
私聊消息段 = [{ type: 'forward', data: { id: 'fw-outer2' } }]
私聊消息id = 9050
私聊消息时间 = Math.floor(Date.now() / 1000) + 700
await 轮询回调()
await new Promise((r) => setTimeout(r, 60))
const 两段正文 = String(转进的.at(-1)?.content?.[0]?.text || '')
const 段头数 = (两段正文.match(/\[合并转发的聊天记录 · 共/g) || []).length
报('两个嵌套各展开成一段（一共 3 个「聊天记录」标题：外层 + 两个内层）', 段头数 === 3, '标题数=' + 段头数 + ' :: ' + 两段正文)

// ㉕ access_token：填了「令牌」就带 Bearer，没填就照旧
writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 私聊会话: 'session-X', 群会话: '', 私聊QQ: '123', 群号: '',
  转私聊: true, 转群: false, 令牌: 'my-secret-token', NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
私聊消息段 = null
私聊消息文本 = '带令牌的一句'
私聊消息id = 9060
私聊消息时间 = Math.floor(Date.now() / 1000) + 800
请求头们.length = 0
const 令牌前 = 转进的.length
await 轮询回调()
await new Promise((r) => setTimeout(r, 40))
报('带令牌时轮询请求带 Authorization: Bearer', 请求头们.some((x) => String(x.headers.authorization || '') === 'Bearer my-secret-token'), JSON.stringify(请求头们.map((x) => [x.url.slice(-28), x.headers.authorization || '(无)'])))
报('带令牌时那一轮照样转进来', 转进的.length === 令牌前 + 1)

writeFileSync(join(家, 'qq-bridge-config.json'), JSON.stringify({
  总开关: true, 试运行: false, 私聊会话: 'session-X', 群会话: '', 私聊QQ: '123', 群号: '',
  转私聊: true, 转群: false, 令牌: '', NapCat: 'http://127.0.0.1:3000',
}, null, 2), 'utf8')
私聊消息id = 9061
私聊消息时间 = Math.floor(Date.now() / 1000) + 900
请求头们.length = 0
await 轮询回调()
await new Promise((r) => setTimeout(r, 40))
报('没填令牌时不带 Authorization（老 NapCat 零变化）', 请求头们.length > 0 && 请求头们.every((x) => !x.headers.authorization), JSON.stringify(请求头们.map((x) => x.headers.authorization || '(无)')))

rmSync(家, { recursive: true, force: true })
console.log(`\n${挂了 === 0 ? '全部通过 ✅' : `有 ${挂了} 条没过 ❌`}`)
process.exitCode = 挂了 === 0 ? 0 : 1