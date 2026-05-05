# Substack crawl design

## Problem

The app already scrapes paid Patreon posts into local Markdown. It now needs to support subscribed Substack articles in the same overall workflow: save source-specific cookies, paste one article URL, auto-detect the platform, scrape the article, download images, and save a Markdown file plus metadata into the existing library.

## Decisions

- Keep one URL input and one `POST /scrape` endpoint.
- Auto-detect the source server-side.
- Store Patreon cookies and Substack cookies separately.
- Support direct article URLs only in the first version.
- Support Substack pages on both `*.substack.com` and custom domains.

## Approaches considered

### Recommended: source-aware pipeline behind one endpoint

Detect the source first, then dispatch to `scrapePatreon()` or `scrapeSubstack()`. Keep shared output conventions and shared duplicate handling.

**Why this wins**

- Matches the requested UX exactly.
- Keeps Patreon and Substack logic isolated.
- Leaves room for additional sources later without redesigning the app surface.

### Alternative: separate source endpoints behind one UI

The UI would detect the source and call `/scrape/patreon` or `/scrape/substack`.

**Trade-off**

- Simpler endpoint bodies, but detection and validation become more duplicated and the API becomes less cohesive.

### Alternative: one generic scraper with inline branches

Put Patreon and Substack logic into one large scraper flow.

**Trade-off**

- Fastest short-term, but it makes selectors, auth, and debug behavior harder to maintain as platforms diverge.

## Architecture

### Source detection

Detection should not rely on hostname alone because Substack publications may use custom domains.

Detection order:

1. Fast URL rules:
   - `patreon.com` => Patreon
   - `/p/...` path => possible Substack
2. Page-signature confirmation for non-Patreon URLs:
   - `substackcdn.com` assets
   - Substack-specific Open Graph or Twitter image URLs
   - feed or canonical patterns associated with Substack pages
   - other stable page metadata discovered during implementation

If the source cannot be classified confidently, the request should fail with an unsupported-page error instead of guessing.

### Server/API

`server.js` remains the entry point for the UI and library. The scrape route should:

- validate that the request includes a URL
- detect the source
- check duplicates before scraping
- dispatch to the matching scraper
- return `source`, `title`, `markdown`, and `filename`

Cookie management should become source-scoped rather than global. Patreon cookies and Substack cookies should be saved independently so one source never overwrites the other.

### Scraper structure

The scraping module should separate shared helpers from source-specific execution:

- shared helpers for directories, slugs, image downloads, markdown conversion, and cookie normalization
- `scrapePatreon()` preserved for the existing flow
- `scrapeSubstack()` added for Substack article pages

Substack scraping should follow the same broad pattern as Patreon:

- bootstrap an authenticated browser session with stored cookies
- load the target article page
- extract title, article HTML, author, and post date
- localize images
- convert to Markdown
- write markdown and metadata into the existing output structure

## UX and data flow

The Claw tab should stay centered on one scrape box, but cookie management should show two distinct source panels:

- Patreon cookies
- Substack cookies

Each panel should have its own save action and status text. The scrape label should become neutral, such as `Article URL`.

End-to-end flow:

1. User saves Patreon and/or Substack cookies.
2. User pastes a direct Patreon or Substack article URL.
3. Server detects the source.
4. Matching scraper runs.
5. Markdown, localized images, and metadata are written into `posts\`, `posts\images\`, and `posts\meta\`.
6. The existing library refreshes and continues to work with the saved file.

Metadata sidecars should also store a `sourceType` field (`patreon` or `substack`) so saved posts remain self-describing.

## Error handling

The first version should use explicit, source-aware failures:

- unsupported page if source detection is inconclusive
- missing Substack cookies when a Substack page requires authenticated access
- login wall or paywall guidance when stored cookies are stale
- duplicate URL rejection before scraping begins
- debug artifact capture when article extraction fails after a source has been identified

Errors should mirror the current Patreon style: actionable and specific, with re-export-cookie guidance where appropriate.

## Compatibility

- Existing Patreon scraping behavior should stay intact.
- Existing library behavior should stay intact.
- Existing metadata files without `sourceType` should remain readable.
- New saved files should continue using the same folder structure and download behavior.

## Verification targets

1. Patreon scraping still works without regressions.
2. A Substack custom-domain article is detected as Substack.
3. A Substack duplicate URL returns the same duplicate response pattern.
4. Missing Substack cookies yields the expected guided error.
5. New metadata includes `sourceType`.
6. The library still works for both old and new saved posts.
