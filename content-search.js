'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const MarkdownIt = require('markdown-it');

const markdown = new MarkdownIt({ html: true });
const MAX_QUERY_LENGTH = 200;
const normalizeText = text => text.normalize('NFKC').replace(/\s+/gu, ' ').trim();

function phrasePattern(query) {
  const parts = query.split(/([\s\p{Pd}_]+)/u);
  const expression = parts.map((part, index) => {
    // Only separators between terms are interchangeable; keep leading/trailing punctuation literal.
    if (index % 2 === 1 && parts[index - 1] && parts[index + 1]) return '[\\s\\p{Pd}_]+';
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(expression, 'iu');
}

function articleText(source) {
  // These two sections are added by finalizeArticle, rather than being article body.
  const body = source.replace(/^\uFEFF?#[ \t]+[^\r\n]+(?:\r?\n|$)/, '')
    .replace(/\r?\n---[ \t]*\r?\n\s*Source:[ \t]*https?:\/\/[^\r\n]+\s*$/, '');
  const parts = [];
  function inlineText(tokens) {
    for (const token of tokens) {
      if (token.type === 'text' || token.type === 'code_inline') parts.push(token.content);
      else if (token.type === 'softbreak' || token.type === 'hardbreak') parts.push(' ');
      else if (token.type === 'html_inline' && /^<br\b/i.test(token.content)) parts.push(' ');
      // Link destinations, image paths, attributes and reference definitions stay out of the cache.
    }
  }
  for (const token of markdown.parse(body, {})) {
    if (token.type === 'inline') inlineText(token.children || []);
    else if (token.type === 'fence' || token.type === 'code_block') parts.push(token.content, ' ');
    else if (token.type === 'html_block') {
      const text = token.content.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<!--[^]*?-->/g, ' ').replace(/<[^>]*>/g, ' ');
      parts.push(markdown.utils.unescapeAll(text), ' ');
    } else if (token.block && token.nesting === -1) parts.push(' ');
  }
  return normalizeText(parts.join(''));
}

function snippetAround(text, match) {
  const start = Math.max(0, match.index - 45);
  const matchEnd = match.index + match[0].length;
  const end = Math.min(text.length, matchEnd + 90);
  return {
    before: (start ? '…' : '') + text.slice(start, match.index),
    match: text.slice(match.index, matchEnd),
    after: text.slice(matchEnd, end) + (end < text.length ? '…' : ''),
  };
}

function createContentSearch({ outputDir, readFile = fs.readFile }) {
  let cache = new Map();
  let refreshQueue = Promise.resolve();

  async function rebuild() {
    let entries;
    try { entries = await fs.readdir(outputDir, { withFileTypes: true }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      cache = new Map();
      return cache;
    }
    const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.md'));
    const next = new Map();
    // Bound disk concurrency when warming a large library; unchanged bodies are never re-read.
    for (let offset = 0; offset < files.length; offset += 16) {
      await Promise.all(files.slice(offset, offset + 16).map(async ({ name }) => {
        const filepath = path.join(outputDir, name);
        try {
          const stat = await fs.stat(filepath);
          const signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
          const previous = cache.get(name);
          const entry = previous?.signature === signature ? previous
            : { signature, text: articleText(await readFile(filepath, 'utf8')) };
          next.set(name, entry);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          // An article can disappear between directory listing and reading.
        }
      }));
    }
    cache = next;
    return cache;
  }

  function warm() {
    // Every request checks a fresh directory snapshot, including external edits and deletions.
    const refresh = refreshQueue.then(rebuild);
    refreshQueue = refresh.catch(() => {});
    return refresh;
  }

  async function search(value = '') {
    if (typeof value !== 'string' || value.length > MAX_QUERY_LENGTH) {
      throw Object.assign(new Error(`Content search must be text of at most ${MAX_QUERY_LENGTH} characters.`), { status: 400 });
    }
    const query = normalizeText(value);
    if (!query) return [];
    const pattern = phrasePattern(query);
    const snapshot = await warm();
    const matches = [];
    for (const [filename, { text }] of snapshot) {
      const match = pattern.exec(text);
      if (match) matches.push({ filename, snippet: snippetAround(text, match) });
    }
    return matches;
  }

  return { warm, search };
}

module.exports = { createContentSearch, articleText };
