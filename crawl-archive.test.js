'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Isolate configuration and scraping so these checks never read saved sessions or use the network.
function loadBatch({ get, outputDir } = {}) {
  const module = { exports: {} };
  const dependencies = {
    dotenv: { config() {} },
    axios: { get: get || (async () => { throw new Error('Unexpected network request'); }) },
    fs,
    path,
    './scraper': { scrapeSubstack: async () => { throw new Error('Unexpected article download'); } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'crawl-archive.js'), 'utf8'), {
    module,
    require(name) {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    process: { env: { OUTPUT_DIR: outputDir || os.tmpdir() } },
    URL,
    console,
    setTimeout(callback) { callback(); },
  }, { filename: 'crawl-archive.js' });
  return module.exports;
}

function tempOutput(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-archive-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function saveFixture(dir, name, source, { markdown = 'Saved article body' } = {}) {
  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta', `${name}.json`), JSON.stringify({ source }));
  if (markdown !== null) fs.writeFileSync(path.join(dir, `${name}.md`), markdown);
}

function post(number) {
  return {
    title: `Article ${number}`,
    url: `https://www.vertoxquant.com/p/article-${number}`,
    postDate: `2023-01-${String(number).padStart(2, '0')}T00:00:00Z`,
  };
}

test('archive reads through an empty page, advances by received rows, and deduplicates URLs', async () => {
  const pages = [
    [
      { id: 3, slug: 'newest', post_date: '2023-03-01T00:00:00Z' },
      { id: 2, slug: 'middle', post_date: '2023-02-01T00:00:00Z' },
    ],
    [
      { id: 2, slug: 'middle', post_date: '2023-02-01T00:00:00Z' },
      { id: 1, slug: 'oldest', post_date: '2023-01-01T00:00:00Z' },
    ],
    [],
  ];
  const offsets = [];
  const { fetchArchivePosts } = loadBatch({
    get: async (url, options) => {
      assert.equal(url, 'https://www.vertoxquant.com/api/v1/archive');
      offsets.push(options.params.offset);
      assert.equal(options.params.sort, 'new');
      assert.equal(options.maxRedirects, 0);
      return { data: pages[offsets.length - 1] };
    },
  });
  const posts = await fetchArchivePosts('https://www.vertoxquant.com/archive');
  assert.deepEqual(offsets, [0, 2, 4]);
  assert.equal(posts.length, 3);
  assert.equal(new Set(posts.map((item) => item.url)).size, 3);
});

test('repeated pagination fails instead of accepting an incomplete oldest set', async () => {
  let calls = 0;
  const { fetchArchivePosts } = loadBatch({
    get: async () => {
      calls += 1;
      return { data: [{ id: 1, slug: 'same-page', post_date: '2023-01-01T00:00:00Z' }] };
    },
  });
  await assert.rejects(fetchArchivePosts('https://www.vertoxquant.com/archive'), /pagination repeated/);
  assert.equal(calls, 2);
});

test('oldest ordering uses timestamps and a deterministic URL tie break', (t) => {
  const outputDir = tempOutput(t);
  const { planBatch } = loadBatch();
  const posts = [
    { ...post(3), postDate: '2023-01-01T00:30:00Z' },
    { ...post(2), postDate: '2023-01-01T00:00:00Z' },
    { ...post(1), postDate: '2023-01-01T01:00:00+02:00' },
    { ...post(4), postDate: '2023-01-01T00:00:00Z' },
  ];
  const result = planBatch(posts, 4, outputDir);
  assert.deepEqual(Array.from(result, (item) => item.title), ['Article 1', 'Article 2', 'Article 4', 'Article 3']);
});

test('the five oldest are selected before skips and the sixth never fills their places', (t) => {
  const outputDir = tempOutput(t);
  saveFixture(outputDir, 'first-saved', post(1).url);
  saveFixture(outputDir, 'third-saved', post(3).url);
  const { planBatch } = loadBatch();
  const result = planBatch([6, 4, 2, 5, 1, 3].map(post), 5, outputDir);
  assert.deepEqual(Array.from(result, (item) => item.title), [1, 2, 3, 4, 5].map((n) => `Article ${n}`));
  assert.deepEqual(Array.from(result, (item) => item.status), ['skipped', 'pending', 'skipped', 'pending', 'pending']);
});

test('metadata without nonempty Markdown does not count as an already saved article', (t) => {
  const outputDir = tempOutput(t);
  saveFixture(outputDir, 'missing', post(1).url, { markdown: null });
  saveFixture(outputDir, 'empty', post(2).url, { markdown: ' \n ' });
  const { planBatch } = loadBatch();
  const result = planBatch([post(1), post(2)], 2, outputDir);
  assert.deepEqual(Array.from(result, (item) => item.status), ['pending', 'pending']);
});

test('saved source query strings, hashes, and trailing slashes are canonicalized for skips', (t) => {
  const outputDir = tempOutput(t);
  saveFixture(outputDir, 'existing-article', `${post(1).url}/?utm_source=archive#comments`);
  const { planBatch } = loadBatch();
  const [result] = planBatch([post(1)], 1, outputDir);
  assert.equal(result.status, 'skipped');
  assert.equal(result.filename, 'existing-article.md');
});
