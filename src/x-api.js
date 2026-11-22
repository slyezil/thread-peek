// Fetches a whole thread through X's own web GraphQL endpoint (TweetDetail),
// using the session you're already logged into. Runs in the content script so
// requests are same-origin and carry your cookies.
(function (root) {
  // X's public web-client bearer (the same one x.com ships in its JS bundle).
  // Overridden by the one captured from live traffic when available.
  const FALLBACK_BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const DEFAULT_VARIABLES = {
    with_rux_injections: false,
    rankingMode: 'Relevance',
    includePromotedContent: false,
    withCommunity: true,
    withQuickPromoteEligibilityTweetFields: false,
    withBirdwatchNotes: true,
    withVoice: true,
  };

  const DEFAULT_FEATURES = {
    rweb_video_screen_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_enhance_cards_enabled: false,
  };

  const DEFAULT_TOGGLES = {
    withArticleRichContentState: true,
    withArticlePlainText: false,
    withGrokAnalyze: false,
    withDisallowedReplyControls: false,
  };

  const cookie = (name) => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  };

  function mainJsUrl() {
    const s = [...document.scripts].find((s) => /\/client-web\/main\.[\w.]+\.js/.test(s.src));
    if (s) return s.src;
    const r = performance.getEntriesByType('resource').find((e) => /\/client-web\/main\.[\w.]+\.js/.test(e.name));
    return r ? r.name : null;
  }

  let templatePromise = null;
  function getTemplate(force) {
    if (!templatePromise || force) {
      templatePromise = chrome.runtime
        .sendMessage({ type: 'getTemplate', mainJs: mainJsUrl(), force: !!force })
        .then((t) => {
          if (!t || !t.queryId) throw new Error("Couldn't find X's TweetDetail API id. Open any post once, then retry.");
          return t;
        })
        .catch((e) => {
          templatePromise = null;
          throw e;
        });
    }
    return templatePromise;
  }

  function buildFeatures(tpl) {
    const f = { ...DEFAULT_FEATURES };
    for (const name of tpl.featureNames || []) if (!(name in f)) f[name] = true;
    return { ...f, ...(tpl.features || {}) };
  }

  async function query(vars, extraFeatures, retried) {
    const tpl = await getTemplate(retried === 'stale');
    const ct0 = cookie('ct0');
    if (!ct0) throw new Error('Log in to X first — Thread Peek reads threads with your session.');

    const variables = { ...DEFAULT_VARIABLES, ...(tpl.variables || {}), ...vars };
    const features = { ...buildFeatures(tpl), ...(extraFeatures || {}) };
    const toggles = { ...DEFAULT_TOGGLES, ...(tpl.fieldToggles || {}) };
    const qs = (o) => encodeURIComponent(JSON.stringify(o));
    const url =
      `${location.origin}/i/api/graphql/${tpl.queryId}/TweetDetail` +
      `?variables=${qs(variables)}&features=${qs(features)}&fieldToggles=${qs(toggles)}`;

    const res = await fetch(url, {
      credentials: 'include',
      headers: {
        authorization: 'Bearer ' + (tpl.bearer || FALLBACK_BEARER),
        'x-csrf-token': ct0,
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-client-language': document.documentElement.lang || 'en',
        'content-type': 'application/json',
        'x-thread-peek': '1', // lets the background ignore our own requests
      },
    });

    if (res.status === 400 && !retried) {
      // X rejects requests missing a feature flag and names them; add and retry.
      const body = await res.json().catch(() => ({}));
      const msg = ((body.errors || [])[0] || {}).message || '';
      const m = msg.match(/cannot be null:\s*(.+)$/);
      if (m) {
        const more = {};
        for (const n of m[1].split(',')) more[n.trim()] = true;
        return query(vars, { ...(extraFeatures || {}), ...more }, 'features');
      }
      throw new Error('X rejected the request: ' + (msg || res.status));
    }
    if (res.status === 404 && !retried) return query(vars, extraFeatures, 'stale');
    if (res.status === 429) throw new Error('X rate limit hit — wait a minute and try again.');
    if (!res.ok) throw new Error(`X returned HTTP ${res.status}`);
    return res.json();
  }

  // Fetch the thread containing `tweetId`. Pages through "show more" cursors
  // until the author's chain stops growing.
  async function fetchThread(tweetId, opts) {
    const maxPages = (opts && opts.maxPages) || 8;
    const acc = { tweets: new Map(), cursors: [] };
    const merge = (json) => {
      const page = TPParse.collect(json, { tweets: acc.tweets, cursors: [] });
      acc.cursors.push(...page.cursors);
      return page.cursors;
    };

    merge(await query({ focalTweetId: tweetId }));
    const focal = acc.tweets.get(tweetId);
    let rootId = (focal && focal.conv) || tweetId;
    let focalId = tweetId;
    if (rootId !== tweetId) {
      // Clicked mid-thread: re-anchor on the first post so we get the whole chain.
      acc.cursors = [];
      merge(await query({ focalTweetId: rootId }));
      focalId = rootId;
    }
    if (!acc.tweets.has(rootId)) rootId = tweetId; // root deleted / hidden

    const used = new Set();
    const authorCount = () => {
      const t = TPParse.buildThread(acc.tweets, rootId);
      return t ? t.tweets.length : 0;
    };
    for (let i = 0; i < maxPages; i++) {
      const next =
        acc.cursors.find((c) => /ShowMore/i.test(c.type) && !used.has(c.value)) ||
        acc.cursors.find((c) => c.type === 'Bottom' && !used.has(c.value));
      if (!next) break;
      used.add(next.value);
      const before = authorCount();
      merge(await query({ focalTweetId: focalId, cursor: next.value, referrer: 'tweet' }));
      if (next.type === 'Bottom' && authorCount() === before) break;
    }

    const thread = TPParse.buildThread(acc.tweets, rootId);
    if (!thread) throw new Error('That post is unavailable.');
    return thread;
  }

  root.TPX = { fetchThread };
})(globalThis);
