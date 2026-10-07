'use strict';
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const {
  detectSource,
  scrapePatreon,
  scrapeSubstack,
  saveCookies,
  loadCookies,
} = require('./scraper');
const { createBatchService } = require('./batch-crawl');
const { createContentSearch } = require('./content-search');

function createApp({ outputDir = path.resolve(process.env.OUTPUT_DIR || 'posts'), batchService } = {}) {
const app = express();
const OUTPUT_DIR = outputDir;
const batches = batchService || createBatchService({ outputDir: OUTPUT_DIR });
const contentSearch = createContentSearch({ outputDir: OUTPUT_DIR });
contentSearch.warm().catch(error => console.error('[content search cache]', error.message));
const SUPPORTED_SOURCES = new Set(['patreon', 'substack']);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));
app.use('/images', express.static(path.join(OUTPUT_DIR, 'images')));

function canonicalizeUrl(value) {
  try {
    return new URL(String(value).trim()).toString();
  } catch {
    return String(value || '').trim();
  }
}

function getSource(value, fallback = 'patreon') {
  const source = String(value || fallback).trim().toLowerCase();
  if (!SUPPORTED_SOURCES.has(source)) {
    throw new Error(`Unsupported source "${source}".`);
  }
  return source;
}

function findDuplicateArticle(url) {
  const metaDir = path.join(OUTPUT_DIR, 'meta');
  if (!fs.existsSync(metaDir)) return null;

  const target = canonicalizeUrl(url);
  for (const file of fs.readdirSync(metaDir).filter((name) => name.endsWith('.json'))) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(metaDir, file), 'utf8'));
      if (canonicalizeUrl(meta.source) === target) {
        const filename = file.replace(/\.json$/, '.md');
        return {
          filename,
          title: meta.title || filename,
        };
      }
    } catch {
      // Skip unreadable metadata.
    }
  }
  return null;
}

app.post('/cookies', (req, res) => {
  const { source: rawSource, cookies } = req.body;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return res.status(400).json({ error: 'Expected a non-empty array of cookies.' });
  }

  let source;
  try {
    source = getSource(rawSource);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const total = saveCookies(source, cookies);
    res.json({ source, saved: cookies.length, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/cookies/status', (req, res) => {
  let source;
  try {
    source = getSource(req.query.source);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const cookies = loadCookies(source);
  res.json({ source, hasCookies: !!cookies, count: cookies ? cookies.length : 0 });
});

function batchRoute(handler) {
  return (req, res) => {
    try { res.json(handler(req)); }
    catch (error) { res.status(error.status || 400).json({ error: error.message }); }
  };
}
app.get('/batches/state', batchRoute(() => batches.state()));
app.post('/batches/sources', batchRoute(req => batches.saveSource(req.body)));
app.put('/batches/sources/:id', batchRoute(req => batches.saveSource(req.body, req.params.id)));
app.delete('/batches/sources/:id', batchRoute(req => {
  batches.removeSource(req.params.id); return { removed: req.params.id };
}));
app.post('/batches/runs', batchRoute(req => batches.start(req.body)));
app.get('/batches/runs/:id', batchRoute(req => batches.get(req.params.id)));
app.post('/batches/runs/:id/stop', batchRoute(req => batches.stop(req.params.id)));
app.post('/batches/runs/:id/retry', batchRoute(req => batches.resume(req.params.id, req.body.action)));

app.post('/scrape', async (req, res) => {
  const rawUrl = typeof req.body.url === 'string' ? req.body.url.trim() : '';
  if (!rawUrl) {
    return res.status(400).json({ error: 'Please provide a Patreon or Substack article URL.' });
  }

  let release;
  try { release = batches.acquireSingle(); }
  catch (err) { return res.status(err.status || 409).json({ error: err.message }); }
  try {

  const url = canonicalizeUrl(rawUrl);
  const duplicate = findDuplicateArticle(url);
  if (duplicate) {
    return res.status(409).json({
      error: `Duplicate: this URL has already been saved as "${duplicate.title}".`,
      duplicate: true,
      filename: duplicate.filename,
      title: duplicate.title,
    });
  }

  let source;
  try {
    source = await detectSource(url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const scrapeMap = {
    patreon: scrapePatreon,
    substack: scrapeSubstack,
  };

  try {
    const result = await scrapeMap[source](url);
    res.json({
      source,
      title: result.title,
      markdown: result.markdown,
      filename: result.filename,
    });
  } catch (err) {
    console.error('[scrape error]', err.message);
    res.status(500).json({ error: err.message });
  }
  } finally { release(); }
});

app.get('/posts/search', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try { res.json({ matches: await contentSearch.search(req.query.q) }); }
  catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error('[content search]', error.message);
    res.status(500).json({ error: 'Could not search article content. Please retry.' });
  }
});

app.get('/posts/:filename/read', (req, res) => {
  const safeName = path.basename(req.params.filename);
  if (!safeName.endsWith('.md')) {
    return res.status(400).json({ error: 'Only .md files can be read.' });
  }
  const filepath = path.join(OUTPUT_DIR, safeName);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'File not found.' });
  }
  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    const slug = safeName.replace(/\.md$/, '');
    const metaPath = path.join(OUTPUT_DIR, 'meta', `${slug}.json`);
    let title = '';
    let author = '';
    let postDate = '';
    let sourceType = '';
    let sourceUrl = '';
    let crawledAt = '';
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        title = meta.title || '';
        author = meta.author || '';
        postDate = meta.postDate || '';
        sourceType = meta.sourceType || '';
        sourceUrl = meta.source || '';
        crawledAt = meta.crawledAt || '';
      } catch {
        // Ignore unreadable metadata
      }
    }
    if (!sourceType && sourceUrl) {
      if (sourceUrl.includes('patreon.com')) sourceType = 'patreon';
      else if (sourceUrl.includes('substack.com') || sourceUrl.includes('/p/')) sourceType = 'substack';
    }
    if (!crawledAt) {
      const stat = fs.statSync(filepath);
      crawledAt = stat.birthtime || stat.ctime || stat.mtime;
    }
    res.json({ content, filename: safeName, title, author, postDate, sourceType, sourceUrl, crawledAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/posts/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  if (!safeName.endsWith('.md')) {
    return res.status(400).json({ error: 'Only .md files can be deleted.' });
  }
  try { batches.assertCanDelete(safeName); }
  catch (err) { return res.status(err.status || 409).json({ error: err.message }); }
  const slug = safeName.replace(/\.md$/, '');
  const errors = [];

  const mdPath = path.join(OUTPUT_DIR, safeName);
  if (fs.existsSync(mdPath)) {
    try { fs.unlinkSync(mdPath); } catch (err) { errors.push(err.message); }
  }

  const imgDir = path.join(OUTPUT_DIR, 'images', slug);
  if (fs.existsSync(imgDir)) {
    try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch (err) { errors.push(err.message); }
  }

  const metaPath = path.join(OUTPUT_DIR, 'meta', `${slug}.json`);
  if (fs.existsSync(metaPath)) {
    try { fs.unlinkSync(metaPath); } catch (err) { errors.push(err.message); }
  }

  if (errors.length) return res.status(500).json({ error: errors.join('; ') });
  res.json({ deleted: safeName });
});

app.get('/posts/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  if (!safeName.endsWith('.md')) {
    return res.status(400).send('Only .md files can be downloaded.');
  }
  const filepath = path.join(OUTPUT_DIR, safeName);
  if (!fs.existsSync(filepath)) {
    return res.status(404).send('File not found.');
  }
  res.download(filepath, safeName);
});

app.get('/posts', (req, res) => {
  if (!fs.existsSync(OUTPUT_DIR)) return res.json([]);
  const metaDir = path.join(OUTPUT_DIR, 'meta');
  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const stat = fs.statSync(path.join(OUTPUT_DIR, name));
      let title = '';
      let author = '';
      let postDate = '';
      let sourceType = '';
      let sourceUrl = '';
      let crawledAt = '';
      try {
        const slug = name.replace(/\.md$/, '');
        const metaPath = path.join(metaDir, `${slug}.json`);
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          title = meta.title || '';
          author = meta.author || '';
          postDate = meta.postDate || '';
          sourceType = meta.sourceType || '';
          sourceUrl = meta.source || '';
          crawledAt = meta.crawledAt || '';
        }
      } catch {
        // Ignore broken metadata and keep listing the file.
      }
      if (!sourceType && sourceUrl) {
        if (sourceUrl.includes('patreon.com')) sourceType = 'patreon';
        else if (sourceUrl.includes('substack.com') || sourceUrl.includes('/p/')) sourceType = 'substack';
      }
      if (!crawledAt) {
        crawledAt = stat.birthtime || stat.ctime || stat.mtime;
      }
      return {
        filename: name,
        title,
        size: stat.size,
        mtime: stat.mtime,
        author,
        postDate,
        sourceType,
        sourceUrl,
        crawledAt,
      };
    })
    .sort((a, b) => {
      // Default sort by article publication date (postDate), newest first
      const da = a.postDate ? new Date(a.postDate) : null;
      const db = b.postDate ? new Date(b.postDate) : null;
      const validA = da && !Number.isNaN(da.getTime());
      const validB = db && !Number.isNaN(db.getTime());
      if (validA && validB) return db - da;
      if (validB) return 1;
      if (validA) return -1;
      const ca = new Date(a.crawledAt || a.mtime);
      const cb = new Date(b.crawledAt || b.mtime);
      return cb - ca;
    });
  res.json(files);
});

return app;
}

if (require.main === module) {
  const port = parseInt(process.env.PORT || '3000', 10);
  createApp().listen(port, () => console.log(`P Creator Crawl running at http://localhost:${port}`));
}
module.exports = { createApp };
