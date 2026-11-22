const $ = (id) => document.getElementById(id);
const HINTS = {
  auto: 'Uses Chrome’s built-in model when it’s already downloaded; otherwise the local summarizer.',
  local: 'Picks the most central sentences of the thread (TextRank). Runs fully offline.',
  ondevice: 'Needs Chrome 138+, ~22 GB free disk and a GPU with >4 GB VRAM (or 16 GB RAM). Downloads the model on first use.',
  claude: 'Best quality. Each summary is one API call billed to your key.',
};

async function load() {
  const s = await chrome.storage.local.get(['engine', 'apiKey', 'model', 'includeReplies']);
  $('engine').value = s.engine || 'auto';
  $('apiKey').value = s.apiKey || '';
  $('model').value = s.model || '';
  $('includeReplies').checked = s.includeReplies !== false;
  sync();
}

function sync() {
  $('claude').style.display = $('engine').value === 'claude' ? 'block' : 'none';
  $('engineHint').textContent = HINTS[$('engine').value];
}

let t;
async function save() {
  sync();
  await chrome.storage.local.set({
    engine: $('engine').value,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    includeReplies: $('includeReplies').checked,
  });
  $('saved').textContent = 'Saved ✓';
  clearTimeout(t);
  t = setTimeout(() => ($('saved').textContent = ''), 1200);
}

for (const id of ['engine', 'includeReplies']) $(id).addEventListener('change', save);
for (const id of ['apiKey', 'model']) $(id).addEventListener('input', save);
load();
