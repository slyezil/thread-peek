// Service worker:
//  1. Watches x.com's own TweetDetail requests to learn the current GraphQL
//     query id, feature flags and bearer (X rotates these with deploys).
//  2. Falls back to scanning X's main.js bundle for the query id.
//  3. Calls the Claude API when that engine is selected (keeps the key out of the page).

const TEMPLATE_KEY = 'tdTemplate';

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details.url.includes('/TweetDetail')) return;
    const headers = details.requestHeaders || [];
    if (headers.some((h) => h.name.toLowerCase() === 'x-thread-peek')) return; // our own request
    try {
      const u = new URL(details.url);
      const queryId = u.pathname.split('/')[4];
      const parse = (k) => (u.searchParams.get(k) ? JSON.parse(u.searchParams.get(k)) : undefined);
      const variables = parse('variables') || {};
      delete variables.focalTweetId;
      delete variables.cursor;
      delete variables.referrer;
      const auth = headers.find((h) => h.name.toLowerCase() === 'authorization');
      chrome.storage.local.set({
        [TEMPLATE_KEY]: {
          source: 'captured',
          at: Date.now(),
          queryId,
          variables,
          features: parse('features'),
          fieldToggles: parse('fieldToggles'),
          bearer: auth ? auth.value.replace(/^Bearer\s+/i, '') : undefined,
        },
      });
    } catch (e) {
      // ignore malformed URLs
    }
  },
  { urls: ['https://x.com/i/api/graphql/*', 'https://twitter.com/i/api/graphql/*'] },
  ['requestHeaders']
);

async function discoverFromBundle(mainJs) {
  if (!mainJs || !/^https:\/\/abs\.twimg\.com\//.test(mainJs)) return null;
  const js = await (await fetch(mainJs)).text();
  const m = js.match(/queryId:"([\w-]+)",operationName:"TweetDetail"/);
  if (!m) return null;
  const tail = js.slice(m.index, m.index + 4000);
  const names = (re) => {
    const x = tail.match(re);
    return x ? [...x[1].matchAll(/"([\w]+)"/g)].map((y) => y[1]) : [];
  };
  return {
    source: 'bundle',
    at: Date.now(),
    queryId: m[1],
    featureNames: names(/featureSwitches:\[([^\]]*)\]/),
  };
}

async function getTemplate({ mainJs, force }) {
  const stored = (await chrome.storage.local.get(TEMPLATE_KEY))[TEMPLATE_KEY];
  if (stored && !force) return stored;
  const found = await discoverFromBundle(mainJs).catch(() => null);
  if (found) {
    // Keep a captured bearer if we had one.
    if (stored && stored.bearer) found.bearer = stored.bearer;
    await chrome.storage.local.set({ [TEMPLATE_KEY]: found });
    return found;
  }
  return stored || null;
}

// ---- Claude engine -------------------------------------------------------

const SYSTEM_PROMPT = `You summarize posts from X (Twitter) so the reader doesn't have to open them.
Reply in exactly this plain-text format and nothing else:
TL;DR: <one sentence, max 30 words>
- <key point>
- <key point>
Use 3 to 7 key points, each under 25 words, in the order the author makes them. Keep concrete numbers, names and claims. Do not add opinions or facts that are not in the posts.`;

async function claudeSummarize({ text, kind }) {
  const { apiKey, model } = await chrome.storage.local.get(['apiKey', 'model']);
  if (!apiKey) throw new Error('Add your Anthropic API key in Thread Peek settings.');
  const m = model || 'claude-opus-5-5';
  const canFallback = /^claude-(opus|sonnet|fable)-/.test(m);

  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2026-10-21',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (canFallback) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';

  const body = {
    model: m,
    max_tokens: 16000,
    output_config: { effort: 'low' },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content:
          (kind === 'replies'
            ? 'Summarize what people are saying in these replies to a post:\n\n'
            : 'Summarize this thread:\n\n') + text,
      },
    ],
  };
  if (canFallback) body.fallbacks = 'default';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error('Anthropic API key was rejected.');
    if (res.status === 429) throw new Error('Anthropic rate limit hit — try again shortly.');
    throw new Error('Claude API: ' + msg);
  }
  if (data.stop_reason === 'refusal') throw new Error('Claude declined to summarize this thread.');

  const out = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  let tldr = '';
  const points = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const t = line.match(/^TL;?DR:?\s*(.*)$/i);
    if (t) tldr = t[1];
    else if (/^[-*•]\s+/.test(line)) points.push(line.replace(/^[-*•]\s+/, ''));
  }
  if (!tldr && !points.length) tldr = out.trim();
  return { tldr, points, engine: 'Claude · ' + (data.model || m) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = async () => {
    if (msg.type === 'getTemplate') return getTemplate(msg);
    if (msg.type === 'claude') return claudeSummarize(msg);
    throw new Error('unknown message');
  };
  run().then(
    (r) => sendResponse(msg.type === 'getTemplate' ? r : { ok: true, result: r }),
    (e) => sendResponse(msg.type === 'getTemplate' ? null : { ok: false, error: String(e.message || e) })
  );
  return true;
});
