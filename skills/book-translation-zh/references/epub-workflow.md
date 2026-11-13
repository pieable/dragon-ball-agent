# EPUB 成书与验收

## 选择处理路径

可重排 EPUB 优先保持其章节、资源和链接关系。来源是 PDF、DOCX 或扫描件时，先判断能否可靠恢复阅读顺序，再决定重建为可重排 EPUB，还是保留原版面；不要把“能提取文字”当成“能还原书籍结构”。

Calibre 适合元数据读取、格式转换和生成检查用 PDF。需要直接编辑 EPUB 包时，可在工作副本中展开文件，保留源文件不变。

## Calibre 的隔离目录

在受限环境中运行 Calibre 前，把临时目录和配置目录都指向当前任务的可写工作目录。Windows PowerShell 示例：

```powershell
$env:CALIBRE_TEMP_DIR = (Resolve-Path 'work\book').Path
$env:CALIBRE_CONFIG_DIRECTORY = (Resolve-Path 'work\book\calibre-config').Path
$env:TEMP = $env:CALIBRE_TEMP_DIR
$env:TMP = $env:CALIBRE_TEMP_DIR
```

只设置临时目录仍可能让 Calibre 写入用户的全局配置目录并失败。

## 组装要求

- 封面使用原书资源，除非用户要求设计新封面。
- 生成语言、书名、作者、出版社或译本说明等正确元数据。
- EPUB 导航只列读者需要进入的内容，避免把封面或重复书名页误列为章节。
- 正文脚注保留正文到注释、注释回正文的双向链接。
- 图片、图题和正文引用保持邻接与对应；不要按全书统一抽到末尾。
- CSS 使用可重排尺寸，避免为单一屏幕写死正文宽度和字号。

## 命令行验收

先用 `scripts/validate_epub.ps1 -EpubPath <file>` 检查结构。再把最终 EPUB 转成临时 PDF，按本书实际结构抽查代表页。通常覆盖封面、书名页、目录、普通正文、最长标题、脚注、表格、图片和末页；不存在的结构不制造样例。

命令行渲染足以发现大多数截断、重叠、乱码、异常空白和分页问题。只有链接行为、动态重排或特定阅读器兼容性仍可疑时，才打开真实阅读器。

结构校验、Calibre 成功转换和代表页视觉检查分别证明不同部分，不能互相替代。最终报告说明每项检查实际覆盖了什么。
