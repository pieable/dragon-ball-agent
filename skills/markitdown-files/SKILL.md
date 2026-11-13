---
name: markitdown-files
description: 将支持的本地文件通过 MarkItDown 转为便于检索和分析的 Markdown，并对照原件核验影响结论的内容、数字与结构关系，保留来源定位和提取缺口。用于提取、审阅、概括或分析 PDF、Office 文档、表格、HTML、图像等非 Markdown 材料；文件编辑及依赖视觉排版的呈现使用相应格式工具。
---

# MarkItDown file conversion

Use MarkItDown when the task needs the textual or structural content of a supported local file rather than its visual layout. Convert the original to a temporary Markdown file, inspect that Markdown, and keep the source file unchanged.

Resolve the executable from `MARKITDOWN_EXE` when explicitly configured, otherwise from PATH:

```powershell
$converter = $env:MARKITDOWN_EXE
if (-not $converter) { $converter = (Get-Command markitdown -ErrorAction Stop).Source }
& $converter <input-file> -o <temporary-output.md>
```

- Use an output location under the active workspace's `work/` directory unless the user asks to retain the Markdown deliverable.
- Prefer a format-specific document, PDF, or spreadsheet workflow when the task requires editing, page/layout verification, tracked changes, formulas, or a rendered visual result.
- If conversion fails because an optional format dependency is missing, report the exact missing capability and install it only when the user authorizes that change.
- Do not enable third-party MarkItDown plugins unless the user explicitly requests them.

## 部署材料

本 Skill 的公共主干与个人材料分开安装。涉及本地样例、档案或维护历史前，读取 [本地依赖](LOCAL-DEPENDENCIES.md)；缺失材料不等同于方法已执行。

## 核对转换结果能否支持当前分析

根据本次要回答的问题，先确定会影响结论的正文、数字、表格、图像或注释，在转换稿中定位，并与原件对应位置核对。检查相关章节是否取得，阅读顺序是否连贯，数字与单位、表头与数据、注释与所解释内容是否仍保持正确关系。转换进程成功与输出非空只说明生成了文件，后续分析所需内容的完整性和准确性由这些对应检查确认。

出现空页、大段缺失、乱码、异常数字、表格错列、跨页断句或注释归属不清时，回到原件确定问题来自原材料还是转换。按缺口选择格式工具：扫描页、图表及依赖空间位置的内容查看原页图像，表格计算核对原工作表的值、公式和单元格关系。OCR 或再次转换所得内容继续对照关键原件核验。已有正文可用时保留，只补取影响当前结论的缺失部分。

向后续分析交付原件入口及相应页、表或单元格定位，说明采用的提取稿、实际核对范围和仍未取得或无法确认的内容。存在关键缺口时先补取证据，无法取得则将对应主张保留为未知，并说明缺什么材料。转换稿用于查找和分析，争议数值与结构关系以原件核对结果为依据。
