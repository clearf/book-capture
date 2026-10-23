---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
argument-hint: "<BookID> [--horizontal] [--max-pages 500]"
description: "Capture book from the Kindle desktop app (macOS or Windows), OCR, and generate structured Markdown"
---

# Kindle Desktop Book Capture

Source is pre-selected: **kindle** (Kindle desktop app, macOS or Windows).

Follow the full pipeline in `${CLAUDE_PLUGIN_ROOT}/commands/capture.md` with source = `kindle`. Skip the platform selection step.

**Kindle-specific notes:**
- Uses **Page Down** key for navigation (arrow keys don't work)
- macOS: app name is `Amazon Kindle` (not `Kindle`); script sends Escape to dismiss startup dialogs; ensure Accessibility permission
- Windows: Store "Kindle" app or Legacy Kindle for PC — only one open, not minimized, screen unlocked for the whole run
- Remind user: open the book in the Kindle app to the first page

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/capture-kindle-mac.mjs" <BookID> [--horizontal] --output-dir "<OUTPUT_DIR>"
```
