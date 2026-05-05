# Substack preview-only fix design

## Problem

Saved Substack cookies are loading the article page, but the current scraper saves only the visible preview for paid posts instead of the full article. On the reproduced failing case, the full paid HTML is present in `window._preloads.post.body_html`, but the scraper ignores it and extracts only the shorter DOM preview.

## Decision

Prefer Substack bootstrap data over rendered DOM content:

- read `window._preloads.post.body_html` first
- use metadata from the same bootstrap payload when available
- keep the existing DOM extraction only as a fallback

## Approaches considered

### Recommended: bootstrap-first extraction

Use `window._preloads.post` as the primary article source, then fall back to DOM extraction only when the bootstrap payload is absent.

#### Why this wins

- Directly fixes the reproduced paid-post failure.
- Uses the richer page payload that already exists after navigation.
- Keeps the current UI, cookie flow, and output format unchanged.

### Alternative: API-first extraction

Try to intercept or call a Substack post API, then fall back to bootstrap and DOM extraction.

#### Trade-off: API-first extraction

- Potentially robust, but more moving parts and more dependence on unstable network paths.
- Unnecessary when the page already embeds the full HTML payload.

### Alternative: expand DOM-only extraction

Keep scraping the rendered page but search more containers and hidden nodes.

#### Trade-off: DOM-only extraction

- Least reliable because the failing page already proves the rendered DOM can stop at the preview.
- More likely to regress on future layout changes.

## Architecture

The Substack path should become bootstrap-first:

1. Load the article page with saved cookies.
2. Read `window._preloads.post`.
3. If `body_html` exists, use it as the article HTML and read title, author, and post date from the same payload.
4. If the bootstrap payload is unavailable or incomplete, fall back to the existing DOM extraction path.
5. Continue through the current image localization, Markdown conversion, and metadata-writing pipeline.

Cookie storage, duplicate detection, source detection, library storage, and Patreon behavior should remain unchanged.

## Error handling

- If bootstrap extraction succeeds, the scraper should not prefer the shorter DOM preview.
- If the page is clearly paid but both bootstrap and DOM extraction fail to produce full article HTML, return a clear error instead of silently saving preview-only content.
- Keep existing debug artifacts for extraction failures.

## Verification targets

1. The reproduced custom-domain paid Substack article saves from bootstrap HTML instead of the preview DOM.
2. Public/direct Substack pages still work through bootstrap or DOM fallback.
3. Patreon scraping is unchanged.
