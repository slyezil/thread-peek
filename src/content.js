// Adds a "TL;DR" button to every post's action bar; clicking it fetches the
// thread in the background and renders a summary card inline.
(function () {
  const settings = { engine: 'auto', includeReplies: true };
  chrome.storage.local.get(['engine', 'includeReplies']).then((s) => Object.assign(settings, s));
  chrome.storage.onChanged.addListener((ch) => {
    for (const k of ['engine', 'includeReplies']) if (ch[k]) settings[k] = ch[k].newValue;
  });

  const threadCache = new Map(); // tweetId -> Promise<thread>
  const summaryCache = new Map(); // rootId|engine -> summary

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function tweetIdOf(article) {
    const a = [...article.querySelectorAll('a[href*="/status/"]')].find((a) => a.querySelector('time'));
    const m = a && a.getAttribute('href').match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  function isDark() {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    if (!m) return false;
    const [r, g, b] = m.map(Number);
    return 0.299 * r + 0.587 * g + 0.114 * b < 128;
  }

  function addButton(article) {
    if (article.querySelector(':scope .tp-btn')) return;
    const bars = article.querySelectorAll('[role="group"]');
    const bar = bars[bars.length - 1];
    const id = tweetIdOf(article);
    if (!bar || !id) return;
    const btn = el('button', 'tp-btn', 'TL;DR');
    btn.type = 'button';
    btn.title = 'Summarize this thread (Thread Peek)';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggle(article, bar, id);
    });
    bar.appendChild(btn);
  }

  function scan() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach(addButton);
  }

  async function getThread(id) {
    if (!threadCache.has(id)) {
      const p = TPX.fetchThread(id);
      threadCache.set(id, p);
      p.catch(() => threadCache.delete(id));
    }
    return threadCache.get(id);
  }

  async function runEngine(posts, kind, setStatus) {
    const text = posts
      .map((t, i) => (kind === 'thread' ? `[${i + 1}/${posts.length}] ${t.text}` : `@${t.screenName}: ${t.text}`))
      .join('\n\n');
    const eng = settings.engine;
    let note = '';

    if (eng === 'claude') {
      setStatus('Asking Claude…');
      const r = await chrome.runtime.sendMessage({ type: 'claude', text, kind });
      if (r && r.ok) return r.result;
      note = (r && r.error) || 'Claude request failed';
    }
    if (eng === 'auto' || eng === 'ondevice') {
      try {
        setStatus('Summarizing on-device…');
        return await TPSum.summarizeOnDevice(text, {
          allowDownload: eng === 'ondevice',
          onProgress: (p) => setStatus(`Downloading on-device model… ${p}%`),
        });
      } catch (e) {
        if (eng === 'ondevice') note = e.message;
      }
    }
    const r = TPSum.summarizeLocal(posts);
    if (note) r.note = note + ' — used the local summarizer instead.';
    return r;
  }

  async function summarize(thread, setStatus) {
    const isThread = thread.tweets.length > 1;
    const kind = isThread ? 'thread' : 'replies';
    const posts = isThread ? thread.tweets : settings.includeReplies ? thread.replies.slice(0, 40) : [];
    if (!posts.length) return null;
    const key = thread.rootId + '|' + kind + '|' + settings.engine;
    if (!summaryCache.has(key)) summaryCache.set(key, await runEngine(posts, kind, setStatus));
    return summaryCache.get(key);
  }

  async function toggle(article, bar, id) {
    const existing = article.querySelector(':scope .tp-card');
    if (existing) return existing.remove();

    const card = el('div', 'tp-card' + (isDark() ? ' tp-dark' : ''));
    // Keep clicks inside the card from opening the post (links still work).
    card.addEventListener('click', (e) => e.stopPropagation());
    const status = el('div', 'tp-status', 'Fetching thread…');
    card.appendChild(status);
    bar.insertAdjacentElement('afterend', card);
    const setStatus = (s) => (status.textContent = s);

    try {
      const thread = await getThread(id);
      const summary = await summarize(thread, setStatus);
      card.replaceChildren();
      render(card, thread, summary);
    } catch (e) {
      card.replaceChildren(el('div', 'tp-error', '⚠ ' + (e.message || e)));
      const retry = el('button', 'tp-link', 'Retry');
      retry.onclick = () => {
        card.remove();
        threadCache.delete(id);
        toggle(article, bar, id);
      };
      card.appendChild(retry);
    }
  }

  function render(card, thread, s) {
    const n = thread.tweets.length;
    const words = thread.tweets.reduce((a, t) => a + t.text.split(/\s+/).length, 0);
    const mins = Math.max(1, Math.round(words / 230));
    const isThread = n > 1;

    const head = el('div', 'tp-head');
    head.appendChild(
      el(
        'span',
        null,
        isThread
          ? `🧵 ${n} posts by @${thread.author.screenName} · ~${mins} min read`
          : `💬 Single post · ${thread.replies.length} replies loaded`
      )
    );
    if (s) head.appendChild(el('span', 'tp-engine', s.engine));
    const close = el('button', 'tp-x', '×');
    close.title = 'Close';
    close.onclick = () => card.remove();
    head.appendChild(close);
    card.appendChild(head);

    if (!s) {
      card.appendChild(el('div', 'tp-status', 'Not a thread, and no replies to summarize.'));
      return;
    }
    if (!isThread) card.appendChild(el('div', 'tp-sub', 'Not a thread — here’s what the replies say:'));
    if (s.note) card.appendChild(el('div', 'tp-note', s.note));
    if (s.truncated) card.appendChild(el('div', 'tp-note', 'Long thread: the on-device model only saw the first part.'));

    if (s.tldr) {
      const p = el('p', 'tp-tldr');
      p.appendChild(el('b', null, 'TL;DR '));
      p.appendChild(document.createTextNode(s.tldr));
      card.appendChild(p);
    }
    if (s.points && s.points.length) {
      const ul = el('ul', 'tp-points');
      for (const pt of s.points) ul.appendChild(el('li', null, pt));
      card.appendChild(ul);
    }
    if (s.keywords && s.keywords.length) card.appendChild(el('div', 'tp-kw', s.keywords.map((k) => '#' + k).join('  ')));

    const links = [...new Set(thread.tweets.flatMap((t) => t.urls))];
    if (links.length) {
      const box = el('div', 'tp-links');
      box.appendChild(el('span', null, '🔗 '));
      links.slice(0, 6).forEach((u, i) => {
        const a = el('a', null, new URL(u).hostname.replace(/^www\./, ''));
        a.href = u;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = u;
        box.appendChild(a);
        if (i < Math.min(links.length, 6) - 1) box.appendChild(document.createTextNode(' · '));
      });
      card.appendChild(box);
    }

    if (isThread) {
      const d = el('details', 'tp-all');
      d.appendChild(el('summary', null, `Read all ${n} posts here`));
      const ol = el('ol');
      for (const t of thread.tweets) {
        const li = el('li', null, t.text + (t.hasMedia ? ' 🖼' : ''));
        if (t.quoted) li.appendChild(el('blockquote', null, `@${t.quoted.screenName}: ${t.quoted.text}`));
        ol.appendChild(li);
      }
      d.appendChild(ol);
      card.appendChild(d);
    }

    if (isThread && settings.includeReplies && thread.replies.length) {
      const d = el('details', 'tp-all');
      d.appendChild(el('summary', null, `Top replies (${Math.min(5, thread.replies.length)})`));
      const ul = el('ul');
      for (const r of thread.replies.slice(0, 5)) ul.appendChild(el('li', null, `@${r.screenName} (♥ ${r.likes}): ${r.text}`));
      d.appendChild(ul);
      card.appendChild(d);
    }

    const foot = el('div', 'tp-foot');
    const copy = el('button', 'tp-link', 'Copy summary');
    copy.onclick = async () => {
      const txt = `TL;DR: ${s.tldr}\n${(s.points || []).map((p) => '- ' + p).join('\n')}\n${location.origin}/${thread.author.screenName}/status/${thread.rootId}`;
      await navigator.clipboard.writeText(txt);
      copy.textContent = 'Copied ✓';
    };
    const open = el('a', 'tp-link', 'Open thread ↗');
    open.href = `/${thread.author.screenName}/status/${thread.rootId}`;
    foot.append(copy, open);
    card.appendChild(foot);
  }

  new MutationObserver(() => {
    clearTimeout(scan.t);
    scan.t = setTimeout(scan, 150);
  }).observe(document.body, { childList: true, subtree: true });
  scan();
})();
