'use strict';
require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { scrapeSubstack } = require('./scraper');

const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || 'posts');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canonicalArticleUrl(value) {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString();
}

function validateArchiveUrl(archiveUrl) {
  const archive = new URL(archiveUrl);
  if (archive.protocol !== 'https:' || archive.username || archive.password
    || archive.pathname.replace(/\/$/, '') !== '/archive' || archive.search || archive.hash) {
    throw new Error('Provide an HTTPS Substack archive URL ending in /archive.');
  }
  return `${archive.origin}/archive`;
}

async function fetchArchivePosts(archiveUrl, { onProgress = () => {}, shouldStop = () => false } = {}) {
  const archive = new URL(validateArchiveUrl(archiveUrl));

  const posts = new Map();
  let offset = 0;
  // Require an empty final page; a capped or repeating API must not yield a partial oldest set.
  for (let page = 0; page < 100; page += 1) {
    if (shouldStop()) throw Object.assign(new Error('Stopped while reading the archive.'), { code: 'STOPPED' });
    const response = await axios.get(`${archive.origin}/api/v1/archive`, {
      params: { sort: 'new', search: '', offset, limit: 20 },
      timeout: 20000,
      maxRedirects: 0,
      headers: { Accept: 'application/json' },
    });
    if (!Array.isArray(response.data)) throw new Error('Unexpected archive response; expected an array.');
    if (response.data.length === 0) return Array.from(posts.values());

    const previousCount = posts.size;
    for (const post of response.data) {
      if (typeof post.slug !== 'string' || !/^[a-z0-9_-]+$/i.test(post.slug)
        || typeof post.post_date !== 'string' || !Number.isFinite(Date.parse(post.post_date))) {
        throw new Error('Archive contains an invalid article slug or publication date.');
      }
      const url = `${archive.origin}/p/${post.slug}`;
      posts.set(url, {
        id: post.id,
        title: post.title || post.slug,
        url,
        postDate: post.post_date,
        audience: post.audience,
      });
    }
    if (posts.size === previousCount) throw new Error('Archive pagination repeated without new articles.');
    onProgress(posts.size);
    offset += response.data.length;
    await pause(300);
  }
  throw new Error('Archive pagination exceeded 100 pages; no articles were downloaded.');
}

function planBatch(posts, limit, outputDir = OUTPUT_DIR) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Limit must be a positive integer.');
  const saved = new Map();
  const metaDir = path.join(outputDir, 'meta');
  if (fs.existsSync(metaDir)) {
    for (const name of fs.readdirSync(metaDir).filter((file) => file.endsWith('.json'))) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(metaDir, name), 'utf8'));
        const filename = name.replace(/\.json$/, '.md');
        if (!fs.readFileSync(path.join(outputDir, filename), 'utf8').trim()) continue;
        saved.set(canonicalArticleUrl(meta.source), filename);
      } catch {
        // Missing/empty Markdown or invalid metadata is not a completed article.
      }
    }
  }

  // Select before skipping: rerunning an oldest-five trial must never download article six.
  return [...posts]
    .sort((a, b) => Date.parse(a.postDate) - Date.parse(b.postDate) || a.url.localeCompare(b.url))
    .slice(0, limit)
    .map((post) => {
      const filename = saved.get(canonicalArticleUrl(post.url));
      return { ...post, status: filename ? 'skipped' : 'pending', ...(filename ? { filename } : {}) };
    });
}

function saveReport(reportPath, report) {
  fs.writeFileSync(`${reportPath}.tmp`, JSON.stringify(report, null, 2), 'utf8');
  fs.renameSync(`${reportPath}.tmp`, reportPath);
}

async function crawlArchive(archiveUrl, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Limit must be a positive integer.');
  const posts = await fetchArchivePosts(archiveUrl);
  const articles = planBatch(posts, limit);
  const report = {
    archiveUrl,
    startedAt: new Date().toISOString(),
    order: 'oldest-first',
    limit,
    archiveCount: posts.length,
    articles,
  };
  const reportDir = path.join(OUTPUT_DIR, 'batches');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${new URL(archiveUrl).hostname}-${Date.now()}.json`);
  saveReport(reportPath, report);
  console.log(`[batch] Archive: ${posts.length}; selected oldest: ${articles.length}`);

  let attempted = false;
  for (const article of articles) {
    if (article.status === 'skipped') {
      console.log(`[batch] skipped: ${article.title}`);
      continue;
    }
    if (attempted) await pause(2000);
    attempted = true;
    article.status = 'running';
    saveReport(reportPath, report);
    console.log(`[batch] scraping ${article.postDate}: ${article.title}`);
    try {
      const result = await scrapeSubstack(article.url);
      if (!fs.readFileSync(result.filepath, 'utf8').trim()) throw new Error('Saved Markdown is empty.');
      const metadataPath = path.join(OUTPUT_DIR, 'meta', result.filename.replace(/\.md$/, '.json'));
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      if (canonicalArticleUrl(metadata.source) !== canonicalArticleUrl(article.url)) {
        throw new Error('Saved metadata does not match the selected article.');
      }
      article.status = 'saved';
      article.filename = result.filename;
      article.markdownBytes = fs.statSync(result.filepath).size;
      console.log(`[batch] saved: ${result.filename}`);
    } catch (error) {
      article.status = 'failed';
      article.error = String(error.message || 'Unknown scrape failure').slice(0, 1000);
      console.error(`[batch] failed: ${article.title}: ${article.error}`);
    }
    saveReport(reportPath, report);
  }
  report.finishedAt = new Date().toISOString();
  report.summary = { saved: 0, skipped: 0, failed: 0 };
  for (const article of articles) report.summary[article.status] += 1;
  saveReport(reportPath, report);
  console.log(`[batch] ${JSON.stringify(report.summary)}`);
  console.log(`[batch] Report: ${reportPath}`);
  return report;
}

if (require.main === module) {
  const [archiveUrl, flag, rawLimit, ...extra] = process.argv.slice(2);
  if (!archiveUrl || flag !== '--limit' || !/^[1-9]\d*$/.test(rawLimit || '') || extra.length) {
    console.error('Usage: node crawl-archive.js https://publication.example/archive --limit 5');
    process.exitCode = 1;
  } else {
    crawlArchive(archiveUrl, Number(rawLimit)).then((report) => {
      if (report.summary.failed) process.exitCode = 1;
    }).catch((error) => {
      console.error(`[batch] ${error.message}`);
      process.exitCode = 1;
    });
  }
}

module.exports = { fetchArchivePosts, planBatch, crawlArchive, canonicalArticleUrl, validateArchiveUrl };
