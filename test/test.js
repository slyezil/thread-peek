// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/parse.js');
const S = require('../src/summarize.js');

const user = (id, sn) => ({ rest_id: id, core: { screen_name: sn, name: sn.toUpperCase() }, legacy: {} });
let n = 1000;
function tw(id, uid, sn, text, replyTo, extra = {}) {
  return {
    __typename: 'Tweet',
    rest_id: id,
    core: { user_results: { result: user(uid, sn) } },
    legacy: {
      id_str: id, user_id_str: uid, full_text: text, conversation_id_str: '100',
      in_reply_to_status_id_str: replyTo, favorite_count: n--, reply_count: 0,
      entities: { urls: [] }, ...extra,
    },
  };
}
const item = (t) => ({ item: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result: t } } } });

// Shape of a real TweetDetail response: root entry, self-thread module, reply modules, cursors.
const thread = [
  'I spent 6 months building robots on an 8GB laptop. Here is what I learned 🧵',
  '1/ Simulation first. MuJoCo runs fine on a laptop CPU and saves you from breaking hardware.',
  '2/ Small policies win. A 2M parameter policy trained with PPO beat my 50M transformer on the real arm.',
  '3/ Data collection is the bottleneck, not compute. Teleoperation with a cheap leader arm gave me 200 demos in a weekend.',
  "4/ Domain randomization matters more than model size. Randomize friction, mass and camera pose or the sim-to-real gap kills you.",
  '5/ Log everything. I lost two weeks because I could not reproduce a good run. Seeds, configs, git hash.',
  'If this was useful, follow me for more and retweet the first post!',
];
const resp = {
  data: { threaded_conversation_with_injections_v2: { instructions: [{ type: 'TimelineAddEntries', entries: [
    { entryId: 'tweet-100', content: { itemContent: { tweet_results: { result: tw('100', 'u1', 'robo', thread[0], null) } } } },
    { entryId: 'conversationthread-101', content: { items: [
      item(tw('101', 'u1', 'robo', '@robo ' + thread[1] + ' https://t.co/abc', '100', { entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://mujoco.org' }] } })),
      item({ __typename: 'TweetWithVisibilityResults', tweet: tw('102', 'u1', 'robo', thread[2], '101') }),
      item(tw('103', 'u1', 'robo', thread[3], '102')),
      { item: { itemContent: { itemType: 'TimelineTimelineCursor', value: 'SHOWMORE1', cursorType: 'ShowMore' } } },
    ] } },
    { entryId: 'conversationthread-200', content: { items: [item(tw('200', 'u2', 'fan', 'Great thread &amp; very useful!', '100'))] } },
    { entryId: 'cursor-bottom-1', content: { entryType: 'TimelineTimelineCursor', value: 'BOTTOM1', cursorType: 'Bottom' } },
  ] }] } },
};
const page2 = { data: { x: [item(tw('104', 'u1', 'robo', thread[4], '103')), item(tw('105', 'u1', 'robo', thread[5], '104')), item(tw('106', 'u1', 'robo', thread[6], '105'))] } };

test('collect + buildThread follows the author chain across pages', () => {
  const acc = P.collect(resp);
  assert.deepStrictEqual(acc.cursors.map((c) => c.type).sort(), ['Bottom', 'ShowMore']);
  P.collect(page2, acc);
  const t = P.buildThread(acc.tweets, '100');
  assert.deepStrictEqual(t.tweets.map((x) => x.id), ['100', '101', '102', '103', '104', '105', '106']);
  assert.strictEqual(t.author.screenName, 'robo');
  assert.strictEqual(t.replies.length, 1);
  assert.strictEqual(t.replies[0].text, 'Great thread & very useful!');
  assert.ok(t.tweets[1].text.startsWith('1/ Simulation'), 'leading @mention stripped');
  assert.ok(t.tweets[1].text.endsWith('https://mujoco.org'), 't.co expanded');
  assert.deepStrictEqual(t.tweets[1].urls, ['https://mujoco.org']);
});

test('local summarizer picks substantive sentences and drops CTA', () => {
  const acc = P.collect(page2, P.collect(resp));
  const t = P.buildThread(acc.tweets, '100');
  const s = S.summarizeLocal(t.tweets);
  console.log(JSON.stringify(s, null, 2));
  assert.ok(s.tldr.length > 10);
  assert.ok(s.points.length >= 2 && s.points.length <= 7);
  const all = [s.tldr, ...s.points].join(' ');
  assert.ok(!/follow me/i.test(all), 'CTA excluded');
  assert.ok(!/^\d\//.test(s.points[0]), 'numbering stripped');
});

test('clean strips thread numbering', () => {
  assert.strictEqual(S.clean('3/12 Hello world'), 'Hello world');
  assert.strictEqual(S.clean('(2/n) Hello'), 'Hello');
  assert.strictEqual(S.clean('A thread: Hello 🧵👇'), 'Hello');
});
