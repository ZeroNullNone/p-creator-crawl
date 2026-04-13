'use strict';
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const { scrapePatreon, saveCookies, loadCookies } = require('./scraper');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || 'posts');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(OUTPUT_DIR, 'images')));

// POST /cookies — save Cookie-Editor export JSON
app.post('/cookies', (req, res) => {
  const { cookies } = req.body;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return res.status(400).json({ error: 'Expected a non-empty array of cookies.' });
  }
  try {
    saveCookies(cookies);
    res.json({ saved: cookies.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /cookies/status — check if cookies are saved
app.get('/cookies/status', (req, res) => {
  const cookies = loadCookies();
  res.json({ hasCookies: !!cookies, count: cookies ? cookies.length : 0 });
});

// POST /scrape  — { url: "https://www.patreon.com/posts/..." }
app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.includes('patreon.com')) {
    return res.status(400).json({ error: 'Please provide a valid Patreon URL.' });
  }

  // Check for duplicate: scan meta files for matching source URL
  const metaDir = path.join(OUTPUT_DIR, 'meta');
  if (fs.existsSync(metaDir)) {
    for (const file of fs.readdirSync(metaDir).filter(f => f.endsWith('.json'))) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(metaDir, file), 'utf8'));
        if (meta.source === url) {
          const filename = file.replace(/\.json$/, '.md');
          return res.status(409).json({
            error: `Duplicate: this URL has already been saved as "${meta.title || filename}".`,
            duplicate: true,
            filename,
            title: meta.title || '',
          });
        }
      } catch { /* skip unreadable meta */ }
    }
  }

  try {
    const result = await scrapePatreon(url);
    res.json({
      title: result.title,
      markdown: result.markdown,
      filename: result.filename,
    });
  } catch (err) {
    console.error('[scrape error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /posts/:filename/read  — return markdown content for inline reading
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

// DELETE /posts/:filename  — remove .md, images folder, and meta sidecar
app.delete('/posts/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  if (!safeName.endsWith('.md')) {
    return res.status(400).json({ error: 'Only .md files can be deleted.' });
  }
  const slug = safeName.replace(/\.md$/, '');
  const errors = [];

  const mdPath = path.join(OUTPUT_DIR, safeName);
  if (fs.existsSync(mdPath)) {
    try { fs.unlinkSync(mdPath); } catch (e) { errors.push(e.message); }
  }

  const imgDir = path.join(OUTPUT_DIR, 'images', slug);
  if (fs.existsSync(imgDir)) {
    try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch (e) { errors.push(e.message); }
  }

  const metaPath = path.join(OUTPUT_DIR, 'meta', `${slug}.json`);
  if (fs.existsSync(metaPath)) {
    try { fs.unlinkSync(metaPath); } catch (e) { errors.push(e.message); }
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

// GET /posts  — list saved .md files
app.get('/posts', (req, res) => {
  if (!fs.existsSync(OUTPUT_DIR)) return res.json([]);
  const metaDir = path.join(OUTPUT_DIR, 'meta');
  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const stat = fs.statSync(path.join(OUTPUT_DIR, f));
      let author = '', postDate = '';
      try {
        const slug = f.replace(/\.md$/, '');
        const metaPath = path.join(metaDir, `${slug}.json`);
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          author   = meta.author   || '';
          postDate = meta.postDate || '';
        }
      } catch { /* ignore */ }
      return { filename: f, size: stat.size, mtime: stat.mtime, author, postDate };
    })
    .sort((a, b) => {
      const da = a.postDate ? new Date(a.postDate) : new Date(a.mtime);
      const db = b.postDate ? new Date(b.postDate) : new Date(b.mtime);
      return db - da;
    });
  res.json(files);
});

app.listen(PORT, () => {
  console.log(`Patreon Claw running at http://localhost:${PORT}`);
});
