/**
 * Host half of dsh-dianming（点名）.
 *
 * 干三件事：
 * 1. 扫目录/开始菜单，攒出一张"本机软件清单"（存 %DSH_HOME%\.dsh\dianming.json）；
 * 2. 提供 /dianming-api 给右下角那张卡片用（搜、扫、开、改设置）；
 * 3. 给模型三个工具（open_app / app_catalog / app_scan），在对话里也能点名。
 *
 * 匹配顺序：本地字符串（名字/别名/关键词/描述）→ 模糊（包含、历史选择）→ 大模型
 * （只把"名字 + 描述"喂过去，且只允许从清单里挑，不许编新软件）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_SETTINGS,
  LOG,
  STORE_FILE,
  launchApp,
  loadStore,
  norm,
  publicApp,
  rememberQuery,
  runScan,
  saveStore,
  searchApps,
} from './core.js'

export const name = 'dianming'
export const inject = ['tools', 'webServer']

const ROUTE = '/dianming-api'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function denyNonLoopback(req, res) {
  const host = String(req.headers.host || '')
  const hostname = host.replace(/:\d+$/, '')
  if (LOOPBACK.has(hostname)) return false
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, error: '只接受本机访问' }))
  return true
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('请求体太大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res, body, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function appById(id) {
  const store = loadStore()
  return store.apps.find((app) => app.id === id) || null
}

/* ------------------------------------------------------------------ *
 * 语义兜底：让模型只从清单里挑一个
 * ------------------------------------------------------------------ */

function candidatePool(query, limit = 60) {
  const store = loadStore()
  const tokens = String(query || '')
    .split(/[\s,，、;；/]+/)
    .map((token) => norm(token))
    .filter((token) => token.length >= 2)
  const rows = store.apps
    .filter((app) => app.enabled !== false)
    .map((app) => {
      const hay = (app.name + ' ' + (app.desc || '') + ' ' + (app.aliases || []).join(' ')).toLowerCase()
      let score = 0
      for (const token of tokens) if (hay.includes(token)) score += 2
      if (app.uses) score += Math.min(1.5, app.uses * 0.15)
      return { app, score }
    })
    .sort((a, b) => b.score - a.score)
  return rows.slice(0, limit).map((row) => row.app)
}

function parseModelJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(raw)
  } catch {
    /* 往下找 */
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1))
    } catch {
      /* 放弃 */
    }
  }
  const idMatch = /"id"\s*:\s*"([^"]+)"/.exec(raw)
  if (idMatch) return { id: idMatch[1], reason: '' }
  return null
}

async function askDshModel(ctx, system, user) {
  const llm = ctx.get ? ctx.get('llm') : null
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有可用的模型服务')
  const selector = ctx.get ? ctx.get('agentDefaultModel') : null
  const selection = selector && typeof selector.currentSelection === 'function' ? selector.currentSelection() : null
  const provider = selection && (selection.provider || selection.providerId)
  const model = selection && (selection.model || selection.modelId)
  if (!provider || !model) throw new Error('还没选模型，先在设置里挑一个默认模型')
  const { createUserMessage, BlockAssembler } = await import('@deepseek-ai/dsh-llm')
  const assembler = new BlockAssembler()
  const stream = llm.stream({
    provider,
    model,
    system,
    messages: [createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'dsh-dianming' } })],
    maxTokens: 400,
    purpose: 'dianming',
    signal: AbortSignal.timeout(25000),
  })
  for await (const chunk of stream) assembler.push(chunk)
  return assembler
    .blocks()
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

async function askCustomModel(settings, system, user) {
  const { baseUrl, apiKey, model } = settings.llm
  if (!baseUrl || !model) throw new Error('自定义接口还缺点东西：baseUrl 和模型名都要填')
  const url = baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions'
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 400,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(25000),
  })
  if (!response.ok) throw new Error('接口返回 ' + response.status + '：' + (await response.text()).slice(0, 200))
  const data = await response.json()
  const choice = data && data.choices && data.choices[0]
  return (choice && choice.message && choice.message.content) || ''
}

async function semanticPick(ctx, query) {
  const pool = candidatePool(query)
  if (pool.length === 0) return { ok: false, error: '清单还是空的，先点一次「扫描」' }
  const listing = pool
    .map((app, index) => `${index + 1}. ${app.name}${app.desc ? ' — ' + app.desc : ''}`)
    .join('\n')
  const system = [
    '你是 Windows 本机软件管家。用户会说一句模糊的需求，你从给定清单里挑最可能的那一个。',
    '规则：只能从清单里挑，不许编造清单外的软件；拿不准就返回空 id。',
    '输出严格 JSON，不要解释：{"id":"<清单里的编号>","reason":"<八个字以内的理由>"}',
    '如果清单里没有能完成这件事的软件，输出 {"id":"","reason":"没有对得上的"}',
  ].filter(Boolean).join('\n')
  const user = '用户需求：' + query + '\n\n本机清单（编号. 名字 — 描述）：\n' + listing
  const settings = loadStore().settings
  let text
  try {
    text = settings.llm.mode === 'custom'
      ? await askCustomModel(settings, system, user)
      : await askDshModel(ctx, system, user)
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
  const parsed = parseModelJson(text)
  if (!parsed) return { ok: false, error: '模型回的不是 JSON：' + String(text).slice(0, 120) }
  const index = Number(parsed.id)
  if (!index || index < 1 || index > pool.length) {
    return { ok: false, error: 'AI 觉得清单里没有对得上的：' + (parsed.reason || '') }
  }
  const app = pool[index - 1]
  return { ok: true, app: publicApp(app), reason: parsed.reason || '' }
}

/* ------------------------------------------------------------------ *
 * 联网补描述（可选）：先本地词典，剩下没人写过的再问一次搜索
 * ------------------------------------------------------------------ */

async function enrichDescriptions(ctx, limit = 15) {
  const store = loadStore()
  const web = ctx.get ? ctx.get('web') : null
  if (!web || typeof web.search !== 'function') return { ok: false, skipped: true, error: '宿主没有搜索服务' }
  const targets = store.apps.filter((app) => !app.desc && app.enabled !== false && !app.missing).slice(0, limit)
  let filled = 0
  for (const app of targets) {
    try {
      const result = await web.search({ query: app.name + ' 是什么软件 用途', maxResults: 3 })
      const items = (result && (result.results || result.items)) || []
      const text = items.map((item) => (item.title || '') + ' ' + (item.snippet || item.description || '')).join(' ')
      const clean = text.replace(/\s+/g, ' ').trim()
      if (clean.length > 12) {
        app.desc = clean.slice(0, 160)
        app.descSource = 'web'
        filled += 1
      }
    } catch {
      /* 单个失败不影响别的 */
    }
  }
  if (filled > 0) saveStore()
  return { ok: true, filled, tried: targets.length }
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  // 清单冷启动时先扫一次，让右下角卡片一打开就有东西
  try {
    const store = loadStore()
    if (store.apps.length === 0) {
      setTimeout(() => {
        try {
          runScan()
        } catch (error) {
          console.error(LOG, '首次扫描失败', String(error))
        }
      }, 3000)
    }
  } catch (error) {
    console.error(LOG, '读取清单失败', String(error))
  }

  const webServer = ctx.webServer ?? (ctx.get ? ctx.get('webServer') : null)
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        if (denyNonLoopback(req, res)) return
        const url = new URL(req.url || '/', 'http://localhost')
        const path = url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) || '/' : url.pathname
        try {
          if (req.method === 'GET' && path === '/state') {
            const store = loadStore()
            return json(res, {
              ok: true,
              settings: store.settings,
              total: store.apps.length,
              active: store.apps.filter((app) => app.enabled !== false && !app.missing).length,
              lastScan: store.lastScan,
              store: STORE_FILE,
            })
          }

          if (req.method === 'GET' && path === '/apps') {
            const store = loadStore()
            const q = (url.searchParams.get('q') || '').trim().toLowerCase()
            const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
            let rows = store.apps
            if (q) {
              rows = rows.filter((app) => {
                const hay = [app.name, app.desc, app.path, ...(app.aliases || []), ...(app.keywords || [])]
                  .filter(Boolean)
                  .join(' ')
                  .toLowerCase()
                return hay.includes(q)
              })
            }
            rows = rows.slice().sort((a, b) => {
              const uses = (b.uses || 0) - (a.uses || 0)
              return uses !== 0 ? uses : String(a.name).localeCompare(String(b.name), 'zh')
            })
            return json(res, {
              ok: true,
              total: rows.length,
              offset,
              limit,
              counts: {
                total: store.apps.length,
                enabled: store.apps.filter((app) => app.enabled !== false).length,
                missing: store.apps.filter((app) => app.missing).length,
                own: store.apps.filter((app) => app.descSource === 'user').length,
              },
              apps: rows.slice(offset, offset + limit).map(publicApp),
            })
          }

          if (req.method === 'POST') {
            const body = JSON.parse((await readBody(req)) || '{}')

            if (path === '/scan') {
              const result = runScan()
              const settings = loadStore().settings
              if (settings.enrich) enrichDescriptions(ctx, settings.enrichLimit || 15).catch(() => {})
              return json(res, { ...result, total: loadStore().apps.length })
            }

            if (path === '/search') {
              const q = String(body.q || '').trim()
              if (!q) return json(res, { ok: true, candidates: [] })
              return json(res, { ok: true, candidates: searchApps(q, Number(body.limit) || 8) })
            }

            if (path === '/semantic') {
              const q = String(body.q || '').trim()
              if (!q) return json(res, { ok: false, error: '说一句要干什么' })
              return json(res, await semanticPick(ctx, q))
            }

            if (path === '/open') {
              const app = appById(String(body.id || ''))
              if (!app) return json(res, { ok: false, error: '清单里没有这个条目，先重新扫描' })
              const result = launchApp(app)
              if (result.ok && body.q) rememberQuery(body.q, app.id)
              return json(res, result)
            }

            if (path === '/app') {
              const store = loadStore()
              const target = body.id ? appById(String(body.id)) : null
              if (target) {
                if (body.name) target.name = String(body.name).trim()
                if (body.path) target.path = String(body.path).trim()
                if (body.desc !== undefined) {
                  target.desc = String(body.desc)
                  target.descSource = 'user'
                }
                if (Array.isArray(body.aliases)) target.aliases = body.aliases.map(String)
                if (Array.isArray(body.keywords)) target.keywords = body.keywords.map(String)
                if (body.enabled !== undefined) target.enabled = Boolean(body.enabled)
                target.missing = false
                saveStore()
                return json(res, { ok: true, app: publicApp(target) })
              }
              const created = {
                id: randomUUID(),
                name: String(body.name || '').trim(),
                path: String(body.path || '').trim(),
                kind: /\.lnk$/i.test(String(body.path || '')) ? 'lnk' : 'exe',
                desc: String(body.desc || ''),
                descSource: 'user',
                aliases: Array.isArray(body.aliases) ? body.aliases.map(String) : [],
                keywords: Array.isArray(body.keywords) ? body.keywords.map(String) : [],
                source: 'manual',
                enabled: true,
                uses: 0,
                addedAt: Date.now(),
                missing: false,
              }
              if (!created.name || !created.path) return json(res, { ok: false, error: '名字和路径都要有' })
              store.apps.push(created)
              saveStore()
              return json(res, { ok: true, app: publicApp(created) })
            }

            if (path === '/app-delete') {
              const store = loadStore()
              const before = store.apps.length
              store.apps = store.apps.filter((app) => app.id !== String(body.id || ''))
              saveStore()
              return json(res, { ok: store.apps.length < before })
            }

            if (path === '/settings') {
              const store = loadStore()
              const patch = body.patch && typeof body.patch === 'object' ? body.patch : {}
              store.settings = {
                ...DEFAULT_SETTINGS,
                ...store.settings,
                ...patch,
                llm: { ...DEFAULT_SETTINGS.llm, ...(store.settings.llm || {}), ...(patch.llm || {}) },
                fab: { ...DEFAULT_SETTINGS.fab, ...(store.settings.fab || {}), ...(patch.fab || {}) },
              }
              saveStore()
              return json(res, { ok: true, settings: store.settings })
            }

            if (path === '/enrich') {
              return json(res, await enrichDescriptions(ctx, Number(body.limit) || 15))
            }
          }

          return json(res, { ok: false, error: '没有这个接口：' + path }, 404)
        } catch (error) {
          console.error(LOG, '接口出错', String(error))
          return json(res, { ok: false, error: String(error && error.message ? error.message : error) }, 500)
        }
      },
    }), 'dsh-dianming: /dianming-api')
  } else {
    console.warn(LOG, '没有 webServer，右下角卡片用不了，只保留模型工具')
  }

  /* ---- 给模型的三个工具 ---- */

  const register = (build) => {
    try {
      ctx.tools.register(build())
    } catch (error) {
      console.error(LOG, '工具注册失败', String(error))
    }
  }

  ctx.inject(['tools'], () => {
    register(() => defineTool({
      name: 'open_app',
      description:
        '按用户的模糊描述打开本机软件（"剪视频的""解压的""那个下载器"都行）。先在本机软件清单里按名字/别名/关键词/描述匹配；' +
        '匹配到多个就返回候选让用户挑，不要自己乱猜；清单里没有才建议用户扫描或补一条。',
      parameters: {
        query: { type: 'string', description: '用户的描述或软件名，照原话写' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute(args) {
        const query = String(args.query || '').trim()
        if (!query) return { ok: false, message: '要说一句想打开什么。' }
        const rows = searchApps(query, 6)
        if (rows.length === 0) {
          const semantic = await semanticPick(ctx, query)
          if (semantic.ok) {
            const app = appById(semantic.app.id)
            const result = app ? launchApp(app) : { ok: false, error: '条目丢了' }
            if (result.ok) {
              rememberQuery(query, semantic.app.id)
              return { ok: true, message: '按 AI 判断打开了：' + semantic.app.name + (semantic.reason ? '（' + semantic.reason + '）' : '') }
            }
            return { ok: false, message: 'AI 猜是「' + semantic.app.name + '」，但没打开：' + result.error }
          }
          return { ok: false, message: '清单里没有对得上的（' + (semantic.error || '') + '）。可以让我扫一遍，或者告诉我要加哪条。' }
        }
        const top = rows[0]
        const close = rows.filter((row) => row.score >= top.score - 60).slice(0, 5)
        if (close.length === 1 && top.score >= 520 && !top.missing) {
          const result = launchApp(appById(top.id))
          if (result.ok) {
            rememberQuery(query, top.id)
            return { ok: true, message: '打开了：' + top.name }
          }
          return { ok: false, message: '找到了「' + top.name + '」但没打开：' + result.error }
        }
        const lines = close.map((row, index) => `${index + 1}. ${row.name}${row.desc ? ' — ' + row.desc : ''}${row.missing ? '（路径已失效）' : ''}`)
        return {
          ok: true,
          message: '匹配到几个，问用户要哪个（不要自己替他选）：\n' + lines.join('\n'),
          candidates: close,
        }
      },
    }))

    register(() => defineTool({
      name: 'app_catalog',
      description: '查本机软件清单：能按关键词筛，也能看总数和前若干条。用户问"我电脑上有没有 XX""都装了什么"时用。',
      parameters: {
        query: { type: 'string', description: '关键词，可空' },
        limit: { type: 'number', description: '最多回几条，默认 30' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute(args) {
        const store = loadStore()
        const limit = Math.min(200, Math.max(1, Number(args.limit) || 30))
        const q = String(args.query || '').trim()
        const rows = q ? searchApps(q, limit) : store.apps.filter((app) => app.enabled !== false).slice(0, limit).map(publicApp)
        if (rows.length === 0) {
          return { ok: true, message: q ? '没有匹配「' + q + '」的条目。' : '清单是空的，先扫一遍。', apps: [] }
        }
        const body = rows.map((row, index) => `${index + 1}. ${row.name}${row.desc ? ' — ' + row.desc : ''}${row.path ? '  [' + row.path + ']' : ''}`)
        return { ok: true, message: `共 ${store.apps.length} 条，这里给 ${rows.length} 条：\n` + body.join('\n'), apps: rows }
      },
    }))

    register(() => defineTool({
      name: 'app_scan',
      description: '重新扫描软件清单（配置里指定的目录 + 开始菜单快捷方式）。新装了软件、或者清单空的时候用。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute() {
        const result = runScan()
        return { ok: true, message: `扫描完成：这次看到 ${result.scanned} 个入口，新增 ${result.added} 条，清单共 ${result.total} 条，用时 ${result.ms}ms。`, ...result }
      },
    }))
  })
}
