<p align="right">
  <strong>中文</strong> | <a href="README.en.md">English</a>
</p>

<div align="center">
  <img src="assets/four-star-dragon-ball.png" alt="四星龙珠" width="180">

  <h1>
    龙珠 Agent
    <br>
    <sub>出来吧，神龙！实现我的愿望吧！</sub>
  </h1>
</div>

当用户费尽千辛万苦凑齐了~~200美元~~七龙珠后。

**用户：** 出来吧，神龙！实现我的愿望吧！

**神龙：** 说出你的愿望。

**用户：** 我要一个真正能陪我长期工作的 GPT！它要一直记得我真正想完成什么。简单的事情自己做，复杂的事情就叫 subagent 来帮忙。而且无论发生什么，都不要打断我问问题，自己决定就行！

**神龙：** 这个愿望无法实现。

**用户：** 为什么？

**神龙：** 你的要求互相矛盾。

**用户：** ……也是。那改一下。平常它自己判断，但是遇到目标不清楚、重要决定，或者可能产生很大代价的时候，要主动问我。其他时候别什么鸡毛蒜皮的小事都跑来确认。

**神龙：** 这样的话，可以实现。

**用户：** 还有！subagent 也不能乱叫。简单的事情自己做；已经知道怎么做、做到什么程度算完成的事情，可以直接交出去。但如果一个阶段还需要不停调查、判断、修改路线，就让一个负责人把整个阶段管完。

**神龙：** 愿望已经明白了。

**用户：** 那就开始吧！

**神龙：** 愿望开始实现。

……

**用户：** 等等！

**神龙：** 说吧。

**用户：** 刚才那部分我改主意了。如果已经有完整结果，就别为了“独立验证”再重复做一遍。只有真的发现矛盾或者缺口，再去查。

**神龙：** 这样的话，可以实现。

---

一套面向长期协作的 Codex 提示词体系。主 agent 连续承担用户理解、整体设计、主要实现与最终判断，按任务需要委派边界清楚的工作。

> 社区配置，非 OpenAI 官方项目。角色、模型与工具的实际支持取决于接收环境。

## 工作方式

从“更新理解 → 补足信息 → 制定下一轮计划 → 执行并判断结果”持续推进。整体路线逐步形成，每轮执行有清楚的问题和判断依据。计划编号记录同一任务的连续投入，简单任务直接处理。

- 产品开发：在想法、实现反馈和使用反馈中形成或重新判断价值、体验、范围与成功标准。
- 代码开发：沿实际使用路径实现并验证，区分局部测试通过与完整结果。
- 深度研究：先补齐决策所需的领域框架，再按证据选择候选与深查对象，保留模块级复用价值。
- 子代理协作：按责任与产物划分工作。已委派的调查不由主 agent 换个来源再做一遍，主 agent 继续承担自己保留的设计、关键代码和集成。

## 当前结构

| 层次 | 文件 | 作用 |
| --- | --- | --- |
| 全局规则 | [global/AGENTS.md](global/AGENTS.md) | 工作循环、权限边界、协作与表达 |
| 角色 | [agents/](agents/README.md) | 10 个自包含角色定义 |
| 任务方法 | [skills/](skills/) | 按任务触发的 Skill 与引用资源 |
| 安装与项目适配 | [INSTALL.md](INSTALL.md)、[examples/](examples/) | 合并安装和项目规则示例 |
| 发布记录 | [docs/HISTORY.md](docs/HISTORY.md) | 本次变化与旧版入口 |

角色从独立 TOML 文件加载。当前宿主可发现 `agents/` 中的角色，无需在 `config.toml` 逐一登记。主模型沿用用户选择，角色模型在安装时核对可用性。

## Skills

| 类别 | Skill |
| --- | --- |
| 开发与体验 | `product-development`、`code-development`、`code-review`、`frontend-design` |
| 调查与判断 | `deep-research`、`search-source-registry`、`company-research-brief`、`xy-axis-thinking` |
| 工作状态与表达 | `workflow-state-distiller`、`workflow-route-mapper`、`eli5` |
| 提示词维护 | `write-instructions-zh` |
| 专项工作 | `livestream-video-editing`、`markitdown-files`、`playwright`、`resume-jd-optimizer-cn` |

每个 Skill 的 `description` 负责说明触发条件，正文与引用资源承载具体方法。外部工具、插件及账号凭据需由接收环境提供。

## 安装

按 [安装说明](INSTALL.md)选择并合并所需内容，保留已有配置。安装后分别核对文件、宿主发现与真实任务表现。未执行的验证如实保留为未验证。

历史共享 Base、Root 配置镜像与强制 fork Hook 已移出当前安装入口，仍可通过 [历史记录](docs/HISTORY.md)回看。仓库不包含个人配置、会话、记忆或密钥。

## 许可

仓库自有内容使用 [MIT](LICENSE)。第三方文件保留各自的许可证和来源声明，见 [第三方说明](docs/THIRD_PARTY.md)。

---

**用户：**

太好了。对了，我还有一个愿望。

**GPT：**

You've reached your usage limit.
