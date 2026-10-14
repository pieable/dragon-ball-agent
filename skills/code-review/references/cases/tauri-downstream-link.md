# 本包可链接但传播的搜索路径破坏下游

记录时点：2026-10-14。Issue于2026-10-09创建。

Tauri构建脚本生成stub `msvcrt.lib`并发布链接搜索路径。Cargo把该路径传播到下游，但抵消stub的link参数只作用于本包。本包可以链接，下游依赖或测试找到stub后链接失败；`cargo check`可以通过，因为没有经过实际链接。

报告提供两包复现、版本矩阵和真实项目对照，用户在修复PR上复验下游恢复。相关功能经过五月开发、回退和七月重新合入，旧stub和默认值变化共同影响可达性；精确致错提交尚未闭合。修复PR于10月12日合入。

用于核对公共机制的传播范围、未出现在diff中的消费者，以及验证工具覆盖的层级。

来源：[issue #16238](https://github.com/tauri-apps/tauri/issues/16238)、[修复PR #16247](https://github.com/tauri-apps/tauri/pull/16247)、[原功能PR #15372](https://github.com/tauri-apps/tauri/pull/15372)、[重新合入PR #15401](https://github.com/tauri-apps/tauri/pull/15401)。
