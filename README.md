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
