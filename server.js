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

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || 'posts');
const SUPPORTED_SOURCES = new Set(['patreon', 'substack']);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
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

app.post('/scrape', async (req, res) => {
  const rawUrl = typeof req.body.url === 'string' ? req.body.url.trim() : '';
  if (!rawUrl) {
    return res.status(400).json({ error: 'Please provide a Patreon or Substack article URL.' });
  }

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
    res.json({ content, filename: safeName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/posts/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  if (!safeName.endsWith('.md')) {
    return res.status(400).json({ error: 'Only .md files can be deleted.' });
  }
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
      let author = '';
      let postDate = '';
      let sourceType = '';
      try {
        const slug = name.replace(/\.md$/, '');
        const metaPath = path.join(metaDir, `${slug}.json`);
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          author = meta.author || '';
          postDate = meta.postDate || '';
          sourceType = meta.sourceType || '';
        }
      } catch {
        // Ignore broken metadata and keep listing the file.
      }
      return { filename: name, size: stat.size, mtime: stat.mtime, author, postDate, sourceType };
    })
    .sort((a, b) => {
      const da = a.postDate ? new Date(a.postDate) : new Date(a.mtime);
      const db = b.postDate ? new Date(b.postDate) : new Date(b.mtime);
      return db - da;
    });
  res.json(files);
});

app.listen(PORT, () => {
  console.log(`P Creator Crawl running at http://localhost:${PORT}`);
});
