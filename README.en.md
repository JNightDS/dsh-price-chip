# dsh-price-chip

Shows the current API pricing: input and output prices, peak or off-peak, the countdown to the next price switch, and your account balance.

Floating mode: drag it anywhere, then pin it in place with the button. The floating card switches between horizontal and vertical layouts.
Sidebar mode: docked at a preset position in the left sidebar.

## What it shows

- Peak (×1, red) or off-peak (×0.5, green) status, plus the countdown to the next switch
- When the countdown ends, prices refresh automatically
- Unit prices for input / cache hit / output, in CNY per 1M tokens
- Account balance (never fetched automatically, see below)

Four buttons: switch placement (floating ↔ sidebar), toggle pinning, switch layout, refresh balance.

## Peak hours and prices

Peak is Mon–Fri 09:00–12:00 and 14:00–18:00 Beijing time. Everything else — weekends and Chinese public holidays included — is off-peak.

The plugin fetches the current prices from the official DeepSeek pricing page and caches the parsed result on disk. Restarts within a week reuse the cache; it fetches again only after a week. If the fetch fails or the page structure changes beyond parsing, it falls back to the cache or the built-in table.

## Keeping the holiday calendar fresh

Public holidays are announced every year, so the plugin works year by year:

- It fetches this year and next year from `NateScarlet/holiday-cn` (the yearly JSON, via the jsDelivr mirror) and merges them into the built-in table.
- Once a year is fetched, it is cached, so the same year is not fetched again.
- When the table nears its end (45 days by default), the plugin adds a short note to the model's prompt telling it to fetch next year's public holiday information.

The `price_chip` tool reports data status — where the prices came from, when they were synced, which years the holiday table covers and how many days remain. It also fetches and merges one year of holiday data, defaulting to the year after the last covered one.

## Balance: only when you refresh

The plugin never queries the balance on its own. The card shows the last number you fetched with ⟳ (kept in browser `localStorage`), or — if you never did. Pressing ⟳ calls `/user/balance` once with your API key and caches the result locally.

## Install

Requires DSH `0.2.1-rc.2` – `<0.3.0`.

```bash
dsh plugin --profile desktop add dsh-price-chip
```

Or from the repository:

```bash
dsh plugin --profile desktop add github:JNightDS/dsh-price-chip
```

Refresh the page after installing. Remove with:

```bash
dsh plugin --profile desktop remove dsh-price-chip
```

## Configuration

Add `config` to the plugin row in the profile's `cordis.patch.yml` and restart DSH:

```yaml
- insert:
    - id: price-chip
      name: 'dsh-price-chip'
      config:
        defaultMode: floating      # floating | sidebar
        defaultLayout: horizontal  # horizontal | vertical
        pinnedByDefault: false
        refreshSeconds: 60         # 15–3600, card refresh only
        apiKeyRef: DEEPSEEK_API_KEY
        baseURL: https://api.deepseek.com
        priceSync: true
        holidaySync: true
        calendarWarnDays: 45
```

## Data and privacy

UI preferences and the last balance live in browser `localStorage`. On the host side the plugin writes one small cache file:

```
~/.dsh/price-chip/cache.json   (~3 KB: price snapshot + holiday years)
```

Deleting it only forces a re-sync on the next start. Outbound requests: the pricing page and holiday JSON (when the cache is stale), plus `/user/balance` when you press ⟳.

## Known limits

- If the pricing page changes structure, parsing fails and the cached/built-in table is used until the parser is updated.
- Holiday data for 2028 and later appears after the State Council publishes it; until then those years fall back to weekday logic.
- The expiry reminder relies on the model acting on the prompt note and calling the tool.

## License

MIT
