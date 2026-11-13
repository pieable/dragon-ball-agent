# 构建四方候选

源文件只维护一份；生成目录不能作为新维护源。四个适配器的当前范围与缺口见 `registry.json`。

```powershell
python tools/build_harness.py codex --output ../candidate-codex --target-home <目标Codex目录>
python tools/build_harness.py claude-code --output ../candidate-claude --target-home <目标.claude目录>
python tools/build_harness.py deepseek-harness --output ../candidate-dsh --target-home <目标.dsh目录>
python tools/build_harness.py antigravity --output ../candidate-antigravity --target-home <目标.gemini/config目录>
```

构建只写新的候选目录，不创建或修改目标安装目录；已有输出目录不会覆盖。生成的 `candidate-manifest.json` 包含精确哈希、目标相对路径和未完成映射。当前四个候选都保留 `deployment_ready: false`，原因是运行所需的角色语义、工具或剩余材料尚未接齐，不得手动改标记当作验证。

当前生成范围：共同规则、19项经过分层审查的Skills；Codex另含11个角色及参考，Antigravity使用插件目录承载规则与Skills。其他角色没有被静默删除，它们的映射任务明确留在清单里，原安装保持不动。

验证包括：共享方法字节相同、Codex渲染与原运行文件一致、Antigravity单规则字节限制、输出与真实安装目录隔离、已有输出保留。宿主实际加载与完整行为验收尚待接入。

本地材料的条件依赖写入候选清单，并在预览中显示缺失与适用分支。原生角色、权限与工具证据见 [能力映射](../docs/HOST-CAPABILITIES.md)。
