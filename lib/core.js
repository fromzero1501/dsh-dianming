/**
 * 点名的核心：目录存储、扫描、匹配、启动。
 *
 * 这一层不依赖 DSH 的任何服务，纯 Node 跑得动，方便单独测（tools/self-test.mjs）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const LOG = '[dsh-dianming]'

export function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'dsh-desktop', 'harness')
}

export const STORE_FILE = join(dshHome(), '.dsh', 'dianming.json')

export const DEFAULT_SETTINGS = {
  roots: ['D:\\100 SoftWare'],
  includeStartMenu: true,
  scanDepth: 7,
  maxApps: 1200,
  semanticMode: 'manual', // off | manual | auto
  enrich: true,
  enrichLimit: 15,
  llm: { mode: 'dsh', baseUrl: '', apiKey: '', model: '' },
  hidden: false,
  fab: { right: 24, bottom: 24 },
}

export function defaultStore() {
  return { version: 1, settings: structuredClone(DEFAULT_SETTINGS), apps: [], history: {}, lastScan: null }
}

let cache = null

export function loadStore() {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(STORE_FILE, 'utf8'))
    cache = {
      version: 1,
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        ...(raw.settings || {}),
        llm: { ...DEFAULT_SETTINGS.llm, ...((raw.settings || {}).llm || {}) },
      },
      apps: Array.isArray(raw.apps) ? raw.apps : [],
      history: raw.history && typeof raw.history === 'object' ? raw.history : {},
      lastScan: raw.lastScan || null,
    }
  } catch {
    cache = defaultStore()
  }
  return cache
}

export function saveStore() {
  const store = loadStore()
  try {
    mkdirSync(dirname(STORE_FILE), { recursive: true })
    writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8')
    return true
  } catch (error) {
    console.error(LOG, '写入失败', String(error))
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 扫描
 * ------------------------------------------------------------------ */

/** 明显不是"要打开的软件"的可执行文件。 */
const NOISE_EXE = /(unins|uninstall|uninst|setup|installer|install|update|updater|upgrade|patch|repair|remove|crash|crashpad|report|feedback|helper|handler|detector|offset|elevate|elevation|vcredist|vc_redist|dxsetup|dxwebsetup|dotnet|oalinst|service|daemon|watchdog|renderer|webview|regist|util|kso|kvpins|wpscli|wpsdoc|main64|stackwalk|minidump|websource|enableloopback|^7zg|^ksystem|kvpet|opencodecs|产品管理)/i

/** 目录名是这类通用词时，往上找有意义的目录名当显示名。 */
const GENERIC_DIR = /^(bin|bin32|bin64|x64|x86|x86_64|win|win32|win64|windows|app|apps|application|program|programs|dist|build|release|debug|current|latest|version|versions|\d+bit|\d+(\.\d+)*)$/i

/** exe 主名太通用时也往上找目录名。 */
const GENERIC_STEM = /^(app|application|main|start|startup|launcher|run|client|program|index|electron|game|setup)$/i

/** 扫描时整棵跳过的目录（安装器、运行库、缓存）。 */
const SKIP_DIRS = new Set([
  'node_modules', 'resources', 'runtime', 'runtimes', 'redist', 'redistributable',
  'locales', 'locale', 'plugins', 'plugin', 'lib', 'lib64', 'libs', 'include',
  'docs', 'doc', 'samples', 'templates', 'cache', 'temp', 'tmp', 'logs', 'log',
  'crashpad', 'crashreports', '__pycache__', 'site-packages', '.git', '.cache',
  'data', 'obs-plugins', 'service', 'etc', 'uninstall', 'module', 'modules',
])

export function norm(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s\-_·.,，、:：;；/\\|<>"'“”‘’]/g, '')
}

function walkDir(root, depth, out, budget) {
  if (depth < 0 || budget.left <= 0) return
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  const dirs = []
  for (const entry of entries) {
    if (budget.left-- <= 0) return
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      // 125.0.6422.61 这类版本目录里放的是浏览器内核/插件，不是独立软件
      if (!SKIP_DIRS.has(entry.name.toLowerCase()) && !/^\d+(\.\d+){1,3}$/.test(entry.name)) dirs.push(full)
    } else if (entry.isFile() && /\.exe$/i.test(entry.name)) {
      out.push(full)
    }
  }
  for (const dir of dirs) walkDir(dir, depth - 1, out, budget)
}

/** 一个目录里挑出"主程序"：先找与目录同名的，再找名字相近的，最后取体积最大的。 */
export function pickMainExe(exes, dir) {
  const useful = exes.filter((file) => !NOISE_EXE.test(basename(file)))
  // 整个目录里只剩安装器/卸载器/辅助进程：这个目录不算一个软件
  if (useful.length === 0) return null
  const pool = useful
  const folder = norm(basename(dir))
  if (folder) {
    const exact = pool.find((file) => norm(basename(file, extname(file))) === folder)
    if (exact) return exact
    const near = pool.find((file) => {
      const stem = norm(basename(file, extname(file)))
      return stem.length >= 3 && (stem.includes(folder) || folder.includes(stem))
    })
    if (near) return near
  }
  const folderToks = (basename(dir).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []).filter((tok) => !NAME_NOISE.test(tok))
  let best = null
  let bestScore = -1
  let bestSize = -1
  for (const file of pool) {
    const stem = basename(file, extname(file)).toLowerCase()
    let score = 0
    for (const tok of folderToks) {
      if (stem === tok) score = Math.max(score, 3)
      else if (stem.startsWith(tok) || tok.startsWith(stem)) score = Math.max(score, 2)
      else if (stem.includes(tok)) score = Math.max(score, 1)
    }
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      /* 读不到大小当 0 */
    }
    if (score > bestScore || (score === bestScore && size > bestSize)) {
      bestScore = score
      bestSize = size
      best = file
    }
  }
  return best
}

function tidyName(text) {
  return String(text || '')
    .replace(/[_-]+/g, ' ')
    // 去掉"64 bit / x64 / Desktop / portable / Beta"这类同义尾巴，让同一个软件的不同入口能合并
    .replace(/\s*[-—]?\s*(64 bit|32 bit|x64|x86|desktop|portable|beta|prerel|setup)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 往上找一个有意义的目录名（跳过 bin、64bit 这种通用层）。 */
function meaningfulFolder(dir) {
  let current = dir
  for (let i = 0; i < 4; i += 1) {
    const folder = basename(current)
    if (folder && !GENERIC_DIR.test(folder)) return folder
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return ''
}

/** 归类用的目录（D:\100 SoftWare\110 BasicSoftware、…\140 AISoftware\Voice）：名字不是软件名。 */
const CATEGORY_DIR = /^(?:\d{2,}\s.*|agent|analysis|design|fandai|photo|pojia|translator|video|voice|basicsoftware|enhacesoftware|worksoftware|aisoftware|small tool|work tools)$/i

/**
 * 从扫描根往下找"这个 exe 属于哪个软件目录"：跳过开头两层分类目录和 bin/Application 这类通用层。
 * 同一个软件目录下的所有 exe 会得到同一个返回值，用来做"一个软件一条"。
 */
function appRootOf(dir, root) {
  const rel = relative(root, dir)
  if (!rel || rel.startsWith('..')) return dir
  const parts = rel.split(sep).filter(Boolean)
  let i = 0
  while (i < parts.length - 1 && CATEGORY_DIR.test(parts[i])) i += 1
  while (i < parts.length) {
    const part = parts[i]
    if (GENERIC_DIR.test(part) || /^\d+(\.\d+){1,3}$/.test(part)) {
      i += 1
      continue
    }
    break
  }
  if (i >= parts.length) return dir
  return join(root, ...parts.slice(0, i + 1))
}

/** 目录名里的版本号、平台尾巴去掉，当软件名用。 */
function cleanFolderName(name) {
  let text = String(name || '')
  for (let i = 0; i < 2; i += 1) {
    text = text.replace(/[-_ ](win|windows|portable|x64|x86|amd64|64|32)$/i, '')
    text = text.replace(/[-_ ]v?\d+(\.\d+){1,4}[a-z0-9.\-_]*/gi, '')
  }
  return tidyName(text)
}

const NAME_NOISE = /^(win|windows|win64|win32|x64|x86|amd64|64|32|portable|prerel|preview|pre|beta|dev|src|with|gitpython|zh|hans|cht|cn|en|setup|installer|console|gui|app|for|the|cpu|gpu|mem|ram|ai)$/i

/** 把文件夹名收拾成软件名：中英混排时只留英文主体，去掉版本/平台/用途注释词。 */
export function polishName(folderName) {
  const raw = String(folderName || '').trim()
  if (!raw) return ''
  let text = cleanFolderName(raw)
  const hasCjk = /[\u4e00-\u9fa5]/.test(text)
  const latin = text.replace(/[\u4e00-\u9fa5]+/g, ' ').match(/[A-Za-z][A-Za-z0-9]{2,}/g) || []
  if (hasCjk && latin.length) text = text.replace(/[\u4e00-\u9fa5]+/g, ' ')
  const tokens = text
    .split(/[\s_\-.]+/)
    .filter((tok, i) => tok && !NAME_NOISE.test(tok) && (i === 0 ? /^\d{1,2}$/.test(tok) || tok.length > 1 : !/^\d+$/.test(tok) && tok.length > 1))
  let out = tokens.join(' ').replace(/\s+/g, ' ').trim()
  if (out.length < 3) out = tidyName(raw)
  return out.length > 34 ? out.slice(0, 34).trim() : out
}

export function displayName(file) {
  const stem = basename(file, extname(file))
  const dir = dirname(file)
  if (GENERIC_STEM.test(stem)) {
    const folder = meaningfulFolder(dir)
    if (folder) return tidyName(folder)
  }
  // obs64.exe / yt-dlp_x86.exe：带位数后缀的，如果所在目录名跟它同源，就用目录名（obs-studio）
  const arch = /[-_ ]?(x64|x86_64|x86|arm64|64|32)$/i.exec(stem)
  if (arch) {
    const base = stem.slice(0, arch.index)
    const folder = meaningfulFolder(dir)
    if (base.length >= 2 && folder) {
      const a = norm(base)
      const b = norm(folder)
      if (a && b && (b.includes(a) || a.includes(b))) return tidyName(folder)
    }
  }
  return tidyName(stem)
}

function scanDirectoryRoots(settings) {
  const apps = []
  const budget = { left: 60000 }
  for (const root of settings.roots || []) {
    if (!root || !existsSync(root)) continue
    const exes = []
    walkDir(root, Math.max(1, Math.min(8, Number(settings.scanDepth) || 5)), exes, budget)
    // 按"软件目录"归并：一个安装目录只出一条，名字用目录名，其他 exe 名降为别名
    const byRoot = new Map()
    for (const file of exes) {
      const key = appRootOf(dirname(file), root)
      if (!byRoot.has(key)) byRoot.set(key, [])
      byRoot.get(key).push(file)
    }
    for (const [folder, list] of byRoot) {
      const main = pickMainExe(list, folder)
      if (!main) continue
      const folderName = basename(folder)
      // exe 直接躺在分类目录里（vs_BuildTools.exe 在 120 EnhaceSoftware 下）：分类名不是软件名
      const folderOk = folderName && !CATEGORY_DIR.test(folderName) && !GENERIC_DIR.test(folderName) && !/^\d+(\.\d+){1,3}$/.test(folderName)
      const appName = (folderOk && polishName(folderName)) || polishName(displayName(main)) || displayName(main)
      if (!appName) continue
      const aliases = []
      const seen = new Set([norm(appName)])
      for (const file of list) {
        if (file === main) continue
        if (NOISE_EXE.test(basename(file))) continue
        const stem = tidyName(basename(file, extname(file)))
        const key = norm(stem)
        if (!stem || stem.length < 3 || seen.has(key) || GENERIC_STEM.test(stem)) continue
        seen.add(key)
        aliases.push(stem)
        if (aliases.length >= 6) break
      }
      apps.push({
        id: 'dir:' + main.toLowerCase(),
        name: appName,
        path: main,
        kind: 'exe',
        desc: '',
        aliases,
        keywords: [],
        source: 'dir',
        enabled: true,
        uses: 0,
        addedAt: Date.now(),
        missing: false,
      })
    }
  }
  return apps
}

function startMenuRoots() {
  const roots = []
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  if (process.env.ProgramData) roots.push(join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  return roots.filter((root) => existsSync(root))
}

const NOISE_LNK = /(卸载|uninstall|帮助|说明|readme|help|manual|changelog|release notes|发行说明|更新日志|检查更新|updater|官网|官方网站|主页|homepage|文档|documentation|修复|repair|注册|购买|升级)/i

/** 许可、网页、示例这类快捷方式不是"软件"，扫描时直接丢。 */
const DOC_LNK = /\.(txt|md|url|html?|chm|lgpl|pdf|ini)$/i
const BORING_LNK = /^(home page|web forum|licen[cs]e.*|samples? for .*|tools for .*|install additional tools.*|release notes|read ?me|产品管理中心|配置工具)$/i
/** VS 的六个命令行快捷方式归成同一个软件。 */
const VS_PROMPT_LNK = /(command prompt|powershell)/i

function walkLinks(root, depth, out, budget) {
  if (depth < 0 || budget.left <= 0) return
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (budget.left-- <= 0) return
    const full = join(root, entry.name)
    if (entry.isDirectory()) walkLinks(full, depth - 1, out, budget)
    else if (entry.isFile() && /\.lnk$/i.test(entry.name)) out.push(full)
  }
}

/** 从 .lnk 里读出快捷方式指向的真实目标（LinkInfo 里的 LocalBasePath），读不出返回空串。 */
export function readLnkTarget(file) {
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    return ''
  }
  if (buf.length < 0x4c || buf.readUInt32LE(0) !== 0x4c) return ''
  const flags = buf.readUInt32LE(0x14)
  let offset = 0x4c
  if (flags & 0x1) {
    if (offset + 2 > buf.length) return ''
    offset += 2 + buf.readUInt16LE(offset)
  }
  if (!(flags & 0x2) || offset + 0x1c > buf.length) return ''
  const base = offset
  // LinkInfo 里的路径是系统 ANSI 代码页（中文 Windows 即 GBK），按 latin1 读会变成乱码
  const decode = (bytes) => {
    try {
      const text = new TextDecoder('gbk').decode(bytes)
      if (text && !text.includes('\uFFFD')) return text
    } catch {}
    return Buffer.from(bytes).toString('latin1')
  }
  const readStr = (at) => {
    if (!at) return ''
    const start = base + at
    if (start <= 0 || start >= buf.length) return ''
    let end = start
    while (end < buf.length && buf[end] !== 0) end += 1
    return decode(buf.subarray(start, end))
  }
  const localBase = readStr(buf.readUInt32LE(base + 0x10))
  const suffix = readStr(buf.readUInt32LE(base + 0x18))
  if (!localBase) return ''
  if (!suffix) return localBase
  return join(localBase, suffix)
}

/** 开始菜单快捷方式与目录里扫到的本体合并成一条：名字优先用中文，另一个留作别名。 */
export function mergeLinkDuplicates(dirApps, lnkApps) {
  const byPath = new Map()
  for (const app of dirApps) byPath.set(app.path.toLowerCase(), app)
  // 只允许"有意义的安装目录"参与按目录归并；直接躺在分类目录里的 exe 不参与
  const byDir = dirApps
    .filter((app) => {
      const base = basename(dirname(app.path))
      return base && !CATEGORY_DIR.test(base) && !GENERIC_DIR.test(base) && !/^\d+(\.\d+)*$/.test(base)
    })
    .sort((a, b) => b.path.length - a.path.length)
  const retired = new Set()
  const kept = []
  for (const lnk of lnkApps) {
    const target = String(lnk.target || '').toLowerCase()
    let twin = target ? byPath.get(target) : null
    // 快捷方式指向的是同一安装目录里的另一个 exe（网盘、火绒这类启动器）也算同一个软件
    if (!twin && target) {
      twin = byDir.find((app) => target.startsWith(dirname(app.path).toLowerCase() + '\\')) || null
    }
    if (!twin) {
      kept.push(lnk)
      continue
    }
    const aliases = new Set([...(twin.aliases || []), lnk.name, tidyName(basename(twin.path, extname(twin.path)))])
    // 名字以目录为准（用户要求：exe 的父文件夹名才是软件名），快捷方式的中文名只当别名
    aliases.delete(twin.name)
    twin.aliases = [...aliases].filter(Boolean)
    retired.add(lnk.path.toLowerCase())
  }
  return { apps: [...dirApps, ...kept], retired }
}

function scanStartMenu() {
  const apps = []
  const budget = { left: 20000 }
  const links = []
  for (const root of startMenuRoots()) walkLinks(root, 6, links, budget)
  const seen = new Set()
  for (const link of links) {
    const rawName = tidyName(basename(link, extname(link)).replace(/\s*[-—]\s*(快捷方式|Shortcut)$/i, ''))
    if (!rawName || NOISE_LNK.test(rawName)) continue
    if (DOC_LNK.test(rawName) || BORING_LNK.test(rawName)) continue
    // 「Developer Command Prompt for VS 2022」这类归成一条 Visual Studio 2022
    const name = /vs 2022$/i.test(rawName) && VS_PROMPT_LNK.test(rawName) ? 'Visual Studio 2022' : rawName
    const key = norm(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    apps.push({
      id: 'lnk:' + link.toLowerCase(),
      name,
      path: link,
      target: readLnkTarget(link),
      kind: 'lnk',
      desc: '',
      aliases: name === rawName ? [] : [rawName],
      keywords: [],
      source: 'startmenu',
      enabled: true,
      uses: 0,
      addedAt: Date.now(),
      missing: false,
    })
  }
  return apps
}

/** 名字一样的条目合成一条：优先留目录里的本体，其余名字并入别名。 */
export function mergeSameName(apps) {
  const out = []
  const byName = new Map()
  const retired = new Set()
  for (const app of apps) {
    const key = norm(app.name)
    const first = key ? byName.get(key) : null
    if (!first) {
      if (key) byName.set(key, app)
      out.push(app)
      continue
    }
    const preferNew = first.source !== 'dir' && app.source === 'dir'
    const keeper = preferNew ? app : first
    const other = preferNew ? first : app
    const aliases = new Set([...(keeper.aliases || []), other.name, ...(other.aliases || [])])
    aliases.delete(keeper.name)
    keeper.aliases = [...aliases].filter(Boolean)
    if (preferNew) out[out.indexOf(first)] = keeper
    retired.add(String(other.path).toLowerCase())
  }

  // 第二遍：A 的名字是 B 的前缀、且多出来的部分含中文注释（"hitomi downloader GUI 批量下载…"）→ 合成一条
  const finalList = []
  for (const app of out) {
    const key = norm(app.name)
    let host = null
    for (const kept of finalList) {
      const mk = norm(kept.name)
      if (!mk || !key) continue
      if (mk === key) {
        host = kept
        break
      }
      const short = mk.length <= key.length ? mk : key
      const long = mk.length <= key.length ? key : mk
      if (long.startsWith(short) && /[\u4e00-\u9fa5]/.test(long.slice(short.length))) {
        host = kept
        break
      }
    }
    if (!host) {
      finalList.push(app)
      continue
    }
    const hostShort = norm(host.name).length <= norm(app.name).length
    const keeper = hostShort ? host : app
    const other = hostShort ? app : host
    const aliases = new Set([...(keeper.aliases || []), host.name, app.name, ...(host.aliases || []), ...(app.aliases || [])])
    aliases.delete(keeper.name)
    keeper.aliases = [...aliases].filter(Boolean)
    if (!hostShort) {
      const idx = finalList.indexOf(host)
      if (idx >= 0) finalList[idx] = keeper
    }
    retired.add(String(other.path).toLowerCase())
  }
  return { apps: finalList, retired }
}

/**
 * 本地用途词典：把"这个软件是干什么的"先写死在本地，离线也能按用途找到。
 * 名字命中就补一句描述 + 几个关键词，用户自己写过的描述不会被覆盖。
 */
const LOCAL_HINTS = [
  [/剪映|jianying/i, '剪视频 剪辑 短视频 字幕', '视频剪辑（剪映）', ['剪映', '剪映专业版', 'JianyingPro']],
  [/capcut/i, '剪视频 剪辑 短视频', '视频剪辑（CapCut）', ['CapCut']],
  [/premiere/i, '剪视频 剪辑 专业剪辑', '专业视频剪辑', ['PR']],
  [/达芬奇|davinci/i, '剪视频 调色 专业剪辑', '视频剪辑与调色', ['达芬奇']],
  [/obs[-_ ]?studio|obs64|obs32/i, '录屏 直播 推流 录制', '录屏与直播推流', ['OBS Studio']],
  [/bandicam|fraps|captura|screentogif|snipaste|pixpin|sharex/i, '截图 录屏 截屏 动图', '截图 / 录屏 / 动图'],
  [/7-?zip|winrar|bandizip|peazip|好压|360压缩/i, '解压 压缩 打包 zip rar', '压缩包解压与打包', ['7z', '7-Zip']],
  [/everything|listary|utools|anytxt/i, '搜索 找文件 快速搜索', '本地文件快速搜索'],
  [/chrome|edge|firefox|brave/i, '浏览器 上网 网页', '网页浏览器', ['谷歌浏览器']],
  [/vscode|visual studio code|cursor|pycharm|idea|webstorm|goland|clion|sublime|notepad\+\+/i, '写代码 编辑器 编程 IDE', '代码编辑器 / IDE', ['VS Code']],
  [/wps|office|word|excel|powerpoint/i, '文档 表格 幻灯片 office', '办公文档', ['WPS']],
  [/wechat|微信/i, '聊天 微信 通讯', '微信', ['微信']],
  [/qqex|\\qq\\|腾讯qq/i, '聊天 通讯 QQ', 'QQ', ['QQ']],
  [/telegram/i, '聊天 通讯 telegram', 'Telegram', ['tg', '电报']],
  [/potplayer|vlc|mpv|bilibili|哔哩哔哩/i, '看视频 播放器 影视', '视频播放'],
  [/foobar|musicbee|网易云|酷狗/i, '听歌 音乐 播放器', '音乐播放'],
  [/clash|v2ray|nekoray|mihomo|nyanpasu/i, '代理 翻墙 网络 加速', '代理 / 网络工具', ['梯子']],
  [/迅雷|idm|motrix|aria2|pikpak|res-downloader|hitomi|downloader|下载/i, '下载 下载器 离线下载', '下载工具'],
  [/photoshop|figma|illustrator|canva|美图|paint/i, '修图 画图 设计 图片', '图片处理 / 设计', ['PS']],
  [/火绒|360安全|defender|杀毒|huorong/i, '杀毒 安全 防护', '安全防护'],
  [/todesk|向日葵|rustdesk|anydesk|teamviewer/i, '远程控制 远程桌面 远控', '远程桌面'],
  [/docker|podman/i, '容器 虚拟化 开发', '容器工具'],
  [/github desktop|sourcetree|git-|\\git\\/i, 'git 版本控制 代码仓库', 'Git 工具'],
  [/python|node\\|java|golang/i, '编程 运行环境 开发', '开发运行时'],
  [/steam|epic|wegame/i, '游戏 启动器', '游戏平台'],
  [/钉钉|飞书|企业微信|slack|discord/i, '办公沟通 团队 聊天', '办公沟通'],
  [/百度网盘|阿里云盘|夸克|onedrive|坚果云|clouddrive|quark/i, '网盘 云盘 同步 存储', '网盘 / 同步'],
  [/calibre|readest|sumatra|adobe reader|pdf/i, '看书 阅读 电子书 pdf', '阅读 / 电子书'],
  [/translate|翻译|deepl/i, '翻译 词典', '翻译工具'],
  [/notepad|记事本|typora|obsidian|onenote/i, '记事 笔记 写作', '笔记 / 写作'],
  [/honeyview|看图|imageglass/i, '看图 图片 浏览', '图片查看'],
  [/clouddrive|alist/i, '网盘 挂载 云盘', '网盘挂载'],
]

/** 这些是命令行小工具：名字就是全部信息，别拿它们所在的目录去套用途。 */
const TECH_STEM = /^(ffmpeg|ffplay|ffprobe|python|python3|node|java|git|curl|wget|adb|scrcpy|7za|7zg|unrar|tar|sqlite3|openssl)/i

/** 命中本地词典就补描述、关键词、别名；用户自己写过的描述不覆盖。 */
export function applyLocalHints(app) {
  const hay = TECH_STEM.test(app.name) ? app.name : app.name + ' ' + app.path
  for (const [pattern, keys, desc, aliases] of LOCAL_HINTS) {
    if (!pattern.test(hay)) continue
    if (!app.desc) {
      app.desc = desc
      app.descSource = 'local'
    }
    if (!app.keywords || app.keywords.length === 0) app.keywords = keys.split(' ')
    if (aliases && aliases.length > 0) {
      const merged = new Set([...(app.aliases || []), ...aliases])
      app.aliases = [...merged]
    }
    break
  }
  return app
}

/** 合并扫描结果：已有条目（含用户改过的）一律不覆盖，只补新增、标失联。 */
export function mergeScanned(store, scanned, retired = new Set()) {
  if (retired.size > 0) {
    store.apps = store.apps.filter((app) => !retired.has(String(app.path).toLowerCase()))
  }
  const byPath = new Map(store.apps.map((app) => [String(app.path).toLowerCase(), app]))
  const byName = new Map()
  for (const app of store.apps) {
    for (const label of [app.name, ...(app.aliases || [])]) {
      const key = norm(label)
      if (key && !byName.has(key)) byName.set(key, app)
    }
  }
  const seenPaths = new Set()
  let added = 0
  for (const item of scanned) {
    const pathKey = item.path.toLowerCase()
    const existing = byPath.get(pathKey)
    if (existing) {
      existing.missing = false
      existing.lastSeen = Date.now()
      // 自动条目跟着新规则改名（用户写过描述的条目保持原样，免得冲掉手工内容）
      if (existing.descSource !== 'user') {
        const aliases = new Set([...(item.aliases || []), ...(existing.aliases || [])])
        aliases.delete(item.name)
        existing.name = item.name
        existing.aliases = [...aliases].filter(Boolean)
        existing.keywords = [...new Set([...(item.keywords || []), ...(existing.keywords || [])])]
      }
      applyLocalHints(existing)
      seenPaths.add(pathKey)
      continue
    }
    // 同名但路径不同：多半是同一个软件的另一份入口，不重复加。
    const sameName = byName.get(norm(item.name))
    if (sameName) {
      sameName.missing = false
      continue
    }
    const record = { ...item, id: item.id || randomUUID() }
    applyLocalHints(record)
    store.apps.push(record)
    byPath.set(pathKey, record)
    for (const label of [record.name, ...(record.aliases || [])]) {
      const key = norm(label)
      if (key && !byName.has(key)) byName.set(key, record)
    }
    seenPaths.add(pathKey)
    added += 1
  }
  // 这次没扫到的自动条目：用户动过的留着（没文件就标失联），没人动过的直接清掉
  let pruned = 0
  store.apps = store.apps.filter((app) => {
    if (app.source === 'manual') return true
    const pathKey = String(app.path).toLowerCase()
    if (seenPaths.has(pathKey)) return true
    const touched = app.descSource === 'user' || (Number(app.uses) || 0) > 0 || app.fav === true
    if (touched) {
      app.missing = !existsSync(app.path)
      return true
    }
    pruned += 1
    return false
  })
  return { added, pruned }
}

export function runScan() {
  const store = loadStore()
  const settings = store.settings
  const started = Date.now()
  const dirApps = scanDirectoryRoots(settings)
  const lnkApps = settings.includeStartMenu ? scanStartMenu() : []
  const merged = mergeLinkDuplicates(dirApps, lnkApps)
  const same = mergeSameName(merged.apps)
  const scanned = same.apps
  const retired = new Set([...merged.retired, ...same.retired])
  const { added, pruned } = mergeScanned(store, scanned, retired)
  store.lastScan = { at: Date.now(), ms: Date.now() - started, scanned: scanned.length, added, pruned }
  saveStore()
  return { ok: true, added, pruned, scanned: scanned.length, total: store.apps.length, ms: store.lastScan.ms }
}

/* ------------------------------------------------------------------ *
 * 匹配与启动
 * ------------------------------------------------------------------ */

export function scoreApp(app, query, history) {
  const q = norm(query)
  if (!q) return 0
  let best = 0
  const fields = [app.name, ...(app.aliases || []), ...(app.keywords || [])]
  for (const field of fields) {
    const value = norm(field)
    if (!value) continue
    if (value === q) best = Math.max(best, 1000)
    else if (value.startsWith(q)) best = Math.max(best, 860 - Math.min(160, value.length - q.length))
    else if (value.includes(q)) best = Math.max(best, 700 - Math.min(160, value.length - q.length))
    else if (q.length >= 2 && q.includes(value) && value.length >= 2) best = Math.max(best, 520)
  }
  const desc = norm(app.desc)
  if (desc && q.length >= 2 && desc.includes(q)) best = Math.max(best, 380)
  // 这个说法以前就是它：直接顶到最前
  if (history && history[q] === app.id) best = Math.max(best, 990)
  if (app.uses > 0) best += Math.min(30, app.uses * 3)
  return best
}

export function searchApps(query, limit = 6) {
  const store = loadStore()
  const rows = []
  for (const app of store.apps) {
    if (app.enabled === false) continue
    const score = scoreApp(app, query, store.history)
    if (score > 0) rows.push({ app, score })
  }
  rows.sort((a, b) => b.score - a.score
    || (b.app.fav === true ? 1 : 0) - (a.app.fav === true ? 1 : 0)
    || (b.app.uses || 0) - (a.app.uses || 0))
  return rows.slice(0, limit).map(({ app, score }) => ({
    id: app.id,
    name: app.name,
    desc: app.desc || '',
    path: app.openPath || app.path,
    openPath: app.openPath || '',
    source: app.source,
    missing: Boolean(app.missing),
    fav: app.fav === true,
    uses: app.uses || 0,
    score,
  }))
}

export function launchApp(app) {
  if (!app) return { ok: false, error: '没有这个软件' }
  const target = app.openPath || app.path
  if (!target || !existsSync(target)) {
    if (!app.openPath) {
      app.missing = true
      saveStore()
    }
    return {
      ok: false,
      error: '路径不存在：' + (target || '(空)') + (app.openPath ? '。这是你填的启动目标。' : '。软件可能被移动或卸载了。'),
    }
  }
  const started = launchTarget(target)
  if (!started.ok) return started
  app.uses = (app.uses || 0) + 1
  app.lastUsedAt = Date.now()
  saveStore()
  return { ok: true, id: app.id, name: app.name }
}

/** 打开某个路径：exe 直接起进程，其余交给 shell（快捷方式、脚本、文档、文件夹都走这条）。 */
export function launchTarget(target) {
  if (!target) return { ok: false, error: '没有填启动目标' }
  if (!existsSync(target)) return { ok: false, error: '路径不存在：' + target }
  try {
    if (/\.exe$/i.test(target)) {
      spawn(target, [], { cwd: dirname(target), detached: true, stdio: 'ignore', windowsHide: false }).unref()
    } else {
      spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${target}"`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true,
      }).unref()
    }
  } catch (error) {
    return { ok: false, error: '启动失败：' + String(error && error.message ? error.message : error) }
  }
  return { ok: true }
}

export function rememberQuery(query, appId) {
  const store = loadStore()
  const key = norm(query)
  if (!key) return
  store.history[key] = appId
  const keys = Object.keys(store.history)
  if (keys.length > 500) delete store.history[keys[0]]
  saveStore()
}

export function publicApp(app) {
  return {
    id: app.id,
    name: app.name,
    desc: app.desc || '',
    descSource: app.descSource || '',
    path: app.path,
    openPath: app.openPath || '',
    kind: app.kind,
    source: app.source,
    enabled: app.enabled !== false,
    missing: Boolean(app.missing),
    fav: app.fav === true,
    favAt: Number(app.favAt) || 0,
    aliases: app.aliases || [],
    keywords: app.keywords || [],
    uses: app.uses || 0,
  }
}
