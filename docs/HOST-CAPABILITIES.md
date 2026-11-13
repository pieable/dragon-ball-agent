# 非 Codex 宿主适配依据

核对日期：2026-11-13。机器可读入口为 `adapters/capabilities.json`。这里区分安装文件中看到的机制、产品文档说明和实际运行验证；已运行原生 CLI 与隔离宿主加载检查，未调用模型或更改现役安装配置。具体证据见 [验证记录](SYNC-VERIFICATION.md)。

## 适配单元

共同职责和专业方法进入 core/skills；工具权限、模型选择、上下文生命周期、MCP 与 hooks 分别适配。生成器不能把三个宿主的未知字段当作可丢弃字段，也不能以同名工具代替权限等价验证。

| 宿主 | 可以准备的映射 | 仍保留的原生内容 |
|---|---|---|
| Claude Code | CLAUDE.md、skills、Markdown agent 候选、按作用域的 MCP 配置计划 | permissions、hooks、模型、现有服务器与授权、私有 skill |
| DSH | 已有 bundle 的角色职责来源和角色 JSON 映射、经核验的 skill 差分 | profile 装配、根专属提示、角色过滤、reset/summary/remote 策略、provider/model、其他 preset |
| Antigravity | 单独 plugin 的 rules/skills、agents 候选、stdio/HTTP MCP 计划 | 工具权限、模型、原 hook 命令、凭据、现有插件与其他配置 |

## Claude Code

本机安装包版本为 2.1.283；当前用户 agents 目录未发现角色文件，settings 中存在插件设置，不能用空 agents 目录推断没有插件角色。

官方文档把子代理定义为独立上下文，Markdown frontmatter 控制工具、模型及权限；支持接续及自动压缩。适配前逐项核对目标版本，不复制 Codex fork 的含义。[子代理文档](https://code.claude.com/docs/en/sub-agents)

用户指令与 skill 分别位于 `~/.claude/CLAUDE.md`、`~/.claude/skills/`；角色候选目标为 `~/.claude/agents/*.md`。安装阶段应检查当前宿主实际加载结果，包含插件的同名覆盖。

MCP 用户作用域在 `~/.claude.json` 的 `mcpServers`，项目作用域为 `.mcp.json`。只对明确选定作用域和服务器标识生成增量计划，不覆盖整份含会话与私人状态的文件。[MCP 文档](https://code.claude.com/docs/en/mcp)

Hooks 有独立的配置位置、事件输入输出与退出码约定。现有 permissions/hooks 原样保留；需要新增时先用离线事件样本验证决策，再验证宿主入口。[Hooks 文档](https://code.claude.com/docs/en/hooks)

## DeepSeek Harness

本轮直接核对正在使用的 one-preset bundle 源：`package.json`、`plugins/main-agent-prompt.mjs`、`plugins/subagent-role.mjs`、`plugins/role-policy.mjs` 和 `roles.json`。bundle 为 0.1.0，依赖声明 0.2.1-rc.2；这是自定义 bundle 的行为，不代表所有 DSH 配置。

根提示只向注册表中的 live root 注入，并排除具有 subagent origin 的恢复会话。`subagent_role` 接受 start/continue/close；子代理建立新 session，继承 preset 组合，再附角色 persona、工具过滤和委派策略。角色字段包含 fs、shell、web、jobs、todo、present、canDelegate、provider、model、reasoningEffort、reset。

`role-policy.mjs` 明确保存 remote、summary、reset 三种策略。reset 角色在溢出后通过 continue 接收新任务并替换原表面上下文；不能等同于一般追加消息。迁移要保留这条生命周期及角色策略记录，而非只输出提示词。

profile 的 Cordis patch、插件与其他 preset 分开维护。已检查的源不能确定全局 MCP 客户端 schema，因此 MCP 配置生成保持阻断，先定位具体客户端包、装配项与其验证入口。Cordis 事件也不直接改写成其他宿主的 hooks.json。

## Antigravity

依据安装内置 `agy-customizations` 的指南与 hooks、MCP、plugins 文档，以及 `migrate-agent-settings`。发现根为 `~/.gemini/config/`；不把 Gemini CLI 的 settings.json 当作此宿主的配置入口。版本清单记录 2.31.2，发布前复核安装版本与文档。

插件角色使用 Markdown frontmatter：name、description、subagent、mainAgent、tools。迁移指南说明：省略 tools 会得到有限只读默认工具；应显式处理工具清单。指南列出的 read_file/edit_file/write_file/run_command/manage_task/search_web 只建立名称映射，权限含义仍需分别核验。指南要求丢弃导入的 model，未提供 Codex 模型名可用的证据，当前模型路由保留本地。

MCP 的 `mcpServers` 支持 command/args/env 的 stdio，以及 url 的 Streamable HTTP；serverUrl 是旧别名，旧 SSE 不直接支持。插件服务器随插件加载才生效。生成计划须确认服务端 transport，不能只替换配置路径。

Hooks 是“命名 hook → 事件 → handler”，只支持同步 command。工具事件使用 matcher/hooks 分组，其他事件为 handler 数组；payload 使用 camelCase。timeout 单位为秒，cwd 为 hooks.json 所在目录；Windows 使用 cmd /c。插件环境变量和 shell 展开不能直接套用 Claude 的字符串替换方式。PreToolUse 的 allow/deny/ask/force_ask 与 permissionOverrides 会影响权限，因此不自动导入。

Skills 默认只注入名称和描述，正文按需激活；规则可常驻或条件触发。工作区、显式工作区配置、全局发现、内置、全局显式配置有不同优先级。实际验收要包含同名覆盖和停用插件，而非仅检查生成文件。

## 可执行交付检查

1. 读取选定宿主/版本与实际配置，保留私有路径、凭据、授权、其他项目/preset；只输出已选择组件的增量计划。
2. 每个转换记录原字段、目标字段和未迁移字段。未知必需字段阻止该组件生成；不能静默忽略。
3. retained local 文件列出“存在/缺失/类型冲突”。缺失的运行依赖在安装前阻断；首次安装不能依赖旧机器隐含内容。
4. 离线验证 schema、路径、工具清单和 hook 事件样本；宿主验收再验证加载、权限拒绝、角色接续和压缩、MCP 发现与停用。

这些文件不授予部署权限；机器可读的 action 是后续工具的规划输入，当前构建器与同步器是否落实每项检查，应由对应代码测试证明。
