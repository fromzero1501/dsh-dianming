// 在 DSH 宿主资源里定位"拖动到此处即可添加"这段文案的实现，用来判断拖拽事件被谁接管
const fs = require('node:fs')
const path = require('node:path')

const roots = [
  'D:/100 SoftWare/140 AISoftware/Agent/DeepSeek Harness/resources/app.asar',
  'D:/100 SoftWare/140 AISoftware/Agent/DeepSeek Harness/resources/app',
]
const needles = ['拖动到此处即可添加', '每张 20MB'].map((text) => Buffer.from(text, 'utf8'))
const hits = []
function walk(target, depth) {
  let stat
  try {
    stat = fs.statSync(target)
  } catch {
    return
  }
  if (stat.isDirectory()) {
    if (depth > 7) return
    for (const entry of fs.readdirSync(target)) walk(path.join(target, entry), depth + 1)
    return
  }
  if (stat.size > 80 * 1024 * 1024) return
  let buf
  try {
    buf = fs.readFileSync(target)
  } catch {
    return
  }
  const found = needles.filter((needle) => buf.includes(needle)).length
  if (found) hits.push(target + '  (' + stat.size + ' bytes, hits=' + found + ')')
}
for (const root of roots) walk(root, 0)
console.log(hits.join('\n') || 'no hit')
