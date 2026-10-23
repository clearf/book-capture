---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
argument-hint: "<ASIN> [--horizontal] [--region jp]"
description: "Capture book from Kindle Cloud Reader (browser), OCR, and generate structured Markdown"
---

# Kindle Cloud Reader Capture

Source is pre-selected: **cloud** (Kindle Cloud Reader via Playwright browser automation).

Follow the full pipeline in `${CLAUDE_PLUGIN_ROOT}/commands/capture.md` with source = `cloud`. Skip the platform selection step.

**Cloud-specific notes:**
- Run capture in background
- Guide user through Amazon login, then signal ready by creating the signal file the script prints: `touch "<signal path>"` (OS temp dir — not `/tmp` on Windows)
- `--region` flag: `jp` (default), `us`, `uk`, `de`, `fr`, `it`, `es`, `ca`, `au`, `in`, `br`
- Playwright must be installed: `cd "${CLAUDE_PLUGIN_ROOT}/scripts" && npx playwright install chromium`

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kindle-capture.mjs" <ASIN> [--horizontal] [--region jp] --output-dir "<OUTPUT_DIR>"
```
