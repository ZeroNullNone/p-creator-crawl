'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');

function articlePath(outputDir, filename) {
  if (typeof filename !== 'string' || path.basename(filename) !== filename || !filename.endsWith('.md')) {
    throw new Error('Invalid article filename.');
  }
  return path.join(outputDir, filename);
}

function inspectImages(outputDir, filename) {
  const markdown = fs.readFileSync(articlePath(outputDir, filename), 'utf8');
  const urls = [...new Set([...markdown.matchAll(/!\[(?:\\.|[^\]\\])*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)].map(m => m[1]))];
  const local = urls.filter(url => url.startsWith('images/'));
  const missing = local.filter(url => {
    const file = path.resolve(outputDir, url);
    return !file.startsWith(`${path.resolve(outputDir)}${path.sep}`)
      || !fs.existsSync(file) || fs.statSync(file).size === 0;
  });
  return { local: local.length, remote: urls.filter(url => /^https?:\/\//i.test(url)), missing };
}

async function repairImages(outputDir, filename, get = axios.get) {
  const file = articlePath(outputDir, filename);
  const stat = fs.statSync(file);
  let markdown = fs.readFileSync(file, 'utf8');
  const { remote } = inspectImages(outputDir, filename);
  for (const url of remote) {
    try {
      const response = await get(url, { responseType: 'arraybuffer', timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0' } });
      const type = String(response.headers['content-type'] || '').split(';')[0];
      const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
        'image/gif': '.gif', 'image/avif': '.avif', 'image/svg+xml': '.svg' }[type];
      if (!ext || !response.data.length) continue;
      // Never recreate an article deleted while this operation was in flight.
      if (!fs.existsSync(file)) return { local: 0, pending: 0, deleted: true };
      const slug = filename.slice(0, -3);
      const dir = path.join(outputDir, 'images', slug);
      fs.mkdirSync(dir, { recursive: true });
      let n = 1;
      while (fs.existsSync(path.join(dir, `recovered-${n}${ext}`))) n += 1;
      const relative = `images/${slug}/recovered-${n}${ext}`;
      fs.writeFileSync(path.join(outputDir, relative), response.data, { flag: 'wx' });
      markdown = markdown.split(url).join(relative);
      fs.writeFileSync(`${file}.tmp`, markdown);
      fs.renameSync(`${file}.tmp`, file);
      fs.utimesSync(file, stat.atime, stat.mtime);
    } catch {
      // Keep the remote reference and expose an honest warning for another attempt.
    }
  }
  const result = inspectImages(outputDir, filename);
  return { local: result.local, pending: result.remote.length + result.missing.length };
}

module.exports = { inspectImages, repairImages };
