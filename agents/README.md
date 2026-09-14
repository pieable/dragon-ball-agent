# 角色定义

本目录包含 10 个角色，每个 TOML 的 `name`、`description` 和 `developer_instructions` 定义其身份、选择条件与责任。当前宿主支持从角色目录直接发现，不以 `config.toml` 中显式引用的条目数判断可用角色数量。

| 角色 | 责任 | 模型 / 推理强度 |
| --- | --- | --- |
| `research-lead` | 连续组织大规模网络研究与阶段验收 | `gpt-5.6-terra` / high |
| `code-executor` | 一个代码模块或功能阶段的实现与验收 | `gpt-5.6-terra` / high |
| `code-reviewer` | 独立、只读地审查交付候选 | `gpt-5.6-sol` / xhigh |
| `explorer` | 有界的本地取证 | `gpt-5.6-luna` / medium |
| `web-researcher` | 有界的网络取证 | `gpt-5.6-luna` / medium |
| `browser-operator` | 连续完成有界浏览器操作阶段 | `gpt-5.6-luna` / medium |
| `visual-usability-tester` | 截图与坐标驱动的视觉黑盒测试 | `gpt-5.6-luna` / low |
| `worker-luna` | 责任与验收清楚的通用执行 | `gpt-5.6-luna` / low |
| `worker` | 有额度且有明确收益时的快速执行 | `gpt-5.3-codex-spark` / high |
| `default` | 兼容叶子角色 | 以文件及宿主继承规则为准 |

角色的核心指令已内联在 TOML 中，当前安装不依赖额外共享 Base 文件。角色中的宿主特定注释和工具限制描述了维护环境的适配情况，迁移时核对目标版本，不将其理解为所有 Codex 版本的机制保证。

主 agent 持续负责用户理解、整体设计和主要实现。子代理按具体责任接手工作，主 agent 不重复执行已委派责任。主 agent 仍可完成自己保留的关键代码、入口与集成。具体指导见 [全局规则](../global/AGENTS.md)。

模型名称、推理强度和工具可用性需要在接收环境确认。仓库包含角色定义，不保证账号拥有对应模型或插件。安装与验证见 [INSTALL.md](../INSTALL.md)。
