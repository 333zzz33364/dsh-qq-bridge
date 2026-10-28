// 「通到 QQ」网页半边冒烟测试 —— 用假的 React / 假的 slots 把设置页渲染成一棵对象树。
// 验：模块 id、inject、挂到 settings.section（id=qq-bridge）、关键元素都渲染出来、不抛错。
// 跑法： node tests/网页半边.mjs

let 捕获 = null
globalThis.window = { __ModuleLoader__: { load: (o) => { 捕获 = o } } }

globalThis.fetch = async (url) => {
  return {
    json: async () => ({
      ok: true, 版本: '0.1.0',
      配置: {
    总开关: false, 试运行: true, NapCat: 'http://127.0.0.1:3000', 令牌: '',
    绑定: [{ 类型: '私聊', 号码: '123', 会话: 'session-X', 称呼: '小明' }],
    收图: true, 发图: true, 收图最多: 4, 图上限MB: 5, 图片根目录: '',
  },
      NapCat状态: { 用户: 10001, 昵称: '测试号' },
      活着的会话: [{ id: 'session-X', 标题: '测试会话' }],
      目标情况: [],
      日志: [{ 时间: '01-01 00:00:00', 文本: '已装好' }],
    }),
  }
}

let 状态槽 = []
let 下标 = 0
const 造React = () => ({
  createElement: (t, p, ...kids) => ({ t, p: p || {}, kids: kids.flat(9).filter((k) => k !== null && k !== undefined && k !== false) }),
  useState: (init) => {
    const i = 下标++
    if (!(i in 状态槽)) 状态槽[i] = init
    return [状态槽[i], (v) => { 状态槽[i] = typeof v === 'function' ? v(状态槽[i]) : v }]
  },
  useEffect: () => {},
  useCallback: (f) => f,
})
const 假require = (n) => {
  if (n === 'react') return 造React()
  throw new Error('不该 require 这个：' + n)
}

await import(new URL('../lib/client.js', import.meta.url).href)

const exports = 捕获.factory(假require)
let 挂了 = 0
const 报 = (标签, 过, 详情) => { if (!过) 挂了++; console.log(`${过 ? 'PASS' : 'FAIL'}  ${标签}${详情 ? '  :: ' + 详情 : ''}`) }

报('模块 id = dsh-qq-bridge', 捕获.id === 'dsh-qq-bridge', 捕获.id)
报('inject 只依赖 slots', Array.isArray(exports.inject) && exports.inject.join() === 'slots')

let 注册 = null
let 组件 = null
const slots = {
  inject: (n, cb) => { if (n !== 'settings.section') throw new Error('槽位名不对：' + n); cb() },
  register: (d, c) => { 注册 = d; 组件 = c; return () => {} },
}
exports.apply({ get: (n) => (n === 'slots' ? slots : undefined) })
报('挂到 settings.section，id = qq-bridge', 注册 !== null && 注册.id === 'qq-bridge' && 注册.name === 'settings.section', JSON.stringify(注册))

// 预先填好「已经读到状态」的第一格（体），这样不用等 useEffect 拉数据，组件一次渲染就出整页
const 初始态 = {
  ok: true, 版本: '0.1.0',
  配置: { 总开关: false, 试运行: true, 目标会话: '', 私聊会话: '', 群会话: '', 私聊QQ: '', 群号: '', 转私聊: true, 转群: false, NapCat: 'http://127.0.0.1:3000',
    绑定: [{ 类型: '群', 号码: '123456', 会话: 'session-X', 称呼: '群里的人' }] },
  NapCat状态: { 用户: 10001, 昵称: '测试号' },
  活着的会话: [{ id: 'session-X', 标题: '测试会话' }],
  目标情况: [],
  日志: [{ 时间: '01-01 00:00:00', 文本: '已装好' }],
}
下标 = 0
状态槽 = [初始态]
const 树 = 组件()
const 文 = JSON.stringify(树)
const 要有 = ['通到 QQ', '总开关', '试运行', '绑定', '总览', '发消息', '提示与门槛', '测试一句', '保存设置', '连着的 QQ：测试号（10001）']
const 缺 = 要有.filter((x) => !文.includes(x))
报('关键元素都渲染出来（含连接状态 + 目标会话标题）', 缺.length === 0, 缺.length ? '缺：' + 缺.join('、') : 文.length + ' 字节')

// ⭐ 1.1.0：点进「绑定」页 —— 人设卡、那一列「单独」都得出来
const 找按钮 = (节点, 文字) => {
  if (!节点 || typeof 节点 !== 'object') return null
  if (Array.isArray(节点)) {
    for (const x of 节点) {
      const r = 找按钮(x, 文字)
      if (r) return r
    }
    return null
  }
  if (Array.isArray(节点.kids) && 节点.kids.includes(文字) && 节点.p && typeof 节点.p.onClick === 'function') return 节点
  return 找按钮(节点.kids, 文字)
}
const 绑定钮 = 找按钮(树, '绑定')
报('能找到「绑定」页签', Boolean(绑定钮))
if (绑定钮) {
  绑定钮.p.onClick()
  下标 = 0
  const 树2 = 组件()
  const 文2 = JSON.stringify(树2)
  const 要有2 = ['人设（选填）', '给聊天带上人设', '单独', '群里怎么回（对所有群生效）', '两条之间至少隔（秒）']
  const 缺2 = 要有2.filter((x) => !文2.includes(x))
  报('绑定行有「启用 / 只听 @」两个开关',
    文2.includes('启用（关掉 = 这个聊天不收了，也不发）') && 文2.includes('只听 @ 我的'), '')
  报('绑定页里人设卡 + 那一列都在', 缺2.length === 0, 缺2.length ? '缺：' + 缺2.join('、') : 文2.length + ' 字节')
}

console.log(`\n${挂了 === 0 ? '全部通过 ✅' : `有 ${挂了} 条没过 ❌`}`)
process.exitCode = 挂了 === 0 ? 0 : 1