// dsh-price-chip — Client half.
// 双位置价签：停靠左侧边栏（官方 sidebar.footer.action 插槽）或自由悬浮窗。
// 悬浮窗另有：固定/自由、横向/纵向排版开关。所有选择都记在本机。
window.__ModuleLoader__.load({
  id: 'dsh-price-chip',
  factory(require) {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useReducer, useRef, useState } = React

    const POS_KEY = 'dsh-price-chip.position'
    const MODE_KEY = 'dsh-price-chip.mode'
    const LAYOUT_KEY = 'dsh-price-chip.layout'
    const PIN_KEY = 'dsh-price-chip.pinned'

    // ---------- 本机偏好 ----------
    function readString(key, fallback, allowed) {
      try {
        const raw = localStorage.getItem(key)
        return allowed.includes(raw) ? raw : fallback
      } catch { return fallback }
    }
    function readBool(key, fallback) {
      try {
        const raw = localStorage.getItem(key)
        if (raw === '1') return true
        if (raw === '0') return false
        return fallback
      } catch { return fallback }
    }
    function writeRaw(key, value) {
      try { localStorage.setItem(key, value) } catch { /* 隐私模式忽略 */ }
    }
    function readPos() {
      try {
        const raw = localStorage.getItem(POS_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || !Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null
        return parsed
      } catch { return null }
    }

    // ---------- 共享界面偏好（两个卡片同步） ----------
    const ui = {
      mode: readString(MODE_KEY, 'floating', ['floating', 'sidebar']),
      layout: readString(LAYOUT_KEY, 'horizontal', ['horizontal', 'vertical']),
      pinned: readBool(PIN_KEY, false),
      listeners: new Set(),
    }
    function patchUi(patch) {
      Object.assign(ui, patch)
      if (patch.mode !== undefined) writeRaw(MODE_KEY, patch.mode)
      if (patch.layout !== undefined) writeRaw(LAYOUT_KEY, patch.layout)
      if (patch.pinned !== undefined) writeRaw(PIN_KEY, patch.pinned ? '1' : '0')
      for (const listener of ui.listeners) listener()
    }
    function useUi() {
      const [, force] = useReducer((n) => n + 1, 0)
      useEffect(() => {
        ui.listeners.add(force)
        return () => { ui.listeners.delete(force) }
      }, [])
      return ui
    }

    // ---------- 数据（单例：两个卡片共用一份轮询） ----------
    const BALANCE_KEY = 'dsh-price-chip.balance'
    function readBalanceCache() {
      try {
        const raw = localStorage.getItem(BALANCE_KEY)
        if (!raw) return { value: null, error: null, at: 0 }
        const parsed = JSON.parse(raw)
        return { value: parsed?.value ?? null, error: null, at: Number(parsed?.at) || 0 }
      } catch {
        return { value: null, error: null, at: 0 }
      }
    }
    const feed = {
      data: null,
      error: null,
      busy: false,
      pollMs: 60000,
      starting: false,
      timer: null,
      visibilityBound: false,
      balance: readBalanceCache(),
      listeners: new Set(),
    }
    function emitFeed() {
      for (const listener of feed.listeners) listener()
    }

    async function fetchState(withBalance) {
      const url = withBalance ? '/price-chip/state?balance=1' : '/price-chip/state'
      const response = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } })
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
      if (!body || body.ok !== true || !body.value) throw new Error(body?.error ?? '数据格式异常')
      return body.value
    }

    /** 首次拿到宿主状态时，若本机还没有用户选择，就采用 Config 里的默认值。 */
    let defaultsApplied = false
    function adoptDefaults(state) {
      if (defaultsApplied || !state || !state.defaults) return
      defaultsApplied = true
      const d = state.defaults
      try {
        if (localStorage.getItem(MODE_KEY) === null) patchUi({ mode: d.mode === 'sidebar' ? 'sidebar' : 'floating' })
        if (localStorage.getItem(LAYOUT_KEY) === null) patchUi({ layout: d.layout === 'vertical' ? 'vertical' : 'horizontal' })
        if (localStorage.getItem(PIN_KEY) === null) patchUi({ pinned: d.pinned === true })
      } catch {
        // 隐私模式下读不到本地存储时忽略
      }
    }

    /** 拉一次状态。withBalance 只在用户点刷新时为 true——余额不自动联网查。 */
    async function poll(withBalance) {
      feed.busy = true
      emitFeed()
      try {
        const value = await fetchState(withBalance)
        feed.data = value
        feed.error = null
        adoptDefaults(value)
        if (withBalance) {
          const next = { value: value?.balance ?? null, error: value?.balanceError ?? null, at: Date.now() }
          feed.balance = next
          try { localStorage.setItem(BALANCE_KEY, JSON.stringify({ value: next.value, at: next.at })) } catch { /* ignore */ }
        }
        const seconds = Number(value?.defaults?.refreshSeconds)
        if (Number.isFinite(seconds) && seconds >= 15 && Math.round(seconds) * 1000 !== feed.pollMs) {
          feed.pollMs = Math.round(seconds) * 1000
          schedulePoll()
        }
      } catch (err) {
        feed.error = err instanceof Error ? err.message : String(err)
      } finally {
        feed.busy = false
        emitFeed()
      }
    }

    function schedulePoll() {
      if (feed.timer) clearInterval(feed.timer)
      feed.timer = setInterval(() => {
        if (!document.hidden) void poll(false)
      }, feed.pollMs)
    }

    /** 两个卡片共用一个订阅：第一个订阅者启动轮询，全部卸载后停掉。 */
    function usePriceState() {
      const [, force] = useReducer((n) => n + 1, 0)
      useEffect(() => {
        feed.listeners.add(force)
        if (!feed.starting) {
          feed.starting = true
          if (!feed.data) void poll(false)
          schedulePoll()
          if (!feed.visibilityBound) {
            feed.visibilityBound = true
            document.addEventListener('visibilitychange', () => {
              if (!document.hidden) void poll(false)
            })
          }
        }
        return () => {
          feed.listeners.delete(force)
          if (feed.listeners.size === 0) {
            feed.starting = false
            if (feed.timer) {
              clearInterval(feed.timer)
              feed.timer = null
            }
          }
        }
      }, [])
      const refresh = useCallback((options) => poll(options?.withBalance === true), [])
      return { data: feed.data, error: feed.error, busy: feed.busy, balance: feed.balance, refresh }
    }
    function useClock() {
      const [, tick] = useReducer((n) => n + 1, 0)
      useEffect(() => {
        const timer = setInterval(tick, 1000)
        return () => clearInterval(timer)
      }, [])
    }

    // ---------- 格式化 ----------
    function fmtRate(value) {
      if (!Number.isFinite(value)) return '—'
      if (value < 0.1) return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
      return String(value)
    }
    function fmtCountdown(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '0:00'
      let total = Math.floor(ms / 1000)
      const days = Math.floor(total / 86400)
      total -= days * 86400
      const hours = Math.floor(total / 3600)
      total -= hours * 3600
      const minutes = Math.floor(total / 60)
      const seconds = total - minutes * 60
      const pad = (n) => String(n).padStart(2, '0')
      const body = hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
      return days > 0 ? `${days}天${body}` : body
    }
    function useCountdownRefresh(data, refresh) {
      useClock()
      const remain = data ? data.nextSwitchAt - Date.now() : 0
      useEffect(() => {
        if (data && remain <= 0) refresh()
      }, [remain <= 0])
      return remain
    }

    // ---------- 样式 ----------
    const dim = { color: 'var(--dsw-alias-text-secondary, rgba(232, 232, 232, 0.62))' }
    const buttonBase = {
      flex: '0 0 auto',
      width: '20px',
      height: '20px',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 0,
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border, rgba(127, 127, 127, 0.26))',
      background: 'transparent',
      color: 'inherit',
      fontSize: '12px',
      lineHeight: 1,
      cursor: 'pointer',
      opacity: 0.75,
    }
    function RateCells({ data, layout }) {
      const values = [
        ['输入', data ? fmtRate(data.rates.miss) : '—'],
        ['命中', data ? fmtRate(data.rates.hit) : '—'],
        ['输出', data ? fmtRate(data.rates.out) : '—'],
      ]
      if (layout === 'vertical') {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '8px' } },
          values.map(([label, value]) => h('div', { key: label, style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
            h('span', { style: { ...dim, fontSize: '9px', letterSpacing: '0.04em' } }, label),
            h('span', { style: { marginLeft: 'auto', fontSize: '12px', fontWeight: 600 } }, `¥${value}`),
          )),
        )
      }
      // 横向：三列严格各占三分之一
      return h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: '4px',
          marginTop: '8px',
        },
      },
        values.map(([label, value]) => h('div', {
          key: label,
          style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px', minWidth: '0' },
        },
          h('span', { style: { ...dim, fontSize: '9px', letterSpacing: '0.04em' } }, label),
          h('span', { style: { fontSize: '12px', fontWeight: 600 } }, `¥${value}`),
        )),
      )
    }
    function BalanceRow({ balance }) {
      const bal = balance?.value
      const text = bal && Number.isFinite(bal.cny)
        ? `¥${bal.cny.toFixed(2)}`
        : bal && Number.isFinite(bal.usd)
          ? `$${bal.usd.toFixed(2)}`
          : '—'
      return h('div', {
        title: balance?.at ? `余额更新于 ${new Date(balance.at).toLocaleTimeString('zh-CN')}，点 ⟳ 重新查询` : '点 ⟳ 查询余额（不自动联网）',
        style: {
          display: 'flex',
          alignItems: 'baseline',
          gap: '8px',
          marginTop: '8px',
          paddingTop: '7px',
          borderTop: '1px dashed var(--dsw-alias-border, rgba(127, 127, 127, 0.22))',
        },
      },
        h('span', { style: { ...dim, fontSize: '9px', letterSpacing: '0.04em' } }, '余额'),
        h('span', { style: { marginLeft: 'auto', fontSize: '13px', fontWeight: 700 } }, text),
      )
    }
    /** 紧凑行（纵向排版用）：标签与数值之间空出一个「命中」的宽度，整块水平居中。 */
    const COMPACT_GRID = {
      display: 'grid',
      gridTemplateColumns: 'auto auto',
      columnGap: '18px',
      width: 'fit-content',
      margin: '0 auto',
      alignItems: 'baseline',
    }
    function CompactRows({ data }) {
      const rows = [
        ['输入', data ? fmtRate(data.rates.miss) : '—'],
        ['命中', data ? fmtRate(data.rates.hit) : '—'],
        ['输出', data ? fmtRate(data.rates.out) : '—'],
      ]
      return h('div', { style: { ...COMPACT_GRID, rowGap: '3px', marginTop: '7px' } },
        rows.map(([label, value]) => [
          h('span', { key: `l-${label}`, style: { ...dim, fontSize: '9px', letterSpacing: '0.04em' } }, label),
          h('span', { key: `v-${label}`, style: { fontSize: '12px', fontWeight: 600, textAlign: 'right' } }, `¥${value}`),
        ]),
      )
    }
    function CompactBalance({ balance }) {
      const bal = balance?.value
      const text = bal && Number.isFinite(bal.cny)
        ? `¥${bal.cny.toFixed(2)}`
        : bal && Number.isFinite(bal.usd)
          ? `$${bal.usd.toFixed(2)}`
          : '—'
      return h('div', { style: { ...COMPACT_GRID } },
        h('span', { style: { ...dim, fontSize: '9px', letterSpacing: '0.04em' } }, '余额'),
        h('span', { style: { fontSize: '13px', fontWeight: 700, textAlign: 'right' } }, text),
      )
    }
    function StatusBadge({ data, offline, stretched, scale = 1, heightPx }) {
      const peak = data?.mode === 'peak'
      const accent = offline ? 'rgba(127,127,127,0.9)' : peak ? '#e0685a' : '#5fb87a'
      const baseFont = stretched ? 11 : 10
      const baseLine = stretched ? 24 : 18
      const lineHeight = stretched && Number.isFinite(heightPx) ? heightPx : baseLine * scale
      const dot = 5
      return h('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: stretched ? 'center' : 'flex-start',
          gap: `${5 * scale}px`,
          padding: stretched ? `0 ${10 * scale}px` : `0 ${7 * scale}px`,
          width: stretched ? '100%' : undefined,
          boxSizing: 'border-box',
          borderRadius: '999px',
          fontSize: `${baseFont * scale}px`,
          lineHeight: `${lineHeight}px`,
          fontWeight: 600,
          letterSpacing: '0.02em',
          whiteSpace: 'nowrap',
          color: accent,
          background: offline ? 'rgba(127,127,127,0.14)' : peak ? 'rgba(224,104,90,0.16)' : 'rgba(95,184,122,0.16)',
        },
      },
        h('span', { style: { width: `${dot * scale}px`, height: `${dot * scale}px`, borderRadius: '50%', background: accent } }),
        offline ? '离线' : data ? (peak ? '高峰 ×1' : '谷时 ×0.5') : '…',
      )
    }

    /**
     * 固定/自由切换图标（手绘稿比例）：
     * 斜线 (8.5,4)→(16,20.5)；顶部横线落在斜线 1/4 处（y≈8.13），
     * 下方横线落在从下往上 3/8 处（y≈14.31），两线由右侧竖线连通；
     * 左侧竖线与右侧等长并向上延伸，顶端横线接到斜线。
     */
    function PinGlyph({ pinned, size = 12 }) {
      const stroke = {
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        fill: 'none',
      }
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        style: { display: 'block', opacity: pinned ? 1 : 0.72 },
        'aria-hidden': true,
      },
        // 45° 斜杆
        h('line', { x1: 8.5, y1: 4, x2: 16, y2: 20.5, ...stroke }),
        // 底部垫线
        h('line', { x1: 3.5, y1: 18, x2: 20.5, y2: 18, ...stroke }),
        // 顶部横线：斜线 1/4 处（从顶端算）
        h('line', { x1: 11, y1: 8.13, x2: 19, y2: 8.13, ...stroke }),
        // 右侧竖线：连通上下两条横线（斜线 1/4 → 从下往上 3/8）
        h('line', { x1: 19, y1: 8.13, x2: 19, y2: 14.31, ...stroke }),
        // 下方横线：从斜线交点起，只保留右侧
        h('line', { x1: 13.19, y1: 14.31, x2: 19, y2: 14.31, ...stroke }),
        // 左侧竖线：与右侧竖线等长，向上延伸到 11.81
        h('line', { x1: 5.5, y1: 11.81, x2: 5.5, y2: 18, ...stroke }),
        // 左侧顶端横线：接到斜线
        h('line', { x1: 5.5, y1: 11.81, x2: 12.05, y2: 11.81, ...stroke }),
      )
    }

    /** 排版切换图标：45° 斜线 + 从 3/4 处分出的向右 / 向下两个箭头（用户手绘稿）。 */
    function LayoutGlyph({ size = 12 }) {
      const stroke = {
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        fill: 'none',
      }
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        style: { display: 'block' },
        'aria-hidden': true,
      },
        // 主斜线：左上 → 右下
        h('line', { x1: 5, y1: 5, x2: 21, y2: 21, ...stroke }),
        // 向右箭头（起点在斜线 3/4 处，即 5 + 16×0.25 = 9）
        h('path', { d: 'M9 9 H 20.5', ...stroke }),
        h('path', { d: 'M17.5 6.5 L 21 9 L 17.5 11.5', ...stroke }),
        // 向下箭头
        h('path', { d: 'M9 9 V 20.5', ...stroke }),
        h('path', { d: 'M6.5 17.5 L 9 21 L 11.5 17.5', ...stroke }),
      )
    }

    /**
     * 卡片头部：峰谷徽标在上、倒计时在下，两者竖直中线对齐（倒计时在徽标宽度内居中）；
     * 右侧放操作按钮。三种布局共用，保证一致性。
     */
    function CardHeader({ data, offline, remain, buttons, badgeScale = 1, badgeHeight }) {
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          h(StatusBadge, { data, offline, stretched: true, scale: badgeScale, heightPx: badgeHeight }),
          h('div', {
            style: {
              marginTop: '3px',
              fontSize: '11px',
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
              textAlign: 'center',
              whiteSpace: 'nowrap',
            },
          }, data && !offline ? fmtCountdown(remain) : ''),
        ),
        buttons,
      )
    }

    // ---------- 悬浮窗 ----------
    const FLOAT_CARD = {
      position: 'fixed',
      zIndex: 60,
      boxSizing: 'border-box',
      pointerEvents: 'auto',
      padding: '9px 11px 10px',
      borderRadius: '12px',
      border: '1px solid var(--dsw-alias-border, rgba(127, 127, 127, 0.26))',
      background: 'var(--dsw-alias-bg-elevated, rgba(26, 26, 28, 0.9))',
      color: 'var(--dsw-alias-text-primary, rgba(232, 232, 232, 0.96))',
      fontFamily: 'inherit',
      fontSize: '11px',
      lineHeight: '1.5',
      fontVariantNumeric: 'tabular-nums',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.3)',
      backdropFilter: 'blur(10px)',
      userSelect: 'none',
      touchAction: 'none',
    }
    const FLOAT_WIDTH = 208
    const VERTICAL_WIDTH = 136

    function FloatingCard() {
      const state = useUi()
      const { data, error, busy, balance, refresh } = usePriceState()
      const remain = useCountdownRefresh(data, refresh)
      const [pos, setPos] = useState(readPos)
      const dragRef = useRef(null)
      const cardRef = useRef(null)
      const offline = error !== null

      const onPointerDown = useCallback((event) => {
        if (state.pinned || event.button !== 0) return
        const rect = cardRef.current?.getBoundingClientRect()
        if (!rect) return
        dragRef.current = { startX: event.clientX, startY: event.clientY, originLeft: rect.left, originTop: rect.top, moved: false, pointerId: event.pointerId }
        cardRef.current.setPointerCapture?.(event.pointerId)
        cardRef.current.style.cursor = 'grabbing'
      }, [state.pinned])
      const onPointerMove = useCallback((event) => {
        const drag = dragRef.current
        if (!drag) return
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
        drag.moved = true
        const width = cardRef.current?.offsetWidth ?? FLOAT_WIDTH
        const height = cardRef.current?.offsetHeight ?? 96
        setPos({
          x: Math.round(Math.min(Math.max(0, drag.originLeft + dx), Math.max(0, window.innerWidth - width))),
          y: Math.round(Math.min(Math.max(0, drag.originTop + dy), Math.max(0, window.innerHeight - height))),
        })
      }, [])
      const onPointerUp = useCallback((event) => {
        const drag = dragRef.current
        dragRef.current = null
        if (!drag) return
        cardRef.current?.releasePointerCapture?.(drag.pointerId)
        if (cardRef.current) cardRef.current.style.cursor = state.pinned ? 'default' : 'grab'
        if (drag.moved) setPos((current) => { if (current) writeRaw(POS_KEY, JSON.stringify(current)); return current })
      }, [state.pinned])

      if (state.mode !== 'floating') return null

      const cardWidth = state.layout === 'vertical' ? VERTICAL_WIDTH : FLOAT_WIDTH
      const positionStyle = pos
        ? { left: `${pos.x}px`, top: `${pos.y}px`, width: `${cardWidth}px` }
        : { right: '16px', bottom: '180px', width: `${cardWidth}px` }

      const btn = (title, icon, onClick, extra) => h('button', {
        type: 'button',
        title,
        onPointerDown: (event) => { event.stopPropagation() },
        onClick: (event) => { event.stopPropagation(); onClick() },
        style: { ...buttonBase, width: '18px', height: '18px', fontSize: '11px', ...(extra ?? {}) },
      }, icon)
      // 放大版按钮：横向网格用（18px → 27px，约 1.5 倍）
      const bigBtn = (title, icon, onClick, extra) => btn(title, icon, onClick, { width: '27px', height: '27px', fontSize: '16px', borderRadius: '8px', ...(extra ?? {}) })
      const rowBtn = (title, icon, onClick, extra) => btn(title, icon, onClick, { width: '24px', height: '24px', fontSize: '14px', borderRadius: '7px', ...(extra ?? {}) })

      const horizontal = state.layout === 'horizontal'
      const actionsGrid = h('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 27px)',
          gridTemplateRows: 'repeat(2, 27px)',
          gap: '4px',
          flex: '0 0 auto',
        },
      },
        // 顺序：1 侧边栏 → 2 固定/悬浮 → 3 刷新 → 4 横竖切换（27px 放大版）
        bigBtn('停靠到左侧边栏', '⇤', () => patchUi({ mode: 'sidebar' })),
        bigBtn(state.pinned ? '解除固定（可拖动）' : '固定位置（不可拖动）', h(PinGlyph, { pinned: state.pinned, size: 18 }), () => patchUi({ pinned: !state.pinned }), { opacity: state.pinned ? 1 : 0.6 }),
        bigBtn('立即刷新', '⟳', () => refresh({ withBalance: true }), { opacity: busy ? 0.4 : 0.75 }),
        bigBtn(horizontal ? '切换为纵向排版' : '切换为横向排版', h(LayoutGlyph, { size: 18 }), () => patchUi({ layout: horizontal ? 'vertical' : 'horizontal' })),
      )

      const actionsRow = h('div', {
        style: { display: 'flex', alignItems: 'center', gap: '4px', flex: '0 0 auto' },
      },
        // 竖版顺序：1 侧边栏 → 2 刷新 → 3 切换横竖 → 4 切换固定
        rowBtn('停靠到左侧边栏', '⇤', () => patchUi({ mode: 'sidebar' })),
        rowBtn('立即刷新', '⟳', () => refresh({ withBalance: true }), { opacity: busy ? 0.4 : 0.75 }),
        rowBtn(horizontal ? '切换为纵向排版' : '切换为横向排版', h(LayoutGlyph, { size: 16 }), () => patchUi({ layout: horizontal ? 'vertical' : 'horizontal' })),
        rowBtn(state.pinned ? '解除固定（可拖动）' : '固定位置（不可拖动）', h(PinGlyph, { pinned: state.pinned, size: 16 }), () => patchUi({ pinned: !state.pinned }), { opacity: state.pinned ? 1 : 0.6 }),
      )

      const outerStyle = {
        ...FLOAT_CARD,
        ...positionStyle,
        cursor: state.pinned ? 'default' : 'grab',
        ...(horizontal ? {} : { display: 'flex', flexDirection: 'column', alignItems: 'center' }),
      }

      return h('div', {
        ref: cardRef,
        style: outerStyle,
        title: tooltipOf(data, error, 'floating'),
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
      },
        // 横向：头部（徽标 + 倒计时 | 按钮）→ 三列单价 → 余额
        horizontal ? h(CardHeader, { data, offline, remain, buttons: actionsGrid, badgeScale: 1.5, badgeHeight: 36 }) : null,
        // 纵向：按钮置顶 → 徽标 → 倒计时 → 紧凑单价 → 余额，全部沿竖直中轴线居中
        horizontal ? null : h('div', { style: { marginBottom: '8px' } }, actionsRow),
        horizontal ? h(RateCells, { data, layout: 'horizontal' }) : null,
        horizontal ? null : h(StatusBadge, { data, offline, scale: 1.5 }),
        horizontal ? null : h('div', { style: { marginTop: '3px', fontSize: '11px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' } },
          data && !offline ? fmtCountdown(remain) : ''),
        horizontal ? null : h(CompactRows, { data }),
        horizontal ? h(BalanceRow, { balance }) : null,
        horizontal ? null : h('div', { style: { alignSelf: 'stretch', marginTop: '8px', paddingTop: '7px', borderTop: '1px dashed var(--dsw-alias-border, rgba(127, 127, 127, 0.22))' } },
          h(CompactBalance, { balance })),
        offline ? h('div', { style: { color: '#e0685a', fontSize: '10px', marginTop: '6px', wordBreak: 'break-all', alignSelf: 'stretch', textAlign: 'center' } }, String(error).slice(0, 60)) : null,
      )
    }
    // ---------- 侧栏卡片 ----------
    function SidebarCard(props) {
      const state = useUi()
      const { data, error, busy, balance, refresh } = usePriceState()
      const remain = useCountdownRefresh(data, refresh)
      if (state.mode !== 'sidebar') return null
      const offline = error !== null
      const wide = props?.wide !== false
      const btn = (title, icon, onClick, extra) => h('button', {
        type: 'button',
        title,
        onClick: (event) => { event.stopPropagation(); onClick() },
        style: { ...buttonBase, width: '18px', height: '18px', fontSize: '11px', ...(extra ?? {}) },
      }, icon)

      if (!wide) {
        // 侧栏折叠成窄条：只留状态点 + 刷新
        return h('div', {
          style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', padding: '4px 0' },
          title: tooltipOf(data, error, 'sidebar'),
        },
          h('span', { style: { width: '7px', height: '7px', borderRadius: '50%', background: offline ? '#888' : data?.mode === 'peak' ? '#e0685a' : '#5fb87a' } }),
          btn('立即刷新', '⟳', () => refresh({ withBalance: true })),
        )
      }

      return h('div', {
        title: tooltipOf(data, error, 'sidebar'),
        style: {
          margin: '2px 4px 4px',
          padding: '7px 9px 8px',
          borderRadius: '10px',
          border: '1px solid var(--dsw-alias-border, rgba(127, 127, 127, 0.22))',
          background: 'var(--dsw-alias-bg-elevated, rgba(26, 26, 28, 0.55))',
          color: 'var(--dsw-alias-text-primary, rgba(232, 232, 232, 0.96))',
          fontFamily: 'inherit',
          fontSize: '11px',
          lineHeight: '1.45',
          fontVariantNumeric: 'tabular-nums',
        },
      },
        // 头部：与浮窗同构（徽标 + 下方居中倒计时 + 右侧按钮）
        h(CardHeader, {
          data,
          offline,
          remain,
          badgeScale: 1,
          buttons: h('div', { style: { display: 'flex', alignItems: 'center', gap: '5px', flex: '0 0 auto' } },
            btn('切换为自由悬浮窗', '⇥', () => patchUi({ mode: 'floating' })),
            btn('立即刷新', '⟳', () => refresh({ withBalance: true }), { opacity: busy ? 0.4 : 0.75 }),
          ),
        }),
        h(RateCells, { data, layout: 'horizontal' }),
        h(BalanceRow, { balance }),
        offline ? h('div', { style: { color: '#e0685a', fontSize: '9px', marginTop: '4px', wordBreak: 'break-all' } }, String(error).slice(0, 44)) : null,
      )
    }

    function tooltipOf(data, error, where) {
      if (!data) return `正在读取 DeepSeek 峰谷价与余额…${error ? `\n错误：${error}` : ''}`
      return [
        `峰谷：${data.mode === 'peak' ? '高峰（全价 ×1）' : '谷时（半价 ×0.5）'}`,
        `价目：${data.kind === 'pro' ? 'V4 Pro' : 'V4.1 Flash'}（人民币 / 百万 tokens）`,
        `当前：命中 ¥${fmtRate(data.rates.hit)} · 未命中 ¥${fmtRate(data.rates.miss)} · 输出 ¥${fmtRate(data.rates.out)}`,
        `峰时：命中 ¥${fmtRate(data.list.peak.hit)} · 未命中 ¥${fmtRate(data.list.peak.miss)} · 输出 ¥${fmtRate(data.list.peak.out)}`,
        data.pricing
          ? `价格来源：${data.pricing.source === 'online'
              ? `官方价格页（${new Date(data.pricing.syncedAt).toLocaleString('zh-CN')}）`
              : data.pricing.source === 'cache'
                ? `本地缓存（${new Date(data.pricing.syncedAt).toLocaleString('zh-CN')}）`
                : `内置表（同步${data.pricing.error ? '失败' : '未启用'}）`}`
          : '',
        '余额不自动查询：点 ⟳ 才会联网取一次，之后用本地缓存',
        data.calendar
          ? `节假日表：${data.calendar.coveredYears.join('、')}（到 ${data.calendar.expiresOn}，还剩 ${data.calendar.daysLeft} 天）`
          : '',
        data.pricing?.builtinCheckedAt ? `内置表核对：${data.pricing.builtinCheckedAt}` : '',
        where === 'floating' ? '⇤ 停靠侧栏 · ✥/⊙ 固定 · ▤/▥ 排版 · ⟳ 刷新' : '⇥ 切回悬浮窗 · ⟳ 刷新',
        error ? `上次错误：${error}` : '',
      ].filter(Boolean).join('\n')
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'price-chip.floating',
          order: 20,
        }, FloatingCard))
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'price-chip.sidebar',
          order: 0,
        }, SidebarCard))
      },
    }
  },
})
