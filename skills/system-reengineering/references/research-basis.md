# 方法依据

整理于2026-10-30。供扩展或复查本 Skill 时按具体问题阅读；日常任务不需重新浏览。以下为原作者方法、产品文档或当事方复盘，效果按各自场景理解。本文指导为中文综合，并非复制某项目的整套流程。

- [Chikofsky/Cross，Reverse engineering and design recovery: a taxonomy（1990）](https://ieeexplore.ieee.org/document/43044/)：区分逆向、设计恢复、结构调整与再工程；支持以理解旧系统服务改造的定位。
- [Demeyer/Ducasse/Nierstrasz，Object-Oriented Reengineering Patterns](https://oorp.github.io/)：1.5、5章、6.6和7章，选择性深入、用测试与隔离小重构理解、试验与迁移迭代。OO细节不机械套用到所有工程。
- [CMU SEI，Architecture Reconstruction Guidelines（2003）](https://www.sei.cmu.edu/library/architecture-reconstruction-guidelines-third-edition/)：恢复 as-built 结构，融合静态与动态视图，核验抽象假设。原设计本身是否适用仍需判断。
- [Geipel/Schweitzer，The Link between Dependency and Cochange（2012）](https://www.sg.ethz.ch/publications/2012/geipel2012the-link-between/)：静态依赖和实际共同变化需结合分析，单一图不能判定演进负担。
- [Mikado 方法作者原文（2009）](https://mikadomethod.wordpress.com/2009/12/09/introduction-to-the-mikado-method/)：试验暴露前置依赖，撤回未成立尝试，从可验证的前置项实施。恢复操作仍须保护原有工作。
- [Fowler，Branch by Abstraction](https://martinfowler.com/bliki/BranchByAbstraction.html) 与 [Sato，Parallel Change](https://martinfowler.com/bliki/ParallelChange.html)：边界隔离、新旧并存及最终退出。
- [Stripe，Online migrations at scale（2017）](https://stripe.com/blog/online-migrations)：数据同步、影子比对、切换读写和清退旧模型；适用于具备相应在线迁移条件的系统。
- [Stripe，Migrating millions of lines of code to TypeScript（2022）](https://stripe.dev/blog/migrating-to-typescript)：紧耦合和共存成本使集中转换合理；准备工具链、转换器与真实路径验证仍不可省略。
- [Shopify，Under Deconstruction](https://shopify.engineering/shopify-monolith)：模块化未必需要拆服务；统一规则可能增加摩擦，改造须解决实际工作困难。
- [Godot 4.6 Jolt 指南](https://docs.godotengine.org/en/4.6/tutorials/physics/using_jolt_physics.html)：成熟物理后端替换仍有参数、关节与碰撞语义差异；接口接通之后需核对具体能力。
- [Live2D 文件类型](https://docs.live2d.com/en/cubism-editor-manual/file-type-and-extension/)：编辑工程与运行数据用途不同。推广到创作管线时，分别验编辑、保存重开及消费端运行。
- [GitHub Scientist](https://github.com/github/scientist)、[Hypothesis 状态测试](https://hypothesis.readthedocs.io/en/latest/stateful.html)、[Playwright 视觉比较](https://playwright.dev/docs/test-snapshots)：按比较对象选方法，处理副作用、状态序列与环境差异；不要求安装这些工具。
- [REA](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md) 与 [REA Reconstruction Companion](https://github.com/ShadowSwaps/REA-Reconstruction-Companion)：参考 reconstruction-methods、safe-changes、version-changes、file-compatibility 中的观察/目标区分、语义映射、独立预期、证据适用性与恢复边界。REA为可选取证工具；未沿用其安装更新、全产品规划或费用策略。

“用一次代表性后续修改检验维护收益”和当前 Skill 的职责划分，是面向本用户工作方式的综合设计。它们的实际收益需通过具体任务观察；文档完整、来源成立和样例通过分别说明自己的范围。
