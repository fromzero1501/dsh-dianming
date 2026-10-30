const base = (process.env.DM_BASE || 'http://127.0.0.1:10605') + '/dianming-api'
const apps = (await (await fetch(base + '/apps?limit=400&offset=0')).json()).apps || []
const notAi = apps.filter((a) => !a.desc || (a.descSource !== 'ai' && a.descSource !== 'web'))
console.log('总', apps.length, '非 ai/web', notAi.length)
for (const a of notAi) console.log(' -', a.name, '|', a.descSource, '|', a.desc || '(空)')
const lens = apps.map((a) => String(a.desc || '').length).sort((x, y) => x - y)
console.log('长度 min/中位/max:', lens[0], lens[Math.floor(lens.length / 2)], lens[lens.length - 1])
for (const q of ['解压', '剪视频', '截图', '下载', '聊天']) {
  const r = await (await fetch(base + '/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, limit: 3 }) })).json()
  console.log(`搜「${q}」→`, (r.candidates || []).map((c) => `${c.name}(${c.score})`).join(' / '))
}
