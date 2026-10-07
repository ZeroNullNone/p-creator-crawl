'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const promises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { articleText, createContentSearch } = require('./content-search');
const { createApp } = require('./server');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-search-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('pcc-search-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function save(dir, name, body, title = 'Title only', author = 'Author only') {
  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `# ${title}\n\n${body}\n\n---\n\nSource: https://source-only.example/p/${name}`);
  fs.writeFileSync(path.join(dir, 'meta', `${name}.json`), JSON.stringify({ title, author, sourceType: 'substack' }));
}

test('body extraction keeps readable Markdown, code, tables and HTML without generated metadata or asset URLs', () => {
  const text = articleText(`# Title only

## Strategy heading
Use **Momentum** and [risk management](https://link-only.example/path_(value)).
Reference [visible label][ref].
![image-only caption](images/hidden-image.png)

| Factor | Value |
| --- | --- |
| 趋势 | 42 |

\`position_size = 2\`

\`\`\`python
signal = returns > 0
\`\`\`

<div data-secret="attribute-only">HTML &amp; readable text</div>

<script>script-only</script>

[ref]: https://reference-only.example

---

Source: https://source-only.example/p/article`);
  for (const phrase of ['Strategy heading', 'Momentum', 'risk management', 'visible label', '趋势', '42', 'position_size = 2', 'signal = returns > 0', 'HTML & readable text']) {
    assert.ok(text.includes(phrase), `Missing body text: ${phrase}`);
  }
  for (const hidden of ['Title only', 'link-only', 'image-only', 'hidden-image', 'attribute-only', 'script-only', 'reference-only', 'source-only']) {
    assert.ok(!text.includes(hidden), `Indexed non-body text: ${hidden}`);
  }
});

test('existing articles match English, short Chinese terms, normalized phrases and literal punctuation', async t => {
  const dir = temporary(t);
  save(dir, 'english', 'A Momentum\n\nstrategy uses C++ and a.b, but no regex wildcards.');
  save(dir, 'chinese', '趋势跟踪与风险控制；ＦＡＣＴＯＲ analysis.');
  const search = createContentSearch({ outputDir: dir });
  await search.warm();
  assert.deepEqual((await search.search('MOMENTUM strategy')).map(m => m.filename), ['english.md']);
  assert.deepEqual((await search.search('趋势')).map(m => m.filename), ['chinese.md']);
  assert.deepEqual((await search.search('factor')).map(m => m.filename), ['chinese.md']);
  assert.deepEqual((await search.search('C++')).map(m => m.filename), ['english.md']);
  assert.deepEqual((await search.search('a.b')).map(m => m.filename), ['english.md']);
  assert.deepEqual(await search.search('.*'), []);
  assert.deepEqual(await search.search('aXb'), []);
  for (const hidden of ['Title only', 'Author only', 'source-only.example']) assert.deepEqual(await search.search(hidden), []);
  const [match] = await search.search('momentum');
  assert.equal(match.snippet.match, 'Momentum');
  assert.ok(match.snippet.after.includes('strategy'));
});

test('unchanged bodies stay cached while additions, edits with restored mtime, deletions and renames are detected', async t => {
  const dir = temporary(t);
  save(dir, 'first', 'Alpha body');
  const firstPath = path.join(dir, 'first.md');
  const oldTime = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(firstPath, oldTime, oldTime);
  let reads = 0;
  const search = createContentSearch({ outputDir: dir, readFile: async (...args) => {
    reads += 1;
    return promises.readFile(...args);
  } });
  await search.warm();
  await search.search('alpha');
  await search.search('missing');
  assert.equal(reads, 1, 'Searching unchanged bodies should not re-read Markdown');

  await new Promise(resolve => setTimeout(resolve, 20));
  save(dir, 'first', 'Omega body'); // Same length, with the publication mtime restored afterward.
  fs.utimesSync(firstPath, oldTime, oldTime);
  assert.equal((await search.search('omega')).length, 1);
  assert.deepEqual(await search.search('alpha'), []);
  assert.equal(reads, 2);

  save(dir, 'second', 'Omega again');
  assert.equal((await search.search('omega')).length, 2);
  fs.renameSync(firstPath, path.join(dir, 'renamed.md'));
  fs.unlinkSync(path.join(dir, 'second.md'));
  assert.deepEqual((await search.search('omega')).map(m => m.filename), ['renamed.md']);
  fs.unlinkSync(path.join(dir, 'renamed.md'));
  assert.deepEqual(await search.search('omega'), []);
});

test('phrase separators are interchangeable in both directions and excerpts preserve the matched spelling', async t => {
  const dir = temporary(t);
  const variants = [
    'walk-forward-test', 'walk_forward_test', 'walk–forward', 'walk—forward',
    'walk forward', 'WALK---_FORWARD', 'walk\n\nforward',
  ];
  variants.forEach((body, index) => save(dir, `variant-${index}`, body));
  save(dir, 'typo', 'walk-farward');
  save(dir, 'reversed', 'forward-walk');
  save(dir, 'intervening', 'walk useful forward');
  save(dir, 'joined', 'walkforward');
  const search = createContentSearch({ outputDir: dir });
  const expected = variants.map((_, index) => `variant-${index}.md`).sort();
  for (const query of ['walk forward', 'walk-forward', 'walk_forward', 'walk–forward', 'walk—forward', 'WALK--_FORWARD']) {
    const matches = await search.search(query);
    assert.deepEqual(matches.map(m => m.filename).sort(), expected, query);
    assert.equal(matches.find(m => m.filename === 'variant-0.md').snippet.match, 'walk-forward');
    assert.equal(matches.find(m => m.filename === 'variant-1.md').snippet.match, 'walk_forward');
    assert.equal(matches.find(m => m.filename === 'variant-3.md').snippet.match, 'walk—forward');
  }
});

test('leading/trailing separators and other punctuation stay literal, including negative values and code identifiers', async t => {
  const dir = temporary(t);
  save(dir, 'symbols', 'Use C++ and a.b, value -1, and identifiers `_hidden_` and `word-`.');
  save(dir, 'plain', 'Use C and aXb, value 1, and identifiers hidden and word.');
  const search = createContentSearch({ outputDir: dir });
  for (const query of ['C++', 'a.b', '-1', '-', '_', '_hidden_', 'word-']) {
    assert.deepEqual((await search.search(query)).map(m => m.filename), ['symbols.md'], query);
  }
  assert.deepEqual(await search.search('.*'), []);
});

test('missing output directories and empty queries work, and invalid queries are rejected', async t => {
  const dir = path.join(temporary(t), 'not-created');
  const search = createContentSearch({ outputDir: dir });
  assert.deepEqual(await search.search('anything'), []);
  assert.deepEqual(await search.search(' \n '), []);
  await assert.rejects(search.search(['text']), { status: 400 });
  await assert.rejects(search.search('x'.repeat(201)), { status: 400 });
});

test('HTTP content search returns excerpts, preserves list/read routes and reflects deletion', async t => {
  const dir = temporary(t);
  save(dir, 'first', 'Momentum controls risk. Validate walk-forward-test.');
  save(dir, 'second', '中文趋势跟踪。');
  const server = await new Promise(resolve => {
    const running = createApp({ outputDir: dir }).listen(0, '127.0.0.1', () => resolve(running));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, options) => {
    const response = await fetch(base + url, options);
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const result = await request('/posts/search?q=momentum');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(result.data.matches.map(m => m.filename), ['first.md']);
  assert.equal(result.data.matches[0].snippet.match, 'Momentum');
  assert.equal(result.data.matches[0].content, undefined, 'Do not send full bodies in search results');
  assert.equal((await request('/posts')).data.length, 2);
  assert.equal((await request('/posts/first.md/read')).status, 200);
  assert.equal((await request('/posts/search?q=' + encodeURIComponent('趋势'))).data.matches.length, 1);
  const separated = await request('/posts/search?q=' + encodeURIComponent('walk forward'));
  assert.deepEqual(separated.data.matches.map(m => m.filename), ['first.md']);
  assert.equal(separated.data.matches[0].snippet.match, 'walk-forward');
  assert.equal((await request('/posts/search?q=walk_forward')).data.matches[0].snippet.match, 'walk-forward');
  assert.deepEqual((await request('/posts/search?q=' + encodeURIComponent('walk farward'))).data.matches, []);
  assert.deepEqual((await request('/posts/search')).data.matches, []);
  assert.equal((await request('/posts/search?q[]=text')).status, 400);
  assert.equal((await request('/posts/search?q=' + 'x'.repeat(201))).status, 400);
  await request('/posts/first.md', { method: 'DELETE' });
  assert.deepEqual((await request('/posts/search?q=momentum')).data.matches, []);
  save(dir, 'third', 'Momentum in a newly saved article.');
  assert.deepEqual((await request('/posts/search?q=momentum')).data.matches.map(m => m.filename), ['third.md']);
});
