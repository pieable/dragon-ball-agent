---
name: markitdown-files
description: Convert supported local files to Markdown with MarkItDown before extracting, reviewing, summarizing, or analyzing their content. Use for PDF, Office documents, spreadsheets, HTML, images, and similar non-Markdown inputs; do not use for editing or layout-sensitive rendering.
---

# MarkItDown file conversion

Use MarkItDown when the task needs the textual or structural content of a supported local file rather than its visual layout. Convert the original to a temporary Markdown file, inspect that Markdown, and keep the source file unchanged.

Locate the installed MarkItDown executable with `Get-Command markitdown` on PowerShell (or the platform equivalent), then run:

```powershell
markitdown <input-file> -o <temporary-output.md>
```

- Use an output location under the active workspace's `work/` directory unless the user asks to retain the Markdown deliverable.
- Prefer a format-specific document, PDF, or spreadsheet workflow when the task requires editing, page/layout verification, tracked changes, formulas, or a rendered visual result.
- If conversion fails because an optional format dependency is missing, report the exact missing capability and install it only when the user authorizes that change.
- Do not enable third-party MarkItDown plugins unless the user explicitly requests them.
