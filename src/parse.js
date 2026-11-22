// Turns X's TweetDetail GraphQL JSON into plain tweet objects and a thread.
// The walk is generic (find any `tweet_results` / cursor object) so it survives
// X reshuffling the timeline instruction layout.
(function (root) {
  const decode = (s) =>
    s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

  const cmpId = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

  function unwrap(r) {
    while (r && r.__typename === 'TweetWithVisibilityResults') r = r.tweet;
    return r;
  }

  const isXLink = (u) => /^https?:\/\/(www\.)?(x|twitter)\.com\//i.test(u);

  function normalizeTweet(raw) {
    const r = unwrap(raw);
    if (!r || !r.legacy) return null;
    const L = r.legacy;
    const user = (r.core && r.core.user_results && r.core.user_results.result) || {};
    const note = r.note_tweet && r.note_tweet.note_tweet_results && r.note_tweet.note_tweet_results.result;
    const entities = (note && note.entity_set) || L.entities || {};

    let text = (note && note.text) || L.full_text || '';
    const urls = [];
    for (const u of entities.urls || []) {
      if (!u.url) continue;
      const full = u.expanded_url || u.url;
      text = text.split(u.url).join(full);
      if (!isXLink(full)) urls.push(full);
    }
    const media = (L.extended_entities && L.extended_entities.media) || (L.entities && L.entities.media) || [];
    for (const m of media) if (m.url) text = text.split(m.url).join('');
    // Replies start with "@a @b " — that's routing, not content.
    text = decode(text).replace(/^(@\w+\s+)+/, '').trim();

    const q = unwrap(r.quoted_status_result && r.quoted_status_result.result);
    const quoted = q && q.legacy ? normalizeTweet(q) : null;

    return {
      id: r.rest_id || L.id_str,
      userId: L.user_id_str,
      screenName: (user.core && user.core.screen_name) || (user.legacy && user.legacy.screen_name) || '',
      name: (user.core && user.core.name) || (user.legacy && user.legacy.name) || '',
      text,
      replyTo: L.in_reply_to_status_id_str || null,
      conv: L.conversation_id_str || r.rest_id,
      createdAt: L.created_at || null,
      likes: L.favorite_count || 0,
      replyCount: L.reply_count || 0,
      urls,
      hasMedia: media.length > 0,
      quoted: quoted ? { screenName: quoted.screenName, text: quoted.text } : null,
    };
  }

  // Collect every tweet and cursor in a TweetDetail response into `out`.
  function collect(json, out) {
    out = out || { tweets: new Map(), cursors: [] };
    const stack = [json];
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n)) {
        for (let i = n.length - 1; i >= 0; i--) stack.push(n[i]);
        continue;
      }
      if (n.tweet_results) {
        const t = normalizeTweet(n.tweet_results.result);
        if (t && t.id && !out.tweets.has(t.id)) out.tweets.set(t.id, t);
        continue;
      }
      if (typeof n.cursorType === 'string' && typeof n.value === 'string') {
        out.cursors.push({ type: n.cursorType, value: n.value });
        continue;
      }
      for (const k in n) stack.push(n[k]);
    }
    return out;
  }

  // The thread = root tweet + every reply by the same author that chains back to it.
  function buildThread(tweets, rootId) {
    const root = tweets.get(rootId);
    if (!root) return null;
    const all = [...tweets.values()].filter((t) => t.conv === root.conv);
    const own = all.filter((t) => t.userId === root.userId && t.id !== root.id).sort((a, b) => cmpId(a.id, b.id));
    const ids = new Set([root.id]);
    const chain = [root];
    let added = true;
    while (added) {
      added = false;
      for (const t of own) {
        if (!ids.has(t.id) && ids.has(t.replyTo)) {
          ids.add(t.id);
          chain.push(t);
          added = true;
        }
      }
    }
    chain.sort((a, b) => cmpId(a.id, b.id));
    const replies = all.filter((t) => !ids.has(t.id) && t.userId !== root.userId).sort((a, b) => b.likes - a.likes);
    return {
      rootId: root.id,
      author: { screenName: root.screenName, name: root.name },
      tweets: chain,
      replies,
    };
  }

  const api = { normalizeTweet, collect, buildThread, cmpId };
  root.TPParse = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
