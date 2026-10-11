// GA4 usage measurement for the MCP server, sent server-side with the Measurement Protocol.
//
// Privacy by construction, so nothing here needs consent or reaches Google as personal data:
//  - No IP address, User-Agent string, cookie or per-person identifier is ever forwarded. Google
//    receives requests from Cloudflare, not from the client, and no `ip_override` is set.
//  - client_id identifies the MCP *client software* (e.g. "Claude Code"), never a person or device:
//    in GA4, "Users" therefore counts distinct client applications. Free-text client names are only
//    reported when they match a known product; anything else is "other".
//  - Location is the country only (from Cloudflare's own lookup), as `user_location.country_id`.
//  - Tool arguments are public news identifiers (dates, topic ids); there is no free-text input.
//  - Advertising consent is DENIED; data is collected through Google's EU endpoint.
//
// Event model (GA4 UI): every JSON-RPC request is a `page_view` on a virtual path such as
// /mcp/tools/get_daily_news, so Pages and screens, Realtime, engagement and Tech (browser = client
// software) reports work unchanged. Each view is paired with a specific event: mcp_connect,
// mcp_tool_call, view_item_list / select_item (items = stories, with the same story_*
// parameters the website sends) or mcp_error.

const GA_ENDPOINT = 'https://region1.google-analytics.com/mp/collect';
const SESSION_WINDOW_MS = 30 * 60 * 1000; // matches GA4's default session timeout
const MAX_VALUE = 100;

// Ordered: the first matching pattern names the client. Matched against clientInfo.name or User-Agent.
const KNOWN_CLIENTS = [
  [/claude[-_ ]?(code|cli)/i, 'Claude Code'],
  [/claude[-_ ]?desktop/i, 'Claude Desktop'],
  [/claude[-_.]?ai|anthropic/i, 'claude.ai'],
  [/claude/i, 'Claude'],
  [/inspector/i, 'MCP Inspector'],
  [/cursor/i, 'Cursor'],
  [/windsurf|codeium/i, 'Windsurf'],
  [/visual[-_ ]?studio[-_ ]?code|vscode|copilot/i, 'VS Code'],
  [/chatgpt|openai/i, 'ChatGPT'],
  [/gemini/i, 'Gemini'],
  [/jetbrains|intellij/i, 'JetBrains'],
  [/\bzed\b/i, 'Zed'],
  [/\bcline\b/i, 'Cline'],
  [/\bgoose\b/i, 'Goose'],
  [/continue/i, 'Continue'],
  [/mcp[-_]remote/i, 'mcp-remote'],
  [/\bn8n\b/i, 'n8n'],
  [/langchain|langgraph/i, 'LangChain'],
  [/mcp[-_ ]?(typescript|ts|js)[-_ ]?sdk|@modelcontextprotocol/i, 'MCP TypeScript SDK'],
  [/mcp[-_ ]?python|fastmcp/i, 'MCP Python SDK'],
  [/python|httpx|aiohttp/i, 'Python client'],
  [/\bnode\b|undici|axios/i, 'Node client'],
  [/\bcurl\b/i, 'curl'],
];

const clip = value => String(value ?? '').slice(0, MAX_VALUE);

// Method names and versions are client-supplied text: report only values defined by MCP.
const KNOWN_METHODS = new Set([
  'initialize', 'ping', 'server/discover', 'tools/list', 'tools/call', 'resources/list', 'resources/read',
  'resources/templates/list', 'prompts/list', 'prompts/get', 'completion/complete', 'logging/setLevel',
  'subscriptions/listen', 'resources/subscribe', 'resources/unsubscribe',
]);
const knownMethod = method => (KNOWN_METHODS.has(method) ? method : '(other)');
const knownVersion = version => (/^\d{4}-\d{2}-\d{2}$/.test(version || '') ? version : '(not set)');

/** Map free-text client identification to a known product name; never echo unknown text. */
export function normalizeClient(clientInfo, userAgent) {
  const candidates = [clientInfo?.name, clientInfo?.title, userAgent].filter(v => typeof v === 'string' && v);
  for (const text of candidates) {
    for (const [pattern, name] of KNOWN_CLIENTS) {
      if (!pattern.test(text)) continue;
      // Only a declared clientInfo version, reduced to major.minor, is reported.
      const m = text === clientInfo?.name || text === clientInfo?.title
        ? /^v?(\d{1,4})\.(\d{1,4})/.exec(String(clientInfo?.version || ''))
        : null;
      return { name, version: m ? `${m[1]}.${m[2]}` : '(not set)' };
    }
  }
  return { name: candidates.length ? 'other' : '(not set)', version: '(not set)' };
}

// Stable, non-reversible id per client product (FNV-1a), shaped like GA's own client ids.
function clientId(name) {
  let h = 0x811c9dc5;
  for (const ch of name) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return `${h}.1`;
}

function daysBetween(date, now) {
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t) ? undefined : Math.max(0, Math.floor((now - t) / 86400000));
}

function storyParams(date, topic, rank) {
  return {
    story_date: date,
    story_rank: rank,
    story_title: clip(topic.title),
    story_category: topic.category || 'none',
    story_keywords: clip((topic.keywords || []).slice(0, 4).join(' ')),
    story_outlets: topic.source_count,
  };
}

const item = (topic, index, date) => ({
  item_id: topic.id,
  item_name: clip(topic.title),
  item_category: topic.category || 'none',
  item_list_id: date,
  item_list_name: `Briefing ${date}`,
  index,
});

/**
 * Build one Measurement Protocol body for an observed request, or null when nothing is reported.
 * `obs`: { origin, method, era, protocolVersion, clientInfo, userAgent, country, toolName,
 *          result (CallToolResult), errorCode, httpStatus, durationMs, now }
 */
export function buildPayload(obs) {
  const now = obs.now ?? Date.now();
  const client = normalizeClient(obs.clientInfo, obs.userAgent);
  const method = knownMethod(obs.method);
  const isToolCall = method === 'tools/call' && obs.toolName;
  const outcome = obs.errorCode !== undefined ? 'protocol_error' : obs.result?.isError ? 'tool_error' : 'success';
  const data = obs.result && !obs.result.isError ? obs.result.structuredContent : undefined;
  const engagement = Math.max(1, Math.round(obs.durationMs || 0));

  const common = {
    session_id: String(Math.floor(now / SESSION_WINDOW_MS)),
    engagement_time_msec: engagement,
    mcp_method: method,
    mcp_client: client.name,
    mcp_client_version: client.version,
    mcp_era: obs.era,
    protocol_version: knownVersion(obs.protocolVersion),
    outcome,
  };
  const path = isToolCall ? `tools/${obs.toolName}` : method;
  const events = [{
    name: 'page_view',
    params: {
      ...common,
      page_location: clip(`${obs.origin}/mcp/${path}`),
      page_title: clip(isToolCall ? `MCP tool: ${obs.toolName}` : `MCP ${method}`),
    },
  }];

  if (outcome === 'protocol_error') {
    events.push({ name: 'mcp_error', params: { ...common, error_code: String(obs.errorCode), http_status: obs.httpStatus, tool_name: clip(obs.toolName || '(none)') } });
  } else if (method === 'initialize' || method === 'server/discover') {
    events.push({ name: 'mcp_connect', params: common });
  }

  if (isToolCall && outcome !== 'protocol_error') {
    const resultCount = data?.topics?.length ?? (data?.topic ? 1 : 0);
    events.push({
      name: 'mcp_tool_call',
      params: { ...common, tool_name: obs.toolName, latency_ms: engagement, result_count: resultCount },
    });

    if (obs.toolName === 'get_daily_news' && data) {
      events.push({
        name: 'view_item_list',
        params: {
          ...common,
          item_list_id: data.date,
          item_list_name: `Briefing ${data.date}`,
          story_date: data.date,
          days_ago: daysBetween(data.date, now),
          items: data.topics.map((topic, i) => item(topic, i, data.date)),
        },
      });
    } else if (obs.toolName === 'get_topic' && data) {
      events.push({
        name: 'select_item',
        params: {
          ...common,
          ...storyParams(data.date, data.topic, data.topic.rank),
          item_list_id: data.date,
          item_list_name: `Briefing ${data.date}`,
          content_type: 'story',
          days_ago: daysBetween(data.date, now),
          items: [item(data.topic, data.topic.rank - 1, data.date)],
        },
      });
    }
  }

  const body = {
    client_id: clientId(client.name),
    timestamp_micros: String(now * 1000),
    consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
    device: { model: 'MCP client', browser: client.name, browser_version: client.version },
    events,
  };
  if (typeof obs.country === 'string' && /^[A-Z]{2}$/.test(obs.country) && obs.country !== 'XX') {
    body.user_location = { country_id: obs.country };
  }
  return body;
}

/** POST a payload; failures are swallowed (analytics must never affect MCP responses). */
export async function sendPayload(body, { measurementId, apiSecret, fetchImpl = fetch, endpoint = GA_ENDPOINT }) {
  const url = `${endpoint}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
  try {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.ok;
  } catch {
    return false;
  }
}
