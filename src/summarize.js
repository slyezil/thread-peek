// Local, no-LLM extractive summarizer (TF-IDF + TextRank + MMR), plus an
// adapter for Chrome's built-in on-device Summarizer API when the machine supports it.
(function (root) {
  const STOP = new Set(
    ('a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just let like me more most my myself no nor not now of off on once only or other our ours ourselves out over own really same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves im ive dont doesnt didnt cant wont isnt thats theres its youre theyre weve one get got thing things lot way make made going go know think see say said want need use used new time much many even still every well back here thread')
      .split(' ')
  );

  const URL_RE = /https?:\/\/\S+/g;

  function clean(text) {
    return text
      .replace(URL_RE, '')
      .replace(/^\s*(\(?\d{1,3}\s*\/\s*(\d{1,3}|n)?\)?[.:)]?|\d{1,2}[.)])\s+/i, '') // "1/", "3/12", "(2/n)", "4."
      .replace(/(🧵|👇|⬇️|↓)+/g, '')
      .replace(/^\s*(a\s+)?thread\s*[:.]\s*/i, '')
      .replace(/\s*(\/end|end\/?|\(end\)|\/fin)\s*$/i, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  function sentences(text) {
    const out = [];
    for (const para of clean(text).split(/\n+/)) {
      for (const s of para.split(/(?<=[.!?…])\s+(?=\S)/)) {
        const t = s.trim();
        if (t.replace(/[^\p{L}\p{N}]/gu, '').length >= 3) out.push(t);
      }
    }
    return out;
  }

  function stem(w) {
    if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
    if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
    if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  }

  function tokens(s, surface) {
    return (s.toLowerCase().replace(/[’']/g, '').match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) || [])
      .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w))
      .map((w) => {
        const st = stem(w);
        if (surface && !surface.has(st)) surface.set(st, w);
        return st;
      });
  }

  function tfidf(docs) {
    const df = new Map();
    for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);
    const N = docs.length;
    return docs.map((d) => {
      const tf = new Map();
      for (const w of d) tf.set(w, (tf.get(w) || 0) + 1);
      const v = new Map();
      let norm = 0;
      for (const [w, c] of tf) {
        const x = (1 + Math.log(c)) * Math.log(1 + N / df.get(w));
        v.set(w, x);
        norm += x * x;
      }
      norm = Math.sqrt(norm) || 1;
      for (const [w, x] of v) v.set(w, x / norm);
      return v;
    });
  }

  function cos(a, b) {
    if (a.size > b.size) [a, b] = [b, a];
    let s = 0;
    for (const [w, x] of a) {
      const y = b.get(w);
      if (y) s += x * y;
    }
    return s;
  }

  function textRank(vecs, iters = 40, d = 0.85) {
    const n = vecs.length;
    const W = vecs.map((a, i) => vecs.map((b, j) => (i === j ? 0 : cos(a, b))));
    const out = W.map((row) => row.reduce((x, y) => x + y, 0) || 1);
    let r = new Array(n).fill(1 / n);
    for (let k = 0; k < iters; k++) {
      const nr = new Array(n).fill((1 - d) / n);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (W[j][i]) nr[i] += (d * W[j][i] * r[j]) / out[j];
      r = nr;
    }
    return { scores: r, W };
  }

  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);

  // posts: [{text}] in reading order. Returns {tldr, points, keywords}.
  function summarizeLocal(posts, opts) {
    const items = [];
    const surface = new Map();
    posts.forEach((p, pi) => sentences(p.text).forEach((s, si) => items.push({ s, pi, si, toks: tokens(s, surface) })));
    if (!items.length) return { tldr: '', points: [], keywords: [], engine: 'local' };
    if (items.length <= 3) {
      return { tldr: truncate(items[0].s, 240), points: items.slice(1).map((x) => truncate(x.s, 220)), keywords: [], engine: 'local' };
    }

    const vecs = tfidf(items.map((x) => x.toks));
    const { scores, W } = textRank(vecs);
    const lastPost = posts.length - 1;
    items.forEach((it, i) => {
      const words = it.s.split(/\s+/).length;
      let f = 1;
      if (words < 6) f *= 0.45;
      else if (words > 50) f *= 0.8;
      if (it.pi === 0 && it.si === 0) f *= 1.25; // hook usually states the topic
      if (it.pi === lastPost && posts.length > 2) f *= 1.1; // conclusion
      if (/\?$/.test(it.s)) f *= 0.8;
      if (/\b(follow|like|retweet|rt|subscribe|bookmark)\b.*\b(me|this|more)\b/i.test(it.s)) f *= 0.2; // CTA spam
      it.score = scores[i] * f;
    });

    const want = Math.max(3, Math.min(7, Math.round(items.length * ((opts && opts.ratio) || 0.25))));
    const chosen = [];
    const order = items.map((_, i) => i).sort((a, b) => items[b].score - items[a].score);
    for (const i of order) {
      if (chosen.length >= want + 1) break;
      if (chosen.some((j) => W[i][j] > 0.45)) continue; // MMR-style redundancy cut
      chosen.push(i);
    }
    const tldrIdx = chosen[0];
    const points = chosen
      .slice(1)
      .sort((a, b) => a - b)
      .map((i) => truncate(items[i].s, 220));

    const kw = new Map();
    for (const v of vecs) for (const [w, x] of v) kw.set(w, (kw.get(w) || 0) + x);
    const keywords = [...kw.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => surface.get(w) || w);

    return { tldr: truncate(items[tldrIdx].s, 240), points, keywords, engine: 'local' };
  }

  // ---- Chrome built-in AI (Gemini Nano, on-device) ------------------------
  // Needs Chrome 138+ and a capable GPU/RAM; we never trigger the model download
  // unless the user explicitly picked the on-device engine.
  let nano = null;
  async function summarizeOnDevice(text, { allowDownload, onProgress } = {}) {
    if (typeof Summarizer === 'undefined') throw new Error('Chrome on-device Summarizer not available');
    const avail = await Summarizer.availability();
    if (avail === 'unavailable') throw new Error('On-device model unsupported on this machine');
    if (avail !== 'available' && !allowDownload) throw new Error('On-device model not downloaded');
    if (!nano) {
      const monitor = (m) =>
        m.addEventListener('downloadprogress', (e) => onProgress && onProgress(Math.round(e.loaded * 100)));
      const base = { format: 'plain-text', sharedContext: 'Posts from a thread on X (Twitter).', monitor };
      nano = Promise.all([
        Summarizer.create({ ...base, type: 'tldr', length: 'short' }),
        Summarizer.create({ ...base, type: 'key-points', length: 'medium' }),
      ]).catch((e) => {
        nano = null;
        throw e;
      });
    }
    const [tl, kp] = await nano;
    let input = text;
    if (kp.inputQuota && kp.measureInputUsage) {
      while (input.length > 500 && (await kp.measureInputUsage(input)) > kp.inputQuota * 0.9) {
        input = input.slice(0, Math.floor(input.length * 0.8));
      }
    }
    const [tldr, points] = await Promise.all([tl.summarize(input), kp.summarize(input)]);
    return {
      tldr: tldr.trim(),
      points: points
        .split('\n')
        .map((l) => l.replace(/^[\s*•-]+/, '').trim())
        .filter(Boolean),
      engine: 'on-device (Gemini Nano)',
      truncated: input.length < text.length,
    };
  }

  const api = { summarizeLocal, summarizeOnDevice, sentences, clean, tokens };
  root.TPSum = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
