// dsh-price-chip — Host half.
// 提供 /price-chip/state RPC：峰谷状态与倍率、当前单价、切价时间点、本轮花费、账户余额。
// 单价来源：DeepSeek 官方价格页（2026-11-25 核对，人民币 / 百万 tokens）。
// 峰谷规则：北京时间周一至周五 09:00-12:00、14:00-18:00 为高峰；周末与中国法定节假日全天谷价。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 从宿主树里取 schemastery（Config 用）。插件常以 link/junction 装进 profile，
 * 裸 import 从真实路径解析不到 profile 的 node_modules，所以要显式找几处；
 * 彻底拿不到时 Config 为 undefined，插件本体照常加载（只是设置页降级）。
 */
function loadSchema() {
  const here = dirname(fileURLToPath(import.meta.url))
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const candidates = []
  if (process.env.DSH_PROFILE_DIR) candidates.push(join(process.env.DSH_PROFILE_DIR, 'package.json'))
  if (process.env.DSH_PROFILE) candidates.push(join(home, 'profiles', process.env.DSH_PROFILE, 'package.json'))
  for (const name of ['desktop', 'web', 'headless']) candidates.push(join(home, 'profiles', name, 'package.json'))
  candidates.push(join(here, 'package.json'))
  for (const anchor of candidates) {
    try {
      const req = createRequire(anchor)
      const mod = req('@deepseek-ai/schemastery')
      const schema = mod?.default ?? mod
      if (schema?.object) return schema
    } catch {
      // 试下一个锚点
    }
  }
  return null
}

const Schema = loadSchema()

export const name = 'price-chip'

/** 插件可配置项（用户在 profile 的 cordis.patch.yml 里覆盖，见 README）。 */
export const Config = !Schema ? undefined : Schema.object({
  defaultMode: Schema.union(['floating', 'sidebar']).default('floating').description('首次打开时显示在哪里：floating 悬浮窗 / sidebar 侧边栏'),
  defaultLayout: Schema.union(['horizontal', 'vertical']).default('horizontal').description('悬浮窗默认排版：horizontal 横向 / vertical 纵向'),
  pinnedByDefault: Schema.boolean().default(false).description('悬浮窗是否默认固定位置（不可拖动）'),
  refreshSeconds: Schema.natural().min(15).max(3600).default(60).description('自动刷新间隔（秒）'),
  apiKeyRef: Schema.string().default('DEEPSEEK_API_KEY').description('读取余额所用凭据名（DSH 凭据服务里的引用名，或同名环境变量）'),
  baseURL: Schema.string().default('https://api.deepseek.com').description('DeepSeek API 地址'),
  priceSync: Schema.boolean().default(true).description('启动时从官方价格页同步一次单价；失败则用内置表'),
  priceUrl: Schema.string().default('https://api-docs.deepseek.com/zh-cn/quick_start/pricing/').description('官方价格页地址（用于启动同步）'),
  holidaySync: Schema.boolean().default(true).description('启动时按整年拉取中国法定节假日/调休表'),
  holidayUrl: Schema.string().default('https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json').description('节假日 JSON 地址模板，{year} 会被替换'),
  calendarWarnDays: Schema.natural().min(1).max(365).default(45).description('节假日表剩余天数低于该值时提醒模型补拉下一年'),
})

// webServer：给浏览器半开只读 HTTP 路由；tools/agents/systemPrompt：数据到期提醒与补拉工具。
export const inject = ['webServer', 'tools', 'agents', 'systemPrompt']

const BJ_OFFSET_MINUTES = 480
const BALANCE_TTL_MS = 60_000
const PRICING_CHECKED_AT = '2026-11-25'

/** 官方单价（人民币 / 百万 tokens）：peak 为全价，offPeak 为半价。 */
const RATES = {
  flash: {
    peak: { hit: 0.04, miss: 2, out: 8 },
    offPeak: { hit: 0.02, miss: 1, out: 4 },
  },
  pro: {
    peak: { hit: 0.3, miss: 9, out: 27 },
    offPeak: { hit: 0.15, miss: 4.5, out: 13.5 },
  },
}

/** 中国法定节假日（全天谷价），来源：国务院 2026 / 2027 年放假安排。 */
const OFF_DAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
  '2027-01-01', '2027-01-02', '2027-01-03',
  '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13',
  '2027-04-03', '2027-04-04', '2027-04-05',
  '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
  '2027-06-09',
  '2027-09-15',
  '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05', '2027-10-06', '2027-10-07',
])

/** 调休上班日（周末但按工作日高峰计）。 */
const WORKDAYS = new Set([
  '2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10',
  '2027-01-31', '2027-02-14', '2027-05-08', '2027-09-26', '2027-10-09',
])

// ---- 运行时数据：官方价目 + 节假日表 ----
// 价格：每次启动同步一次，之后不再轮询（调价不频繁）。
// 节假日：启动时按「整年」拉取，覆盖年份临近结束时通知模型再去拉下一年。
const BUILTIN_YEARS = [2026, 2027]
const coveredYears = new Set(BUILTIN_YEARS)
let activeRates = RATES
const pricingStatus = { source: 'builtin', syncedAt: null, error: null }
let calendarFetchedAt = null

// 磁盘缓存：价格一周内不重抓（重启也不抓）；节假日按年缓存，一年只拉一次。
const CACHE_VERSION = 1
const PRICE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const HOLIDAY_MISSING_RETRY_MS = 7 * 24 * 60 * 60 * 1000

function cacheFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'price-chip', 'cache.json')
}
async function readCache() {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
async function writeCache(data) {
  try {
    await mkdir(join(cacheFile(), '..'), { recursive: true })
    await writeFile(cacheFile(), JSON.stringify(data), 'utf8')
  } catch {
    // 缓存写失败不影响插件运行
  }
}

/** HTML 表格 → 行 × 单元格文本（去标签、压空白）。 */
export function htmlTableRows(html) {
  const rows = []
  for (const tr of String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
      m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim())
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

/**
 * 解析官方中文价格页，得到 { flash, pro } 两档（空闲 / 高峰，元 / 百万 tokens）。
 * 解析不完整或数值异常时返回 null（调用方沿用内置表）。
 */
export function parsePricePage(html) {
  const out = {
    flash: { offPeak: {}, peak: {} },
    pro: { offPeak: {}, peak: {} },
  }
  const metricOf = (cell) => {
    if (cell.includes('缓存命中')) return 'hit'
    if (cell.includes('缓存未命中')) return 'miss'
    if (cell.includes('tokens输出')) return 'out'
    return null
  }
  let metric = null
  let phase = null
  for (const cells of htmlTableRows(html)) {
    for (const cell of cells) {
      const m = metricOf(cell)
      if (m) { metric = m; continue }
      if (cell.includes('空闲时段')) { phase = 'offPeak'; continue }
      if (cell.includes('高峰时段')) { phase = 'peak'; continue }
      if (!metric || !phase) continue
      const num = cell.match(/([\d.]+)\s*元/)
      if (!num) continue
      if (out.flash[phase][metric] === undefined) out.flash[phase][metric] = Number(num[1])
      else if (out.pro[phase][metric] === undefined) out.pro[phase][metric] = Number(num[1])
    }
  }
  const complete = (kind) => ['offPeak', 'peak'].every((p) =>
    ['hit', 'miss', 'out'].every((k) => Number.isFinite(out[kind][p][k]) && out[kind][p][k] > 0))
  if (!complete('flash') || !complete('pro')) return null
  // 高峰应约为空闲的两倍，偏差过大说明解析错位
  for (const kind of ['flash', 'pro']) {
    for (const k of ['hit', 'miss', 'out']) {
      const off = out[kind].offPeak[k]
      const peak = out[kind].peak[k]
      if (Math.abs(peak / off - 2) > 0.35) return null
    }
  }
  return out
}

/** 把 holiday-cn 的年度 JSON（{year, days:[{date,isOffDay,name}]}）合并进节假日集合。 */
export function mergeHolidayYear(json) {
  const year = Number(json?.year)
  const days = Array.isArray(json?.days) ? json.days : []
  if (!Number.isFinite(year) || days.length === 0) throw new Error('节假日数据格式不对')
  let offDays = 0
  let workDays = 0
  for (const day of days) {
    const key = typeof day?.date === 'string' ? day.date : ''
    if (!key) continue
    if (day.isOffDay) { OFF_DAYS.add(key); WORKDAYS.delete(key); offDays++ }
    else { WORKDAYS.add(key); OFF_DAYS.delete(key); workDays++ }
  }
  coveredYears.add(year)
  return { year, offDays, workDays }
}

/** 当前节假日表覆盖情况：最大年份、到期日、剩余天数。 */
export function calendarStatus(nowMs = Date.now()) {
  const years = [...coveredYears].sort((a, b) => a - b)
  const maxYear = years.length > 0 ? years[years.length - 1] : 0
  const expiresAt = Date.UTC(maxYear + 1, 0, 1) - BJ_OFFSET_MINUTES * 60000
  return {
    coveredYears: years,
    expiresOn: `${maxYear}-12-31`,
    daysLeft: Math.max(0, Math.ceil((expiresAt - nowMs) / 86400000)),
  }
}


function bjParts(ms) {
  const d = new Date(ms + BJ_OFFSET_MINUTES * 60000)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  return {
    year,
    month,
    day,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
    key: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  }
}

/** 该时刻是否处于高峰（全价）。 */
export function isPeakAt(ms) {
  const p = bjParts(ms)
  if (OFF_DAYS.has(p.key)) return false
  const isWeekend = p.weekday === 0 || p.weekday === 6
  if (isWeekend && !WORKDAYS.has(p.key)) return false
  const minutes = p.hour * 60 + p.minute
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
}

/** 下一个峰谷切换时刻（毫秒时间戳）；按分钟扫描，最多向后找 9 天。 */
export function nextSwitchAt(ms) {
  const current = isPeakAt(ms)
  const start = Math.ceil((ms + 1) / 60000) * 60000
  const limit = ms + 9 * 24 * 60 * 60 * 1000
  for (let t = start; t <= limit; t += 60000) {
    if (isPeakAt(t) !== current) return t
  }
  return ms + 60 * 60 * 1000
}

/** 模型名 → 价目表键（flash / pro）。 */
export function kindOf(model) {
  const s = String(model ?? '').toLowerCase()
  if (s.includes('pro')) return 'pro'
  return 'flash'
}

/** 某时刻、某模型的完整价目与倍率。 */
export function ratesAt(ms, model) {
  const kind = kindOf(model)
  const peak = isPeakAt(ms)
  const mode = peak ? 'peak' : 'offPeak'
  return {
    kind,
    mode: peak ? 'peak' : 'off-peak',
    multiplier: peak ? 1 : 0.5,
    rates: activeRates[kind][mode],
    list: activeRates[kind],
  }
}

/** 从会话事件里按轮次累计 token 用量。 */
/** 解析 API Key：凭据服务优先，环境变量兜底。 */
/** 解析 API Key：凭据服务优先，环境变量兜底。 */
async function resolveApiKey(ctx, apiKeyRef) {
  const credentials = ctx.get('credentials')
  if (credentials) {
    try {
      const hit = await credentials.resolve(apiKeyRef)
      if (hit?.value) return hit.value
    } catch {
      // 凭据服务不可用时继续走环境变量
    }
  }
  return process.env[apiKeyRef] || undefined
}

export function apply(ctx, config) {
  const raw = config && typeof config === 'object' ? config : {}
  const apiKeyRef = typeof raw.apiKeyRef === 'string' && raw.apiKeyRef ? raw.apiKeyRef : 'DEEPSEEK_API_KEY'
  const configuredBase = typeof raw.baseURL === 'string' && raw.baseURL ? raw.baseURL : 'https://api.deepseek.com'
  const refreshSecondsRaw = Number(raw.refreshSeconds)
  const refreshSeconds = Number.isFinite(refreshSecondsRaw) ? Math.min(Math.max(Math.round(refreshSecondsRaw), 15), 3600) : 60
  /** 前端首次打开时采用的默认值。 */
  const defaults = {
    mode: raw.defaultMode === 'sidebar' ? 'sidebar' : 'floating',
    layout: raw.defaultLayout === 'vertical' ? 'vertical' : 'horizontal',
    pinned: raw.pinnedByDefault === true,
    refreshSeconds,
  }
  let balanceCache = { at: 0, value: null, error: null }

  // ---- 同步策略：价格启动拉一次；节假日按年拉、到期前提醒模型补 ----
  const priceSync = raw.priceSync !== false
  const priceUrl = typeof raw.priceUrl === 'string' && raw.priceUrl ? raw.priceUrl : 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
  const holidaySync = raw.holidaySync !== false
  const holidayUrlTemplate = typeof raw.holidayUrl === 'string' && raw.holidayUrl.includes('{year}')
    ? raw.holidayUrl
    : 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json'
  const warnDaysRaw = Number(raw.calendarWarnDays)
  const calendarWarnDays = Number.isFinite(warnDaysRaw) ? Math.min(Math.max(Math.round(warnDaysRaw), 1), 365) : 45

  /** 价格：一周内有成功记录就跳过；否则抓一次并写缓存。 */
  async function syncPrices() {
    const cache = await readCache()
    const cached = cache?.prices
    if (cached && Number.isFinite(cached.syncedAt) && Date.now() - cached.syncedAt < PRICE_CACHE_TTL_MS && cached.flash && cached.pro) {
      activeRates = { flash: cached.flash, pro: cached.pro }
      pricingStatus.source = 'cache'
      pricingStatus.syncedAt = cached.syncedAt
      return
    }
    try {
      const response = await fetch(priceUrl, { signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error(`价格页 HTTP ${response.status}`)
      const parsed = parsePricePage(await response.text())
      if (!parsed) throw new Error('价格页解析失败（页面结构可能变了）')
      activeRates = { flash: parsed.flash, pro: parsed.pro }
      pricingStatus.source = 'online'
      pricingStatus.syncedAt = Date.now()
      pricingStatus.error = null
      await writeCache({ ...(cache ?? {}), version: CACHE_VERSION, prices: { flash: parsed.flash, pro: parsed.pro, syncedAt: pricingStatus.syncedAt } })
    } catch (error) {
      pricingStatus.error = error?.message ? String(error.message) : String(error)
      if (cached?.flash && cached?.pro) {
        activeRates = { flash: cached.flash, pro: cached.pro }
        pricingStatus.source = 'cache'
        pricingStatus.syncedAt = cached.syncedAt
      }
    }
  }

  /** 节假日：按年缓存，一年只拉一次；404 记下 7 天内不再重试。 */
  async function syncHolidays(years) {
    const cache = await readCache()
    const holidays = cache?.holidays && typeof cache.holidays === 'object' ? { ...cache.holidays } : {}
    let changed = false
    for (const year of years) {
      const entry = holidays[year]
      if (Array.isArray(entry?.days) && entry.days.length > 0) {
        try {
          mergeHolidayYear({ year, days: entry.days })
          if (entry.fetchedAt) calendarFetchedAt = entry.fetchedAt
          continue
        } catch {
          // 缓存坏了就走网络
        }
      }
      if (entry?.missing && Number.isFinite(entry.checkedAt) && Date.now() - entry.checkedAt < HOLIDAY_MISSING_RETRY_MS) continue
      try {
        const url = holidayUrlTemplate.replace('{year}', String(year))
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
        if (!response.ok) {
          if (response.status === 404) {
            holidays[year] = { missing: true, checkedAt: Date.now() }
            changed = true
          }
          throw new Error(`HTTP ${response.status}`)
        }
        const json = await response.json()
        mergeHolidayYear(json)
        holidays[year] = { fetchedAt: Date.now(), days: (json.days ?? []).map((d) => ({ date: d.date, isOffDay: !!d.isOffDay })) }
        calendarFetchedAt = holidays[year].fetchedAt
        changed = true
      } catch {
        // 缺年就回退内置/星期规则
      }
    }
    if (changed) await writeCache({ ...(cache ?? {}), version: CACHE_VERSION, holidays })
  }
  /** 节假日表临近到期时给模型的提醒（未到期返回空串）。 */
  function calendarWarningText() {
    const status = calendarStatus()
    if (status.daysLeft > calendarWarnDays) return ''
    const nextYear = Number(status.expiresOn.slice(0, 4)) + 1
    return `【峰谷价签】节假日/调休表只覆盖到 ${status.expiresOn}（还剩 ${status.daysLeft} 天）。若跨年计算峰谷，先调用 price_chip（action=calendar）拉取 ${nextYear} 年的数据。`
  }

  /** 数据状态文本（工具与提示共用）。 */
  function statusText() {
    const status = calendarStatus()
    const priceLine = pricingStatus.source === 'online'
      ? `价格：官方价格页已同步（${new Date(pricingStatus.syncedAt).toLocaleString('zh-CN')}）`
      : pricingStatus.source === 'cache'
        ? `价格：本地缓存（${new Date(pricingStatus.syncedAt).toLocaleString('zh-CN')}）${pricingStatus.error ? `，本次同步失败：${pricingStatus.error}` : ''}`
        : `价格：内置表${pricingStatus.error ? `（同步失败：${pricingStatus.error}）` : ''}`
    const calendarLine = `节假日表：${status.coveredYears.join('、')}（到 ${status.expiresOn}，还剩 ${status.daysLeft} 天）`
    const warn = status.daysLeft <= calendarWarnDays ? '；已临近到期，可用 price_chip（action=calendar）拉取下一年' : ''
    return `${priceLine}\n${calendarLine}${warn}`
  }

  async function getBalance(force) {
    const now = Date.now()
    if (!force && balanceCache.at && now - balanceCache.at < BALANCE_TTL_MS) return balanceCache
    const apiKey = await resolveApiKey(ctx, apiKeyRef)
    if (!apiKey) {
      balanceCache = { at: now, value: null, error: `未找到凭据 ${apiKeyRef}` }
      return balanceCache
    }
    const base = (process.env.DEEPSEEK_BASE_URL || configuredBase).replace(/\/+$/, '')
    try {
      const response = await fetch(`${base}/user/balance`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new Error(`余额接口 HTTP ${response.status}`)
      const raw = await response.json()
      const infos = Array.isArray(raw?.balance_infos) ? raw.balance_infos : []
      const pick = (currency) => infos.find((i) => i.currency === currency)
      const cny = pick('CNY')
      const usd = pick('USD')
      balanceCache = {
        at: now,
        value: {
          available: raw?.is_available === true,
          cny: cny ? Number(cny.total_balance) : null,
          usd: usd ? Number(usd.total_balance) : null,
          cnyToppedUp: cny ? Number(cny.topped_up_balance) : null,
          cnyGranted: cny ? Number(cny.granted_balance) : null,
        },
        error: null,
      }
    } catch (error) {
      balanceCache = { at: now, value: balanceCache.value, error: error?.message ? String(error.message) : String(error) }
    }
    return balanceCache
  }

  let lastBalance = { value: null, error: null, at: 0 }

  async function buildState(includeBalance) {
    const now = Date.now()
    const price = ratesAt(now, null)
    if (includeBalance) {
      const fetched = await getBalance(true)
      lastBalance = { value: fetched.value, error: fetched.error, at: Date.now() }
    }
    return {
      now,
      beijingTime: bjParts(now),
      mode: price.mode,
      multiplier: price.multiplier,
      nextSwitchAt: nextSwitchAt(now),
      rates: price.rates,
      list: price.list,
      kind: price.kind,
      balance: lastBalance.value,
      balanceError: lastBalance.error,
      balanceAt: lastBalance.at,
      defaults,
      pricing: { source: pricingStatus.source, syncedAt: pricingStatus.syncedAt, error: pricingStatus.error, builtinCheckedAt: PRICING_CHECKED_AT },
      calendar: { ...calendarStatus(), fetchedAt: calendarFetchedAt, warnDays: calendarWarnDays },
    }
  }
  // 启动时各同步一次（异步；失败不影响插件运行）
  if (priceSync) void syncPrices()
  if (holidaySync) {
    const year = bjParts(Date.now()).year
    void syncHolidays([year, year + 1])
  }

  // ---- 给模型的工具：一个入口，两个动作（省掉每轮的第二个 schema） ----
  ctx.tools.register({
    name: 'price_chip',
    description: '峰谷价签的数据：action=status 看单价来自哪里、节假日表覆盖到哪年、还剩几天；action=calendar 补拉某一年的节假日表（临近到期时用）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'status 或 calendar' },
        year: { type: 'number', description: 'action=calendar 时的年份，例如 2028；省略取当前覆盖最大年份的下一年' },
      },
      required: ['action'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      if (args?.action === 'calendar') {
        const status = calendarStatus()
        const maxYear = status.coveredYears.length > 0
          ? status.coveredYears[status.coveredYears.length - 1]
          : bjParts(Date.now()).year
        const requested = Number(args?.year)
        const year = Number.isFinite(requested) ? Math.round(requested) : maxYear + 1
        try {
          await syncHolidays([year])
          const after = calendarStatus()
          return after.coveredYears.includes(year)
            ? `已获取 ${year} 年节假日表。当前覆盖年份：${after.coveredYears.join('、')}。`
            : `没有拿到 ${year} 年节假日表（可能还没公布）。当前覆盖年份：${after.coveredYears.join('、')}。`
        } catch (error) {
          const message = error?.message ? String(error.message) : String(error)
          return `获取 ${year} 年节假日表失败：${message}。可以稍后重试，或用 Config 的 holidayUrl 换一个数据源。`
        }
      }
      return statusText()
    },
  })
  // ---- 到期提醒：给每个 Agent 挂一段条件性 system prompt（临近到期才输出） ----
  const promptDisposers = []
  function mountCalendarPrompt(agent) {
    try {
      const off = agent.ctx.systemPrompt.section({
        name: 'price-chip:calendar',
        order: 10310,
        interpolate: false,
        text: () => calendarWarningText(),
      })
      if (off) promptDisposers.push(off)
    } catch {
      // 该上下文没有 systemPrompt 服务时跳过
    }
  }
  ctx.effect(() => {
    const disposeCreated = ctx.on('agent/created', ({ agent }) => mountCalendarPrompt(agent))
    try {
      for (const agent of ctx.agents.list()) mountCalendarPrompt(agent)
    } catch {
      // agents 服务未就绪时只依赖后续 agent/created
    }
    return () => {
      try { disposeCreated?.() } catch { /* ignore */ }
      for (const off of promptDisposers.splice(0)) {
        try { if (typeof off === 'function') off() } catch { /* ignore */ }
      }
    }
  }, 'price-chip: calendar prompt')

  // ---- Web UI 数据通道：/price-chip/state（只读 JSON）----
  // 走 webServer 前缀路由：与已装插件的做法一致，不占 /api 命名空间、不需要客户端 RPC 信封。
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/price-chip',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const rest = url.pathname.slice('/price-chip'.length) || '/'
      if (rest !== '/state' || req.method !== 'GET') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      try {
        const value = await buildState(url.searchParams.get('balance') === '1')
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, value }))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: error?.message ? String(error.message) : String(error) }))
      }
    },
  }), 'price-chip: /price-chip route')
}
