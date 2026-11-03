// 为什么这个词匹配到了这些条目：把命中字段和分数摊开打印（只读，用真实清单的副本）
import { copyFileSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const realHome = process.env.DSH_HOME || join(process.env.APPDATA || homedir(), 'dsh-desktop', 'harness')
const realStore = join(realHome, '.dsh', 'dianming.json')
if (!existsSync(realStore)) {
  console.error('找不到清单：' + realStore)
  process.exit(1)
}

const sandbox = join(tmpdir(), 'dianming-why-' + process.pid)
mkdirSync(join(sandbox, '.dsh'), { recursive: true })
copyFileSync(realStore, join(sandbox, '.dsh', 'dianming.json'))
process.env.DSH_HOME = sandbox

const core = await import('../lib/core.js')
const query = process.argv[2] || '抖音'
const q = core.norm(query)
const store = core.loadStore()

const hits = []
for (const app of store.apps) {
  if (app.enabled === false) continue
  const score = core.scoreApp(app, query, store.history)
  if (score <= 0) continue
  const fields = [['name', app.name], ...(app.aliases || []).map((a) => ['alias', a]), ...(app.keywords || []).map((k) => ['keyword', k]), ['desc', app.desc]]
  const why = []
  for (const [kind, value] of fields) {
    const norm = core.norm(value)
    if (!norm) continue
    if (norm === q) why.push(`${kind}=「${value}」完全等于`)
    else if (norm.startsWith(q)) why.push(`${kind}=「${value}」以它开头`)
    else if (norm.includes(q)) why.push(`${kind}=「${value}」包含它`)
    else if (q.length >= 2 && q.includes(norm) && norm.length >= 2) why.push(`${kind}=「${value}」是它的子串`)
  }
  hits.push({ name: app.name, score, uses: app.uses || 0, why })
}

hits.sort((a, b) => b.score - a.score)
console.log(`查询「${query}」命中 ${hits.length} 条`)
for (const hit of hits.slice(0, 12)) {
  console.log(`  ${hit.score}  ${hit.name}  uses=${hit.uses}`)
  for (const line of hit.why.slice(0, 4)) console.log(`        ${line}`)
}
const sample = store.apps.find((app) => app.name === hits[0]?.name)
if (sample) {
  console.log('\n第一条的别名/关键词：')
  console.log('  aliases=' + JSON.stringify(sample.aliases || []))
  console.log('  keywords=' + JSON.stringify(sample.keywords || []))
}
rmSync(sandbox, { recursive: true, force: true })
