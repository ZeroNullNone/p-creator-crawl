'use strict';
require('dotenv').config();

const puppeteer = require('puppeteer-core');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');
const { MathMLToLaTeX } = require('mathml-to-latex');
const axios = require('axios');
const slugify = require('slugify');
const path = require('path');
const fs = require('fs');

const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || 'posts');
const IMAGES_DIR = path.join(OUTPUT_DIR, 'images');
const META_DIR = path.join(OUTPUT_DIR, 'meta');
const COOKIE_FILES = {
  patreon: path.resolve('patreon-cookies.json'),
  substack: path.resolve('substack-cookies.json'),
};

const PATREON_TITLE_SELECTORS = [
  '[data-tag="post-title"]',
  'h1[class*="title"]',
  'h1[class*="Title"]',
  '.sc-title',
  'h1',
];

const SUBSTACK_TITLE_SELECTORS = [
  '[data-testid="post-title"]',
  'h1.post-title',
  'h1[class*="post"]',
  'h1',
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const SUBSTACK_HTML_MARKERS = [
  /substackcdn\.com/i,
  /substack-post-media\.s3\.amazonaws\.com/i,
  /\bsubstack\.com\/api\//i,
  /<meta[^>]+name="twitter:image"[^>]+content="[^"]*substack/i,
  /<meta[^>]+property="og:image"[^>]+content="[^"]*substack/i,
  /<meta[^>]+name="author"[^>]+content="[^"]+"/i,
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeSlug(text) {
  if (/[^\x00-\x7F]/.test(text)) {
    return text
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 200)
      || 'untitled';
  }
  return slugify(text, { lower: true, strict: true, trim: true }) || 'untitled';
}

function getCookieFile(source) {
  const file = COOKIE_FILES[source];
  if (!file) {
    throw new Error(`Unsupported source "${source}".`);
  }
  return file;
}

async function downloadImage(url, destPath) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': USER_AGENT },
    });
    fs.writeFileSync(destPath, response.data);
    return true;
  } catch {
    return false;
  }
}

function cookieIdentity(cookie) {
  return [
    cookie.name || '',
    cookie.domain || cookie.url || '',
    cookie.path || '/',
  ].join('\u0000');
}

function mergeCookieArrays(existingCookies, incomingCookies) {
  const merged = new Map();
  for (const cookie of existingCookies || []) {
    if (cookie?.name) merged.set(cookieIdentity(cookie), cookie);
  }
  for (const cookie of incomingCookies || []) {
    if (cookie?.name) merged.set(cookieIdentity(cookie), cookie);
  }
  return Array.from(merged.values());
}

function saveCookies(source, cookieArray) {
  const cookiesToSave = source === 'substack'
    ? mergeCookieArrays(loadCookies(source) || [], cookieArray)
    : cookieArray;
  fs.writeFileSync(getCookieFile(source), JSON.stringify(cookiesToSave, null, 2), 'utf8');
  return cookiesToSave.length;
}

function loadCookies(source) {
  try {
    const cookieFile = getCookieFile(source);
    if (!fs.existsSync(cookieFile)) return null;
    const data = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
    if (!Array.isArray(data) || data.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

const SAME_SITE_MAP = {
  no_restriction: 'None',
  lax: 'Lax',
  strict: 'Strict',
  unspecified: '',
};

function normaliseCookies(cookies) {
  return cookies.map((c) => {
    const out = {};
    for (const key of ['name', 'value', 'domain', 'path', 'secure', 'httpOnly']) {
      if (c[key] !== undefined) out[key] = c[key];
    }
    const exp = c.expires ?? c.expirationDate;
    if (exp !== undefined && exp !== -1) out.expires = exp;
    if (c.sameSite != null) {
      const mapped = SAME_SITE_MAP[String(c.sameSite).toLowerCase()];
      out.sameSite = mapped !== undefined ? mapped : '';
    }
    return out;
  }).filter((cookie) => cookie.name && cookie.value !== undefined && (cookie.domain || cookie.url));
}

function getCookieDomain(cookie) {
  if (cookie?.domain) return String(cookie.domain).toLowerCase().replace(/^\./, '');
  if (cookie?.url) {
    try {
      return new URL(cookie.url).hostname.toLowerCase();
    } catch {
      return '';
    }
  }
  return '';
}

function hasCookieForHost(cookies, host) {
  const targetHost = String(host || '').toLowerCase().replace(/^\./, '');
  if (!targetHost) return false;
  return (cookies || []).some((cookie) => {
    const cookieHost = getCookieDomain(cookie);
    return cookieHost === targetHost
      || targetHost.endsWith(`.${cookieHost}`)
      || cookieHost.endsWith(`.${targetHost}`);
  });
}

function extractPatreonPostId(url) {
  try {
    const slug = new URL(url).pathname.split('/').filter(Boolean)[1] || '';
    const m = slug.match(/(\d+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function extractApiMediaImages(json, existingContent = '') {
  if (!json?.included) return '';
  return json.included
    .filter((item) => item.type === 'media'
      && (item.attributes?.media_type === 'image' || item.attributes?.image_urls))
    .map((item) => {
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

function stripSiteSuffix(title, source) {
  if (!title) return '';
  if (source === 'patreon') {
    return title.replace(/\s*[-|]\s*Patreon.*$/i, '').trim();
  }
  if (source === 'substack') {
    return title
      .replace(/\s*[-|]\s*Substack.*$/i, '')
      .replace(/\s*[-|]\s*on\s+Substack.*$/i, '')
      .trim();
  }
  return title.trim();
}

function looksLikeSubstack(pageUrl, html) {
  const host = new URL(pageUrl).hostname.toLowerCase();
  if (host.endsWith('.substack.com')) return true;
  const sample = String(html || '').slice(0, 80000);
  return SUBSTACK_HTML_MARKERS.some((re) => re.test(sample));
}

async function detectSource(articleUrl) {
  let parsed;
  try {
    parsed = new URL(articleUrl);
  } catch {
    throw new Error('Please provide a valid Patreon or Substack article URL.');
  }

  const host = parsed.hostname.toLowerCase();
  if (host.includes('patreon.com')) return 'patreon';
  if (host.endsWith('.substack.com')) return 'substack';

  try {
    const response = await axios.get(articleUrl, {
      responseType: 'text',
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    const finalUrl = response.request?.res?.responseUrl || articleUrl;
    const finalHost = new URL(finalUrl).hostname.toLowerCase();
    if (finalHost.includes('patreon.com')) return 'patreon';
    if (looksLikeSubstack(finalUrl, response.data)) return 'substack';
  } catch {
    // Fall through to the unsupported-source error below.
  }

  throw new Error('Please provide a Patreon article URL or a direct Substack article URL.');
}

function getChromeExecutablePath() {
  const executablePath = process.env.CHROME_EXECUTABLE_PATH;
  if (!executablePath || !fs.existsSync(executablePath)) {
    throw new Error(`Chrome not found at: ${executablePath}\nUpdate CHROME_EXECUTABLE_PATH in .env`);
  }
  return executablePath;
}

async function withScrapePage(run) {
  const browser = await puppeteer.launch({
    executablePath: getChromeExecutablePath(),
    headless: process.env.HEADLESS !== 'false',
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
    await page.setUserAgent(USER_AGENT);
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['font', 'media'].includes(type)) req.abort();
      else req.continue();
    });

    return await run(page);
  } finally {
    await page.close();
    await browser.close();
  }
}

async function seedCookies(page, source, articleUrl, cookies) {
  if (!cookies?.length) return false;
  const seedUrl = source === 'patreon' ? 'https://www.patreon.com' : new URL(articleUrl).origin;
  await page.goto(seedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const normalised = normaliseCookies(cookies);
  if (normalised.length) {
    await page.setCookie(...normalised);
    return true;
  }
  return false;
}

async function saveDebugArtifacts(page) {
  const debugDir = path.join(OUTPUT_DIR, 'debug');
  ensureDir(debugDir);
  const ts = Date.now();
  const screenshotPath = path.join(debugDir, `debug-${ts}.png`);
  const htmlPath = path.join(debugDir, `debug-${ts}.html`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  const html = await page.content();
  fs.writeFileSync(htmlPath, html.slice(0, 200000), 'utf8');
  return {
    screenshotRelPath: `posts/debug/debug-${ts}.png`,
    htmlRelPath: `posts/debug/debug-${ts}.html`,
  };
}

function buildTurndownService() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  td.use(gfm);
  td.addRule('lineBreak', { filter: 'br', replacement: () => '\n' });
  return td;
}

function replaceLiteral(text, search, replacement) {
  return String(text).split(search).join(replacement);
}

function normaliseLatex(latex) {
  return String(latex || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatMarkdownMath(latex, display) {
  return display ? `$$\n${latex}\n$$` : `$${latex}$`;
}

async function prepareSubstackMathForMarkdown(page, bodyHtml) {
  if (!/<(?:mjx-container|math)\b|data-component-name="Latex|class="[^"]*latex-rendered/i.test(bodyHtml)) {
    return { html: bodyHtml, markdownReplacements: [] };
  }

  const extracted = await page.evaluate((html) => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html');
    const body = doc.body;
    const seen = new Set();
    const formulas = [];
    let formulaIndex = 0;

    for (const candidate of body.querySelectorAll('[data-component-name^="Latex"], .latex-rendered, mjx-container')) {
      const root = candidate.closest('[data-component-name^="Latex"], .latex-rendered') || candidate;
      if (seen.has(root)) continue;
      seen.add(root);

      const componentName = root.getAttribute('data-component-name') || '';
      const attrsRaw = root.getAttribute('data-attrs');
      let persistentExpression = '';
      if (attrsRaw) {
        try {
          const attrs = JSON.parse(attrsRaw);
          persistentExpression = typeof attrs.persistentExpression === 'string'
            ? attrs.persistentExpression.trim()
            : '';
        } catch {
          persistentExpression = '';
        }
      }

      const mathEl = root.querySelector('mjx-assistive-mml > math, math')
        || (root.tagName.toLowerCase() === 'math' ? root : null);
      if (!persistentExpression && !mathEl) continue;

      const assistive = root.querySelector('mjx-assistive-mml');
      const display = componentName.includes('Block')
        || assistive?.getAttribute('display') === 'block'
        || mathEl?.getAttribute('display') === 'block'
        || root.tagName.toLowerCase() === 'div';
      const placeholder = `COPILOTMATHPLACEHOLDER${++formulaIndex}TOKEN`;
      formulas.push({
        placeholder,
        latex: persistentExpression,
        mathml: mathEl?.outerHTML || '',
        display,
        fallbackText: (root.textContent || '').trim(),
      });

      if (display) {
        const block = doc.createElement('p');
        block.textContent = placeholder;
        root.replaceWith(block);
      } else {
        root.replaceWith(doc.createTextNode(placeholder));
      }
    }

    return { html: body.innerHTML, formulas };
  }, bodyHtml);

  const markdownReplacements = extracted.formulas.map((formula) => {
    try {
      const latex = normaliseLatex(formula.latex || MathMLToLaTeX.convert(formula.mathml));
      if (!latex) throw new Error('Empty LaTeX output');
      return {
        placeholder: formula.placeholder,
        replacement: formatMarkdownMath(latex, formula.display),
      };
    } catch {
      const fallback = formula.display
        ? `[Formula not converted: ${formula.fallbackText || 'math block'}]`
        : `[Formula not converted: ${formula.fallbackText || 'inline math'}]`;
      return {
        placeholder: formula.placeholder,
        replacement: fallback,
      };
    }
  });

  return { html: extracted.html, markdownReplacements };
}

function cleanMarkdown(bodyMd, author) {
  let cleaned = bodyMd;
  cleaned = cleaned.replace(/\n+#{1,3}\s*(related posts?|popular posts?|you might also like|more from\b)[^\n]*/i, '').trimEnd();
  if (author) {
    const escapedAuthor = author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    cleaned = cleaned.replace(new RegExp(`^#{1,4}\\s+${escapedAuthor}\\s*\\n+`, 'm'), '');
  }
  cleaned = cleaned.replace(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\s*\n+/m, '');
  return cleaned.trimStart();
}

function resolveUniqueSlug(baseSlug) {
  ensureDir(OUTPUT_DIR);
  ensureDir(META_DIR);

  let candidate = baseSlug || 'untitled';
  let suffix = 2;
  while (
    fs.existsSync(path.join(OUTPUT_DIR, `${candidate}.md`))
    || fs.existsSync(path.join(META_DIR, `${candidate}.json`))
  ) {
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function localiseImages(bodyHtml, slug) {
  const imgTagRegex = /<img[^>]+>/gi;
  const seen = new Set();
  const jobs = [];
  let match;
  let imgCounter = 0;

  while ((match = imgTagRegex.exec(bodyHtml)) !== null) {
    const imgTag = match[0];
    const srcM = imgTag.match(/\bsrc="([^"]+)"/i) || imgTag.match(/\bsrc='([^']+)'/i);
    const dataSrcM = imgTag.match(/\bdata-src="([^"]+)"/i) || imgTag.match(/\bdata-src='([^']+)'/i);
    const originalSrc = (srcM?.[1] && !srcM[1].startsWith('data:')) ? srcM[1] : dataSrcM?.[1];
    if (!originalSrc || originalSrc.startsWith('data:') || seen.has(originalSrc)) continue;
    seen.add(originalSrc);
    try {
      const url = new URL(originalSrc);
      const ext = path.extname(url.pathname).split('?')[0] || '.jpg';
      imgCounter += 1;
      const filename = `img-${imgCounter}${ext}`;
      jobs.push({
        originalSrc,
        destPath: path.join(IMAGES_DIR, slug, filename),
        relPath: `images/${slug}/${filename}`,
      });
    } catch {
      // Skip invalid image URLs.
    }
  }

  if (!jobs.length) return bodyHtml;

  ensureDir(path.join(IMAGES_DIR, slug));
  const results = await Promise.all(jobs.map((job) => downloadImage(job.originalSrc, job.destPath)));
  const replacements = new Map();
  jobs.forEach((job, index) => {
    if (results[index]) replacements.set(job.originalSrc, job.relPath);
  });

  let processedHtml = bodyHtml;
  for (const [original, local] of replacements) {
    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    processedHtml = processedHtml.replace(new RegExp(escaped, 'g'), local);
  }
  return processedHtml;
}

async function finalizeArticle({
  title,
  bodyHtml,
  author = '',
  postDate = '',
  articleUrl,
  sourceType,
  markdownReplacements = [],
}) {
  const finalTitle = (title || 'Untitled').trim() || 'Untitled';
  const slug = resolveUniqueSlug(safeSlug(finalTitle));
  const processedHtml = await localiseImages(bodyHtml, slug);
  let bodyMd = buildTurndownService().turndown(processedHtml);
  for (const replacement of markdownReplacements) {
    bodyMd = replaceLiteral(bodyMd, replacement.placeholder, replacement.replacement);
  }
  bodyMd = cleanMarkdown(bodyMd, author);
  const markdown = `# ${finalTitle}\n\n${bodyMd}\n\n---\n\nSource: ${articleUrl}`;

  ensureDir(OUTPUT_DIR);
  ensureDir(META_DIR);

  const filename = `${slug}.md`;
  const filepath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(filepath, markdown, 'utf8');

  if (postDate) {
    const d = new Date(postDate);
    if (!Number.isNaN(d.getTime())) fs.utimesSync(filepath, d, d);
  }

  fs.writeFileSync(
    path.join(META_DIR, `${slug}.json`),
    JSON.stringify({ title: finalTitle, author, postDate, source: articleUrl, sourceType }, null, 2),
    'utf8'
  );

  return { title: finalTitle, markdown, filename, filepath, source: sourceType };
}

async function scrapePatreon(articleUrl) {
  const cookies = loadCookies('patreon');
  if (!cookies) {
    throw new Error(
      'No Patreon cookies found.\n\n'
      + 'Export your cookies:\n'
      + '  1. Open patreon.com in Chrome\n'
      + '  2. Click the Cookie-Editor extension → Export All\n'
      + '  3. Paste the JSON into the Patreon cookies panel in this app'
    );
  }

  return withScrapePage(async (page) => {
    await seedCookies(page, 'patreon', articleUrl, cookies);

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
      } catch {
        // Ignore unrelated responses.
      }
    });

    await page.goto(articleUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((resolve) => setTimeout(resolve, 3000));

    let title = '';
    let bodyHtml = '';

    if (capturedPost?.content) {
      title = capturedPost.title;
      bodyHtml = capturedPost.content;
      console.log('[scraper] strategy 1 (Patreon API intercept) succeeded');
    }

    if (!bodyHtml) {
      const postId = extractPatreonPostId(articleUrl);
      if (postId) {
        const api = await page.evaluate(async (id) => {
          try {
            const r = await fetch(`/api/posts/${id}`, { credentials: 'include' });
            if (!r.ok) return null;
            const json = await r.json();
            const attrs = json?.data?.attributes;
            if (!attrs?.content) return null;
            return { title: attrs.title || '', content: attrs.content, _json: json };
          } catch {
            return null;
          }
        }, postId);
        if (api?.content) {
          if (!capturedApiJson) capturedApiJson = api._json;
          const mediaHtml = extractApiMediaImages(api._json, api.content);
          title = api.title;
          bodyHtml = api.content + mediaHtml;
          console.log('[scraper] strategy 2 (Patreon in-page API fetch) succeeded');
        }
      }
    }

    const r3 = await page.evaluate((titleSelectors) => {
      let resolvedTitle = document.title.replace(/\s*[-|]\s*Patreon.*$/i, '').trim();
      for (const selector of titleSelectors) {
        const el = document.querySelector(selector);
        if (el?.textContent?.trim()) {
          resolvedTitle = el.textContent.trim();
          break;
        }
      }

      const contentRoots = [
        '[data-tag="post-content"]',
        '[data-tag="post-body"]',
        'div[class*="postContent"]',
        'div[class*="PostContent"]',
        'div[class*="post-content"]',
        'article',
        'main',
      ];

      let scope = null;
      for (const selector of contentRoots) {
        const el = document.querySelector(selector);
        if (el && (el.innerText || '').trim().length > 100) {
          scope = el;
          break;
        }
      }
      if (!scope) scope = document;

      const relatedRe = /^(related posts?|popular posts?|you might also like|more from)$/i;
      const fileExtRe = /\.[a-zA-Z0-9]{2,6}$/;
      const seen = new Set();
      const parts = [];
      let textStarted = false;
      let lastWasFilename = false;

      for (const el of scope.querySelectorAll('p, h2, h3, h4, blockquote, figure, img')) {
        if (el.closest('nav, header, footer, [role="navigation"], [data-tag*="related"], [data-tag*="popular"], [data-tag*="comment"], [data-tag*="attachment"], [class*="ttachment"]')) continue;

        const tag = el.tagName.toLowerCase();
        if (tag === 'img') {
          if (!textStarted || lastWasFilename || el.closest('figure')) {
            lastWasFilename = false;
            continue;
          }
          const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
          if (!src || src.startsWith('data:') || seen.has(src)) continue;
          seen.add(src);
          lastWasFilename = false;
          parts.push(`<figure><img src="${src}"></figure>`);
          continue;
        }

        if (tag === 'figure') {
          if (!textStarted || lastWasFilename) {
            lastWasFilename = false;
            continue;
          }
          const img = el.querySelector('img');
          if (!img) continue;
          const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
          if (!src || src.startsWith('data:') || seen.has(src)) continue;
          if (!img.getAttribute('src') || img.getAttribute('src').startsWith('data:')) {
            img.setAttribute('src', src);
          }
          seen.add(src);
          lastWasFilename = false;
          parts.push(el.outerHTML);
          continue;
        }

        const text = (el.innerText || '').trim();
        if (relatedRe.test(text)) break;
        if (text.length < 10) continue;
        if (text.length < 120 && fileExtRe.test(text)) {
          lastWasFilename = true;
          continue;
        }
        lastWasFilename = false;
        textStarted = true;
        if (!seen.has(text)) {
          seen.add(text);
          parts.push(el.outerHTML);
        }
      }

      const debugInfo = [];
      document.querySelectorAll('div, section, article, main, aside').forEach((el) => {
        const len = (el.innerText || '').trim().length;
        if (len > 200) {
          debugInfo.push({
            sel: el.tagName.toLowerCase()
              + (el.id ? `#${el.id}` : (el.className ? `.${String(el.className).split(' ')[0]}` : '')),
            len,
          });
        }
      });
      debugInfo.sort((a, b) => b.len - a.len);

      return {
        title: resolvedTitle,
        bodyHtml: parts.join(''),
        debugInfo: debugInfo.slice(0, 8),
        scopeUsed: scope === document ? 'document' : scope.tagName + (scope.dataset?.tag ? `[data-tag="${scope.dataset.tag}"]` : ''),
      };
    }, PATREON_TITLE_SELECTORS);

    const domHasImages = r3.bodyHtml && /<img/i.test(r3.bodyHtml);
    console.log(`[scraper] strategy 3 scope=${r3.scopeUsed} hasImages=${domHasImages} bodyLen=${(r3.bodyHtml || '').length}`);

    if (domHasImages) {
      if (!title) title = r3.title;
      bodyHtml = r3.bodyHtml;
      console.log('[scraper] strategy 3 (Patreon DOM with images) used for correct ordering');
    } else if (!bodyHtml) {
      if (r3.bodyHtml) {
        title = r3.title;
        bodyHtml = r3.bodyHtml;
        console.log('[scraper] strategy 3 (Patreon DOM text fallback) succeeded');
      } else {
        const debug = await saveDebugArtifacts(page);
        console.error('[debug] top elements:', JSON.stringify(r3.debugInfo));
        throw new Error(
          `Could not find Patreon article content.\nScreenshot → ${debug.screenshotRelPath}\n\n`
          + `Top elements:\n${r3.debugInfo.map((item) => `  ${item.sel}: ${item.len} chars`).join('\n')}\n\n`
          + 'If it shows a login wall, re-export your Patreon cookies from Cookie-Editor.'
        );
      }
    }

    if (!title) title = stripSiteSuffix(await page.title(), 'patreon');

    let author = '';
    let postDate = '';

    if (capturedApiJson) {
      const attrs = capturedApiJson.data?.attributes || {};
      if (attrs.published_at) postDate = attrs.published_at;
      const included = capturedApiJson.included || [];
      const campaign = included.find((item) => item.type === 'campaign');
      const user = included.find((item) => item.type === 'user');
      author = campaign?.attributes?.name
        || user?.attributes?.full_name
        || user?.attributes?.vanity
        || '';
    }

    if (!author || !postDate) {
      const domMeta = await page.evaluate(() => {
        const authorEl = document.querySelector(
          '[data-tag="creator-name"], [data-tag="creator-vanity-name"], [data-tag="post-author"], [data-tag="patron-name"]'
        );
        const timeEl = document.querySelector('time[datetime]');
        return {
          author: authorEl?.textContent?.trim() || '',
          postDate: timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || '',
        };
      });
      if (!author) author = domMeta.author;
      if (!postDate) postDate = domMeta.postDate;
    }

    if (author) {
      console.log(`[scraper] author="${author}" date="${postDate}"`);
    }

    return finalizeArticle({
      title,
      bodyHtml,
      author,
      postDate,
      articleUrl,
      sourceType: 'patreon',
    });
  });
}

async function scrapeSubstack(articleUrl) {
  const cookies = loadCookies('substack');
  const articleHost = new URL(articleUrl).hostname.toLowerCase();
  const hasSubstackDomainCookie = hasCookieForHost(cookies, 'substack.com');
  const hasArticleDomainCookie = hasCookieForHost(cookies, articleHost);

  return withScrapePage(async (page) => {
    if (cookies?.length) {
      await seedCookies(page, 'substack', articleUrl, cookies);
    }

    await page.goto(articleUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const extracted = await page.evaluate((titleSelectors) => {
      const preloads = window._preloads && typeof window._preloads === 'object'
        ? window._preloads
        : null;
      const preloadedPost = preloads?.post && typeof preloads.post === 'object'
        ? preloads.post
        : null;
      const bootstrapBodyHtml = typeof preloadedPost?.body_html === 'string'
        ? preloadedPost.body_html.trim()
        : '';
      const bootstrapTitle = preloadedPost?.title?.trim()
        || preloadedPost?.social_title?.trim()
        || '';
      const bootstrapAuthor = preloadedPost?.publishedBylines?.[0]?.name?.trim()
        || preloads?.pub?.name?.trim()
        || '';
      const bootstrapPostDate = preloadedPost?.post_date
        || preloadedPost?.updated_at
        || '';
      const isPaidPost = preloadedPost?.audience === 'only_paid';

      const titleFromMeta = document.querySelector('meta[property="og:title"]')?.getAttribute('content')
        || document.querySelector('meta[name="twitter:title"]')?.getAttribute('content')
        || '';
      let title = titleFromMeta || document.title;
      for (const selector of titleSelectors) {
        const el = document.querySelector(selector);
        if (el?.textContent?.trim()) {
          title = el.textContent.trim();
          break;
        }
      }

      const paywallPatterns = [
        /subscribe to continue reading/i,
        /this post is for paid subscribers/i,
        /already subscribed\?/i,
        /sign in to read/i,
        /upgrade to paid/i,
        /start writing today/i,
      ];

      const bodySelectors = [
        '[data-testid="post-body"]',
        '.available-content .body.markup',
        '.available-content .body',
        '.body.markup',
        '.markup',
        'article',
        'main',
      ];

      let scope = null;
      for (const selector of bodySelectors) {
        const el = document.querySelector(selector);
        if (el && (el.innerText || '').trim().length > 120) {
          scope = el;
          break;
        }
      }
      if (!scope) {
        const article = document.querySelector('article');
        if (article && (article.innerText || '').trim().length > 120) {
          scope = article;
        }
      }

      const author = document.querySelector('meta[name="author"]')?.getAttribute('content')
        || document.querySelector('a[rel="author"]')?.textContent?.trim()
        || document.querySelector('[data-testid="byline"] a')?.textContent?.trim()
        || '';
      const postDate = document.querySelector('meta[property="article:published_time"]')?.getAttribute('content')
        || document.querySelector('time[datetime]')?.getAttribute('datetime')
        || document.querySelector('time')?.textContent?.trim()
        || '';

      const fullText = (document.body?.innerText || '').trim();
      const requiresLogin = paywallPatterns.some((pattern) => pattern.test(fullText));
      const seenText = new Set();
      const seenImages = new Set();
      const parts = [];

      if (scope) {
        for (const el of scope.querySelectorAll('h2, h3, h4, h5, p, blockquote, pre, table, ul, ol, figure, img, hr')) {
          if (el.closest('nav, header, footer, aside, form, button, [role="dialog"], [class*="comment"], [data-testid*="comment"], [class*="subscribe"], [class*="paywall"], [class*="footer"]')) continue;

          const tag = el.tagName.toLowerCase();
          if (tag === 'img') {
            if (el.closest('figure')) continue;
            const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
            if (!src || src.startsWith('data:') || seenImages.has(src)) continue;
            seenImages.add(src);
            parts.push(`<figure><img src="${src}"></figure>`);
            continue;
          }

          if (tag === 'figure') {
            const img = el.querySelector('img');
            if (!img) continue;
            const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
            if (!src || src.startsWith('data:') || seenImages.has(src)) continue;
            if (!img.getAttribute('src') || img.getAttribute('src').startsWith('data:')) {
              img.setAttribute('src', src);
            }
            seenImages.add(src);
            parts.push(el.outerHTML);
            continue;
          }

          const text = (el.innerText || '').trim();
          if (!text && tag !== 'hr') continue;
          if (text && seenText.has(text)) continue;
          if (text) seenText.add(text);
          parts.push(el.outerHTML);
        }
      }

      const debugInfo = [];
      document.querySelectorAll('article, main, section, div, aside').forEach((el) => {
        const len = (el.innerText || '').trim().length;
        if (len > 200) {
          debugInfo.push({
            sel: el.tagName.toLowerCase()
              + (el.id ? `#${el.id}` : (el.className ? `.${String(el.className).split(' ')[0]}` : '')),
            len,
          });
        }
      });
      debugInfo.sort((a, b) => b.len - a.len);

      return {
        title,
        bootstrapTitle,
        bootstrapAuthor,
        bootstrapPostDate,
        bootstrapBodyHtml,
        author,
        postDate,
        bodyHtml: parts.join(''),
        isPaidPost,
        requiresLogin,
        debugInfo: debugInfo.slice(0, 8),
        scopeUsed: scope ? `${scope.tagName.toLowerCase()}${scope.className ? `.${String(scope.className).split(' ')[0]}` : ''}` : 'none',
      };
    }, SUBSTACK_TITLE_SELECTORS);

    const title = stripSiteSuffix(extracted.bootstrapTitle || extracted.title || await page.title(), 'substack');
    const canUseBootstrapBody = !!extracted.bootstrapBodyHtml && !(extracted.isPaidPost && extracted.requiresLogin);
    let bodyHtml = canUseBootstrapBody ? extracted.bootstrapBodyHtml : extracted.bodyHtml;
    const author = extracted.bootstrapAuthor || extracted.author;
    const postDate = extracted.bootstrapPostDate || extracted.postDate;
    let markdownReplacements = [];

    if (canUseBootstrapBody) {
      console.log(`[scraper] Substack bootstrap bodyLen=${extracted.bootstrapBodyHtml.length}`);
    } else if (extracted.bodyHtml) {
      console.log(`[scraper] Substack scope=${extracted.scopeUsed} bodyLen=${extracted.bodyHtml.length}`);
    }

    if (!bodyHtml || (extracted.isPaidPost && extracted.requiresLogin)) {
      if (extracted.requiresLogin) {
        if (!cookies?.length) {
          throw new Error(
            'This Substack article appears to require a logged-in subscription.\n\n'
            + 'Export your cookies:\n'
            + '  1. Open the article while logged into Substack in Chrome\n'
            + '  2. Click the Cookie-Editor extension → Export All\n'
            + '  3. Paste the JSON into the Substack cookies panel in this app'
          );
        }

        if (!hasSubstackDomainCookie) {
          throw new Error(
            'Your saved Substack cookies are missing the main Substack login session.\n\n'
            + 'Export cookies from https://substack.com while logged in, save them in the Substack panel, then export again from the exact article domain and save again. The app will merge both sets.'
          );
        }

        if (!hasArticleDomainCookie) {
          throw new Error(
            `Your saved Substack cookies do not include the article domain (${articleHost}).\n\n`
            + 'Export cookies from the exact article domain while logged in, save them in the Substack panel, and keep the existing Substack.com cookies there too.'
          );
        }

        throw new Error(
          'This Substack article still shows a login or subscriber wall.\n\n'
          + 'Re-export cookies from both https://substack.com and the exact article domain, then save both exports into the Substack panel. The app will merge them.'
        );
      }

      if (extracted.isPaidPost && extracted.bodyHtml && !extracted.bootstrapBodyHtml) {
        throw new Error(
          'This Substack article only exposed the preview, not the full paid content.\n\n'
          + 'Save cookies from both https://substack.com and the exact article domain in the Substack panel so the merged cookie set includes the full subscriber session.'
        );
      }

      const debug = await saveDebugArtifacts(page);
      throw new Error(
        `Could not find Substack article content.\nScreenshot → ${debug.screenshotRelPath}\n\n`
        + `Top elements:\n${extracted.debugInfo.map((item) => `  ${item.sel}: ${item.len} chars`).join('\n')}`
      );
    }

    ({ html: bodyHtml, markdownReplacements } = await prepareSubstackMathForMarkdown(page, bodyHtml));

    return finalizeArticle({
      title,
      bodyHtml,
      author,
      postDate,
      articleUrl,
      sourceType: 'substack',
      markdownReplacements,
    });
  });
}

module.exports = {
  detectSource,
  scrapePatreon,
  scrapeSubstack,
  saveCookies,
  loadCookies,
};
