<p align="right"><strong>中文</strong> | <a href="README.en.md">English</a></p>

<div align="center">
  <img src="assets/four-star-dragon-ball.png" alt="四星龙珠" width="180">
  <h1>龙珠 Agent</h1>
</div>

# 一份核心源，四种 Harness

共同工作原则和专业方法维护一次，由适配器装配到 Codex、Claude Code、DeepSeek Harness 和 Antigravity。运行目录保存部署结果与本地私有层，不再维护四套互相覆盖的副本。

## 当前可以做什么

- 从 `core/` 与 `skills/` 生成四种隔离候选，共 19 项专业方法；Codex 包含 11 个原生角色，Antigravity 使用其插件目录。
- 预览候选、上次安装与本地修改的三方差异；遇到冲突保留双方。
- 在测试目录验证安装、更新、中断恢复和回滚，既有私人档案与未托管文件不覆盖。
- 读取明确指定的 MCP 配置，检查集成是否登记，不输出本地参数、凭据或未知项目名称。

完整候选保持 `deployment_ready: false`。使用显式组件选择可独立安装已通过原生加载验证的 Codex 规则/Skills、DeepSeek Harness Skills；未验证的角色与宿主入口仍拒绝安装。新装不要求原维护者的私有文件，迁移保留本地差异；首次接管通过哈希绑定的审核计划与事务备份进行。见 [安装步骤](INSTALL.md)、[宿主能力](docs/HOST-CAPABILITIES.md) 与 [验证记录](docs/SYNC-VERIFICATION.md)。

## 从哪里开始

[构建、预览与回滚](INSTALL.md) · [统一架构](docs/UNIFIED-HARNESSES-INDEX.md) · [私人材料与许可](docs/SKILL-LAYERS.md) · [工具集成](integrations/README.md)

| 来源 | 职责 |
|---|---|
| `core/work-principles.md` | 共同工作原则 |
| `skills/` | 19 项专业方法及其引用资源 |
| `adapters/` | 原生格式、路径、能力差异与精确基线补丁 |
| `integrations/` | 工具来源目录和接入边界 |
| `system-manifest.json` | 经审查的 194 项部署源及 SHA256 |
| `tools/` | 候选生成、预览、安装事务与恢复 |

## 私有层与维护

学习档案、历史共同决定、个人范文与未获再分发许可的材料留在本机，公开包显式登记其调用条件。缺少材料会显示具体分支；空白模板不覆盖已有文件。账号、模型凭据、安全配置、会话、记忆、缓存和宿主运行时不迁入公共源。

本地修改先比较：共同方法回收到共享源，宿主行为回收到适配器，私人内容继续留在本地。不同宿主的工具权限、模型名和上下文生命周期分别核验，不靠改文件扩权。

仓库原创部分采用 [MIT](LICENSE)；第三方内容按各文件附带许可和 [来源说明](docs/THIRD_PARTY.md) 使用。历史发布记录保留在 [HISTORY](docs/HISTORY.md)。
