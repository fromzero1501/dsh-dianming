/**
 * 宿主半冒烟：用假 ctx 跑 lib/index.js，验证
 *  1) 插件能加载、工具注册上         2) /dianming-api 各分支能返回
 *  3) 语义兜底能走通（模型用假流）    4) 设置能落盘
 * 不真启动任何软件。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 用独立沙箱目录，别碰用户真实清单
const SANDBOX = join(tmpdir(), 'dianming-smoke-' + process.pid)
process.env.DSH_HOME = SANDBOX
mkdirSync(join(SANDBOX, '.dsh'), { recursive: true })

const routes = []
const tools = []
const registered = []

const ctx = {
  get(name) {
    if (name === 'llm') {
      return {
        stream(params) {
          const prompt = String((params && params.system) || '') + JSON.stringify((params && params.messages) || '')
          const body = prompt.includes('desc') && prompt.includes('keys')
            ? '[{"id":"1","desc":"冒烟测试：AI 写的用途说明","keys":["冒烟","测试"]}]'
            : '{"id":"1","reason":"假模型"}'
          return (async function* () {
            yield { type: 'text-delta', index: 0, text: body }
          })()
        },
      }
    }
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) }
    }
    if (name === 'web') {
      return {
        search: async ({ query }) => ({
          results: [{ title: query + ' 官网', snippet: '冒烟测试：这是网页摘要里写的用途' }],
        }),
        fetch: async () => '',
      }
    }
    return null
  },
  effect(fn) {
    fn()
    return () => {}
  },
  inject(_deps, fn) {
    fn()
  },
  tools: { register: (tool) => { registered.push(tool); return () => {} } },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
}

const core = await import('../lib/core.js')
await core.runScan()
const mod = await import('../lib/index.js')
mod.apply(ctx, {})

if (routes.length === 0) throw new Error('没有注册路由')
if (registered.length === 0) throw new Error('没有注册工具')
const route = routes[0]

function call(method, path, body, host = '127.0.0.1:1702') {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = '/dianming-api' + path
    req.headers = { host }
    const chunks = []
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name] = value },
      writeHead(status, headers) {
        this.statusCode = status
        Object.assign(this.headers, headers || {})
        return this
      },
      end(text) { resolve({ status: this.statusCode, body: JSON.parse(text || '{}') }) },
    }
    route.handler(req, res).catch(reject)
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
}

const out = []
const state = await call('GET', '/state')
out.push(`state: total=${state.body.total} roots=${(state.body.settings.roots || []).join(',')}`)

const search = await call('POST', '/search', { q: '剪视频', limit: 5 })
out.push('search 剪视频: ' + search.body.candidates.map((c) => `${c.name}(${c.score})`).join(' / '))
const unrelated = await call('POST', '/search', { q: '抖音', limit: 5 })
out.push('search 无关词(抖音): 命中=' + unrelated.body.candidates.length + '（应为 0，不能因为常用就把别的软件翻出来）')

const semantic = await call('POST', '/semantic', { q: '要把视频压小一点' })
out.push('semantic: ok=' + semantic.body.ok + ' app=' + (semantic.body.app ? semantic.body.app.name : '-') + ' reason=' + semantic.body.reason)

const patched = await call('POST', '/settings', { patch: { fab: { right: 30 }, semanticMode: 'manual' } })
out.push('settings: fab.right=' + patched.body.settings.fab.right + ' mode=' + patched.body.settings.semanticMode)
await call('POST', '/settings', {
  patch: { fab: { right: state.body.settings.fab.right }, semanticMode: state.body.settings.semanticMode },
})
out.push('设置已还原: fab.right=' + state.body.settings.fab.right + ' mode=' + state.body.settings.semanticMode)

// AI 补简介：假模型吐一条 JSON 数组，验证写入 desc/descSource
const enriched = await call('POST', '/enrich', { mode: 'ai', limit: 2 })
out.push('补简介任务已启动: ' + JSON.stringify({ running: enriched.body.running, total: enriched.body.total }))
let progress = enriched.body
for (let i = 0; i < 40 && progress.running; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 50))
  progress = (await call('GET', '/enrich-progress')).body
}
out.push('补简介进度: ' + JSON.stringify({ done: progress.done, total: progress.total, filled: progress.filled, running: progress.running }))
const enrichedApp = await call('GET', '/apps?q=' + encodeURIComponent('AI 写的用途'))
out.push('补简介后按描述搜到: ' + (enrichedApp.body.apps || []).map((a) => a.name + '/' + a.descSource).join(','))

const denied = await call('GET', '/state', undefined, 'evil.example.com')
out.push('非回环 Host: status=' + denied.status)

// /apps 分页 + 计数 + 描述来源（清单面板依赖）
const page = await call('GET', '/apps?offset=0&limit=5')
out.push(`apps 第 1 页: 本页 ${page.body.apps.length} / 总数 ${page.body.total} / counts=${JSON.stringify(page.body.counts)}`)
const page2 = await call('GET', '/apps?offset=5&limit=5')
out.push('apps 第 2 页首条: ' + (page2.body.apps[0] ? page2.body.apps[0].name : '-') + ' 与第 1 页不同=' + (page2.body.apps[0]?.id !== page.body.apps[0]?.id))
const filtered = await call('GET', '/apps?q=' + encodeURIComponent('解压') + '&limit=50')
out.push('apps?q=解压: ' + filtered.body.apps.slice(0, 4).map((a) => a.name).join(' / '))

// 手工条目：建 → 写描述 → 删，不碰真实扫描条目
const created = await call('POST', '/app', { name: '冒烟测试条目', path: 'C:\\Windows\\notepad.exe', desc: '' })
out.push('新建手工条目: ok=' + created.body.ok + ' id=' + (created.body.app ? '有' : '无'))
const wrote = await call('POST', '/app', { id: created.body.app.id, desc: '冒烟测试写的描述' })
out.push('写描述: desc=' + wrote.body.app.desc + ' descSource=' + wrote.body.app.descSource)
const found = await call('GET', '/apps?q=' + encodeURIComponent('冒烟测试写的描述'))
out.push('按描述搜到: ' + found.body.apps.map((a) => a.name).join(','))
// 启动目标：不存在必须拒绝；存在则落盘，可还原
const badTarget = await call('POST', '/open-target', { path: 'C:\\definitely-missing\\nope.exe' })
const badSave = await call('POST', '/app', { id: created.body.app.id, openPath: 'C:\\definitely-missing\\nope.bat' })
const goodSave = await call('POST', '/app', { id: created.body.app.id, openPath: 'C:\\Windows\\System32\\notepad.exe' })
const targetView = await call('GET', '/apps?q=' + encodeURIComponent('冒烟测试条目'))
const targetRow = (targetView.body.apps || []).find((a) => a.id === created.body.app.id) || {}
out.push('试开不存在的目标: ok=' + badTarget.body.ok + ' error=' + (badTarget.body.error || ''))
out.push('保存不存在的目标: ok=' + badSave.body.ok)
out.push('保存存在的启动目标: ok=' + goodSave.body.ok + ' openPath=' + (targetRow.openPath || '(空)'))
const resetTarget = await call('POST', '/app', { id: created.body.app.id, openPath: '' })
const afterReset = await call('GET', '/apps?q=' + encodeURIComponent('冒烟测试条目'))
const resetRow = (afterReset.body.apps || []).find((a) => a.id === created.body.app.id) || {}
out.push('还原启动目标: ok=' + resetTarget.body.ok + ' openPath=' + (resetRow.openPath || '(空)'))

// 收藏：切换 → 收藏面板只列收藏 → 取消
const favOn = await call('POST', '/app', { id: created.body.app.id, fav: true })
out.push('收藏: ok=' + favOn.body.ok + ' fav=' + favOn.body.app.fav + ' 有收藏时间=' + (Number(favOn.body.app.favAt) > 0))
const favList = await call('GET', '/apps?fav=1&limit=200')
const favRows = favList.body.apps || []
out.push('收藏面板: total=' + favList.body.total + ' counts.fav=' + favList.body.counts.fav
  + ' 含本条目=' + favRows.some((a) => a.id === created.body.app.id)
  + ' 全是收藏=' + favRows.every((a) => a.fav === true))
const favOff = await call('POST', '/app', { id: created.body.app.id, fav: false })
const favList2 = await call('GET', '/apps?fav=1&limit=200')
out.push('取消收藏: ok=' + favOff.body.ok + ' fav=' + favOff.body.app.fav
  + ' 面板已移除=' + !(favList2.body.apps || []).some((a) => a.id === created.body.app.id))

const removed = await call('POST', '/app-delete', { id: created.body.app.id })
out.push('删除手工条目: ok=' + removed.body.ok)

// 拖拽入库：新路径能加、重复要跳过、不支持的类型要拒
const dropOne = await call('POST', '/app-add-path', { paths: ['C:\\Windows\\System32\\notepad.exe'] })
out.push('拖入 exe: 新增=' + (dropOne.body.added || []).length + ' 名称=' + ((dropOne.body.added || [])[0] || {}).name)
const dropAgain = await call('POST', '/app-add-path', { paths: ['C:\\Windows\\System32\\notepad.exe'] })
out.push('拖入重复: 新增=' + (dropAgain.body.added || []).length
  + ' 跳过原因=' + ((dropAgain.body.skipped || [])[0] || {}).reason)
const dropBad = await call('POST', '/app-add-path', { paths: ['C:\\Windows\\win.ini', 'C:\\definitely-missing\\nope.exe'] })
out.push('拖入不支持/不存在: 跳过=' + JSON.stringify((dropBad.body.skipped || []).map((item) => item.reason)))

// 拖拽拿不到路径时会话侧不再落副本（脚本要靠原目录），改为走剪贴板取真实路径：
// 剪贴板里没有文件时必须给出明确原因，而不是静默失败。
const clipTry = await call('POST', '/clip-add', {})
out.push('剪贴板加入(空): ok=' + clipTry.body.ok + ' 原因=' + String(clipTry.body.error || '').slice(0, 20))

// 收藏项不被重扫清掉：mergeScanned 里 fav 视同"用户动过"（只改内存，不落盘，最后跑）
const store = core.loadStore()
const keep = store.apps.find((a) => a.source !== 'manual')
const plain = store.apps.find((a) => a !== keep && a.source !== 'manual' && !a.fav
  && !(Number(a.uses) > 0) && a.descSource !== 'user')
if (keep) {
  keep.fav = true
  keep.uses = 0
  keep.descSource = ''
  const scanned = core.mergeScanned(store, [], new Set())
  out.push('重扫保留收藏: 收藏条目还在=' + store.apps.includes(keep)
    + ' 未收藏的自动条目被清=' + (plain ? !store.apps.includes(plain) : 'n/a')
    + ' pruned=' + scanned.pruned)
}

out.push('工具: ' + registered.map((t) => t.name).join(', '))
out.push('路由: ' + routes.map((r) => r.kind + ' ' + r.path).join(', '))
console.log(out.join('\n'))
rmSync(SANDBOX, { recursive: true, force: true })
