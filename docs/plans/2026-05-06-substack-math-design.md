# Substack math preservation design

## Problem

Some Substack articles contain formulas rendered by MathJax. The current scraper drops or flattens those formulas during HTML-to-Markdown conversion, so the saved article loses equation content.

## Goal

Preserve Substack formulas in Markdown as normalized LaTeX delimiters:

- inline math as `$...$`
- display math as `$$...$$`

Exact byte-for-byte recovery of the author's original TeX is not required. Semantically equivalent normalized LaTeX is acceptable.

## Approaches considered

### Recommended: convert MathML-backed Latex components into LaTeX

Detect Substack `Latex` components, extract their MathML, convert that MathML into normalized LaTeX, and replace the rendered MathJax HTML before Turndown runs.

#### Why this wins

- Matches the desired Markdown output format.
- Uses data that is already present in the page.
- Keeps the change tightly scoped to Substack math blocks instead of rewriting the full scraper.

### Alternative: plain-text math fallback

Preserve formulas as human-readable unicode/plain text when conversion is difficult.

#### Trade-off: plain-text fallback

- Simpler, but it loses structure and does not satisfy the LaTeX-delimiter goal.

### Alternative: keep MathML or rendered HTML in Markdown

Preserve formulas as raw `<math>` or MathJax HTML blocks.

#### Trade-off: raw HTML fallback

- Retains more information than plain text, but it is not Markdown-native math and is harder to reuse downstream.

## Architecture

The Substack scraper should add a math-preservation prepass before Markdown conversion:

1. Extract article HTML as today.
2. Scan the Substack article HTML for `data-component-name="Latex"` / `.latex-rendered` nodes.
3. For each formula node:
   - detect whether it is inline or display-style
   - extract MathML from `math` / `mjx-assistive-mml`
   - convert that MathML into normalized LaTeX
   - replace the rendered widget with `$...$` or `$$...$$`
4. Pass the rewritten HTML into the existing Turndown pipeline.

Patreon behavior should remain unchanged.

## Error handling

- If a formula block has usable MathML, it should be converted to LaTeX delimiters.
- If a formula block cannot be converted, it should not disappear silently. Preserve a visible fallback form so math loss is obvious.
- Partial success is acceptable: save the article while making failed formulas detectable.

## Verification targets

1. The reproduced Substack article saves formulas as `$...$` / `$$...$$`.
2. Inline and display formulas both survive conversion.
3. Non-math Substack articles still convert normally.
4. Patreon scraping remains unchanged.
