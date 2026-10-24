// Read-only MCP tools over the daily news exports that GitHub Pages serves as static JSON
// (news/<date>.json). Deliberately minimal: each call reads at most one day's file directly, with
// no index lookup and no search. `fetchJson(path)` is injected (resolving null for a missing file)
// so the Worker can add edge caching and tests can serve fixtures; `now` is injectable for tests.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const articleSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    source: { type: 'string' },
    url: { type: 'string' },
    published_at: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['title', 'url'],
};

const videoSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    channel: { type: 'string' },
    url: { type: 'string' },
    published_at: { type: 'string' },
  },
  required: ['title', 'url'],
};

const topicSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    summary: { type: 'string' },
    category: { type: 'string' },
    section: { type: 'string', enum: ['world', 'politics', 'business', 'technology', 'science-health', 'sports', 'culture'] },
    source_count: { type: 'integer' },
    article_count: { type: 'integer' },
    articles: { type: 'array', items: articleSchema },
    videos: { type: 'array', items: videoSchema },
  },
  required: ['id', 'title'],
};

export const TOOLS = [
  {
    name: 'get_daily_news',
    title: 'Get daily news briefing',
    description: 'Get the news briefing for one day: overview bullet points and up to 15 top topics, each with an '
      + 'English title, summary, section (world, politics, business, technology, science-health, sports, culture), '
      + 'links to the covering articles and any matching news videos. Defaults to today (UTC); a day\'s '
      + 'briefing is published the morning after, so until then today falls back to yesterday.',
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Day (YYYY-MM-DD, UTC); omit for today.' } },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string' },
        generated_at: { type: 'string' },
        overview: {
          type: 'array',
          items: { type: 'object', properties: { text: { type: 'string' }, topic_ids: { type: 'array', items: { type: 'string' } } }, required: ['text'] },
        },
        topics: { type: 'array', items: topicSummarySchema },
      },
      required: ['date', 'overview', 'topics'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'get_topic',
    title: 'Get topic details',
    description: 'Get one topic of a day in full, including article descriptions, entities and keywords.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        topic_id: { type: 'string', description: 'Topic id from get_daily_news for the same date.' },
      },
      required: ['date', 'topic_id'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string' },
        topic: {
          type: 'object',
          properties: {
            ...topicSummarySchema.properties,
            headline: { type: 'string' },
            entities: { type: 'array', items: { type: 'string' } },
            keywords: { type: 'array', items: { type: 'string' } },
            rank: { type: 'integer', description: 'Position in that day\'s briefing (1 = top story).' },
          },
          required: ['id', 'title'],
        },
      },
      required: ['date', 'topic'],
    },
    annotations: READ_ONLY,
  },
];

/** A tool execution error: reported to the model as `isError: true`, not as a protocol error. */
export class ToolInputError extends Error {}

const article = ({ title, source, url, published_at: publishedAt }) => ({ title, source, url, published_at: publishedAt });
const video = ({ title, channel, url, published_at: publishedAt }) => ({ title, channel, url, published_at: publishedAt });

function topicSummary(topic) {
  return {
    id: topic.id,
    title: topic.title,
    summary: topic.summary || '',
    category: topic.category,
    ...(topic.section ? { section: topic.section } : {}),
    source_count: topic.source_count,
    article_count: topic.article_count,
    articles: (topic.articles || []).map(article),
    videos: (topic.videos || []).map(video),
  };
}

const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

/** Load one day's export: the given date, or today with a fallback to yesterday (one parallel round trip). */
async function loadDay(fetchJson, date, now = Date.now()) {
  const today = isoDay(now);
  if (date === undefined) {
    const yesterday = isoDay(now - DAY_MS);
    const [todayDay, yesterdayDay] = await Promise.all([fetchJson(`${today}.json`), fetchJson(`${yesterday}.json`)]);
    if (todayDay) return { date: today, day: todayDay };
    if (yesterdayDay) return { date: yesterday, day: yesterdayDay };
    throw new ToolInputError(`No briefing for ${today} or ${yesterday} yet; pass an earlier date.`);
  }
  if (typeof date !== 'string' || !DATE_RE.test(date)) throw new ToolInputError('date must be formatted YYYY-MM-DD.');
  if (date > today) throw new ToolInputError(`${date} is in the future (today is ${today} UTC).`);
  const day = await fetchJson(`${date}.json`);
  if (!day) throw new ToolInputError(`No briefing for ${date}. A day's briefing is published the morning after (UTC).`);
  return { date, day };
}

const handlers = {
  async get_daily_news(args, { fetchJson, now }) {
    const { date, day } = await loadDay(fetchJson, args.date, now);
    const topics = day.topics || [];
    // Overview points reference topics by 1-based position ("stories").
    const overview = (day.overview?.points || []).map(point => ({
      text: point.text,
      topic_ids: (point.stories || []).map(n => topics[n - 1]?.id).filter(Boolean),
    }));
    return { date, generated_at: day.generated_at, overview, topics: topics.map(topicSummary) };
  },

  async get_topic(args, { fetchJson, now }) {
    if (typeof args.date !== 'string') throw new ToolInputError('date is required.');
    if (typeof args.topic_id !== 'string' || !args.topic_id) throw new ToolInputError('topic_id is required.');
    const { date, day } = await loadDay(fetchJson, args.date, now);
    const index = (day.topics || []).findIndex(t => t.id === args.topic_id);
    const topic = day.topics?.[index];
    if (!topic) throw new ToolInputError(`No topic ${args.topic_id} on ${date}; call get_daily_news for that date to see its topic ids.`);
    return {
      date,
      topic: {
        ...topicSummary(topic),
        rank: index + 1,
        headline: topic.headline,
        entities: topic.entities || [],
        keywords: topic.label || [],
        articles: (topic.articles || []).map(a => ({ ...article(a), description: a.description || '' })),
      },
    };
  },
};

export const hasTool = name => Object.hasOwn(handlers, name);

/** Run a tool; returns a CallToolResult (without resultType). Unknown tools must be checked with hasTool first. */
export async function callTool(name, args, context) {
  try {
    const structuredContent = await handlers[name](args || {}, context);
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, isError: false };
  } catch (err) {
    const text = err instanceof ToolInputError ? err.message : `Could not load the news data: ${err.message}`;
    return { content: [{ type: 'text', text }], isError: true };
  }
}
