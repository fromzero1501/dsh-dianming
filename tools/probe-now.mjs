// 现场诊断：调运行中的点名接口，看样本 vs 实际补简介的差异
const base = process.env.DM_BASE || 'http://127.0.0.1:8731'
const api = base + '/dianming-api'

async function post(path, body) {
  const res = await fetch(api + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  return res.json()
}

async function get(path) {
  const res = await fetch(api + path)
  return res.json()
}

const state = await get('/state')
console.log('state:', JSON.stringify(state.settings ? { total: state.total, mode: state.settings.llm.mode, semanticMode: state.settings.semanticMode } : state))

const apps = await get('/apps?limit=12&offset=0')
const aiRows = (apps.apps || []).filter((a) => a.descSource === 'ai' || a.descSource === 'web')
console.log('ai 描述样本（前 12 条里）:')
for (const row of aiRows.slice(0, 6)) {
  console.log(` - ${row.name} [${row.descSource}] ${String(row.desc).slice(0, 80)}`)
}

const probe = await post('/describe-probe', { limit: 3, only: 'all' })
console.log('probe:', JSON.stringify(probe, null, 2).slice(0, 3000))
