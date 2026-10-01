'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const crawlTypes = require('./crawl-types');
const { planBatch, canonicalArticleUrl } = require('./crawl-archive');
const { repairImages } = require('./article-media');
const { loadCookies } = require('./scraper');

const LIVE = new Set(['scanning', 'running', 'retrying', 'stopping']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function atomicJson(file, value) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}
function summarize(job) {
  const result = { saved: 0, skipped: 0, failed: 0, pending: 0, running: 0, imagesPending: 0 };
  for (const article of job.articles) {
    if (article.status in result) result[article.status] += 1;
    result.imagesPending += article.imagesPending || 0;
  }
  return result;
}

function createBatchService({ outputDir, types = crawlTypes, scrapeDelay = 2000, wait = pause,
  repair = repairImages, cookies = loadCookies } = {}) {
  const dir = path.join(outputDir, 'batches');
  fs.mkdirSync(dir, { recursive: true });
  const sourcesFile = path.join(dir, 'sources.json');
  let sources = fs.existsSync(sourcesFile) ? JSON.parse(fs.readFileSync(sourcesFile, 'utf8')) : [
    { id: 'vertoxquant', name: 'VertoxQuant', type: 'substack-archive', url: 'https://www.vertoxquant.com/archive' },
  ];
  if (!Array.isArray(sources)) throw new Error('Invalid saved batch sources.');
  const jobs = new Map();
  let activeId = null;
  let activePromise = null;

  function persist(job) {
    job.updatedAt = new Date().toISOString();
    job.summary = summarize(job);
    atomicJson(path.join(dir, `${job.id}.json`), job);
  }

  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.json') && name !== 'sources.json')) {
    try {
      const report = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (!report.archiveUrl || !Array.isArray(report.articles)) continue;
      if (report.schemaVersion === 1 && report.id === file.slice(0, -5) && /^ui-[a-f0-9-]+$/.test(report.id)) {
        if (LIVE.has(report.status)) {
          report.status = 'interrupted';
          report.stopRequested = false;
          report.message = 'The server stopped before this run finished. Resume to continue.';
          report.articles.forEach(a => { if (a.status === 'running') a.status = 'pending'; });
          persist(report);
        }
        jobs.set(report.id, report);
      } else if (report.summary && report.finishedAt) {
        const id = `legacy:${file}`;
        jobs.set(id, { ...report, id, legacy: true, mode: 'crawl', scanComplete: true,
          source: { name: new URL(report.archiveUrl).hostname, url: report.archiveUrl, type: 'substack-archive' },
          status: report.summary.failed ? 'completed_with_errors' : 'completed', summary: summarize(report) });
      }
    } catch { /* Non-run validation reports and malformed files are not execution history. */ }
  }

  function requireIdle() { if (activeId) fail('Another crawl is running. Wait or stop it first.', 409); }
  function source(id) { const found = sources.find(s => s.id === id); if (!found) fail('Source not found.', 404); return found; }
  function jobById(id) { const job = jobs.get(id); if (!job) fail('Run not found.', 404); return job; }
  function typeFor(id) { if (!Object.hasOwn(types, id)) fail('This crawl type is not implemented.'); return types[id]; }
  function available(article) {
    if (!article.filename || path.basename(article.filename) !== article.filename) return false;
    try {
      const md = path.join(outputDir, article.filename);
      const meta = JSON.parse(fs.readFileSync(path.join(outputDir, 'meta', article.filename.replace(/\.md$/, '.json')), 'utf8'));
      return fs.statSync(md).size > 0 && canonicalArticleUrl(meta.source) === canonicalArticleUrl(article.url);
    } catch { return false; }
  }
  function view(job, details = false) {
    const { articles, ...rest } = job;
    return { ...rest, active: activeId === job.id, summary: summarize(job),
      ...(details ? { articles: articles.map(a => ({ ...a, available: available(a) })) } : {}) };
  }

  function launch(job, action = 'crawl') {
    requireIdle();
    activeId = job.id;
    job.stopRequested = false;
    job.status = job.scanComplete ? 'running' : 'scanning';
    job.message = '';
    delete job.finishedAt;
    try { persist(job); } catch (error) { activeId = null; throw error; }
    activePromise = execute(job, action).catch(error => {
      job.status = job.stopRequested || error.code === 'STOPPED' ? 'stopped' : 'failed';
      job.message = String(error.message).slice(0, 600);
      job.finishedAt = new Date().toISOString();
      persist(job);
    }).finally(() => { activeId = null; activePromise = null; });
    // Keep persistence errors from becoming unhandled rejections in the HTTP server.
    activePromise.catch(error => console.error('[batch]', error.message));
    return view(job, true);
  }

  async function execute(job, action) {
    const type = typeFor(job.source.type);
    if (!job.scanComplete) {
      const posts = await type.scan(job.archiveUrl, {
        shouldStop: () => job.stopRequested,
        onProgress: count => { job.discovered = count; persist(job); },
      });
      job.archiveCount = posts.length;
      job.articles = planBatch(posts, job.limit || Number.MAX_SAFE_INTEGER, outputDir)
        .map(a => ({ ...a, initiallySaved: a.status === 'skipped', attempts: 0, imagesPending: 0 }));
      job.scanComplete = true;
      persist(job);
    }
    if (job.mode === 'check') {
      job.status = job.stopRequested ? 'stopped' : 'checked';
      job.finishedAt = new Date().toISOString();
      persist(job);
      return;
    }
    let attempted = false;
    const candidates = job.articles.filter(a => action === 'images'
      ? a.imagesPending > 0 : ['pending', 'failed', 'running'].includes(a.status));
    // A retry gets one initial attempt and one bounded retry; it never widens the selected list.
    const ceilings = new Map(candidates.map(a => [a.url, (a.attempts || 0) + 2]));
    let authRequired = false;
    for (let pass = 0; pass < (action === 'images' ? 1 : 2); pass += 1) {
      for (const article of candidates) {
        if (job.stopRequested || authRequired) break;
        if (pass && (article.status !== 'failed' || !article.retryable)) continue;
        if (attempted) await wait(scrapeDelay);
        if (job.stopRequested) break;
        attempted = true;
        job.status = pass ? 'retrying' : 'running';
        job.currentUrl = article.url;
        job.message = pass ? 'Retrying temporary failures once.' : '';
        persist(job);
        if (action === 'images') {
          if (!available(article)) { article.imagesPending = 0; article.mediaError = 'Article was deleted. Start a new crawl to download it again.'; persist(job); continue; }
          try {
            const media = await repair(outputDir, article.filename);
            article.imagesPending = media.pending;
            article.mediaError = media.pending ? 'Some images are still unavailable.' : '';
          } catch { article.mediaError = 'Could not repair images; retry later.'; }
          persist(job);
          continue;
        }
        const existing = planBatch([article], 1, outputDir)[0];
        if (existing.status === 'skipped') {
          article.filename = existing.filename;
          article.status = article.initiallySaved ? 'skipped' : 'saved';
          delete article.error;
          persist(job);
          continue;
        }
        article.status = 'running';
        article.attempts = (article.attempts || 0) + 1;
        persist(job);
        try {
          const result = await type.scrape(article.url);
          article.filename = result.filename;
          if (!available(article)) throw new Error('Saved article or matching metadata is missing.');
          article.status = 'saved';
          article.retryable = false;
          delete article.error;
          if (result.subscriptionVerified) job.accessVerifiedAt = new Date().toISOString();
          try {
            const media = await repair(outputDir, article.filename);
            article.imagesPending = media.pending;
            article.mediaError = media.pending ? 'Text saved; some images need another attempt.' : '';
          } catch {
            article.imagesPending = 1;
            article.mediaError = 'Text saved; image verification could not finish.';
          }
        } catch (error) {
          article.status = 'failed';
          article.error = String(error.message).slice(0, 600);
          authRequired = error.code === 'AUTH_REQUIRED';
          article.retryable = !authRequired && article.attempts < ceilings.get(article.url)
            && (/timeout|navigation|context was destroyed|net::|network|socket/i.test(article.error)
              || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code)
              || [429, 502, 503, 504].includes(error.response?.status));
        }
        persist(job);
      }
    }
    delete job.currentUrl;
    const summary = summarize(job);
    job.status = authRequired ? 'needs_login' : job.stopRequested || summary.pending ? 'stopped'
      : summary.failed ? 'completed_with_errors' : summary.imagesPending ? 'completed_with_warnings' : 'completed';
    job.message = authRequired ? 'Update the saved cookies, then resume this run.' : '';
    job.finishedAt = new Date().toISOString();
    persist(job);
  }

  return {
    state() {
      return { types: Object.entries(types).map(([id, t]) => ({ id, label: t.label, description: t.description,
        placeholder: t.placeholder, cookieSource: t.cookieSource })),
      sources: sources.map(s => ({ ...s, cookiesSaved: !!cookies(types[s.type]?.cookieSource)?.length })),
      activeId, runs: [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(j => view(j)) };
    },
    saveSource(input, id) {
      const type = typeFor(input.type);
      const name = String(input.name || '').trim();
      if (!name || name.length > 100) fail('Use a source name between 1 and 100 characters.');
      const url = type.validateUrl(input.url);
      if (sources.some(s => s.id !== id && s.type === input.type && s.url === url)) fail('This source is already saved.', 409);
      if (id) source(id);
      const saved = { id: id || randomUUID(), name, url, type: input.type };
      const next = id ? sources.map(s => s.id === id ? saved : s) : [...sources, saved];
      atomicJson(sourcesFile, next);
      sources = next;
      return saved;
    },
    removeSource(id) {
      source(id);
      if (activeId && jobs.get(activeId)?.source.id === id) fail('Stop the active run before removing its source.', 409);
      const next = sources.filter(s => s.id !== id);
      atomicJson(sourcesFile, next); sources = next;
    },
    start({ sourceId, mode = 'crawl', scope = 'all' }) {
      requireIdle();
      if (!['crawl', 'check'].includes(mode) || !['all', 'oldest5'].includes(scope)) fail('Invalid crawl mode or scope.');
      const selected = { ...source(sourceId) };
      typeFor(selected.type);
      const job = { schemaVersion: 1, id: `ui-${randomUUID()}`, source: selected, archiveUrl: selected.url,
        mode, scope, limit: scope === 'oldest5' ? 5 : null, startedAt: new Date().toISOString(),
        status: 'scanning', scanComplete: false, discovered: 0, articles: [] };
      jobs.set(job.id, job);
      return launch(job);
    },
    get(id) { return view(jobById(id), true); },
    stop(id) {
      const job = jobById(id);
      if (activeId !== id) fail('This run is not active.', 409);
      job.stopRequested = true; job.status = 'stopping'; persist(job);
      return view(job, true);
    },
    resume(id, action = 'retry') {
      requireIdle();
      const job = jobById(id);
      if (job.legacy || job.mode === 'check') fail('Start a new crawl from this source.');
      if (!['retry', 'images'].includes(action)) fail('Invalid retry action.');
      return launch(job, action);
    },
    acquireSingle() { requireIdle(); activeId = 'single'; return () => { if (activeId === 'single') activeId = null; }; },
    assertCanDelete(filename) {
      if (activeId === 'single') fail('A single article is being saved. Wait for it to finish before deleting.', 409);
      const active = jobs.get(activeId);
      if (active && active.articles.some(a => a.filename === filename && a.url === active.currentUrl)) {
        fail('This article is being saved or repairing images. Wait for it to finish.', 409);
      }
    },
    whenIdle() { return activePromise || Promise.resolve(); },
  };
}

module.exports = { createBatchService };
