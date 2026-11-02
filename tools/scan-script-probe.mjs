// 在沙箱里用一份真实清单的副本重扫一遍，只看「启动脚本（.bat/.cmd）」进来多少条，不碰真实清单。
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const realHome = process.env.APPDATA ? join(process.env.APPDATA, 'dsh-desktop', 'harness') : ''
const sandbox = mkdtempSync(join(tmpdir(), 'dianming-bat-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, '.dsh'), { recursive: true })
const src = join(realHome, '.dsh', 'dianming.json')
if (existsSync(src)) copyFileSync(src, join(sandbox, '.dsh', 'dianming.json'))

const core = await import('../lib/core.js')
const before = core.loadStore().apps.length
const result = core.runScan()
const store = core.loadStore()
const scripts = store.apps.filter((app) => /\.(bat|cmd)$/i.test(String(app.path)))
console.log(`before=${before} after=${store.apps.length} added=${result.added} pruned=${result.pruned}`)
console.log(`脚本入口 ${scripts.length} 条:`)
for (const app of scripts.slice(0, 40)) {
  console.log(`  ${app.name}  →  ${app.path}   别名=${(app.aliases || []).join(',')}`)
}
// 按关键词抽查（node tools/scan-script-probe.mjs tts）
const keyword = (process.argv[2] || '').toLowerCase()
if (keyword) {
  const hits = store.apps.filter((app) => `${app.name} ${app.path}`.toLowerCase().includes(keyword))
  console.log(`关键词「${keyword}」命中 ${hits.length} 条:`)
  for (const app of hits.slice(0, 20)) {
    console.log(`  [${app.kind}] ${app.name}  →  ${app.path}   别名=${(app.aliases || []).join(',')}`)
    console.log(`       flags: uses=${app.uses || 0} descSource=${app.descSource || '-'} fav=${app.fav === true} source=${app.source}`)
  }
}
rmSync(sandbox, { recursive: true, force: true })
