# P Creator Crawl

A local web app that converts Patreon posts and Substack articles you've **already paid for or subscribed to** into Markdown files for personal, offline reading and archiving.

> Operates entirely on your own machine. No data is sent to any third-party service.

---

## ⚠️ Legal & Policy Notice

**Read this before use.**

This tool operates against creator platforms such as [Patreon](https://www.patreon.com/policy/legal) and Substack. Please understand the implications:

| What this tool does | What this means |
|---|---|
| Requires a valid, paid membership or subscription | It does **not** bypass paywalls — you must have already legitimately subscribed |
| Saves content only to your local machine | No redistribution to non-paying users |
| Automates browser interactions | May conflict with the ToS clause prohibiting "abusing Patreon in a technical way" |
| Stores downloaded content locally | The patron license grants "access and view" rights, not explicit download/storage rights |

**You are responsible for how you use this tool.** Specifically:
- Use only for content you have an active, paid subscription to
- Do **not** share or redistribute scraped content with others
- Do **not** use this to archive content and then cancel your subscription to avoid paying
- Your account may be suspended if a platform detects automated scraping

The MIT license on this code covers the software itself, not any content scraped with it. Creator content remains fully owned by the creators.

---

## Features

- 🔐 Separate cookie injection flows for Patreon and Substack
- 🔎 One scrape box with automatic Patreon/Substack source detection
- 📝 Converts HTML posts to clean Markdown (GFM)
- 🖼️ Downloads and localises embedded images
- 📚 Built-in library to browse, read, and download saved posts
- 🔍 Separate title/author and article-content search, with highlighted matching excerpts
- 📋 Batch Crawl page with saved sources, duplicate skipping, progress and resumable runs
- 🌏 Handles mixed-language titles (Chinese, Japanese, etc.) in filenames

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- Google Chrome
- A paid Patreon membership and/or Substack subscription for the articles you want to save

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` to set your `CHROME_EXECUTABLE_PATH`.

### 3. Start the server

```bash
npm start
```

Then open **http://localhost:3000** in your browser.

---

## Authentication

P Creator Crawl uses **cookie injection**. Patreon and Substack cookies are stored separately, so you can prepare one or both sources before scraping.

### Patreon cookies

1. Install the [Cookie-Editor](https://cookie-editor.com/) browser extension
2. Log into Patreon in your browser (with your paid membership)
3. Click the Cookie-Editor icon → **Export All** → copy the JSON
4. Open http://localhost:3000, paste the JSON into the **Patreon cookies** panel, and save

### Substack cookies

1. Open **https://substack.com** while logged into your subscribed account
2. Click the Cookie-Editor icon → **Export All** → copy the JSON
3. Open http://localhost:3000, paste the JSON into the **Substack cookies** panel, and save
4. If the publication uses a custom domain, open the exact article domain (for example `https://www.vertoxquant.com/...`), export again, and save again
5. The app **merges** repeated Substack saves, so keep both the `substack.com` cookies and the article-domain cookies in the same Substack store

> Cookies expire over time. If you get a login error, re-export and re-paste.

---

## Usage

1. Open the **Claw** tab
2. Paste a Patreon post URL (e.g. `https://www.patreon.com/posts/some-post-123456`) or a direct Substack article URL (including custom-domain Substack posts such as `https://www.vertoxquant.com/p/backtests-lie`)
3. Click **Scrape** — the article is converted and saved to the `posts/` folder
4. Switch to the **Library** tab to browse, read inline, or download saved posts

### Search saved articles

The Library has two independent search boxes. **Search by title, author** keeps the
existing title, author and filename matching. **Search article content** searches
the saved body text, including code and tables, and displays a highlighted excerpt.
Use both boxes together to require both matches; platform/status filters and sorting
still apply. Content queries are case-insensitive phrases and support Chinese short
words. Spaces, hyphens, Unicode dashes and underscores between phrase terms are
interchangeable: `walk forward` also finds `walk-forward-test`, `walk_forward` and
`walk–forward`. Words must still appear next to each other and in the same order;
spelling differences such as `walk-farward` are not corrected. Excerpts highlight the
actual matched spelling. Other punctuation, including `C++`, stays literal, as do
leading/trailing separators such as the minus sign in `-1`. Line breaks and repeated
spaces are treated as one space.
Press Enter to search immediately, or pause typing for 300 ms. Each box has its own
clear button; failed content searches show a Retry action.

Existing articles are automatically cached in server memory on startup. Only changed
Markdown bodies are re-read; every content search checks for new, modified and deleted
files, including external file changes. Images, link destinations, the generated title
and source footer are excluded. The browser receives matching excerpts rather than
all article bodies. The cache is rebuilt after restart and requires no database or
re-crawling. After adding or changing files externally, refresh the Library to reload
its article list before searching.

### Batch Crawl page

Open **Batch Crawl** (`/#batch`) and select the preconfigured **VertoxQuant** source.
**Check list** scans the archive and previews missing articles without downloading
article content. **Start crawl** scans and saves automatically, oldest first, using
your existing cookies. Choose all missing articles or only the five oldest articles.
The five are selected before duplicate checks; a saved article is not replaced by a
newer one. Duplicate checks require nonempty Markdown and matching source metadata,
so deleting an article makes it eligible for a later crawl.

The page shows discovered, saved, skipped, failed and pending-image counts, per-article
results and run history. Temporary article failures get one automatic retry. Login
failures pause the run for updated cookies; **Resume crawl** / **Retry failed** continue
the same selection. **Repair images** retries remote images without re-downloading the
article text. Unavailable local image files remain warnings when their original URL
is no longer known. Cookie presence alone does not verify paid access.

Runs continue on the server when you switch tabs or close the browser. Refreshing
reconnects to progress. **Stop after current article** finishes the current article
(including its image attempts); during a scan it stops after the current archive
request. A server restart marks unfinished runs **Interrupted**; resume them manually.
Keep one server process per output directory and do not run the CLI crawler alongside
a web crawl. The web server allows one Claw or batch operation at a time, while the
Library remains readable. A currently saving/repairing article cannot be deleted.

**+ Add** and **Edit source** manage saved archive URLs. Only implemented crawler types
appear in the selector. Currently this is **Substack Archive**, verified on VertoxQuant;
other Substack publications are checked when scanned. Source settings live in
`posts/batches/sources.json`, with atomic run reports alongside them (or under your
configured `OUTPUT_DIR`). Removing a source keeps articles and reports. Reports store
metadata and results, not article bodies or cookies; deleted articles have no Read link.
Existing CLI run reports also appear in history.

To add a coded crawler, register it in `crawl-types.js`: provide `label`, `description`,
`placeholder`, `cookieSource`, `validateUrl(url)`, `scan(url, {onProgress, shouldStop})`,
and `scrape(articleUrl)`. Scan returns `{title, url, postDate}` articles; scrape uses the
existing persistence format and returns `{filename}` (optionally `subscriptionVerified`
only after verified paid access). Keep scans read-only and honor `shouldStop` between
requests. The existing source form and runner then expose the new type automatically.

### Small archive batch from the terminal

From the project directory, save the oldest five articles of a Substack publication:

```bash
node crawl-archive.js https://www.vertoxquant.com/archive --limit 5
```

The script lists all archive pages, sorts by publication date, then processes only the
oldest `--limit` articles sequentially using your saved Substack cookies. Articles with
existing Markdown and matching source metadata are skipped; skips do not cause newer
articles to be added to the selection. Rerun the same command to retry missing articles.
Results appear in the existing Library, with a saved/skipped/failed report under
`posts/batches/` (or your configured `OUTPUT_DIR`). Article requests are spaced by two
seconds. Image downloads use the existing scraper; failed images can remain remote links.

### Verification

Run `npm test`. Tests use temporary output directories, simulated article downloads and
a temporary loopback HTTP server; they do not crawl live sites or change saved cookies.

---

## Configuration

All configuration is via `.env`:

| Variable | Default | Description |
|---|---|---|
| `CHROME_EXECUTABLE_PATH` | *(required)* | Path to the Chrome binary |
| `OUTPUT_DIR` | `posts` | Directory where Markdown files are saved |
| `HEADLESS` | `true` | Set to `false` to show the browser window |
| `PORT` | `3000` | Local server port |

---

## Project Structure

```
 p-creator-crawl/
├── public/
│   └── index.html        # Single-page web UI
├── posts/                # Saved Markdown files (git-ignored)
│   └── images/           # Downloaded post images
├── scraper.js            # Patreon/Substack scraping logic
├── server.js             # Express API server
├── .env.example          # Configuration template
└── package.json
```

---

## License

[MIT](LICENSE) — applies to the code only. Scraped content belongs to the respective creators.
