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
    if (name === 'web') return { search: async () => [], fetch: async () => '' }
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
out.push('AI 补简介: ' + JSON.stringify(enriched.body))
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
const removed = await call('POST', '/app-delete', { id: created.body.app.id })
out.push('删除手工条目: ok=' + removed.body.ok)

out.push('工具: ' + registered.map((t) => t.name).join(', '))
out.push('路由: ' + routes.map((r) => r.kind + ' ' + r.path).join(', '))
console.log(out.join('\n'))
rmSync(SANDBOX, { recursive: true, force: true })
