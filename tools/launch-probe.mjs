const base = (process.env.DM_BASE || 'http://127.0.0.1:3069') + '/dianming-api'
const j = async (p, opt) => (await fetch(base + p, opt)).json()

const apps = (await j('/apps?q=topaz&limit=20')).apps || []
for (const a of apps) console.log('APP', JSON.stringify({ id: a.id, name: a.name, path: a.path, missing: a.missing, enabled: a.enabled }))

if (apps[0]) {
  const r = await j('/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: apps[0].id, q: 'topaz' }) })
  console.log('OPEN', JSON.stringify(r))
}
