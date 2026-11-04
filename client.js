/**
 * dsh-session-cleanup — Client half.
 *
 * One action in `sidebar.footer.action`, ordered above the Reload page row. It
 * opens a dialog that scans `<DSH_HOME>/sessions` through the Host half, lists
 * the three deletable kinds with a checkbox each (all ticked), and only then
 * posts the ticked paths back for deletion.
 *
 * Nothing here decides what is junk: the Host classifies every directory from
 * its log and re-checks each path at delete time, so the dialog is a preview of
 * the Host's own verdict, not a second opinion.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-cleanup',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const BASE = '/dsh-session-cleanup'
    const NS = 'dsh-session-cleanup'
    // The slot's locale namespace carries only plugin `meta` texts; this
    // plugin's own strings live under a namespace nothing else registers, so a
    // duplicate (namespace, locale) registration cannot shadow them.
    const TEXT_NS = 'dsh-session-cleanup/text'
    const SLOT_ID = 'dsh-session-cleanup'

    const DICT = {
      zh: {
        'action.label': '清理会话',
        'action.hint': '扫描并清理空目录、残留目录与没有用户消息的会话',
        'dialog.title': '清理会话',
        'dialog.scanning': '正在扫描会话目录…',
        'dialog.empty': '没有可清理的内容。会话目录很干净。',
        'dialog.scanError': '扫描失败',
        'dialog.root': '目录',
        'dialog.orphanCache': '同时清理 {n} 条孤立投影缓存记录',
        'dialog.selected': '已选 {n} 项，共 {size}',
        'dialog.cancel': '取消',
        'dialog.delete': '删除所选',
        'dialog.deleting': '正在删除…',
        'dialog.deleteError': '删除失败',
        'dialog.doneTitle': '清理完成',
        'dialog.done': '已删除 {dirs} 个会话目录、{cache} 条缓存记录，释放 {size}。',
        'dialog.nothing': '没有删除任何内容。',
        'dialog.skipped': '跳过 {n} 项（{why}）',
        'dialog.refused': '拒绝 {n} 项：{why}',
        'dialog.reload': '刷新页面',
        'dialog.close': '关闭',
        'cat.empty-dir': '空目录',
        'cat.log-missing': '残留目录（日志已不在，仅剩备份）',
        'cat.no-user-message': '没有用户消息的会话',
        'cat.undecodable': '无法解析（未列入清理）',
        'item.noTitle': '（无标题）',
      },
      en: {
        'action.label': 'Clean up sessions',
        'action.hint': 'Scan and remove empty, orphaned and message-less session directories',
        'dialog.title': 'Clean up sessions',
        'dialog.scanning': 'Scanning session directories…',
        'dialog.empty': 'Nothing to clean up. The session directories are tidy.',
        'dialog.scanError': 'Scan failed',
        'dialog.root': 'Directory',
        'dialog.orphanCache': 'Also remove {n} orphaned projection-cache records',
        'dialog.selected': '{n} selected, {size} total',
        'dialog.cancel': 'Cancel',
        'dialog.delete': 'Delete selected',
        'dialog.deleting': 'Deleting…',
        'dialog.deleteError': 'Delete failed',
        'dialog.doneTitle': 'Cleanup finished',
        'dialog.done': 'Deleted {dirs} session directories and {cache} cache records, freeing {size}.',
        'dialog.nothing': 'Nothing was deleted.',
        'dialog.skipped': '{n} skipped ({why})',
        'dialog.refused': '{n} refused: {why}',
        'dialog.reload': 'Reload page',
        'dialog.close': 'Close',
        'cat.empty-dir': 'Empty directories',
        'cat.log-missing': 'Orphaned directories (log gone, only a backup left)',
        'cat.no-user-message': 'Sessions without user messages',
        'cat.undecodable': 'Unreadable (not offered)',
        'item.noTitle': '(untitled)',
      },
    }

    /**
     * Translate through the registered locale when it resolves a key, and fall
     * back to the bundled table otherwise. A raw key must never reach the
     * footer or the dialog: a plugin whose locale service is missing, late, or
     * already occupied still renders readable text.
     */
    let translate = null
    let activeLocale = 'zh'

    function t(key) {
      if (translate !== null) {
        try {
          const value = translate(key)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        } catch {
          // Fall through to the bundled table.
        }
      }
      const table = DICT[activeLocale] || DICT.zh
      const value = table[key]
      return typeof value === 'string' ? value : DICT.zh[key] || key
    }

    const CATEGORIES = ['empty-dir', 'log-missing', 'no-user-message']

    const fmtSize = (bytes) => {
      const value = Number(bytes) || 0
      if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
      if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${value} B`
    }

    const keyOf = (row) => `${row.workspace}|${row.id}`

    const CSS = `
.dsc-action{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;min-width:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#a8adb7);cursor:pointer;font:inherit;font-size:13px;line-height:20px;white-space:nowrap}
.dsc-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsc-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a8cff);outline-offset:-2px}
.dsc-actionText{overflow:hidden;text-overflow:ellipsis}
.dsc-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);backdrop-filter:blur(1px)}
.dsc-panel{box-sizing:border-box;width:min(560px,calc(100vw - 40px));max-height:min(78vh,680px);display:flex;flex-direction:column;gap:10px;padding:16px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-2,#1b1d21);color:var(--dsw-alias-label-primary,#e6e8eb);box-shadow:0 18px 48px rgba(0,0,0,.45);font-size:13px;line-height:18px}
.dsc-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.dsc-title{font-size:14px;font-weight:600}
.dsc-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b909a);word-break:break-all}
.dsc-groups{display:flex;flex-direction:column;gap:10px;overflow:auto;max-height:min(52vh,440px);padding:2px 0}
.dsc-group{display:flex;flex-direction:column;gap:2px}
.dsc-groupHead{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b909a);padding:2px 0}
.dsc-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer}
.dsc-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsc-rowText{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.dsc-rowTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-rowMeta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b909a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-size{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b909a)}
.dsc-note{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b909a)}
.dsc-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d)}
.dsc-foot{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsc-footRight{display:flex;align-items:center;gap:8px}
.dsc-btn{height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.dsc-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsc-btn[data-primary="true"]{background:var(--dsw-alias-state-business-primary,#4a8cff);border-color:transparent;color:#fff}
.dsc-btn[data-danger="true"]{background:var(--dsw-alias-state-error-primary,#e5484d);border-color:transparent;color:#fff}
.dsc-btn:disabled{opacity:.55;cursor:not-allowed}
`

    function Styles() {
      return h('style', { 'data-dsh-plugin': NS, children: CSS })
    }

    function CleanupIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { display: 'block', flex: 'none' },
        },
        h('path', { d: 'M3 5h10' }),
        h('path', { d: 'M6 5V3.5h4V5' }),
        h('path', { d: 'M5 5l.6 7.4a1 1 0 0 0 1 .9h2.8a1 1 0 0 0 1-.9L11 5' }),
        h('path', { d: 'M6.8 7.5v3.5M9.2 7.5v3.5' }),
      )
    }

    function useScan(open) {
      const [phase, setPhase] = useState('idle')
      const [plan, setPlan] = useState(null)
      const [picked, setPicked] = useState(() => new Set())
      const [withCache, setWithCache] = useState(true)
      const [error, setError] = useState('')
      const [result, setResult] = useState(null)

      useEffect(() => {
        if (!open) return undefined
        let alive = true
        setPhase('loading')
        setError('')
        setResult(null)
        fetch(`${BASE}/scan`, { cache: 'no-store' })
          .then((response) => response.json())
          .then((data) => {
            if (!alive) return
            if (data === null || data.ok !== true) throw new Error((data && data.error) || 'scan failed')
            const offered = (data.rows || []).filter((row) => CATEGORIES.includes(row.category))
            setPlan(data)
            setPicked(new Set(offered.map(keyOf)))
            setWithCache(true)
            setPhase('review')
          })
          .catch((cause) => {
            if (!alive) return
            setError(String((cause && cause.message) || cause))
            setPhase('error')
          })
        return () => {
          alive = false
        }
      }, [open])

      const toggle = useCallback((key) => {
        setPicked((current) => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }, [])

      return { phase, plan, picked, withCache, error, result, toggle, setWithCache, setPhase, setResult, setError }
    }

    function Dialog(props) {
      const { scan, onClose } = props
      const { phase, plan, picked, withCache, error, result } = scan
      const rows = useMemo(() => {
        const groups = new Map()
        for (const row of plan ? plan.rows || [] : []) {
          if (!CATEGORIES.includes(row.category)) continue
          if (!groups.has(row.category)) groups.set(row.category, [])
          groups.get(row.category).push(row)
        }
        return groups
      }, [plan])

      const selectedRows = useMemo(() => {
        const list = []
        for (const group of rows.values()) {
          for (const row of group) if (picked.has(keyOf(row))) list.push(row)
        }
        return list
      }, [rows, picked])

      const selectedBytes = selectedRows.reduce((sum, row) => sum + (row.bytes || 0), 0)

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && phase !== 'deleting') {
            event.preventDefault()
            onClose()
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [phase, onClose])

      const total = Array.from(rows.values()).reduce((sum, group) => sum + group.length, 0)

      const submit = async () => {
        scan.setPhase('deleting')
        scan.setError('')
        try {
          const response = await fetch(`${BASE}/delete`, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessions: selectedRows.map((row) => ({ workspace: row.workspace, id: row.id })),
              cache: withCache && plan ? plan.orphans || [] : [],
            }),
          })
          const data = await response.json()
          if (data === null || data.ok !== true) throw new Error((data && data.error) || 'delete failed')
          scan.setResult(data)
          scan.setPhase('done')
        } catch (cause) {
          scan.setError(String((cause && cause.message) || cause))
          scan.setPhase('error')
        }
      }

      const body = []
      if (phase === 'loading') body.push(h('div', { key: 'load', className: 'dsc-note' }, t('dialog.scanning')))
      if (phase === 'error') {
        body.push(h('div', { key: 'err', className: 'dsc-error' }, `${error}`))
      }
      if (phase === 'review' || phase === 'deleting') {
        if (total === 0) {
          body.push(h('div', { key: 'empty', className: 'dsc-note' }, t('dialog.empty')))
        } else {
          for (const category of CATEGORIES) {
            const group = rows.get(category)
            if (group === undefined || group.length === 0) continue
            body.push(
              h('div', { key: `g-${category}`, className: 'dsc-group' }, [
                h('div', { key: 'head', className: 'dsc-groupHead' }, `${t(`cat.${category}`)} · ${group.length}`),
                ...group.map((row) =>
                  h(
                    'label',
                    { key: keyOf(row), className: 'dsc-row' },
                    h('input', {
                      type: 'checkbox',
                      checked: picked.has(keyOf(row)),
                      disabled: phase === 'deleting',
                      onChange: () => scan.toggle(keyOf(row)),
                    }),
                    h(
                      'span',
                      { className: 'dsc-rowText' },
                      h('span', { className: 'dsc-rowTitle' }, row.title !== '' ? row.title : t('item.noTitle')),
                      h('span', { className: 'dsc-rowMeta' }, row.id),
                    ),
                    h('span', { className: 'dsc-size' }, fmtSize(row.bytes)),
                  ),
                ),
              ]),
            )
          }
          if (plan && (plan.orphans || []).length > 0) {
            body.push(
              h(
                'label',
                { key: 'cache', className: 'dsc-row' },
                h('input', {
                  type: 'checkbox',
                  checked: withCache,
                  disabled: phase === 'deleting',
                  onChange: () => scan.setWithCache(!withCache),
                }),
                h(
                  'span',
                  { className: 'dsc-rowText' },
                  h('span', { className: 'dsc-rowTitle' }, t('dialog.orphanCache').replace('{n}', String(plan.orphans.length))),
                ),
              ),
            )
          }
        }
      }
      if (phase === 'done' && result) {
        const dirs = (result.deleted || []).length
        const cacheCount = result.removedCache || 0
        body.push(
          h('div', { key: 'done', className: 'dsc-group' }, [
            h(
              'div',
              { key: 'sum', className: 'dsc-note' },
              dirs + cacheCount === 0
                ? t('dialog.nothing')
                : t('dialog.done')
                    .replace('{dirs}', String(dirs))
                    .replace('{cache}', String(cacheCount))
                    .replace('{size}', fmtSize(result.freedBytes || 0)),
            ),
            (result.skipped || []).length > 0
              ? h(
                  'div',
                  { key: 'skip', className: 'dsc-note' },
                  t('dialog.skipped')
                    .replace('{n}', String(result.skipped.length))
                    .replace('{why}', result.skipped.map((item) => item.reason).join('；')),
                )
              : null,
            (result.refused || []).length > 0
              ? h(
                  'div',
                  { key: 'refuse', className: 'dsc-note' },
                  t('dialog.refused')
                    .replace('{n}', String(result.refused.length))
                    .replace('{why}', result.refused.map((item) => `${item.id}: ${item.reason}`).join('；')),
                )
              : null,
          ]),
        )
      }

      const footer = []
      if (phase === 'done') {
        footer.push(h('div', { key: 'left' }))
        footer.push(
          h('div', { key: 'right', className: 'dsc-footRight' }, [
            h('button', { key: 'close', type: 'button', className: 'dsc-btn', onClick: onClose }, t('dialog.close')),
            h(
              'button',
              {
                key: 'reload',
                type: 'button',
                className: 'dsc-btn',
                'data-primary': 'true',
                onClick: () => window.location.reload(),
              },
              t('dialog.reload'),
            ),
          ]),
        )
      } else {
        footer.push(
          h(
            'div',
            { key: 'left', className: 'dsc-note' },
            phase === 'deleting' ? t('dialog.deleting') : t('dialog.selected').replace('{n}', String(selectedRows.length)).replace('{size}', fmtSize(selectedBytes)),
          ),
        )
        footer.push(
          h('div', { key: 'right', className: 'dsc-footRight' }, [
            h(
              'button',
              { key: 'cancel', type: 'button', className: 'dsc-btn', disabled: phase === 'deleting', onClick: onClose },
              t('dialog.cancel'),
            ),
            h(
              'button',
              {
                key: 'go',
                type: 'button',
                className: 'dsc-btn',
                'data-danger': 'true',
                disabled: phase !== 'review' || (selectedRows.length === 0 && !(withCache && plan && (plan.orphans || []).length > 0)),
                onClick: () => {
                  submit()
                },
              },
              t('dialog.delete'),
            ),
          ]),
        )
      }

      return h(
        'div',
        {
          className: 'dsc-overlay',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && phase !== 'deleting') onClose()
          },
        },
        h('div', { className: 'dsc-panel', role: 'dialog', 'aria-modal': 'true' }, [
          h('div', { key: 'head', className: 'dsc-head' }, [
            h('div', { key: 'title', className: 'dsc-title' }, phase === 'done' ? t('dialog.doneTitle') : t('dialog.title')),
            plan ? h('div', { key: 'root', className: 'dsc-sub' }, `${t('dialog.root')}: ${plan.root}`) : null,
          ]),
          h('div', { key: 'body', className: 'dsc-groups' }, body),
          h('div', { key: 'foot', className: 'dsc-foot' }, footer),
        ]),
      )
    }

    function CleanupAction(props) {
      const wide = props !== null && props !== undefined && props.wide !== false
      const [open, setOpen] = useState(false)
      const scan = useScan(open)
      const label = t('action.label')
      return h(React.Fragment, null, [
        h(Styles, { key: 'style' }),
        h(
          'button',
          {
            key: 'button',
            type: 'button',
            className: 'dsc-action',
            title: t('action.hint'),
            'aria-label': label,
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              setOpen(true)
            },
          },
          h(CleanupIcon, { key: 'icon' }),
          wide ? h('span', { key: 'text', className: 'dsc-actionText' }, label) : null,
        ),
        open ? h(Dialog, { key: 'dialog', scan, onClose: () => setOpen(false) }) : null,
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale')
        if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          try {
            const snapshot = typeof locale.getLocale === 'function' ? locale.getLocale() : undefined
            const active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : ''
            activeLocale = active.toLowerCase().startsWith('en') ? 'en' : 'zh'
          } catch {
            activeLocale = 'zh'
          }
          try {
            ctx.effect(
              () => locale.register(TEXT_NS, { zh: DICT.zh, en: DICT.en }),
              'dsh-session-cleanup: strings',
            )
          } catch {
            // An occupied (namespace, locale) pair is not fatal: t() falls back
            // to the bundled table.
          }
          try {
            const bound = locale.bind(TEXT_NS)
            if (typeof bound === 'function' && bound('action.label') !== 'action.label') translate = bound
          } catch {
            translate = null
          }
        }

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: SLOT_ID, order: 5, locale: NS },
            CleanupAction,
          ),
        )
      },
    }
  },
})
