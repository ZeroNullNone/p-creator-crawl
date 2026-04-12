'use strict';
require('dotenv').config();

const puppeteer = require('puppeteer-core');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');
const axios = require('axios');
const slugify = require('slugify');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || 'posts');
const IMAGES_DIR = path.join(OUTPUT_DIR, 'images');
const COOKIES_FILE = path.resolve('patreon-cookies.json');

// Selectors tried in order to find the article body
const CONTENT_SELECTORS = [
  '[data-tag="post-content"]',
  '[data-tag="post-body"]',
  'div[class*="postContent"]',
  'div[class*="PostContent"]',
  'div[class*="post-content"]',
  'div[class*="postBody"]',
  'div[class*="PostBody"]',
  'div[class*="articleContent"]',
  'div[class*="ArticleContent"]',
  '.post-content',
  'article',
];

// Selectors tried in order to find the article title
const TITLE_SELECTORS = [
  '[data-tag="post-title"]',
  'h1[class*="title"]',
  'h1[class*="Title"]',
  '.sc-title',
  'h1',
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeSlug(text) {
  // If title contains non-ASCII characters (Chinese, Japanese, etc.), preserve
  // them in the filename instead of letting slugify strip them to a partial match.
  if (/[^\x00-\x7F]/.test(text)) {
    return text
      .replace(/[\\/:*?"<>|]/g, '-')   // invalid on Windows
      .replace(/\s+/g, '-')             // spaces → dash
      .replace(/-{2,}/g, '-')           // collapse multiple dashes
      .replace(/^-+|-+$/g, '')          // trim leading/trailing dashes
      .slice(0, 200)                    // keep filename reasonable
      || 'untitled';
  }
  // ASCII-only titles: use slugify for clean lowercase slugs
  return slugify(text, { lower: true, strict: true, trim: true }) || 'untitled';
}

async function downloadImage(url, destPath) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    fs.writeFileSync(destPath, response.data);
    return true;
  } catch {
    return false;
  }
}

/** Save cookies exported from Cookie-Editor to patreon-cookies.json. */
function saveCookies(cookieArray) {
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookieArray, null, 2), 'utf8');
}

/** Load saved cookies. Returns null if file doesn't exist or is invalid. */
function loadCookies() {
  try {
    if (!fs.existsSync(COOKIES_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
    if (!Array.isArray(data) || data.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Normalise Cookie-Editor export format to Puppeteer's setCookie format.
 * Cookie-Editor uses "expirationDate"; Puppeteer uses "expires".
 */
// Cookie-Editor sameSite values → CDP-accepted values
const SAME_SITE_MAP = {
  no_restriction: 'None',
  lax: 'Lax',
  strict: 'Strict',
  unspecified: '',
};

function normaliseCookies(cookies) {
  return cookies.map((c) => {
    const out = {};
    // Only forward fields Puppeteer/CDP accepts
    for (const key of ['name', 'value', 'domain', 'path', 'secure', 'httpOnly']) {
      if (c[key] !== undefined) out[key] = c[key];
    }
    // expirationDate (Cookie-Editor) → expires (CDP)
    const exp = c.expires ?? c.expirationDate;
    if (exp !== undefined && exp !== -1) out.expires = exp;
    // Normalise sameSite to CDP-accepted string
    if (c.sameSite != null) {
      const mapped = SAME_SITE_MAP[c.sameSite.toLowerCase()];
      out.sameSite = mapped !== undefined ? mapped : '';
    }
    return out;
  });
}


function extractPostId(url) {
  try {
    const slug = new URL(url).pathname.split('/').filter(Boolean)[1] || '';
    const m = slug.match(/(\d+)$/);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * Extract images from Patreon API response's `included` media objects.
 * These are images attached to the post but not embedded in attrs.content.
 */
function extractApiMediaImages(json, existingContent = '') {
  if (!json?.included) return '';
  return json.included
    .filter(item => item.type === 'media' &&
      (item.attributes?.media_type === 'image' || item.attributes?.image_urls))
    .map(item => {
      const url = item.attributes?.download_url
        || item.attributes?.image_urls?.original
        || item.attributes?.image_urls?.default
        || item.attributes?.image_urls?.url;
      if (!url || existingContent.includes(url)) return null;
      return `<figure><img src="${url}"></figure>`;
    })
    .filter(Boolean)
    .join('');
}

async function scrapePatreon(articleUrl) {
  const executablePath = process.env.CHROME_EXECUTABLE_PATH;
  const headless = process.env.HEADLESS !== 'false';

  const cookies = loadCookies();
  if (!cookies) {
    throw new Error(
      'No Patreon cookies found.\n\n' +
      'Export your cookies:\n' +
      '  1. Open patreon.com in Chrome\n' +
      '  2. Click the Cookie-Editor extension → Export All\n' +
      '  3. Paste the JSON into the "Set Cookies" panel in this app'
    );
  }

  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new Error(
      `Chrome not found at: ${executablePath}\nUpdate CHROME_EXECUTABLE_PATH in .env`
    );
  }

  const browser = await puppeteer.launch({
    executablePath,
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });
  const page = await browser.newPage();

  try {
    // Anti-bot: spoof user agent and hide webdriver flag
    await page.setUserAgent(USER_AGENT);
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Inject cookies into the fresh browser session
    await page.goto('https://www.patreon.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.setCookie(...normaliseCookies(cookies));

    // Suppress fonts and media to speed up loading
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['font', 'media'].includes(type)) req.abort();
      else req.continue();
    });

    // ── Strategy 1: intercept Patreon's own SPA API call ─────────────────────
    // Must be registered BEFORE page.goto so we don't miss the response.
    let capturedPost = null;
    let capturedApiJson = null;
    page.on('response', async (response) => {
      if (capturedPost) return;
      try {
        if (!/\/api\/posts\/\d+/.test(response.url())) return;
        const json = await response.json();
        capturedApiJson = json;
        const attrs = json?.data?.attributes;
        if (attrs?.content) {
          const mediaHtml = extractApiMediaImages(json, attrs.content);
          capturedPost = { title: attrs.title || '', content: attrs.content + mediaHtml };
        }
      } catch { /* not the post API */ }
    });

    await page.goto(articleUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    // Wait for async response handlers + SPA rendering
    await new Promise(r => setTimeout(r, 3000));

    let title = '';
    let bodyHtml = '';

    if (capturedPost?.content) {
      title = capturedPost.title;
      bodyHtml = capturedPost.content;
      console.log('[scraper] strategy 1 (API intercept) succeeded');
    }

    // ── Strategy 2: explicit in-page API fetch ────────────────────────────────
    if (!bodyHtml) {
      const postId = extractPostId(articleUrl);
      if (postId) {
        const api = await page.evaluate(async (id) => {
          try {
            const r = await fetch(`/api/posts/${id}`, { credentials: 'include' });
            if (!r.ok) return null;
            const json = await r.json();
            const attrs = json?.data?.attributes;
            if (!attrs?.content) return null;
            return { title: attrs.title || '', content: attrs.content, _json: json };
          } catch { return null; }
        }, postId);
        if (api?.content) {
          if (!capturedApiJson) capturedApiJson = api._json;
          const mediaHtml = extractApiMediaImages(api._json, api.content);
          title = api.title;
          bodyHtml = api.content + mediaHtml;
          console.log('[scraper] strategy 2 (eval API fetch) succeeded');
        }
      }
    }

    // ── Strategy 3: collect unique <p>/heading/figure/img nodes in DOM order ─────
    // Always runs so images appear in their correct positions (not appended at end).
    // Scopes to the post content container first so only content images are included.
    const r3 = await page.evaluate((tSels) => {
        let t = document.title.replace(/\s*[-|]\s*Patreon.*$/i, '').trim();
        for (const s of tSels) {
          const el = document.querySelector(s);
          if (el?.textContent?.trim()) { t = el.textContent.trim(); break; }
        }

        // Find the tightest post-content container available
        const CONTENT_ROOTS = [
          '[data-tag="post-content"]', '[data-tag="post-body"]',
          'div[class*="postContent"]', 'div[class*="PostContent"]',
          'div[class*="post-content"]', 'article', 'main',
        ];
        let scope = null;
        for (const sel of CONTENT_ROOTS) {
          const el = document.querySelector(sel);
          if (el && (el.innerText || '').trim().length > 100) { scope = el; break; }
        }
        // Fall back to full document if no scoped container found
        if (!scope) scope = document;

        const RELATED_RE = /^(related posts?|popular posts?|you might also like|more from)$/i;
        const FILE_EXT_RE = /\.[a-zA-Z0-9]{2,6}$/;  // paragraph looks like an attached filename
        const seen = new Set();
        const parts = [];
        let textStarted = false;     // gate: skip images before first real paragraph
        let lastWasFilename = false; // gate: skip attachment thumbnail after a filename label
        for (const el of scope.querySelectorAll('p, h2, h3, h4, blockquote, figure, img')) {
          // Skip structural chrome, comment sections, and file-attachment containers
          if (el.closest('nav, header, footer, [role="navigation"], [data-tag*="related"], [data-tag*="popular"], [data-tag*="comment"], [data-tag*="attachment"], [class*="ttachment"]')) continue;
          const tag = el.tagName.toLowerCase();
          if (tag === 'img') {
            if (!textStarted || lastWasFilename) { lastWasFilename = false; continue; }
            if (el.closest('figure')) continue; // handled by the figure branch
            const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
            if (!src || src.startsWith('data:') || seen.has(src)) continue;
            seen.add(src);
            lastWasFilename = false;
            parts.push(`<figure><img src="${src}"></figure>`);
          } else if (tag === 'figure') {
            if (!textStarted || lastWasFilename) { lastWasFilename = false; continue; }
            const img = el.querySelector('img');
            if (!img) continue;
            const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
            if (!src || src.startsWith('data:') || seen.has(src)) continue;
            if (!img.getAttribute('src') || img.getAttribute('src').startsWith('data:')) img.setAttribute('src', src);
            seen.add(src);
            lastWasFilename = false;
            parts.push(el.outerHTML);
          } else {
            const text = (el.innerText || '').trim();
            if (RELATED_RE.test(text)) break;
            if (text.length < 10) continue;
            // Detect attachment filename labels (short text ending with a file extension)
            if (text.length < 120 && FILE_EXT_RE.test(text)) { lastWasFilename = true; continue; }
            lastWasFilename = false;
            textStarted = true;
            if (!seen.has(text)) { seen.add(text); parts.push(el.outerHTML); }
          }
        }

        // Debug: top containers by text length
        const tops = [];
        document.querySelectorAll('div, section, article, main, aside').forEach(el => {
          const len = (el.innerText || '').trim().length;
          if (len > 200) tops.push({ sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : (el.className ? '.' + String(el.className).split(' ')[0] : '')), len });
        });
        tops.sort((a, b) => b.len - a.len);

        return { title: t, bodyHtml: parts.join(''), debugInfo: tops.slice(0, 8), scopeUsed: scope === document ? 'document' : scope.tagName + (scope.dataset?.tag ? `[data-tag="${scope.dataset.tag}"]` : '') };
      }, TITLE_SELECTORS);

    const domHasImages = r3.bodyHtml && /<img/i.test(r3.bodyHtml);
    console.log(`[scraper] strategy 3 scope=${r3.scopeUsed} hasImages=${domHasImages} bodyLen=${(r3.bodyHtml || '').length}`);
    if (domHasImages) {
      // DOM has images interspersed at correct positions — always prefer this
      if (!title) title = r3.title;
      bodyHtml = r3.bodyHtml;
      console.log('[scraper] strategy 3 (DOM with images) used for correct ordering');
    } else if (!bodyHtml) {
      if (r3.bodyHtml) {
        title = r3.title; bodyHtml = r3.bodyHtml;
        console.log('[scraper] strategy 3 (p-dedup) succeeded');
      } else {
        const debugDir = path.join(OUTPUT_DIR, 'debug');
        ensureDir(debugDir);
        const ts = Date.now();
        await page.screenshot({ path: path.join(debugDir, `debug-${ts}.png`), fullPage: false });
        const html = await page.content();
        fs.writeFileSync(path.join(debugDir, `debug-${ts}.html`), html.slice(0, 200000), 'utf8');
        console.error('[debug] top elements:', JSON.stringify(r3.debugInfo));
        throw new Error(
          `Could not find article content.\nScreenshot → posts/debug/debug-${ts}.png\n\n` +
          `Top elements:\n${r3.debugInfo.map(d => `  ${d.sel}: ${d.len} chars`).join('\n')}\n\n` +
          `If it shows a login wall, re-export cookies from Cookie-Editor.`
        );
      }
    }

    if (!title) title = await page.title().then(t => t.replace(/\s*[-|]\s*Patreon.*$/i, '').trim());

    // ── Extract author and post date ─────────────────────────────────────────
    let author = '';
    let postDate = '';

    // Prefer API JSON (most reliable)
    if (capturedApiJson) {
      const attrs = capturedApiJson.data?.attributes || {};
      if (attrs.published_at) postDate = attrs.published_at;
      const included = capturedApiJson.included || [];
      const campaign = included.find(i => i.type === 'campaign');
      const user     = included.find(i => i.type === 'user');
      author = campaign?.attributes?.name
            || user?.attributes?.full_name
            || user?.attributes?.vanity
            || '';
    }
    // DOM fallback
    if (!author || !postDate) {
      const domMeta = await page.evaluate(() => {
        const authorEl = document.querySelector(
          '[data-tag="creator-name"], [data-tag="creator-vanity-name"], ' +
          '[data-tag="post-author"], [data-tag="patron-name"]'
        );
        const timeEl = document.querySelector('time[datetime]');
        return {
          author:   authorEl?.textContent?.trim() || '',
          postDate: timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || '',
        };
      });
      if (!author)   author   = domMeta.author;
      if (!postDate) postDate = domMeta.postDate;
    }
    if (author)   console.log(`[scraper] author="${author}" date="${postDate}"`);

    const slug = safeSlug(title);
    const imgDir = path.join(IMAGES_DIR, slug);
    ensureDir(imgDir);

    const imgTagRegex = /<img[^>]+>/gi;
    const seen = new Set();
    const jobs = [];
    let match, imgCounter = 0;

    while ((match = imgTagRegex.exec(bodyHtml)) !== null) {
      const imgTag = match[0];
      const srcM = imgTag.match(/\bsrc="([^"]+)"/i) || imgTag.match(/\bsrc='([^']+)'/i);
      const dataSrcM = imgTag.match(/\bdata-src="([^"]+)"/i) || imgTag.match(/\bdata-src='([^']+)'/i);
      // Prefer src unless it's a data URI placeholder, then fall back to data-src
      const originalSrc = (srcM?.[1] && !srcM[1].startsWith('data:')) ? srcM[1] : dataSrcM?.[1];
      if (!originalSrc || originalSrc.startsWith('data:') || seen.has(originalSrc)) continue;
      seen.add(originalSrc);
      try {
        const url = new URL(originalSrc);
        const ext = path.extname(url.pathname).split('?')[0] || '.jpg';
        imgCounter += 1;
        const filename = `img-${imgCounter}${ext}`;
        jobs.push({ originalSrc, filename, destPath: path.join(imgDir, filename), relPath: `images/${slug}/${filename}` });
      } catch { /* skip */ }
    }

    const results = await Promise.all(jobs.map((j) => downloadImage(j.originalSrc, j.destPath)));
    const replacements = new Map();
    jobs.forEach((j, i) => { if (results[i]) replacements.set(j.originalSrc, j.relPath); });

    let processedHtml = bodyHtml;
    for (const [original, local] of replacements) {
      const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      processedHtml = processedHtml.replace(new RegExp(escaped, 'g'), local);
    }

    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    td.use(gfm);
    td.addRule('lineBreak', { filter: 'br', replacement: () => '\n' });

    let bodyMd = td.turndown(processedHtml);
    // Strip "Related posts" / "Popular posts" sections and everything after them
    bodyMd = bodyMd.replace(/\n+#{1,3}\s*(related posts?|popular posts?|you might also like|more from\b)[^\n]*/i, '').trimEnd();
    // Strip author name heading from start (Patreon renders it in post header)
    if (author) {
      const escapedAuthor = author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      bodyMd = bodyMd.replace(new RegExp(`^#{1,4}\\s+${escapedAuthor}\\s*\\n+`, 'm'), '');
    }
    // Strip any date line near the start (e.g. "Jan 31, 2025")
    bodyMd = bodyMd.replace(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\s*\n+/m, '');
    bodyMd = bodyMd.trimStart();

    const markdown = `# ${title}\n\n${bodyMd}\n\n---\n\nSource: ${articleUrl}`;

    ensureDir(OUTPUT_DIR);
    const filename = `${slug}.md`;
    const filepath = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(filepath, markdown, 'utf8');

    // Set file modification time to the post's publish date
    if (postDate) {
      const d = new Date(postDate);
      if (!isNaN(d.getTime())) fs.utimesSync(filepath, d, d);
    }

    // Save sidecar metadata for the library UI
    const META_DIR = path.join(OUTPUT_DIR, 'meta');
    ensureDir(META_DIR);
    fs.writeFileSync(
      path.join(META_DIR, `${slug}.json`),
      JSON.stringify({ title, author, postDate, source: articleUrl }, null, 2),
      'utf8'
    );

    return { title, markdown, filename, filepath };
  } finally {
    await page.close();
    await browser.close();
  }
}

module.exports = { scrapePatreon, saveCookies, loadCookies };
