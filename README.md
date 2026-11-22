# Thread Peek

Chrome/Edge extension (Manifest V3) that adds a **TL;DR** button to every post on x.com.
Click it and the whole thread is fetched in the background and summarized in a card
right under the post, so you never have to open the thread.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Open x.com (logged in) and click **TL;DR** under any post.

## What the card shows

- 🧵 post count, author, reading time saved
- **TL;DR** + 3–7 key points
- links the author shared
- "Read all N posts here": the full thread inline
- top replies; for a single post (not a thread) it summarizes the replies instead
- copy summary / open thread

## Summarizer engines (toolbar icon → settings)

| Engine | Needs | Notes |
|---|---|---|
| Auto (default) | nothing | On-device model if Chrome already has it, else Local |
| Local extractive | nothing | TF-IDF + TextRank + redundancy cut. Offline, instant, no AI |
| Chrome on-device | Chrome 138+, capable GPU/RAM | Gemini Nano via the built-in `Summarizer` API |
| Claude | Anthropic API key | Best quality; one API call per summary |

## How the thread is fetched

The content script calls X's own web GraphQL endpoint (`TweetDetail`) with your logged-in
session, the same request x.com makes when you open a post, and follows "show more"
cursors until the author's chain stops growing. X rotates the query id and feature
flags with each deploy, so the background worker:

1. records them from x.com's own `TweetDetail` requests (open any post once), else
2. reads them from X's `main.js` bundle, and
3. adds any feature flag X says is missing and retries.

If X changes its response layout, `src/parse.js` is the place to adjust.

## Tests

```
node --test test/
```
