// Stateless MCP over Streamable HTTP (protocol revision 2026-07-28), dual-era: modern clients
// send per-request `_meta` + mirrored headers; legacy clients (2025-03-26 .. 2025-11-25) open with
// `initialize`, which is answered without a session. Each POST carries one JSON-RPC message and
// gets one application/json reply; nothing here needs streaming or server-side state.

import { TOOLS, callTool, hasTool } from './tools.js';

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

export const SERVER_INFO = { name: 'daily-news-overview', title: 'Daily News Overview', version: '1.0.0' };
const INSTRUCTIONS = 'Daily world news briefings clustered from 2400+ RSS feeds, one per day (UTC). '
  + 'Call get_daily_news (today by default, or any past date) and get_topic for article details. '
  + 'Data is read-only and public.';

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';

const MAX_BODY_BYTES = 64 * 1024;
const LIST_TTL_MS = 60 * 60 * 1000;
const NAMED_METHODS = { 'tools/call': 'name', 'resources/read': 'uri', 'prompts/get': 'name' };

const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_VERSION: -32022,
};

class RpcError extends Error {
  constructor(status, code, message, data) {
    super(message);
    Object.assign(this, { status, code, data });
  }
}

function json(status, payload, headers = {}) {
  return new Response(payload === undefined ? null : JSON.stringify(payload), {
    status,
    headers: payload === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
  });
}

const rpcError = (id, err) => json(err.status, {
  jsonrpc: '2.0',
  ...(id !== undefined && id !== null ? { id } : {}),
  error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) },
});

// `=?base64?…?=` carries header values that are not plain ASCII (spec: Value Encoding).
export function decodeHeaderValue(value) {
  const m = /^=\?base64\?(.*)\?=$/.exec(value);
  if (!m) return value;
  try {
    const bytes = Uint8Array.from(atob(m[1]), c => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function originAllowed(origin, allowedOrigins) {
  return !origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * Decide which era the request belongs to and enforce the 2026-07-28 header/body rules.
 * Returns the protocol version the request is served under.
 */
function negotiate(message, headers) {
  const meta = message.params?._meta;
  const metaVersion = meta?.[META_VERSION];
  const headerVersion = headers.get('mcp-protocol-version');

  if (metaVersion === undefined) {
    // Legacy request (after a stateless `initialize`). Pre-2025-06-18 clients send no header.
    if (headerVersion && MODERN_VERSIONS.includes(headerVersion)) {
      throw new RpcError(400, ERR.INVALID_PARAMS, `Missing required _meta field ${META_VERSION}`);
    }
    if (headerVersion && !SUPPORTED_VERSIONS.includes(headerVersion)) {
      throw new RpcError(400, ERR.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: headerVersion });
    }
    return headerVersion || '2025-03-26';
  }

  if (!headerVersion) throw new RpcError(400, ERR.HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version header is required');
  if (headerVersion !== metaVersion) {
    throw new RpcError(400, ERR.HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version '${headerVersion}' does not match body '${metaVersion}'`);
  }
  if (!MODERN_VERSIONS.includes(metaVersion)) {
    throw new RpcError(400, ERR.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: metaVersion });
  }
  if (typeof meta[META_CAPABILITIES] !== 'object' || meta[META_CAPABILITIES] === null) {
    throw new RpcError(400, ERR.INVALID_PARAMS, `Missing required _meta field ${META_CAPABILITIES}`);
  }

  const methodHeader = headers.get('mcp-method');
  if (methodHeader === null) throw new RpcError(400, ERR.HEADER_MISMATCH, 'Header mismatch: Mcp-Method header is required');
  if (methodHeader !== message.method) {
    throw new RpcError(400, ERR.HEADER_MISMATCH, `Header mismatch: Mcp-Method header value '${methodHeader}' does not match body value '${message.method}'`);
  }
  const nameField = NAMED_METHODS[message.method];
  if (nameField) {
    const raw = headers.get('mcp-name');
    if (raw === null) throw new RpcError(400, ERR.HEADER_MISMATCH, 'Header mismatch: Mcp-Name header is required');
    const name = decodeHeaderValue(raw);
    if (name !== message.params?.[nameField]) {
      throw new RpcError(400, ERR.HEADER_MISMATCH, `Header mismatch: Mcp-Name header does not match body ${nameField}`);
    }
  }
  return metaVersion;
}

function initializeResult(params) {
  const requested = params?.protocolVersion;
  return {
    protocolVersion: LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0],
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  };
}

async function dispatch(message, modern, context) {
  const { method, params = {} } = message;
  switch (method) {
  case 'ping':
    return {};
  case 'server/discover':
    if (!modern) break;
    return {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
      ttlMs: LIST_TTL_MS,
      cacheScope: 'public',
    };
  case 'tools/list':
    return { tools: TOOLS, ...(modern ? { ttlMs: LIST_TTL_MS, cacheScope: 'public' } : {}) };
  case 'tools/call':
    if (typeof params.name !== 'string') throw new RpcError(200, ERR.INVALID_PARAMS, 'params.name must be a string');
    if (!hasTool(params.name)) throw new RpcError(200, ERR.INVALID_PARAMS, `Unknown tool: ${params.name}`);
    if (params.arguments !== undefined && (typeof params.arguments !== 'object' || params.arguments === null || Array.isArray(params.arguments))) {
      throw new RpcError(200, ERR.INVALID_PARAMS, 'params.arguments must be an object');
    }
    return callTool(params.name, params.arguments, context);
  }
  throw new RpcError(404, ERR.METHOD_NOT_FOUND, `Method not found: ${method}`);
}

async function handlePost(request, config, context) {
  const length = Number(request.headers.get('content-length') || 0);
  const text = length > MAX_BODY_BYTES ? null : await request.text();
  if (text === null || text.length > MAX_BODY_BYTES) {
    return rpcError(null, new RpcError(413, ERR.INVALID_REQUEST, 'Request body too large'));
  }

  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return rpcError(null, new RpcError(400, ERR.PARSE, 'Parse error'));
  }
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message?.id, new RpcError(400, ERR.INVALID_REQUEST, 'Body must be a single JSON-RPC 2.0 request or notification'));
  }

  const isNotification = !('id' in message);
  if (isNotification) return json(202);
  if (message.id === null || !['string', 'number'].includes(typeof message.id)) {
    return rpcError(null, new RpcError(400, ERR.INVALID_REQUEST, 'Request id must be a string or integer'));
  }

  const started = Date.now();
  const meta = message.params?._meta;
  const observation = {
    origin: new URL(request.url).origin,
    method: message.method,
    era: 'legacy',
    protocolVersion: meta?.[META_VERSION] || request.headers.get('mcp-protocol-version') || message.params?.protocolVersion,
    clientInfo: message.method === 'initialize' ? message.params?.clientInfo : meta?.[META_CLIENT_INFO],
    userAgent: request.headers.get('user-agent'),
    toolName: message.method === 'tools/call' && typeof message.params?.name === 'string' && hasTool(message.params.name) ? message.params.name : undefined,
  };
  const report = (fields, response) => {
    context.track?.({ ...observation, ...fields, httpStatus: response.status, durationMs: Date.now() - started });
    return response;
  };

  try {
    if (message.method === 'initialize') {
      return report({}, json(200, { jsonrpc: '2.0', id: message.id, result: initializeResult(message.params) }));
    }
    const version = negotiate(message, request.headers);
    const modern = MODERN_VERSIONS.includes(version);
    observation.era = modern ? 'modern' : 'legacy';
    observation.protocolVersion = version;
    if (context.rateLimit && message.method === 'tools/call' && !(await context.rateLimit(request))) {
      throw new RpcError(429, ERR.INTERNAL, 'Rate limit exceeded, retry in a minute');
    }
    const result = await dispatch(message, modern, context);
    const body = modern ? { resultType: 'complete', ...result, _meta: { [META_SERVER_INFO]: SERVER_INFO } } : result;
    const cacheable = modern && ['server/discover', 'tools/list'].includes(message.method);
    return report(
      { result: message.method === 'tools/call' ? result : undefined },
      json(200, { jsonrpc: '2.0', id: message.id, result: body }, cacheable ? { 'Cache-Control': `public, max-age=${LIST_TTL_MS / 1000}` } : {}),
    );
  } catch (err) {
    const rpc = err instanceof RpcError ? err : new RpcError(500, ERR.INTERNAL, 'Internal error');
    return report({ errorCode: rpc.code }, rpcError(message.id, rpc));
  }
}

export function serverCard(endpointUrl) {
  return {
    name: SERVER_INFO.name,
    title: SERVER_INFO.title,
    version: SERVER_INFO.version,
    description: INSTRUCTIONS,
    supportedProtocolVersions: SUPPORTED_VERSIONS,
    remotes: [{ type: 'streamable-http', url: endpointUrl }],
    capabilities: { tools: {} },
    authentication: { required: false },
  };
}

/**
 * Handle one HTTP request. `config`: { allowedOrigins: string[] }.
 * `context`: { fetchJson(path) -> Promise<any>, rateLimit?(request) -> Promise<boolean>,
 *              track?(observation) — called once per JSON-RPC request, after the response is built }.
 */
export async function handleRequest(request, config, context) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');

  if (url.pathname === '/.well-known/mcp/server-card.json' && request.method === 'GET') {
    return json(200, serverCard(`${url.origin}/mcp`), { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
  }
  if (url.pathname === '/' && request.method === 'GET') {
    return json(200, { ...SERVER_INFO, mcp_endpoint: `${url.origin}/mcp`, transport: 'streamable-http', protocol_versions: SUPPORTED_VERSIONS });
  }
  if (url.pathname !== '/mcp') return json(404, { error: 'Not found' });

  // DNS-rebinding guard: a browser Origin must be on the allowlist; server-side clients send none.
  if (!originAllowed(origin, config.allowedOrigins)) {
    return rpcError(null, new RpcError(403, ERR.INVALID_REQUEST, 'Forbidden origin'));
  }
  const cors = corsHeaders(origin);

  let response;
  if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
  else if (request.method === 'POST') response = await handlePost(request, config, context);
  else response = new Response(null, { status: 405, headers: { Allow: 'POST, OPTIONS' } });

  for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
  return response;
}
