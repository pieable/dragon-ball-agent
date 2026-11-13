<!-- fastctx:begin -->
## Local file inspection

本地文件读取、搜索和查找优先使用 FastCtx 的 `inspect_local_file`、`grep`、`glob`。只读取任务所需内容。跨文件机械替换使用 FastCtx 的 `replace`，生成内容、语义改写和小范围编辑使用 `apply_patch`。参数、批量读取、续读和替换协议按工具说明执行。
<!-- fastctx:end -->