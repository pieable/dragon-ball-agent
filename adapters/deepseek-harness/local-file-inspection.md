## Local file inspection

本地文件读取、搜索和查找使用 read、grep、glob，只读取任务所需内容。修改使用 edit 或 write，保留无关改动，按工具当前协议操作。

## 在 Windows 中执行任务

### 运行 PowerShell 命令

在 Windows 上默认使用 PowerShell 7。只有明确兼容需要才使用 Windows PowerShell 5.1。必须新建 PowerShell 进程时使用 `pwsh -NoProfile -NonInteractive`，仅在执行策略确实阻止受信任脚本时使用 `-ExecutionPolicy Bypass`。

简短嵌套命令可以直接执行。含变量、脚本块、复杂管道、JSON、正则或大量引号的多行逻辑写入系统临时脚本后运行并清理。不要使用 `Invoke-Expression` 或把字符串拼成命令执行。把文本传给 Shell 时选择不会意外执行变量、命令替换或泄露敏感信息的引用方式。调用含空格路径的程序时，把程序路径和参数分开。

脚本设置 `$ErrorActionPreference = 'Stop'`，并检查外部程序的 `$LASTEXITCODE`。机器读取 PowerShell 对象时选择明确字段或输出足够深度的 JSON，不依赖可能截断内容的默认表格。任务脚本变量不得复用 `$HOME`、`$home`、`$DSH_HOME` 等常见系统变量。

PowerShell 7 默认使用 UTF-8，只有确认编码问题时才另行指定。交给 Windows PowerShell 5.1 的中文脚本不要使用无 BOM 的 UTF-8。

在 Windows DSH 沙箱中，`gh` 读取凭据失败时，先提升权限进行只读认证检查。提升后成功说明凭据仍有效，后续需要认证的 `gh` 命令也使用相应权限。不要因此要求用户重新登录，也不要把令牌保存为明文。

### 操作文件和目录

路径操作使用 `-LiteralPath` 和 `Join-Path`。删除、覆盖、递归移动或其他难恢复操作前，在同一 PowerShell 进程内解析并核实准确绝对目标处于授权范围，不把主目录、工作区根目录、文件系统根目录或宽范围目录作为递归目标，也不用未解析变量、通配符或命令替换决定目标。不要在 PowerShell 中枚举路径，再把结果交给 `cmd`、批处理或另一种 Shell 删除或移动。实际可行时选择可恢复方式。目标仍不清楚时停止并询问。

来源不明的已有改动和新文件视为用户内容。保留与任务无关的部分。无法避开冲突时报告。除非用户明确要求，不使用 `git reset --hard`、`git checkout --` 等破坏性命令。

