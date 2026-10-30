// 触发「重补」并跟进度，跑完抽样看质量
const base = (process.env.DM_BASE || 'http://127.0.0.1:10605') + '/dianming-api'

const post = async (path, body) => (await fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
})).json()
const get = async (path) => (await fetch(base + path)).json()

const started = await post('/enrich', { force: true, limit: 400 })
console.log('start:', JSON.stringify(started))

let last = -1
for (;;) {
  await new Promise((r) => setTimeout(r, 5000))
  const p = await get('/enrich-progress')
  if (p.done !== last) {
    last = p.done
    console.log(`进度 ${p.done}/${p.total} 成功 ${p.filled} 失败 ${p.failed} 当前 ${p.current || '-'}`)
  }
  if (!p.running) { console.log('结束:', JSON.stringify(p)); break }
  if (p.done >= 400) break
}

const apps = await get('/apps?limit=400&offset=0')
const rows = apps.apps || []
const aiRows = rows.filter((a) => a.descSource === 'ai' || a.descSource === 'web')
console.log(`描述来源：ai/web ${aiRows.length} 条，总 ${rows.length}`)
const short = aiRows.filter((a) => !a.desc || String(a.desc).length < 10)
console.log(`过短/空：${short.length}`)
const bad = aiRows.filter((a) => /[|*#`]|[:：]$|需要我|已记录|建议你/.test(String(a.desc)))
console.log(`带格式或跑题：${bad.length}`)
for (const row of aiRows.slice(0, 12)) console.log(` - ${row.name}: ${row.desc}`)
