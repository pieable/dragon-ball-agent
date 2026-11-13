# 四种 Harness 的统一维护源

## 目标与源文件归属

龙珠 Agent 维护 Codex、Claude Code、DeepSeek Harness 和 Antigravity 的共同工作方法与各自适配。运行目录是部署结果，不再是四套相互独立的维护源。

现有 `skills/` 继续保存唯一的专业方法来源，避免为了目录整齐复制第二份。`core/work-principles.md` 保存共同原则，`adapters/codex/agents/*.toml` 保存已核验的 Codex 角色来源。角色职责、工具权限与上下文语义尚未跨宿主验证，不能自动把 Codex 角色当成其他三方的通用配置。旧位置退出人工维护，部署文件由适配器生成。

目标结构：

```
core/                       # 共享原则、职责、能力需求及组件目录
skills/                     # 专业方法的唯一来源与引用材料
adapters/codex/              # Codex TOML、角色装配与配置映射
adapters/claude-code/        # CLAUDE.md、Markdown agents、JSON配置及hook协议
adapters/deepseek-harness/   # Cordis preset/plugin、角色路由与生命周期
adapters/antigravity/        # 现役config目录、插件agents、rules和hook协议
integrations/               # 自有MCP/插件实现；共享源码而非复制安装目录
tools/                      # 生成、差异预览、验证；部署状态在仓库外
```

共享的是目标、责任和专业方法；模型路由、工具名称、权限声明、上下文继承、压缩、生命周期、输出格式和安装位置由适配器表达。不能把相同角色名当成相同执行语义。

## 已查到的差异

**Codex**：全局 AGENTS、角色 TOML、Skills 与宿主配置共同装配。当前11个角色的不同前缀和自包含正文必须保留。角色自身配置不能打开父级没有的能力。

**DSH**：现役协作 bundle 位于本机 codex-migration/one-preset，经 desktop profile 的包链接加载；它比公开仓库旧 DSH 分支更新。其主指令插件只给根会话注入正文，九角色通过 `subagent_role` 的 start/continue/close 管理。子代理独立上下文；部分角色reset，其他角色定制压缩；模型/provider及档位按角色路由。不能用Codex fork规则或相同模型字符串直接替代。另有Norns RP业务preset，不属于通用工作规则，不因统一维护而覆盖它。

**Antigravity**：当前2.31.2内置文档采用 `~/.gemini/config/`，与Gemini CLI settings和旧antigravity-ide路径不同。支持rules、skills、plugins、hooks、MCP，插件可带agents。agents是Markdown frontmatter，角色与工具映射应按其迁移文档，而不是复制Codex TOML。Hook事件结构、命令运行目录、超时单位和输入字段与其他宿主不同。单规则include展开后上限24000字节、合计20000 token，构建时检查真实大小并保持章节语义。

**Claude Code**：存在独立settings、agents与skills目录，当前同名Skill并不与Codex正文一致。具体角色字段、hook与MCP加载优先级须依据本机安装文档及配置核对后形成适配器。

本机DSH的13个同名Skill正文与Codex都不同；Claude的3个同名Skill也不同。差异可能是有效适配、旧版本或后续独立改进，须逐项归类，不能按“Codex更新”覆盖另一边。

## 构建与同步

每个组件记录唯一来源、输出目标、所需能力、已验证宿主及版本证据。适配器输出文件和兼容性报告。缺失能力标明受影响行为及对应接入任务，不悄悄删掉要求，不用普通文字冒充实际工具支持。

本地修改采用三方比较：上次部署结果、当前本地文件、本次生成结果。只有源改时可安排更新；只有本地改时保留并回收；双方改时显式合并。未托管同名文件先确认接管；用户删除托管文件也视为本地修改，不擅自补回。

共同方法修改回收到core/skills；仅某宿主需要的变化回收到相应adapter；私有数据保留本地层。回收先形成候选diff，不能自动用本机文件覆盖共享源。

安装记录包含源commit、适配器版本、候选与安装前后哈希、逐项备份和结果。部署只动托管范围，保留本地档案、样例、模型凭据、其他preset和已有无关设置。回滚也检查安装后的本地改动。

## 验证顺序与当前进度

先核对生成内容与有效规则等价，再检查配置格式与引用；临时目录检查首次安装、更新、本地修改、中断和回退。最后分别通过四个宿主的真实加载入口检查全局指导、角色、Skill、工具与hooks。模型行为验证另行安排，不因做同步默认发起模型请求。

当前已实现四方隔离构建、194项源白名单、19项Skill分层、三方预览、事务安装与回滚。10项本地材料条件依赖在候选和预览中可见；12个DSH与2个Claude行为差异保留原文件，不纳入托管覆盖。完整候选因原生加载及工具/角色适配未完成而保持部署阻断，真实运行配置未变更。
