# P Creator Crawl

A local web app that converts Patreon posts you've **already paid for** into Markdown files — for personal, offline reading and archiving.

> Operates entirely on your own machine. No data is sent to any third-party service.

---

## ⚠️ Legal & Policy Notice

**Read this before use.**

This tool operates in [Patreon's Terms of Service](https://www.patreon.com/policy/legal). Please understand the implications:

| What this tool does | What this means |
|---|---|
| Requires a valid, paid Patreon membership | It does **not** bypass paywalls — you must have already legitimately subscribed |
| Saves content only to your local machine | No redistribution to non-paying users |
| Automates browser interactions | May conflict with the ToS clause prohibiting "abusing Patreon in a technical way" |
| Stores downloaded content locally | The patron license grants "access and view" rights, not explicit download/storage rights |

**You are responsible for how you use this tool.** Specifically:
- Use only for content you have an active, paid subscription to
- Do **not** share or redistribute scraped content with others
- Do **not** use this to archive content and then cancel your subscription to avoid paying
- Your account may be suspended if Patreon detects automated scraping

The MIT license on this code covers the software itself, not any content scraped with it. Creator content remains fully owned by the creators.

---

## Features

- 🔐 Two authentication modes: Chrome remote debugging session or cookie injection
- 📝 Converts HTML posts to clean Markdown (GFM)
- 🖼️ Downloads and localises embedded images
- 📚 Built-in library to browse, read, and download saved posts
- 🌏 Handles mixed-language titles (Chinese, Japanese, etc.) in filenames

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- Google Chrome
- A paid Patreon membership for the posts you want to save

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

Patreon Claw uses **cookie injection** — you export your session cookies from a logged-in browser and paste them into the app. No Chrome profile or remote debugging needed.

1. Install the [Cookie-Editor](https://cookie-editor.com/) browser extension
2. Log into Patreon in your browser (with your paid membership)
3. Click the Cookie-Editor icon → **Export All** → copy the JSON
4. Open http://localhost:3000, paste the JSON into the **Set Cookies** panel, and save

> Cookies expire over time. If you get a login error, re-export and re-paste.

---

## Usage

1. Open the **Claw** tab
2. Paste a Patreon post URL (e.g. `https://www.patreon.com/posts/some-post-123456`)
3. Click **Claw It** — the post is converted and saved to the `posts/` folder
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
patreon-claw/
├── public/
│   └── index.html        # Single-page web UI
├── posts/                # Saved Markdown files (git-ignored)
│   └── images/           # Downloaded post images
├── scraper.js            # Puppeteer scraping logic
├── server.js             # Express API server
├── .env.example          # Configuration template
└── package.json
```

---

## License

[MIT](LICENSE) — applies to the code only. Scraped content belongs to the respective creators.
