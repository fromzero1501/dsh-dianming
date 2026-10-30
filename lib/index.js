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

let enrichJob = null

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

async function askDshModel(ctx, system, user, maxTokens = 400) {
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
    maxTokens,
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

async function askCustomModel(settings, system, user, maxTokens = 400) {
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
      max_tokens: maxTokens,
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
 * 补描述：让模型读"名字 + 路径"写一句用途和几个关键词；模型不可用时退回联网搜索
 * ------------------------------------------------------------------ */

const DESCRIBE_SYSTEM = [
  '你在给一台 Windows 电脑的软件清单补简介，目的是让用户以后用一句"我想干什么"就能搜到它。',
  '对清单里每个软件输出：desc = 一句话中文说明（12 到 30 字，说清它干什么、能替代什么）；keys = 3 到 6 个用户可能用来找它的中文词（同义词、用途、俗称都行）。',
  '只用你确实知道的信息；不确定就按名字和路径写保守的通用说明，不要编版本号、价格、公司、功能细节。',
  '广告、捆绑、破解类工具照实写它是干什么的。',
  '输出严格 JSON 数组，不要解释、不要代码围栏：[{"id":"1","desc":"…","keys":["…","…"]}]',
].join('\n')

/** 模型输出可能带围栏或前后废话，尽量把 id/desc/keys 抠出来。 */
function parseDescribeJson(raw, items) {
  const text = String(raw || '')
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  let list = null
  if (start >= 0 && end > start) {
    try {
      list = JSON.parse(text.slice(start, end + 1))
    } catch {
      list = null
    }
  }
  if (!Array.isArray(list)) {
    list = []
    const re = /(\d+)\s*[.、:：]\s*([^\n]+)/g
    let match
    while ((match = re.exec(text)) !== null) list.push({ id: match[1], desc: match[2] })
  }
  const rows = []
  for (const row of list) {
    const index = Number(row && row.id)
    if (!index || index < 1 || index > items.length) continue
    const desc = String(row.desc || '').replace(/\s+/g, ' ').trim().slice(0, 60)
    if (desc.length < 4) continue
    const keys = Array.isArray(row.keys)
      ? row.keys.map((key) => String(key).trim()).filter(Boolean).slice(0, 6)
      : []
    rows.push({ app: items[index - 1], desc, keys })
  }
  return rows
}

async function describeBatch(ctx, settings, items) {
  const listing = items.map((app, index) => `${index + 1}. ${app.name}${app.path ? ' — ' + app.path : ''}`).join('\n')
  const user = '本机软件清单（编号. 名字 — 路径）：\n' + listing
  const raw = settings.llm.mode === 'custom'
    ? await askCustomModel(settings, DESCRIBE_SYSTEM, user, 1600)
    : await askDshModel(ctx, DESCRIBE_SYSTEM, user, 1600)
  return parseDescribeJson(raw, items)
}

/** 先查网：给这一批每个软件搜一句网页摘要，连同摘要一起交给模型压缩。 */
async function describeBatchWithWeb(ctx, settings, items) {
  const web = ctx.get ? ctx.get('web') : null
  const snippets = []
  if (web && typeof web.search === 'function') {
    await Promise.all(items.map(async (app, index) => {
      try {
        const result = await web.search({ query: app.name + ' 软件 是做什么的', maxResults: 3 })
        const list = (result && (result.results || result.items)) || []
        snippets[index] = list
          .map((item) => (item.title || '') + '：' + (item.snippet || item.description || ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 500)
      } catch {
        snippets[index] = ''
      }
    }))
  }
  const hasSnippet = snippets.some(Boolean)
  const listing = items
    .map((app, index) => {
      const line = index + 1 + '. ' + app.name + (app.path ? ' — ' + app.path : '')
      return snippets[index] ? line + '\n   网页摘要：' + snippets[index] : line
    })
    .join('\n')
  const user = '本机软件清单（编号. 名字 — 路径，部分附网页摘要）：\n' + listing
  const system = hasSnippet
    ? DESCRIBE_SYSTEM + '\n有网页摘要的条目只能依据摘要写，摘要没提到的不要编；摘要与软件明显对不上时，按你有把握的常识写。'
    : DESCRIBE_SYSTEM
  const raw = settings.llm.mode === 'custom'
    ? await askCustomModel(settings, system, user, 1600)
    : await askDshModel(ctx, system, user, 1600)
  const rows = parseDescribeJson(raw, items)
  for (const row of rows) {
    const index = items.indexOf(row.app)
    row.source = index >= 0 && snippets[index] ? 'web' : 'ai'
  }
  return rows
}

/** 补简介任务的进度快照。 */
function enrichSnapshot() {
  if (!enrichJob) {
    return { ok: true, running: false, total: 0, done: 0, filled: 0, failed: 0, current: '', startedAt: 0, finishedAt: 0, error: '' }
  }
  return {
    ok: true,
    running: enrichJob.running,
    total: enrichJob.total,
    done: enrichJob.done,
    filled: enrichJob.filled,
    failed: enrichJob.failed,
    current: enrichJob.current,
    startedAt: enrichJob.startedAt,
    finishedAt: enrichJob.finishedAt || 0,
    error: enrichJob.error || '',
  }
}

/** 起一个后台补简介任务（同一时间只允许一个），立刻返回快照，前端轮询 /enrich-progress 看进度。 */
function startDescribeJob(ctx, options = {}) {
  if (enrichJob && enrichJob.running) return enrichSnapshot()
  const store = loadStore()
  const settings = store.settings
  const force = Boolean(options.force)
  const cap = Math.max(1, Math.min(400, Number(options.limit) || 400))
  const targets = store.apps
    .filter((app) => app.enabled !== false && !app.missing && (force ? app.descSource !== 'user' : !app.desc))
    .slice(0, cap)
  enrichJob = {
    running: true,
    total: targets.length,
    done: 0,
    filled: 0,
    failed: 0,
    current: '',
    startedAt: Date.now(),
    finishedAt: 0,
    error: '',
    cancel: false,
  }
  if (targets.length === 0) {
    enrichJob.running = false
    enrichJob.finishedAt = Date.now()
    return enrichSnapshot()
  }
  const job = enrichJob
  ;(async () => {
    try {
      for (let i = 0; i < targets.length; i += 5) {
        if (job.cancel) break
        const batch = targets.slice(i, i + 5)
        job.current = batch.map((app) => app.name).join('、')
        let rows = []
        try {
          rows = await describeBatchWithWeb(ctx, settings, batch)
        } catch (error) {
          job.error = String(error && error.message ? error.message : error)
        }
        for (const row of rows) {
          if (row.app.descSource === 'user') continue
          row.app.desc = row.desc
          row.app.descSource = row.source || 'ai'
          if (row.keys.length > 0) row.app.keywords = [...new Set([...(row.app.keywords || []), ...row.keys])]
        }
        if (rows.length > 0) saveStore()
        job.done = Math.min(targets.length, i + batch.length)
        job.filled += rows.length
        job.failed += batch.length - rows.length
      }
    } catch (error) {
      job.error = String(error && error.message ? error.message : error)
    } finally {
      job.running = false
      job.finishedAt = Date.now()
      job.current = ''
    }
  })()
  return enrichSnapshot()
}

/** 给还没有描述的软件批量写简介；每批 10 个，写完立刻落盘，中途失败已完成的也保住。 */
async function describeMissing(ctx, limit = 20, options = {}) {
  const store = loadStore()
  const settings = store.settings
  const force = Boolean(options.force)
  const cap = Math.max(1, Math.min(400, Number(limit) || 20))
  const targets = store.apps
    .filter((app) => app.enabled !== false && !app.missing && (force ? app.descSource !== 'user' : !app.desc))
    .slice(0, cap)
  if (targets.length === 0) {
    return { ok: true, filled: 0, tried: 0, remaining: 0, done: true }
  }
  let filled = 0
  let error = ''
  for (let i = 0; i < targets.length; i += 10) {
    const batch = targets.slice(i, i + 10)
    try {
      const rows = await describeBatch(ctx, settings, batch)
      for (const row of rows) {
        if (row.app.descSource === 'user') continue
        row.app.desc = row.desc
        row.app.descSource = 'ai'
        if (row.keys.length > 0) row.app.keywords = [...new Set([...(row.app.keywords || []), ...row.keys])]
        filled += 1
      }
      if (rows.length > 0) saveStore()
    } catch (err) {
      error = String(err && err.message ? err.message : err)
      break
    }
  }
  const remaining = store.apps.filter((app) => app.enabled !== false && !app.missing && !app.desc).length
  return { ok: filled > 0 || !error, filled, tried: targets.length, remaining, error: error || undefined }
}

async function enrichFromWeb(ctx, limit = 15) {
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
          if (req.method === 'GET' && path === '/enrich-progress') return json(res, enrichSnapshot())

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
              // 扫完顺手让 AI 补一批简介（后台跑，不挡扫描返回）
              if (settings.enrich) startDescribeJob(ctx, { limit: settings.enrichLimit || 20 })
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
              const mode = String(body.mode || 'ai')
              const limit = Number(body.limit) || 400
              const force = Boolean(body.force)
              if (mode === 'web') return json(res, await enrichFromWeb(ctx, limit))
              return json(res, startDescribeJob(ctx, { force, limit }))
            }

            if (path === '/enrich-stop') {
              if (enrichJob && enrichJob.running) enrichJob.cancel = true
              return json(res, enrichSnapshot())
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
