# UI math rendering design

## Problem

Substack formulas are now preserved in saved Markdown as `$...$` and `$$...$$`, but the web UI renders Markdown with `marked` only, so formulas appear as raw delimiter text instead of readable equations.

## Goal

Render formulas nicely in the web app preview and reader without changing the saved Markdown file format.

## Approaches considered

### Recommended: MathJax render pass in the browser

Keep saved Markdown unchanged, render Markdown to HTML with `marked`, then typeset formulas inside the preview and reader containers with MathJax.

#### Why this wins

- Matches the existing `$...$` / `$$...$$` output.
- Keeps the saved file format stable.
- Fits the current single-file frontend with minimal change.

### Alternative: KaTeX render pass

Use KaTeX client-side after Markdown parsing.

#### Trade-off: KaTeX render pass

- Fast, but stricter and a less direct fit for existing MathJax-style math content.

### Alternative: server-side formula rendering

Render formulas into HTML before they reach the browser.

#### Trade-off: server-side rendering

- More complex than needed when the requirement is app-only display.

## Architecture

The UI should add a shared math-rendering step:

1. Parse Markdown with `marked`.
2. Insert the resulting HTML into the target container.
3. Run a shared `renderMath(container)` helper on that container only.

The helper should be used in:

- the fresh scrape preview
- the Library reader

Saved `.md` files should remain unchanged.

## Error handling

- If MathJax is unavailable or fails to typeset, the page should still show the parsed markdown instead of breaking the UI.
- Rendering should stay container-scoped so one pane update does not unnecessarily reprocess the full page.

## Verification targets

1. Fresh scrape preview shows readable formulas.
2. Library reader shows readable formulas for the same post.
3. Raw Markdown tab remains unchanged.
4. Saved markdown file contents remain unchanged.
