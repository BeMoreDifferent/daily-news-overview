# Daily News MCP server

Endpoint: `https://daily-news-mcp.bemoredifferent.workers.dev/mcp` (Streamable HTTP, no auth)

GitHub Pages only serves GET, and MCP requires every message to be an HTTP POST, so Pages alone
cannot be an MCP server. This Cloudflare Worker is a stateless MCP endpoint (protocol 2026-07-28,
plus legacy 2025-03-26 – 2025-11-25 clients through a session-less `initialize`) that reads the
static `news/*.json` from Pages. GitHub stays the source of truth and nothing needs to be redeployed
when new days are published.

Tools (read-only, deliberately barebone: no date listing, no search):

- `get_daily_news` — one day's briefing; `date` (YYYY-MM-DD, UTC) defaults to today. A day is
  published the morning after, so until then today falls back to yesterday (both fetched in parallel).
- `get_topic` — one story of a given date in full.

Each call reads one `news/<date>.json` directly; `news/index.json` is never needed.

## Connect

```bash
claude mcp add --transport http daily-news https://daily-news-mcp.bemoredifferent.workers.dev/mcp
```

In claude.ai, add it under Settings → Connectors → Add custom connector with the same URL.

## Develop and deploy

```bash
npm install           # in mcp/
npm run dev           # local worker on :8787 (reads live Pages data)
npm run deploy        # uses CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN from ../.env
npm test              # repo root: test/mcpServer.test.js
```

## Free plan and latency

- The Workers Free plan allows 100k requests/day and 10 ms CPU per request. Parsed exports are
  memoized per isolate (up to 40 files) and subrequests are edge-cached (10 min for recent days,
  missing days included, and 1 day for older ones), so warm calls skip both the fetch and `JSON.parse`.
- `tools/call` is rate limited to 60/min per IP (Workers rate-limit binding).
- Only Workers, vars and the rate-limit binding are used: no KV, Durable Objects or other billed products.

## Google Analytics 4

Usage is measured server-side with the GA4 Measurement Protocol (`src/analytics.js`). Events go
out after the response (`ctx.waitUntil`), so they add no latency, and nothing is sent unless both
`GA_MEASUREMENT_ID` and `GA_API_SECRET` are set as Worker secrets.

**No personal data.** No IP address, User-Agent, cookie or person-level id is forwarded.
`client_id` is a hash of the *client product* (e.g. "Claude Code"), so in GA4 **Users = distinct
client applications**, not people. Unknown client names become "other". Location is the country
only. Tool arguments are dates and topic ids only, so no free text is ever reported. Ad consent is
DENIED, and data is collected through the EU endpoint.

| Event | When | Key parameters |
|---|---|---|
| `page_view` | every JSON-RPC request | `page_location` = `/mcp/tools/<tool>` or `/mcp/<method>`, `mcp_*`, `outcome` |
| `mcp_connect` | `initialize`, `server/discover` | `mcp_era`, `protocol_version`, `mcp_client` |
| `mcp_tool_call` | every `tools/call` | `tool_name`, `outcome`, `latency_ms`, `result_count` |
| `view_item_list` | `get_daily_news` | `items` = the day's stories, `item_list_id` = date, `days_ago` |
| `select_item` | `get_topic` | `items` + the website's `story_*` parameters |
| `mcp_error` | protocol errors | `error_code`, `http_status` |

Every event carries `session_id` (30-minute window per client app) and `engagement_time_msec`
(server time), so Realtime, Pages and screens, Events, Tech (Browser = client software, Device
model = "MCP client"), Demographics (country) and Explorations all work. MCP traffic runs on its own
web data stream "MCP server" in the site's property: filter on **Stream name** to separate it from
the website.

Setup (once):

1. In `.env` set `GA_PROPERTY_ID` (GA Admin → Property details) and run `npm run ga:setup` in
   `mcp/` with `GA_ADMIN_TOKEN=<OAuth token with analytics.edit scope>`. This creates the stream,
   the API secret and every custom dimension and metric, and writes the ids to `.env`.
   - Without a token, do the same steps by hand in GA Admin. Data streams → Add web stream
     "MCP server" → Measurement Protocol API secrets → Create. Then register the custom
     definitions listed in `scripts/setupGa4.js`.
2. `npm run ga:push` stores both values as Worker secrets (they take effect immediately).
3. Check Realtime in GA4 while calling a tool.
