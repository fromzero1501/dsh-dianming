/**
 * 点名 core 层自测：不碰 DSH，直接跑扫描 + 匹配，看清单和生产出来的候选对不对。
 * 用法：node tools/self-test.mjs
 */
import { existsSync } from 'node:fs'
import {
  STORE_FILE,
  loadStore,
  runScan,
  searchApps,
  scoreApp,
} from '../lib/core.js'

console.log('清单文件：', STORE_FILE)

const t0 = Date.now()
const result = runScan()
console.log('扫描结果：', result, '总耗时', Date.now() - t0, 'ms')

const store = loadStore()
console.log('清单条数：', store.apps.length)
console.log('有描述：', store.apps.filter((app) => app.desc).length)
console.log('失联：', store.apps.filter((app) => app.missing).length)

console.log('\n--- 前 25 条 ---')
for (const app of store.apps.slice(0, 25)) {
  console.log(`  ${app.name}  |  ${app.desc || '(无描述)'}  |  ${app.source}  |  ${app.path}`)
}

console.log('\n--- 抽查几个描述补全情况 ---')
for (const keyword of ['剪映', 'obs', '7-zip', 'clash', 'wps', 'telegram', 'pikpak']) {
  const hit = store.apps.find((app) => app.name.toLowerCase().includes(keyword))
  console.log(`  ${keyword} -> ${hit ? hit.name + ' | ' + (hit.desc || '(无描述)') : '没找到'}`)
}

const queries = ['剪视频', '解压', '录屏', '下载器', '代理', '截图', '写代码', '聊天', '看视频', '网盘']
console.log('\n--- 按描述搜索 ---')
for (const query of queries) {
  const rows = searchApps(query, 4)
  console.log(`  「${query}」-> ${rows.length === 0 ? '没有命中' : rows.map((row) => `${row.name}(${row.score})`).join('、')}`)
}

console.log('\n--- 按名字搜索 ---')
for (const query of ['obs', 'clash', 'wps', 'res']) {
  const rows = searchApps(query, 4)
  console.log(`  「${query}」-> ${rows.length === 0 ? '没有命中' : rows.map((row) => `${row.name}(${row.score})`).join('、')}`)
}

// 启动器不真开，只验存在性与打分函数不报错
const sample = store.apps[0]
if (sample) {
  console.log('\n第一条路径存在？', existsSync(sample.path), '打分(名字自匹配)：', scoreApp(sample, sample.name, {}))
}
console.log('\n自测结束。')
