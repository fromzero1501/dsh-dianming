/**
 * Client half of dsh-dianming（点名）.
 *
 * 右下角一颗常驻圆钮，点开是一张弹层小卡片：输入一句话，
 * 回车打开最像的那个软件；匹配到多个就列出来让你点。全程不新建对话、不写聊天记录。
 *
 * 数据全部走 Host 的 /dianming-api：列表、扫描、设置都在那里，这里只管画和点。
 * 用 Shadow DOM 隔离样式，避免和宿主页面互相污染。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dianming',
  factory: () => {
    const module = { exports: {} }
    const API = '/dianming-api'
    const HOST_ID = 'dsh-dianming-root'

    /** 页面里已经挂过一份就不再挂第二份（热重载会重复 apply）。 */
    function alreadyMounted() {
      return document.getElementById(HOST_ID) !== null
    }

    async function api(path, options) {
      const response = await fetch(API + path, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      })
      const data = await response.json().catch(() => ({ ok: false, error: '返回的不是 JSON' }))
      if (!response.ok && data && data.error === undefined) data.error = 'HTTP ' + response.status
      return data
    }

    const CSS = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
      .fab {
        position: fixed; z-index: 2147483000; width: 52px; height: 52px; border-radius: 50%;
        border: 1px solid rgba(99, 102, 241, .35);
        background: linear-gradient(145deg, #6366f1, #4f46e5);
        color: #fff; font-size: 17px; font-weight: 600; letter-spacing: 1px;
        cursor: pointer; box-shadow: 0 6px 20px rgba(79, 70, 229, .38);
        display: flex; align-items: center; justify-content: center;
        transition: transform .15s ease, box-shadow .15s ease;
        user-select: none;
      }
      .fab:hover { transform: translateY(-1px) scale(1.03); box-shadow: 0 10px 26px rgba(79, 70, 229, .45); }
      .fab:active { transform: scale(.96); }
      .card {
        position: fixed; z-index: 2147483001; width: 420px; max-height: 66vh;
        display: flex; flex-direction: column;
        background: var(--dsh-surface, #ffffff); color: var(--dsh-text, #1f2937);
        border: 1px solid rgba(0,0,0,.10); border-radius: 14px;
        box-shadow: 0 18px 48px rgba(15, 23, 42, .22);
        overflow: hidden;
      }
      .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px; }
      .title { font-size: 13px; font-weight: 600; opacity: .9; }
      .hint { font-size: 11px; opacity: .5; flex: 1; }
      .iconbtn {
        border: 0; background: transparent; color: inherit; opacity: .55; cursor: pointer;
        font-size: 15px; line-height: 1; padding: 4px 6px; border-radius: 6px;
      }
      .iconbtn:hover { opacity: 1; background: rgba(127,127,127,.14); }
      .row { display: flex; gap: 6px; padding: 0 12px 8px; }
      input[type=text] {
        flex: 1; min-width: 0; padding: 9px 11px; font-size: 14px;
        border: 1px solid rgba(127,127,127,.35); border-radius: 9px;
        background: rgba(127,127,127,.06); color: inherit; outline: none;
      }
      input[type=text]:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,.16); }
      .list { overflow-y: auto; padding: 2px 8px 6px; flex: 1; }
      .item {
        display: flex; align-items: center; gap: 9px; padding: 8px 9px; border-radius: 9px;
        cursor: pointer; border: 1px solid transparent;
      }
      .item .dot { width: 6px; height: 6px; border-radius: 50%; background: #6366f1; opacity: .55; flex: none; }
      .item .body { min-width: 0; flex: 1; }
      .item .name { font-size: 13.5px; font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .item .cpath {
        font-size: 10.5px; opacity: .42; margin-top: 2px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums;
      }
      .item .sub { font-size: 11px; opacity: .52; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
      .item.sel { background: rgba(99,102,241,.12); border-color: rgba(99,102,241,.35); }
      .item.miss .name { text-decoration: line-through; opacity: .55; }
      .star {
        border: 0; background: transparent; cursor: pointer; flex: none;
        font-size: 14px; line-height: 1; padding: 2px 4px; border-radius: 6px;
        color: inherit; opacity: .34;
      }
      .star:hover { opacity: 1; background: rgba(127,127,127,.14); }
      .star.on { opacity: 1; color: #f59e0b; }
      .empty { padding: 18px 12px; font-size: 12.5px; opacity: .6; text-align: center; line-height: 1.7; }
      .foot { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-top: 1px solid rgba(127,127,127,.18); }
      .status { flex: 1; font-size: 11.5px; opacity: .6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .link { border: 0; background: transparent; color: #6366f1; font-size: 12px; cursor: pointer; padding: 3px 5px; border-radius: 5px; }
      .link:hover { background: rgba(99,102,241,.12); }
      .link.ghost { color: inherit; opacity: .55; }
      .set { padding: 4px 12px 10px; overflow-y: auto; font-size: 12.5px; }
      .set label { display: block; margin: 10px 0 4px; opacity: .7; }
      .set textarea, .set input, .set select {
        width: 100%; padding: 7px 9px; font-size: 12.5px; color: inherit;
        border: 1px solid rgba(127,127,127,.35); border-radius: 8px; background: rgba(127,127,127,.06);
        font-family: inherit; outline: none;
      }
      .set textarea { min-height: 66px; resize: vertical; }
      .set .inline { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
      .set .inline input { width: auto; }
      .panel {
        position: fixed; z-index: 2147483002; left: 50%; top: 50%; transform: translate(-50%, -50%);
        width: min(780px, 94vw); height: min(600px, 88vh); display: flex; flex-direction: column;
        overflow: hidden; background: var(--dsh-surface, #ffffff); color: var(--dsh-text, #1f2937);
        border: 1px solid rgba(0,0,0,.12); border-radius: 14px; box-shadow: 0 24px 60px rgba(15, 23, 42, .32);
      }
      .phead { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid rgba(127,127,127,.18); }
      .phead .ptitle { font-size: 13.5px; font-weight: 600; white-space: nowrap; }
      .phead .pcount { font-size: 11.5px; opacity: .55; white-space: nowrap; }
      .phead input[type=text] { max-width: 220px; }
      .pbar { position: relative; height: 22px; margin: 0 12px; display: none; align-items: center; border-radius: 6px; background: rgba(127,127,127,.16); overflow: hidden; }
      .pbar.on { display: flex; margin-top: 8px; }
      .pfill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: linear-gradient(90deg,#6366f1,#4f46e5); opacity: .35; transition: width .25s ease; }
      .ptext { position: relative; font-size: 11.5px; padding-left: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pbody { flex: 1; overflow-y: auto; padding: 2px 10px 10px; }
      .prow { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-bottom: 1px solid rgba(127,127,127,.12); }
      .prow .pmain { flex: 1; min-width: 0; }
      .prow .pline { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .prow .pname { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: none; max-width: 46%; }
      .prow .pmeta { font-size: 11.5px; opacity: .55; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
      .prow .ppath { font-size: 10.5px; opacity: .4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
      .prow .pedit { display: flex; flex-direction: column; gap: 4px; padding: 6px 0 2px; }
      .prow .ptarget { display: flex; align-items: center; gap: 6px; }
      .prow .ptarget .pinput { flex: 1; min-width: 0; }
      .prow .ptip { font-size: 10.5px; opacity: .45; }
      .prow textarea, .prow input[type=text] {
        width: 100%; padding: 5px 7px; font-size: 12px; color: inherit; font-family: inherit; outline: none;
        border: 1px solid rgba(127,127,127,.3); border-radius: 7px; background: rgba(127,127,127,.06); resize: vertical;
      }
      .prow textarea { min-height: 34px; }
      .prow .pact { display: flex; gap: 6px; align-items: center; }
      .badge { font-size: 10px; padding: 1px 5px; border-radius: 5px; background: rgba(99,102,241,.14); color: #6366f1; white-space: nowrap; }
      .badge.own { background: rgba(16,185,129,.16); color: #059669; }
      .badge.off { background: rgba(127,127,127,.18); color: inherit; opacity: .75; }
      .prow .pside { display: flex; align-items: center; gap: 6px; flex: none; }
      .prow .pside label { font-size: 11px; opacity: .6; display: flex; align-items: center; gap: 3px; }
      .pfoot { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid rgba(127,127,127,.18); }
      .hidden { display: none !important; }
      @media (prefers-color-scheme: dark) {
        .card, .panel { background: #1f2430; color: #e6e8ee; border-color: rgba(255,255,255,.10); }
      }
    `

    function el(tag, className, text) {
      const node = document.createElement(tag)
      if (className) node.className = className
      if (text !== undefined) node.textContent = text
      return node
    }

    /** 候选行右侧的路径：太长就保留盘符开头 + 结尾文件名，完整值放 title。 */
    function shortPath(value) {
      const text = String(value || '')
      if (text.length <= 62) return text
      return text.slice(0, 18) + '…' + text.slice(-42)
    }

    function apply() {
      if (alreadyMounted()) return () => {}

      const host = document.createElement('div')
      host.id = HOST_ID
      const shadow = host.attachShadow({ mode: 'open' })
      const style = document.createElement('style')
      style.textContent = CSS
      shadow.append(style)

      const fab = el('button', 'fab', '点')
      fab.title = '点名：说一句就打开软件'
      shadow.append(fab)

      const card = el('div', 'card hidden')
      card.innerHTML = ''
      shadow.append(card)

      // 头部
      const head = el('div', 'head')
      const title = el('span', 'title', '点名')
      const hint = el('span', 'hint', '说个描述，回车打开')
      const closeBtn = el('button', 'iconbtn', '×')
      closeBtn.title = '关闭（Esc）'
      head.append(title, hint, closeBtn)

      // 输入行
      const row = el('div', 'row')
      const input = document.createElement('input')
      input.type = 'text'
      input.placeholder = '例如：剪视频 / 解压 / 录屏 / 下载器'
      row.append(input)

      // 列表
      const list = el('div', 'list')

      // 脚
      const foot = el('div', 'foot')
      const status = el('span', 'status', '')
      const aiBtn = el('button', 'link hidden', 'AI 猜一下')
      const favBtn = el('button', 'link ghost', '收藏')
      const listBtn = el('button', 'link ghost', '清单')
      const scanBtn = el('button', 'link ghost', '扫描')
      const setBtn = el('button', 'link ghost', '设置')
      foot.append(status, aiBtn, favBtn, listBtn, scanBtn, setBtn)

      // 设置面板
      const settingsBox = el('div', 'set hidden')

      // 清单面板（大浮层，不塞进 420px 的卡片里）
      const panel = el('div', 'panel hidden')

      card.append(head, row, list, foot, settingsBox)
      shadow.append(panel)
      document.body.append(host)

      let candidates = []
      let selected = 0
      let lastQuery = ''
      let state = null
      let timer = null
      /** 每次搜索/语义请求自增；只有最新那一次的结果允许上屏。 */
      let reqSeq = 0
      /** 输入法拼字期间不搜索。 */
      let composing = false
      let panelRows = []
      let panelTotal = 0
      let panelQuery = ''
      let panelTimer = null
      let editingId = ''
      /** 候选行节点，切换选中时只改 class，绝不重建 DOM（重建会让 mousedown 落在被换掉的节点上，click 永远不触发）。 */
      let itemNodes = []

      function select(index) {
        selected = index
        itemNodes.forEach((node, i) => node.classList.toggle('sel', i === selected))
        const node = itemNodes[selected]
        if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' })
      }

      function position() {
        const right = Number(state?.settings?.fab?.right ?? 24)
        const bottom = Number(state?.settings?.fab?.bottom ?? 24)
        fab.style.right = right + 'px'
        fab.style.bottom = bottom + 'px'
        card.style.right = right + 'px'
        card.style.bottom = bottom + 62 + 'px'
      }

      function open() {
        card.classList.remove('hidden')
        position()
        input.focus()
        input.select()
        if (candidates.length === 0 && !lastQuery) renderList()
      }

      function close() {
        card.classList.add('hidden')
        settingsBox.classList.add('hidden')
        panel.classList.add('hidden')
        list.classList.remove('hidden')
        row.classList.remove('hidden')
        foot.classList.remove('hidden')
      }

      // ---------- 清单面板：看全量软件 + 写自定义描述 ----------
      let panelBody = null
      let panelCount = null
      let panelTip = null
      let panelMore = null
      let panelBar = null
      let panelFill = null
      let panelBarText = null
      let panelTitle = null
      /** true = 面板只显示收藏的软件。 */
      let panelFav = false
      let enrichTimer = null

      function buildPanel() {
        if (panelBody) return
        const phead = el('div', 'phead')
        panelTitle = el('span', 'ptitle', '软件清单')
        panelCount = el('span', 'pcount', '')
        const psearch = document.createElement('input')
        psearch.type = 'text'
        psearch.placeholder = '搜名字 / 描述 / 路径'
        const rescan = el('button', 'link', '重新扫描')
        const enrichBtn = el('button', 'link', 'AI 补简介')
        enrichBtn.title = '先联网查一遍，再让模型写成一句话'
        const reBtn = el('button', 'link', '重补')
        reBtn.title = '把已经有的简介（除了你自己写的）重新联网补一遍'
        const pclose = el('button', 'iconbtn', '×')
        pclose.title = '关闭（Esc）'
        phead.append(panelTitle, panelCount, psearch, enrichBtn, reBtn, rescan, pclose)

        panelBar = el('div', 'pbar')
        panelFill = el('div', 'pfill')
        panelBarText = el('span', 'ptext', '')
        panelBar.append(panelFill, panelBarText)

        panelBody = el('div', 'pbody')
        const pfoot = el('div', 'pfoot')
        panelMore = el('button', 'link', '加载更多')
        panelTip = el('span', 'status', '')
        pfoot.append(panelMore, panelTip)
        panel.append(phead, panelBar, panelBody, pfoot)

        psearch.addEventListener('input', () => {
          clearTimeout(panelTimer)
          panelTimer = setTimeout(() => {
            panelQuery = psearch.value.trim()
            loadPanel(true)
          }, 200)
        })
        psearch.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closePanel()
          }
        })
        pclose.addEventListener('click', closePanel)
        panelMore.addEventListener('click', () => loadPanel(false))
        const paintEnrich = (state) => {
          const total = Number(state.total) || 0
          const done = Number(state.done) || 0
          const pct = total > 0 ? Math.round((done / total) * 100) : 0
          panelFill.style.width = pct + '%'
          panelBarText.textContent = `已补 ${done} / ${total}（${pct}%）` + (state.current ? ` · 正在：${state.current}` : '')
        }
        const stopEnrichPolling = () => {
          if (enrichTimer) clearInterval(enrichTimer)
          enrichTimer = null
          enrichBtn.disabled = false
          reBtn.textContent = '重补'
          panelBar.classList.remove('on')
        }
        const tickEnrich = async () => {
          const state = await api('/enrich-progress')
          if (state.running) panelBar.classList.add('on')
          paintEnrich(state)
          if (state.running) return
          stopEnrichPolling()
          panelBarText.textContent = state.error
            ? '补简介出错：' + state.error
            : `补简介完成：新写 ${state.filled} 条` + (state.failed ? `，没写成 ${state.failed} 条` : '')
          loadPanel(true)
        }
        const watchEnrich = () => {
          if (enrichTimer) return
          enrichBtn.disabled = true
          reBtn.textContent = '停止'
          panelBar.classList.add('on')
          panelBarText.textContent = '正在补简介…'
          enrichTimer = setInterval(() => { tickEnrich().catch(() => {}) }, 700)
          tickEnrich().catch(() => {})
        }
        const runEnrich = async (force) => {
          if (enrichTimer) return
          try {
            const started = await api('/enrich', { method: 'POST', body: JSON.stringify({ mode: 'ai', force, limit: 400 }) })
            if (!started.total) {
              panelBar.classList.add('on')
              panelBarText.textContent = force ? '没有可重补的条目' : '所有软件都已有简介'
              return
            }
            watchEnrich()
          } catch {
            panelBar.classList.add('on')
            panelBarText.textContent = '补简介失败'
          }
        }
        enrichBtn.addEventListener('click', () => { runEnrich(false).catch(() => {}) })
        reBtn.addEventListener('click', () => {
          if (enrichTimer) {
            api('/enrich-stop', { method: 'POST', body: '{}' }).catch(() => {})
            return
          }
          runEnrich(true).catch(() => {})
        })
        rescan.addEventListener('click', async () => {
          panelTip.textContent = '扫描中…'
          try {
            const result = await api('/scan', { method: 'POST', body: '{}' })
            panelTip.textContent = result.ok ? `扫描完，共 ${result.total} 条` : (result.error || '扫描失败')
          } catch {
            panelTip.textContent = '扫描失败'
          }
          loadPanel(true)
        })
      }

      function openPanel(mode) {
        buildPanel()
        panelFav = mode === 'fav'
        if (panelTitle) panelTitle.textContent = panelFav ? '收藏的软件' : '软件清单'
        card.classList.add('hidden')
        panel.classList.remove('hidden')
        loadPanel(true)
        if (!panelFav) resumeEnrich()
      }

      function resumeEnrich() {
        if (!panelBar) return
        api('/enrich-progress').then((state) => {
          if (state.running) {
            panelBar.classList.add('on')
            if (!enrichTimer) {
              enrichBtn.disabled = true
              reBtn.textContent = '停止'
              enrichTimer = setInterval(() => {
                api('/enrich-progress').then((next) => {
                  panelFill.style.width = (next.total > 0 ? Math.round((next.done / next.total) * 100) : 0) + '%'
                  panelBarText.textContent = `已补 ${next.done} / ${next.total}` + (next.current ? ` · 正在：${next.current}` : '')
                }).catch(() => {})
              }, 700)
            }
          }
        }).catch(() => {})
      }

      function closePanel() {
        panel.classList.add('hidden')
        card.classList.remove('hidden')
        input.focus()
      }

      function renderPanelRows() {
        const top = panelBody.scrollTop
        panelBody.textContent = ''
        if (panelRows.length === 0) {
          const emptyText = panelQuery
            ? '没有匹配的条目。'
            : panelFav
              ? '还没有收藏。在搜索候选或清单里点一下星标就能收藏。'
              : '清单还是空的，先点「重新扫描」。'
          panelBody.append(el('div', 'empty', emptyText))
          panelMore.classList.add('hidden')
          panelBody.scrollTop = 0
          return
        }
        panelRows.forEach((app) => {
          const row = el('div', 'prow')
          const main = el('div', 'pmain')

          const line = el('div', 'pline')
          line.append(el('span', 'pname', app.name))
          line.append(el('span', 'badge', app.source === 'manual' ? '手工' : app.source === 'startmenu' ? '开始菜单' : '扫描'))
          if (app.descSource === 'user') line.append(el('span', 'badge own', '自定义'))
          if (app.openPath && app.openPath !== app.path) line.append(el('span', 'badge own', '自定义启动'))
          if (app.enabled === false) line.append(el('span', 'badge off', '已停用'))
          if (app.missing) line.append(el('span', 'badge off', '失效'))
          const preview = app.desc || (app.aliases && app.aliases.length ? '别名：' + app.aliases.join(' ') : '')
          if (preview) {
            const meta = el('span', 'pmeta', preview)
            meta.title = preview
            line.append(meta)
          }
          main.append(line)

          const shownPath = app.openPath || app.path || ''
          const pathLine = el('div', 'ppath', shownPath)
          pathLine.title = shownPath
          main.append(pathLine)

          if (editingId === app.id) {
            const box = el('div', 'pedit')
            const targetRow = el('div', 'ptarget')
            const targetInput = document.createElement('input')
            targetInput.type = 'text'
            targetInput.className = 'pinput'
            targetInput.placeholder = '启动目标：任何文件或快捷方式，粘贴完整路径'
            targetInput.value = app.openPath || ''
            const testBtn = el('button', 'link ghost', '试开')
            testBtn.title = '按这个路径启动一次，不保存'
            testBtn.addEventListener('click', async () => {
              const value = targetInput.value.trim() || app.path || ''
              panelTip.textContent = '正在试开：' + value
              let result
              try {
                result = await api('/open-target', { method: 'POST', body: JSON.stringify({ path: value }) })
              } catch {
                result = { ok: false, error: '试开失败' }
              }
              panelTip.textContent = result.ok ? '已启动：' + value : result.error || '试开失败'
            })
            const resetBtn = el('button', 'link ghost', '还原')
            resetBtn.title = '清掉自定义目标，回到扫描到的路径'
            resetBtn.addEventListener('click', async () => {
              targetInput.value = ''
              await saveApp(app, { openPath: '' })
            })
            targetRow.append(targetInput, testBtn, resetBtn)
            const tip = el('div', 'ptip', '留空表示用扫描到的路径；路径可从资源管理器 Shift+右键「复制为路径」')
            const desc = document.createElement('textarea')
            desc.className = 'pdesc'
            desc.placeholder = '给它写一句描述（例如：视频剪辑，剪映的民间版）'
            desc.value = app.desc || ''
            const aliases = document.createElement('input')
            aliases.type = 'text'
            aliases.placeholder = '别名（空格分隔，例如：剪视频 剪辑）'
            aliases.value = (app.aliases || []).join(' ')
            const act = el('div', 'pact')
            const ok = el('button', 'link', '保存')
            ok.addEventListener('click', async () => {
              const words = aliases.value.split(/[\s,，]+/).map((word) => word.trim()).filter(Boolean)
              editingId = ''
              await saveApp(app, { desc: desc.value.trim(), aliases: words, openPath: targetInput.value.trim() })
            })
            const cancel = el('button', 'link ghost', '取消')
            cancel.addEventListener('click', () => {
              editingId = ''
              renderPanelRows()
            })
            act.append(ok, cancel)
            box.append(targetRow, tip, desc, aliases, act)
            main.append(box)
          }

          const side = el('div', 'pside')
          const star = el('button', 'star' + (app.fav ? ' on' : ''), app.fav ? '★' : '☆')
          star.title = app.fav ? '取消收藏' : '收藏'
          star.addEventListener('click', () => toggleFavApp(app, star))
          const toggleLabel = document.createElement('label')
          const toggle = document.createElement('input')
          toggle.type = 'checkbox'
          toggle.checked = app.enabled !== false
          toggle.addEventListener('change', () => saveApp(app, { enabled: toggle.checked }))
          toggleLabel.append(toggle, el('span', '', '启用'))

          const edit = el('button', 'link ghost', editingId === app.id ? '收起' : '改')
          edit.addEventListener('click', () => {
            editingId = editingId === app.id ? '' : app.id
            renderPanelRows()
          })

          const del = el('button', 'link ghost', '删除')
          let armed = false
          del.addEventListener('click', () => {
            if (!armed) {
              armed = true
              del.textContent = '确定？'
              setTimeout(() => {
                armed = false
                del.textContent = '删除'
              }, 2500)
              return
            }
            removeApp(app)
          })
          side.append(star, toggleLabel, edit, del)

          row.append(main, side)
          panelBody.append(row)
        })
        panelBody.scrollTop = top
      }

      async function loadPanel(reset) {
        const offset = reset ? 0 : panelRows.length
        panelTip.textContent = reset ? '读取中…' : '加载中…'
        let result
        try {
          const suffix = (panelQuery ? '&q=' + encodeURIComponent(panelQuery) : '') + (panelFav ? '&fav=1' : '')
          result = await api(`/apps?offset=${offset}&limit=100${suffix}`)
        } catch {
          panelTip.textContent = '读不到清单，宿主可能还没起来'
          return
        }
        if (!result.ok) {
          panelTip.textContent = result.error || '读不到清单'
          return
        }
        panelRows = reset ? result.apps : panelRows.concat(result.apps)
        panelTotal = Number(result.total) || 0
        renderPanelRows()
        panelTip.textContent = `显示 ${panelRows.length} / ${panelTotal} 条`
        panelMore.classList.toggle('hidden', panelRows.length >= panelTotal)
        if (result.counts) {
          panelCount.textContent = panelFav
            ? `收藏 ${result.counts.fav} 条`
            : `共 ${result.counts.total} 条 · 启用 ${result.counts.enabled}`
        }
      }

      async function saveApp(app, patch) {
        let result
        try {
          result = await api('/app', { method: 'POST', body: JSON.stringify({ id: app.id, ...patch }) })
        } catch {
          result = { ok: false, error: '保存失败' }
        }
        if (result.ok && result.app) {
          Object.assign(app, result.app)
          panelTip.textContent = '已保存：' + app.name
          renderPanelRows()
        } else {
          panelTip.textContent = result.error || '保存失败'
        }
      }

      /** 清单/收藏面板里点星标。 */
      async function toggleFavApp(app, node) {
        let result
        try {
          result = await api('/app', { method: 'POST', body: JSON.stringify({ id: app.id, fav: !app.fav }) })
        } catch {
          result = { ok: false, error: '收藏失败' }
        }
        if (!result.ok) {
          panelTip.textContent = result.error || '收藏失败'
          return
        }
        if (result.app) Object.assign(app, result.app)
        if (node) {
          node.textContent = app.fav ? '★' : '☆'
          node.classList.toggle('on', app.fav === true)
          node.title = app.fav ? '取消收藏' : '收藏'
        }
        panelTip.textContent = (app.fav ? '已收藏：' : '已取消收藏：') + app.name
        if (panelFav) loadPanel(true)
      }

      /** 搜索候选里点星标（不影响打开）。 */
      async function toggleFavCandidate(item, node) {
        let result
        try {
          result = await api('/app', { method: 'POST', body: JSON.stringify({ id: item.id, fav: !item.fav }) })
        } catch {
          result = { ok: false, error: '收藏失败' }
        }
        if (!result.ok) {
          status.textContent = result.error || '收藏失败'
          return
        }
        item.fav = Boolean(result.app && result.app.fav)
        if (node) {
          node.textContent = item.fav ? '★' : '☆'
          node.classList.toggle('on', item.fav)
          node.title = item.fav ? '取消收藏' : '收藏'
        }
        status.textContent = (item.fav ? '已收藏：' : '已取消收藏：') + item.name
      }

      async function removeApp(app) {
        let result
        try {
          result = await api('/app-delete', { method: 'POST', body: JSON.stringify({ id: app.id }) })
        } catch {
          result = { ok: false, error: '删除失败' }
        }
        if (result.ok) {
          panelRows = panelRows.filter((item) => item.id !== app.id)
          panelTotal = Math.max(0, panelTotal - 1)
          renderPanelRows()
          panelTip.textContent = '已删除：' + app.name
        } else {
          panelTip.textContent = result.error || '删除失败'
        }
      }

      function openSettings() {
        settingsBox.classList.remove('hidden')
        list.classList.add('hidden')
        row.classList.add('hidden')
        foot.classList.add('hidden')
        renderSettings()
      }

      function backFrom() {
        settingsBox.classList.add('hidden')
        list.classList.remove('hidden')
        row.classList.remove('hidden')
        foot.classList.remove('hidden')
        input.focus()
      }

      function renderList(message) {
        list.textContent = ''
        itemNodes = []
        if (message) {
          const empty = el('div', 'empty', message)
          list.append(empty)
          return
        }
        if (candidates.length === 0) {
          const empty = el('div', 'empty', lastQuery ? '本地目录里没有对得上的。' : '输入一个描述，例如「剪视频」「解压」。')
          list.append(empty)
          return
        }
        candidates.forEach((item, index) => {
          const node = el('div', 'item' + (index === selected ? ' sel' : '') + (item.missing ? ' miss' : ''))
          node.append(el('span', 'dot'))
          const body = el('div', 'body')
          body.append(el('div', 'name', item.name))
          const pathText = el('div', 'cpath', shortPath(item.path))
          pathText.title = item.path
          body.append(pathText)
          const sub = item.desc || (item.missing ? '路径已失效，可能被移动或卸载' : '')
          if (sub) body.append(el('div', 'sub', sub))
          node.append(body)
          const star = el('button', 'star' + (item.fav ? ' on' : ''), item.fav ? '★' : '☆')
          star.title = item.fav ? '取消收藏' : '收藏'
          star.addEventListener('pointerdown', (event) => {
            event.preventDefault()
            event.stopPropagation()
          })
          star.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            toggleFavCandidate(item, star)
          })
          node.append(star)
          node.addEventListener('mouseenter', () => {
            if (selected !== index) select(index)
          })
          node.addEventListener('pointerdown', (event) => {
            event.preventDefault()
            event.stopPropagation()
            if (item.missing) {
              status.textContent = item.name + ' 的路径已失效，可能被移动或卸载'
              return
            }
            openCandidate(index)
          })
          itemNodes.push(node)
          list.append(node)
        })
      }

      function renderSettings() {
        settingsBox.textContent = ''
        if (!state) {
          settingsBox.append(el('div', 'empty', '还没读到设置，稍后再点。'))
          return
        }
        const s = state.settings

        settingsBox.append(el('label', '', '扫描这些目录（一行一个）'))
        const roots = document.createElement('textarea')
        roots.value = (s.roots || []).join('\n')
        settingsBox.append(roots)

        const inline = el('div', 'inline')
        const startMenu = document.createElement('input')
        startMenu.type = 'checkbox'
        startMenu.checked = s.includeStartMenu !== false
        const startMenuLabel = el('span', '', '同时扫描开始菜单快捷方式')
        inline.append(startMenu, startMenuLabel)
        settingsBox.append(inline)

        const enrichRow = el('div', 'inline')
        const enrichToggle = document.createElement('input')
        enrichToggle.type = 'checkbox'
        enrichToggle.checked = s.enrich !== false
        enrichRow.append(enrichToggle, el('span', '', '扫描完自动让 AI 补简介'))
        settingsBox.append(enrichRow)

        settingsBox.append(el('label', '', 'AI 兜底'))
        const semantic = document.createElement('select')
        for (const [value, text] of [['manual', '只在我点「AI 猜一下」时用'], ['auto', '本地没结果就自动用'], ['off', '完全不用 AI']]) {
          const option = document.createElement('option')
          option.value = value
          option.textContent = text
          option.selected = (s.semanticMode || 'manual') === value
          semantic.append(option)
        }
        settingsBox.append(semantic)

        settingsBox.append(el('label', '', '模型来源'))
        const llmMode = document.createElement('select')
        for (const [value, text] of [['dsh', '跟随 DSH 当前模型'], ['custom', '自定义接口（OpenAI 兼容）']]) {
          const option = document.createElement('option')
          option.value = value
          option.textContent = text
          option.selected = (s.llm?.mode || 'dsh') === value
          llmMode.append(option)
        }
        settingsBox.append(llmMode)

        const customBox = el('div', (s.llm?.mode === 'custom') ? '' : 'hidden')
        const baseUrl = document.createElement('input')
        baseUrl.type = 'text'
        baseUrl.placeholder = 'https://api.example.com/v1'
        baseUrl.value = s.llm?.baseUrl || ''
        const model = document.createElement('input')
        model.type = 'text'
        model.placeholder = '模型名，例如 gpt-4o-mini'
        model.value = s.llm?.model || ''
        const apiKey = document.createElement('input')
        apiKey.type = 'password'
        apiKey.placeholder = s.llm?.apiKey ? '密钥已保存，不填就是不改' : 'API Key'
        customBox.append(baseUrl, model, apiKey)
        settingsBox.append(customBox)

        llmMode.addEventListener('change', () => {
          customBox.classList.toggle('hidden', llmMode.value !== 'custom')
        })

        const actions = el('div', 'inline')
        const save = el('button', 'link', '保存')
        const back = el('button', 'link ghost', '返回')
        const rescan = el('button', 'link ghost', '重新扫描')
        actions.append(save, rescan, back)
        settingsBox.append(actions)

        save.addEventListener('click', async () => {
          const patch = {
            roots: roots.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
            includeStartMenu: startMenu.checked,
            enrich: enrichToggle.checked,
            semanticMode: semantic.value,
            llm: {
              mode: llmMode.value,
              baseUrl: baseUrl.value,
              model: model.value,
              ...(apiKey.value ? { apiKey: apiKey.value } : {}),
            },
          }
          const result = await api('/settings', { method: 'POST', body: JSON.stringify({ patch }) })
          if (result.ok) {
            state.settings = result.settings
            status.textContent = '设置已保存'
          } else {
            status.textContent = result.error || '保存失败'
          }
        })

        rescan.addEventListener('click', doScan)
        back.addEventListener('click', backFrom)
      }

      async function loadState() {
        try {
          state = await api('/state')
          position()
        } catch {
          /* 宿主还没起来，下次点开再读 */
        }
      }

      async function doSearch(query) {
        const seq = ++reqSeq
        lastQuery = query
        if (!query) {
          candidates = []
          selected = 0
          aiBtn.classList.add('hidden')
          renderList()
          status.textContent = ''
          return
        }
        let result
        try {
          result = await api('/search', { method: 'POST', body: JSON.stringify({ q: query, limit: 8 }) })
        } catch {
          if (seq === reqSeq) status.textContent = '搜索失败，宿主可能还没起来'
          return
        }
        // 旧请求晚到：一个字都不许上屏
        if (seq !== reqSeq) return
        candidates = Array.isArray(result.candidates) ? result.candidates : []
        selected = 0
        const mode = state?.settings?.semanticMode || 'manual'
        const showAi = candidates.length === 0 && mode !== 'off'
        aiBtn.classList.toggle('hidden', !showAi)
        renderList()
        status.textContent = candidates.length > 0 ? `本地命中 ${candidates.length} 个` : '本地没命中'
        if (candidates.length === 0 && mode === 'auto') {
          // 等输入真的停下来再问模型：避免拼字中途和旧请求把界面冲掉
          setTimeout(() => {
            if (seq === reqSeq && !composing && input.value.trim() === query && candidates.length === 0) askAi()
          }, 400)
        }
      }

      async function askAi() {
        const query = input.value.trim()
        if (!query) return
        const seq = ++reqSeq
        status.textContent = '让 AI 猜一下…'
        aiBtn.classList.add('hidden')
        let result
        try {
          result = await api('/semantic', { method: 'POST', body: JSON.stringify({ q: query }) })
        } catch {
          result = { ok: false, error: 'AI 调用失败' }
        }
        if (seq !== reqSeq) return
        if (result.ok && result.app) {
          candidates = [{ ...result.app, score: 0, desc: (result.app.desc || '') + (result.reason ? `（${result.reason}）` : '') }]
          selected = 0
          renderList()
          status.textContent = 'AI 觉得是它，回车打开'
        } else {
          // 失败只动状态条；已有候选一律保留
          status.textContent = result.error || 'AI 也没猜出来'
          if (candidates.length === 0) renderList('AI 没猜出来。说得再具体一点，或者点「清单」给它写一句描述。')
        }
      }

      async function openCandidate(index) {
        const item = candidates[index]
        if (!item) return
        status.textContent = '正在打开 ' + item.name + ' …'
        const result = await api('/open', { method: 'POST', body: JSON.stringify({ id: item.id, q: input.value.trim() }) })
        if (result.ok) {
          status.textContent = '已打开：' + result.name
          candidates = []
          setTimeout(() => {
            close()
            input.value = ''
            status.textContent = ''
          }, 700)
        } else {
          status.textContent = result.error || '没打开'
        }
      }

      async function doScan() {
        status.textContent = '扫描中…'
        const result = await api('/scan', { method: 'POST', body: '{}' })
        if (result.ok) {
          status.textContent = `扫描完：新增 ${result.added} 条，共 ${result.total} 条`
          await loadState()
        } else {
          status.textContent = result.error || '扫描失败'
        }
      }

      function scheduleSearch() {
        clearTimeout(timer)
        const query = input.value.trim()
        timer = setTimeout(() => {
          if (composing) return
          doSearch(query)
        }, 120)
      }

      input.addEventListener('compositionstart', () => {
        composing = true
      })
      input.addEventListener('compositionend', () => {
        composing = false
        scheduleSearch()
      })
      input.addEventListener('input', () => {
        if (composing) return
        scheduleSearch()
      })

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          if (!panel.classList.contains('hidden')) closePanel()
          else close()
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          if (candidates.length > 0) {
            select((selected + 1) % candidates.length)
          }
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          if (candidates.length > 0) {
            select((selected - 1 + candidates.length) % candidates.length)
          }
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          if (candidates.length > 0) openCandidate(selected)
          else if (input.value.trim()) doSearch(input.value.trim())
        }
      })

      fab.addEventListener('click', () => {
        if (card.classList.contains('hidden')) {
          loadState().then(open)
        } else {
          close()
        }
      })

      closeBtn.addEventListener('click', close)
      aiBtn.addEventListener('click', askAi)
      favBtn.addEventListener('click', () => openPanel('fav'))
      listBtn.addEventListener('click', () => openPanel('list'))
      scanBtn.addEventListener('click', doScan)
      setBtn.addEventListener('click', openSettings)

      // 点卡片/面板外面收起
      document.addEventListener('pointerdown', (event) => {
        const path = event.composedPath()
        if (path.includes(panel) || path.includes(card) || path.includes(fab)) return
        if (!panel.classList.contains('hidden')) closePanel()
        else if (!card.classList.contains('hidden')) close()
      }, true)

      loadState()
      console.debug('[dsh-dianming] 右下角「点」按钮已就位')

      return () => {
        clearTimeout(timer)
        host.remove()
      }
    }

    module.exports.name = 'dianming'
    module.exports.inject = []
    module.exports.apply = apply
    return module.exports
  },
})
