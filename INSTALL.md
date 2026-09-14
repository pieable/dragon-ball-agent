# 安装与更新

这是一套可合并安装的个人工作规则、角色定义与 Skills。先检查接收环境，按需要选择内容。仓库不包含账号配置、密钥、MCP 服务程序或插件缓存。

## 安装位置

| 仓库内容 | 目标位置 | 用途 |
| --- | --- | --- |
| `global/AGENTS.md` | `CODEX_HOME/AGENTS.md`，默认 `~/.codex/AGENTS.md` | 全局工作方式，合并已有规则 |
| `agents/*.toml` | `~/.codex/agents/`，或项目 `.codex/agents/` | 10 个角色定义 |
| `skills/<name>/` | 宿主实际发现的个人或项目 Skill 目录 | 完整复制选用的 Skill 及其资源 |
| `examples/project-AGENTS.md` | 参考后编写项目 `AGENTS.md` | 项目边界和资料入口 |

官方当前文档列出的个人 Skill 目录是 `~/.agents/skills/`，项目目录是 `.agents/skills/`。部分现有安装使用 `~/.codex/skills/`。先核实当前宿主的发现位置，避免在多个目录安装同名副本。使用自定义 `CODEX_HOME` 时也要核实角色的实际加载位置。

## 合并步骤

1. 记录当前版本，备份将修改的文件。备份可能包含敏感配置，留在本地，不提交到公开仓库。
2. 阅读全局规则，将需要的规则合并到现有 `AGENTS.md`。检查同目录的 `AGENTS.override.md`，它可能使 `AGENTS.md` 不被加载。保留接收环境已有的权限、MCP、插件和项目配置。
3. 复制选用的角色 TOML。支持目录发现的当前宿主按文件中的 `name` 识别角色，无需在 `config.toml` 逐一登记。已有 `[agents.<name>]` 时，确认它是否包含独立覆盖或指向不同文件，再决定是否清理重复引用。
4. 按任务需要复制完整 Skill 目录，保留引用资源、许可证与 UI 元数据。按下一节核对工具依赖。
5. 保留用户当前主模型。角色中的模型和推理强度是本仓库的配置选择，安装前确认目标账号支持。需要替换时让用户决定能力与成本的取舍。
6. 打开新任务，检查全局规则、选用的 Skill 和角色是否可见。按安装范围运行一个无副作用的代表任务，核对角色与工具是否按预期工作。

`examples/config.toml` 只是可选全局限制片段，不能覆盖整份用户配置。旧版宿主若不支持目录发现，应依照该版本文档适配，并单独验证。

## 环境依赖

- 全局规则含 Windows / PowerShell 和 FastCtx 使用约定。非 Windows 环境按其平台调整对应小节。FastCtx 不可用时使用宿主提供的等价文件工具，并说明替代情况。
- 浏览器与视觉操作依赖宿主可用的浏览器或截图工具。角色文件本身不会安装工具，也不会授予新的权限。
- `markitdown-files` 需要 MarkItDown，`playwright` 需要其 Skill 中说明的命令行环境。Playwright 的命令示例采用旧安装路径，安装在其他目录时将 `PWCLI` 指向实际的 `scripts/playwright_cli.sh`，再执行示例。`livestream-video-editing` 的 Resolve 工作流依赖本机软件。
- 研究 Skill 的搜索工具、GitHub 访问与网络权限由接收环境提供。可选凭据只从环境变量或宿主凭据系统获得。
- 其他 Skill / 插件的名称引用不代表本仓库附带它们，缺失时按任务需要安装或明确使用替代方法。

## 验证与回退

分别记录文件安装、宿主发现、实际任务三个结果。语法通过或可见列表正确，只证明对应层面，不能证明所有任务表现。未做新任务测试时明确写“真实使用尚未验证”。出现冲突时按备份恢复本次改动，不覆盖安装前的其他配置。

更新时对照仓库 diff 合并。旧共享 Base、Root 配置镜像、强制 `fork_turns:none` Hook 和 `batch-execution` 不属于当前安装入口。迁移说明见 [历史与本次发布](docs/HISTORY.md)。

## 官方依据

- [AGENTS.md 加载](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [自定义角色目录与字段](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Skill 发现与编写](https://learn.chatgpt.com/docs/build-skills)

文档和宿主会更新。安装时以目标环境实际支持的行为为准。
