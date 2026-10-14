# 设计指导来源

本地 frontend-design 结合当前 Codex 的项目实现、内容协作与真实入口验证要求适配。[Anthropic frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md) 的主体契合、审美规划与自我批评方法继续保留，其原始许可见 [LICENSE.txt](../LICENSE.txt)。

本目录的 visual-quality.md 与 design-system.md 是本地修改与适配，补充到现有 frontend-design。来源为 Jim Liu 与 BaoCut contributors 的以下材料，固定提交为 `7aa049e82e1367da013b7aba80f0b79033fa04ad`：

- [design/SKILL.md](https://github.com/JimLiu/baocut/blob/7aa049e82e1367da013b7aba80f0b79033fa04ad/skills/baocut/built-in-skills/design/SKILL.md)
- [design/references/craft.md](https://github.com/JimLiu/baocut/blob/7aa049e82e1367da013b7aba80f0b79033fa04ad/skills/baocut/built-in-skills/design/references/craft.md)
- [design-system/SKILL.md](https://github.com/JimLiu/baocut/blob/7aa049e82e1367da013b7aba80f0b79033fa04ad/skills/baocut/built-in-skills/design-system/SKILL.md)
- [design-system/references/craft.md](https://github.com/JimLiu/baocut/blob/7aa049e82e1367da013b7aba80f0b79033fa04ad/skills/baocut/built-in-skills/design-system/references/craft.md)

设计与设计系统的适配指导统一由 frontend-design 的入口和本目录参考承载。审美方向、视觉质量、设计系统与界面交接分别按当前任务读取，对应来源可通过本文件的固定提交链接核对。

增量包含精确来源复用、可见方向比较、内容真实性、具体视觉质量要求、字体和布局细节，以及设计系统的来源清单、变量用途、真实组件、单一来源与主题检查。对比度与目标尺寸的数值和例外对照 W3C WCAG 2.2 核验，链接见 visual-quality.md。

BaoCut 编辑器的文件格式、素材导入、工具桥、标注、卡片与自动清理流程留在来源中。这里使用当前项目的实现、文件与浏览器验证。原文涉及的固定配色、字体或候选数量不作为本地任务规模要求。

Copyright (c) 2026 Jim Liu and BaoCut contributors. BaoCut 来源仓库的完整许可保留为 [claude-design-license.txt](claude-design-license.txt)。不同来源的归属与许可分别保留。

## 审美、比较与视觉评审的补充来源

以下原文于 2026-10-14 核对，固定提交用于回查本次采用的方法。补充内容是按当前 Codex 任务范围组织的中文综合指导，来源的运行工具与操作流程各有自身条件。链接用于对照来源，执行以本 Skill 当前入口与专题指导为依据。

| 来源与固定版本 | 核对的原文 | 当前承接的方法与位置 |
|---|---|---|
| Claude Design 第三方提取材料，`3c4deaae9bbd6259e3d972f3bdb208ef6fd942f9` | [hi-fi-design](https://github.com/asgeirtj/system_prompts_leaks/blob/3c4deaae9bbd6259e3d972f3bdb208ef6fd942f9/Anthropic/claude-design/skills/hi-fi-design/SKILL.md)、[options](https://github.com/asgeirtj/system_prompts_leaks/blob/3c4deaae9bbd6259e3d972f3bdb208ef6fd942f9/Anthropic/claude-design/skills/options/SKILL.md) | 真实设计上下文、早期关键区域样张、稳定候选身份及局部组合反馈，承接于 aesthetic-direction.md |
| Impeccable，`2f98774f86bc05563876643db37e6c37c322850f`，Apache-2.0 | [critique](https://github.com/pbakaus/impeccable/blob/2f98774f86bc05563876643db37e6c37c322850f/skill/reference/critique.md)、[typeset](https://github.com/pbakaus/impeccable/blob/2f98774f86bc05563876643db37e6c37c322850f/skill/reference/typeset.md)、[layout](https://github.com/pbakaus/impeccable/blob/2f98774f86bc05563876643db37e6c37c322850f/skill/reference/layout.md)、[polish](https://github.com/pbakaus/impeccable/blob/2f98774f86bc05563876643db37e6c37c322850f/skill/reference/polish.md) | 按任务评审层级、分组、密度、文字角色与内容边界，定位共同原因并在相应来源修正，承接于 visual-quality.md 与 visual-critique.md |
| Taste Skill，`a60a36dc2bb3bb77ccf17f2f62041f5ca8a458b9`，MIT | [Skill](https://github.com/Leonxlnx/taste-skill/blob/a60a36dc2bb3bb77ccf17f2f62041f5ca8a458b9/skills/taste-skill/SKILL.md)、[critique](https://github.com/Leonxlnx/taste-skill/blob/a60a36dc2bb3bb77ccf17f2f62041f5ca8a458b9/skills/taste-skill/references/critique.md) | 从真实画面观察视觉焦点、分组、素材裁切与内容完整性，发现对应截图和具体修法，承接于 visual-critique.md |
| Trystan-SA 重建与适配版，`3c3ddb07d7aa3fef051d83608596470c95cfd8fe`，MIT | [frontend-aesthetic-direction](https://github.com/Trystan-SA/claude-design-system-prompt/blob/3c3ddb07d7aa3fef051d83608596470c95cfd8fe/codex/skills/frontend-aesthetic-direction.md)、[hierarchy-rhythm-review](https://github.com/Trystan-SA/claude-design-system-prompt/blob/3c3ddb07d7aa3fef051d83608596470c95cfd8fe/codex/skills/hierarchy-rhythm-review.md) | 将视觉意图落实到字体、色彩、密度与构图，区分局部层级和整页节奏，承接于 aesthetic-direction.md 与 visual-critique.md |

Claude Design 材料的维护者记录了从运行环境提取正文及重建 Skill 元数据的方式，见 [2026-08-19 提取说明](https://github.com/asgeirtj/system_prompts_leaks/blob/39262eabe81093bfdbea04e05f187b85a5c771f3/Anthropic/claude-design/skills/README.md)。来源按第三方提取材料使用；Trystan-SA 则按作者声明的重建版使用。

Taste Skill 的原始方法面向营销页、作品集等公开页面，其站点样本与效果属于作者自己的研究和测试记录。本地提取画面观察方法，工作台与教学页面的结构仍由各自任务决定。固定图片数量、必用动效、随机抽取方向、评分上限和轮数保留在原项目中。

Impeccable 的检测器、CLI、钩子与评审调度采用其工具链；本地通过现有浏览器和评审能力执行适用检查。Trystan-SA 中的固定字体与颜色数量、间距网格和候选配额依其原场景解释，当前作品以真实来源、内容和用户要求确定取值。Claude Design 的 canvas、私有文件格式与工具桥继续按其宿主条件理解。

配套 assets/design-comparison.html 为本地原创教学样例，展示同源内容下的视觉关系变化，使用时可编辑样例代码再检查实际画面。
