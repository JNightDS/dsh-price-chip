# dsh-price-chip · DeepSeek 峰谷价签

用于显示当前 API 价格：输入输出具体价格、峰时或谷时、切价倒计时，并显示您的账户余额。

悬浮窗模式：可自由拖动，也可以放在合适的位置后点击按钮固定位置。悬浮窗可切换横版和竖版。
侧边栏模式：固定在左侧侧边栏预设位置处。

## 卡片上有什么

- 峰时、谷时用颜色分开，倍率直接写 ×1 / ×0.5
- 倒计时结束后，自动刷新价格
- 三档单价：输入、缓存命中、输出，单位是元 / 百万 tokens
- 账户余额（不自动联网查，见下）

四个按钮：换位置（悬浮窗 ↔ 侧栏）、切换是否固定、切换横竖、刷新余额。

## 峰谷和价格

高峰是北京时间周一到周五 09:00–12:00、14:00–18:00，其余时间都算谷时，周末和法定节假日整天也是谷价。

插件会从 DeepSeek 官方价格页抓当前价目，解析出来存进本地缓存。一周内重启都复用缓存，超过一周才重新抓取。抓不到或页面结构变了解析不出来，就退回缓存或内置表。

## 节假日表怎么跟上

放假安排是每年公布的，所以插件按「整年」处理：

- 拉取本年和次年的数据（来源是 `NateScarlet/holiday-cn` 的年度 JSON，走 jsDelivr 镜像），合并写入内置表格。
- 拉取到某年的数据后写进缓存，同一年不会重复拉取。
- 表快到期时（默认剩余 45 天内），插件会给模型一段提示，让它去补下一年的法定节假日信息。

`price_chip` 工具：用来查看数据状态——单价来自哪里、什么时候同步的、节假日表覆盖到哪一年、还剩几天；也可以用它补拉某一年的节假日表，默认取当前覆盖年份的下一年。

## 余额：只在你点刷新时查询

插件**不会自动联网查余额**。卡片上显示的是上一次你点 ⟳ 时拿到的数字（存在浏览器本地），没查过就显示 —。点 ⟳ 会用你的 API key 调一次 `/user/balance`，结果同时写进本地缓存。

## 安装

要求 DSH 0.2.1-rc.2 及以上、0.3.0 以下。

```bash
dsh plugin --profile desktop add dsh-price-chip
```

从仓库装：

```bash
dsh plugin --profile desktop add github:JNightDS/dsh-price-chip
```

装完刷新页面。卸载：

```bash
dsh plugin --profile desktop remove dsh-price-chip
```

## 配置

在 profile 的 cordis.patch.yml 里给插件行加 config，改完重启 Harness：

```yaml
- insert:
    - id: price-chip
      name: 'dsh-price-chip'
      config:
        defaultMode: floating
        defaultLayout: horizontal
        pinnedByDefault: false
        refreshSeconds: 60
        apiKeyRef: DEEPSEEK_API_KEY
        baseURL: https://api.deepseek.com
        priceSync: true
        holidaySync: true
        calendarWarnDays: 45
```

| 字段 | 默认 | 说明 |
|---|---|---|
| defaultMode | floating | 第一次打开放在哪：floating 悬浮窗，sidebar 侧栏 |
| defaultLayout | horizontal | 悬浮窗默认排版 |
| pinnedByDefault | false | 悬浮窗默认是否固定 |
| refreshSeconds | 60 | 卡片自动刷新间隔，15–3600 秒（只刷新峰谷与单价，不查余额） |
| apiKeyRef | DEEPSEEK_API_KEY | 查余额用的凭据名 |
| baseURL | https://api.deepseek.com | API 地址，也可以用 DEEPSEEK_BASE_URL 覆盖 |
| priceSync | true | 启用价格同步（缓存过期才抓） |
| priceUrl | 官方价格页 | 价格同步地址 |
| holidaySync | true | 启用节假日按年同步 |
| holidayUrl | jsDelivr 的 holiday-cn | 节假日 JSON 地址模板，{year} 会被替换 |
| calendarWarnDays | 45 | 剩余多少天以内开始提醒模型补下一年 |

## 数据与隐私

偏好（位置、排版、固定状态、停在哪里）只存在浏览器本地；余额数字也缓存在浏览器本地。

宿主侧只写一个缓存文件：

```
~/.dsh/price-chip/cache.json   （约 3 KB：价格快照 + 各年节假日）
```

删掉它只会让下次启动重新联网同步，不影响使用。对外请求：价格页与节假日 JSON（缓存过期时）、以及你点 ⟳ 时的 `/user/balance`。

## 已知限制

- 官方价格页改版后解析可能失败，此时退回缓存/内置表，需要跟着更新解析规则。
- 2028 年及之后的放假安排要等国务院公布后才有，公布前那一年按星期判断。
- 「到期提醒」依赖模型看到提示后主动调用工具；不调用的话，跨年那几天会按星期判断。

## 目录结构

| 文件 | 作用 |
|---|---|
| index.js | 宿主半：价格解析与缓存、峰谷判断、节假日按年同步、余额、/price-chip/state、price_chip 工具、到期提醒 |
| client.js | 界面半：悬浮窗 / 侧栏卡、共享数据轮询、按钮、排版、拖动与偏好存储 |
| cordis.patch.yml | 插件行与默认配置 |
| icon.svg / locale | 市场显示用的图标与文案 |

## License

MIT
