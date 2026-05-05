# UI math marked protection design

## Problem

Some formulas are saved correctly in Markdown but still render incorrectly in the web UI because the frontend passes raw markdown through `marked` before MathJax typesets it. That lets markdown parsing touch LaTeX syntax like `_`, which breaks some expressions before MathJax sees them.

## Goal

Keep saved `.md` files unchanged while making the preview and Library reader display all preserved formulas as readable math.

## Approaches considered

### Recommended: protect math before `marked`

Tokenize `$...$` and `$$...$$` segments before calling `marked.parse(...)`, restore those exact math strings into the generated HTML, then run MathJax on the target container.

#### Why this wins

- Fixes the actual failure point in the current UI render pipeline.
- Reuses the existing shared preview/reader helper.
- Keeps saved markdown and backend scraping unchanged.

### Alternative: add a markdown math plugin

Replace the current plain `marked` flow with a markdown extension that understands math.

#### Trade-off

- More moving pieces and compatibility risk than needed for a small single-file frontend.

### Alternative: change saved markdown output

Alter backend output to avoid delimiter patterns that markdown parsers can touch.

#### Trade-off

- Solves the wrong layer and would unnecessarily change saved files.

## Architecture

The frontend shared render helper should:

1. Extract inline and display math into safe tokens.
2. Run `marked.parse(...)` on the tokenized markdown.
3. Restore the original math strings into the rendered HTML.
4. Run the existing MathJax render pass on the updated container.

This should be used by both:

- fresh scrape preview
- Library reader

## Error handling

- If token restore misses anything, the UI should still render normal markdown instead of failing hard.
- If MathJax is unavailable, the page should still show the restored raw math delimiters as plain text.

## Verification targets

1. Formulas with subscripts like `\mathcal{F}_{t-1}` render correctly in preview.
2. The same formulas render correctly in the Library reader.
3. Raw Markdown tab and saved `.md` files remain unchanged.
