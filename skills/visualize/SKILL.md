---
name: visualize
description: Create interactive diagrams, charts and UI previews inside a Pleiad conversation. Use for visual explanations and exploration, not ordinary project file edits.
---

# Visualize in Pleiad

Pleiad supports the Visualize reference format for all its agents. For an inline visual, write a UTF-8 HTML fragment under the current working directory (for example `output/visualizations/comparison.html`), then output a standalone line: `visualize{"path":"<absolute-path>/comparison.html","title":"Comparison"}`. When the user supplies an existing HTML file for display, reference that file directly without recreating it.

The Codex native form `visualize{"path":"<absolute-path>/comparison.html","title":"Comparison"}` is equivalent. Prefer the ASCII form with Claude or when the transport drops special Unicode markers. Both forms use exactly the same renderer and storage.

Output the reference as response content, NOT as a code sample: no backticks, no Markdown code fence, no indentation, no list prefix. Pleiad deliberately leaves fenced examples as text and will not display a visual from them.

Use an absolute executor-side path, with forward slashes or JSON-escaped backslashes on Windows. Optional `"mode":"wide"` enables an expandable view for a desktop mockup or several related panels. Each visual must be at most 1 MiB. Pleiad snapshots the HTML into conversation history at the end of the assistant message; later file edits do not alter past visuals. Include a new reference when updating one. Use at most 32 references per turn.

Use this same output path when an installed Visualize skill provides design guidance. The retired `present` MCP tool is not available. Images use ordinary Markdown image links to absolute local paths; files use Markdown links; text uses the normal response.

Write literal HTML, with scoped styles and scripts. Render an initial state immediately. JavaScript, SVG, canvas, sliders, buttons and local event handlers work inside an isolated iframe. Use a unique root ID. Responsive layouts must fit 360px; do not shrink labels to fit. Include accessible names on controls.

The host supplies light/dark base styles, common `.card`, `.btn` and layout classes, and visualization CSS variables such as `--foreground`, `--background`, `--muted-foreground`, `--border`, `--card`, `--popover`, `--popover-foreground`, and `--viz-series-1` through `--viz-series-6`. For product mockups define your own scoped product styles.

Static scripts/styles/fonts may load over HTTPS from cdnjs.cloudflare.com, esm.sh, cdn.jsdelivr.net, unpkg.com, fonts.googleapis.com, fonts.gstatic.com and fonts.bunny.net. Pin library versions. Inline data and data URI images work. Fetch, XHR, WebSocket, forms, nested frames, relative assets and access to the parent app are unavailable. Do not rely on storage, `window.openai`, annotations or Codex's `Tweak` controls; use local controls and guard optional host helpers. Do not navigate or make network writes from a visual.

Use a normal Markdown table for a simple comparison. Create HTML when seeing or interacting with the result materially improves understanding. Keep explanation in the response, with only necessary titles, labels, legends and controls inside the visual. Do not make a visual solely because a task mentions data or a UI. A requested website or project edit remains a project task.
