'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBatchService } = require('./batch-crawl');
const { createApp } = require('./server');
const { inspectImages, repairImages } = require('./article-media');
const { validateArchiveUrl } = require('./crawl-archive');

const post = n => ({ title: `Article ${n}`, url: `https://example.com/p/${n}`, postDate: `2023-01-${String(n).padStart(2, '0')}T00:00:00Z` });
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcc-batch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function save(dir, url, markdown = '# Article\n\nSaved text') {
  const filename = `${new URL(url).pathname.split('/').pop()}.md`;
  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
  fs.writeFileSync(path.join(dir, filename), markdown);
  fs.writeFileSync(path.join(dir, 'meta', filename.replace('.md', '.json')), JSON.stringify({ source: url }));
  return { filename };
}
function setup(t, options = {}) {
  const outputDir = options.outputDir || temporary(t);
  const calls = [];
  const type = { label: 'Test archive', cookieSource: 'substack', validateUrl: validateArchiveUrl,
    scan: async (_url, { onProgress }) => { onProgress(6); return [6, 4, 3, 1, 2, 5].map(post); },
    scrape: async url => { calls.push(url); return save(outputDir, url); }, ...options.type };
  const serviceOptions = { outputDir, types: { 'substack-archive': type }, scrapeDelay: 0,
    wait: async () => {}, cookies: () => null, repair: async () => ({ pending: 0 }), ...options.service };
  return { outputDir, calls, serviceOptions, service: createBatchService(serviceOptions) };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('check is read only; oldest-five crawl skips saved articles and never fills with a sixth', async t => {
  const { service, calls, outputDir } = setup(t);
  save(outputDir, post(1).url);
  const check = service.start({ sourceId: 'vertoxquant', mode: 'check', scope: 'oldest5' });
  await service.whenIdle();
  assert.equal(service.get(check.id).status, 'checked');
  assert.equal(service.get(check.id).summary.pending, 4);
  assert.deepEqual(calls, []);
  const crawl = service.start({ sourceId: 'vertoxquant', scope: 'oldest5' });
  await service.whenIdle();
  assert.deepEqual(calls, [2, 3, 4, 5].map(n => post(n).url));
  assert.equal(service.get(crawl.id).summary.saved, 4);
  assert.equal(service.get(crawl.id).summary.skipped, 1);
  assert.equal(service.get(crawl.id).status, 'completed');
});

test('temporary failures retry once, permanent failures do not, and login failures pause remaining articles', async t => {
  const counts = {};
  const dir = temporary(t);
  const { service } = setup(t, { outputDir: dir, type: { scrape: async url => {
    counts[url] = (counts[url] || 0) + 1;
    if (url === post(1).url && counts[url] === 1) throw new Error('Navigation timeout');
    if (url === post(2).url) throw new Error('Network timeout');
    if (url === post(3).url) throw new Error('Unsupported content');
    return save(dir, url);
  } } });
  const run = service.start({ sourceId: 'vertoxquant' });
  await service.whenIdle();
  assert.equal(counts[post(1).url], 2);
  assert.equal(counts[post(2).url], 2);
  assert.equal(counts[post(3).url], 1);
  assert.equal(service.get(run.id).summary.saved, 4);
  assert.equal(service.get(run.id).summary.failed, 2);
  const login = setup(t, { type: { scrape: async () => { throw Object.assign(new Error('Refresh cookies'), { code: 'AUTH_REQUIRED' }); } } });
  const authRun = login.service.start({ sourceId: 'vertoxquant' });
  await login.service.whenIdle();
  assert.equal(login.service.get(authRun.id).status, 'needs_login');
  assert.equal(login.service.get(authRun.id).summary.pending, 5);
  assert.equal(login.service.get(authRun.id).articles[0].attempts, 1);
});

test('stop finishes current article, blocks concurrent crawls, then resumes only remaining articles', async t => {
  const entered = deferred(); const finish = deferred();
  const dir = temporary(t); const urls = [];
  const { service } = setup(t, { outputDir: dir, type: { scrape: async url => {
    urls.push(url); entered.resolve(); await finish.promise; return save(dir, url);
  } } });
  const run = service.start({ sourceId: 'vertoxquant' });
  await entered.promise;
  assert.throws(() => service.start({ sourceId: 'vertoxquant' }), { status: 409 });
  assert.throws(() => service.acquireSingle(), { status: 409 });
  assert.throws(() => service.removeSource('vertoxquant'), { status: 409 });
  service.stop(run.id); finish.resolve(); await service.whenIdle();
  assert.equal(service.get(run.id).status, 'stopped');
  assert.equal(service.get(run.id).summary.saved, 1);
  assert.equal(service.get(run.id).summary.pending, 5);
  service.resume(run.id); await service.whenIdle();
  assert.equal(service.get(run.id).status, 'completed');
  assert.deepEqual(urls, [1, 2, 3, 4, 5, 6].map(n => post(n).url));
  const release = service.acquireSingle();
  assert.throws(() => service.start({ sourceId: 'vertoxquant' }), { status: 409 });
  release();
});

test('restart marks active reports interrupted and deduplicates a file saved before the interruption', async t => {
  const { service, serviceOptions, outputDir } = setup(t);
  const run = service.start({ sourceId: 'vertoxquant', mode: 'check', scope: 'oldest5' });
  await service.whenIdle();
  const reportPath = path.join(outputDir, 'batches', `${run.id}.json`);
  const report = JSON.parse(fs.readFileSync(reportPath));
  report.mode = 'crawl'; report.status = 'running'; report.articles[0].status = 'running';
  fs.writeFileSync(reportPath, JSON.stringify(report));
  save(outputDir, post(1).url);
  const restarted = createBatchService(serviceOptions);
  assert.equal(restarted.get(run.id).status, 'interrupted');
  assert.equal(restarted.get(run.id).articles[0].status, 'pending');
  restarted.resume(run.id); await restarted.whenIdle();
  assert.equal(restarted.get(run.id).summary.saved, 5);
  assert.equal(restarted.get(run.id).status, 'completed');
});

test('deleted articles lose Library access in history and can be downloaded again', async t => {
  const { service, outputDir, calls } = setup(t);
  const run = service.start({ sourceId: 'vertoxquant' }); await service.whenIdle();
  fs.unlinkSync(path.join(outputDir, '1.md'));
  fs.unlinkSync(path.join(outputDir, 'meta', '1.json'));
  assert.equal(service.get(run.id).articles[0].available, false);
  const next = service.start({ sourceId: 'vertoxquant' }); await service.whenIdle();
  assert.equal(calls.length, 7);
  assert.equal(service.get(next.id).summary.saved, 1);
  assert.equal(service.get(next.id).summary.skipped, 5);
});

test('image warnings remain visible, repair blocks deletion, and repair does not re-scrape text', async t => {
  let repairing = false; const entered = deferred(); const finish = deferred();
  const { service, calls } = setup(t, { service: { repair: async () => {
    if (!repairing) return { pending: 2 };
    entered.resolve(); await finish.promise; return { pending: 0 };
  } } });
  const run = service.start({ sourceId: 'vertoxquant', scope: 'oldest5' }); await service.whenIdle();
  assert.equal(service.get(run.id).status, 'completed_with_warnings');
  assert.equal(service.get(run.id).summary.imagesPending, 10);
  repairing = true; service.resume(run.id, 'images'); await entered.promise;
  assert.throws(() => service.assertCanDelete('1.md'), { status: 409 });
  service.assertCanDelete('unrelated.md');
  finish.resolve(); await service.whenIdle();
  assert.equal(service.get(run.id).summary.imagesPending, 0);
  assert.equal(calls.length, 5);
});

test('sources persist, validate implemented types and URLs, and removing one keeps its history', async t => {
  const { service, serviceOptions } = setup(t);
  assert.throws(() => service.saveSource({ type: 'unknown', name: 'No', url: 'https://example.com/archive' }));
  assert.throws(() => service.saveSource({ type: 'substack-archive', name: 'No', url: 'http://example.com/archive' }));
  const added = service.saveSource({ type: 'substack-archive', name: 'Example', url: 'https://example.com/archive/' });
  assert.throws(() => service.saveSource({ ...added, name: 'Duplicate' }), { status: 409 });
  const run = service.start({ sourceId: added.id, mode: 'check' }); await service.whenIdle();
  service.saveSource({ ...added, name: 'Renamed' }, added.id);
  assert.equal(createBatchService(serviceOptions).state().sources.find(s => s.id === added.id).name, 'Renamed');
  service.removeSource(added.id);
  assert.equal(service.get(run.id).source.name, 'Example');
  assert.equal(service.state().sources.length, 1);
});

test('repair saves only actual image responses and preserves failed references and article timestamps', async t => {
  const dir = temporary(t);
  save(dir, post(1).url, '# Text\n![ok](https://example.com/ok.png)\n![bad](https://example.com/bad.png)\n![missing](images/1/missing.png)');
  const before = fs.statSync(path.join(dir, '1.md')).mtimeMs;
  const result = await repairImages(dir, '1.md', async url => url.endsWith('/ok.png')
    ? { headers: { 'content-type': 'image/png' }, data: Buffer.from('image fixture') }
    : { headers: { 'content-type': 'text/html' }, data: Buffer.from('login page') });
  assert.equal(result.pending, 2);
  assert.equal(inspectImages(dir, '1.md').remote.length, 1);
  assert.match(fs.readFileSync(path.join(dir, '1.md'), 'utf8'), /images\/1\/recovered-1.png/);
  assert.ok(Math.abs(fs.statSync(path.join(dir, '1.md')).mtimeMs - before) < 1);
  await assert.rejects(repairImages(dir, '../outside.md'), /Invalid article/);
});

test('HTTP routes cover start, read, stop, retry, CRUD, conflict and deleted Library links', async t => {
  const entered = deferred(); const finish = deferred();
  const dir = temporary(t);
  const { service } = setup(t, { outputDir: dir, type: { scrape: async url => {
    entered.resolve(); await finish.promise; return save(dir, url);
  } } });
  const app = createApp({ outputDir: dir, batchService: service });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, body, method = 'POST') => {
    const response = await fetch(base + url, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await request('/batches/state')).data.sources[0].cookiesSaved, false);
  const run = (await request('/batches/runs', { sourceId: 'vertoxquant' })).data;
  await entered.promise;
  assert.equal((await request('/scrape', { url: post(1).url })).status, 409);
  assert.equal((await request(`/batches/runs/${run.id}/stop`, {})).status, 200);
  finish.resolve(); await service.whenIdle();
  assert.equal((await request(`/batches/runs/${run.id}`)).data.status, 'stopped');
  assert.equal((await request(`/batches/runs/${run.id}/retry`, {})).status, 200);
  await service.whenIdle();
  assert.equal((await request('/posts/1.md/read')).status, 200);
  assert.equal((await request('/posts/1.md', {}, 'DELETE')).status, 200);
  assert.equal((await request('/posts/1.md/read')).status, 404);
  assert.equal((await request(`/batches/runs/${run.id}`)).data.articles[0].available, false);
  const added = (await request('/batches/sources', { type: 'substack-archive', name: 'HTTP source', url: 'https://example.com/archive' })).data;
  assert.equal((await request(`/batches/sources/${added.id}`, { ...added, name: 'Edited' }, 'PUT')).data.name, 'Edited');
  assert.equal((await request(`/batches/sources/${added.id}`, {}, 'DELETE')).status, 200);
  assert.equal((await request('/batches/runs/missing')).status, 404);
});
