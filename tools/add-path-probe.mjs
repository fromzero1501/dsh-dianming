// 拖拽入库探针：在沙箱清单副本上验证 exe / 快捷方式 / 文件夹 / 重复 的处理
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const realHome = process.env.DSH_HOME || join(process.env.APPDATA || homedir(), 'dsh-desktop', 'harness')
const realStore = join(realHome, '.dsh', 'dianming.json')
const sandbox = join(tmpdir(), 'dianming-drop-' + process.pid)
mkdirSync(join(sandbox, '.dsh'), { recursive: true })
if (existsSync(realStore)) copyFileSync(realStore, join(sandbox, '.dsh', 'dianming.json'))
process.env.DSH_HOME = sandbox

const core = await import('../lib/core.js')

// 找一个真实的开始菜单快捷方式
const startMenu = join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
let lnk = ''
const walk = (dir, depth) => {
  if (lnk || depth > 3) return
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (lnk) return
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, depth + 1)
    else if (/\.lnk$/i.test(entry.name)) lnk = full
  }
}
walk(startMenu, 0)

const exe = 'C:\\Windows\\System32\\notepad.exe'
const result = core.addByPaths([exe, exe, lnk, 'C:\\Windows', 'C:\\Windows\\win.ini'])
console.log('新增 ' + result.added.length + ' 条:')
for (const app of result.added) console.log(`  [${app.kind}] ${app.name} → ${app.path}`)
console.log('跳过 ' + result.skipped.length + ' 条:')
for (const item of result.skipped) console.log(`  ${item.reason}  ${item.path}`)
console.log('快捷方式输入: ' + (lnk || '(没找到)'))
rmSync(sandbox, { recursive: true, force: true })
