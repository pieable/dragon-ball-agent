# 公开迁移审查记录

## 已纳入的候选

当前清单包含全局 AGENTS、11 个角色及方法参考，以及 13 个 Skills 的运行文件：code-development、code-review、company-research-brief、deep-research、image-art-direction、livestream-video-editing、product-development、project-file-maintenance、system-reengineering、workflow-route-mapper、workflow-state-distiller、xy-axis-thinking、playwright。Deep Research 的旧项目经验存档留在本地；当前运行正文不依赖那组旧案例。

这些文件来自迁移前实际工作区，不是各组件的旧 HEAD。角色仅将机器路径替换为安装占位符，其余配置和正文保持一致。Playwright 的原许可证与 NOTICE 随文件保留。方法参考中的公开项目案例保留原来源。

迁移清单以 `system-manifest.json` 为准；按当前机器路径渲染后，已纳入文件全部与运行目录中的原文件字节相同。预览器的新增、冲突保留、来源变更拒绝、路径越界拒绝与模板渲染共 5 项测试通过。没有执行安装或模型行为测试。

## 尚未纳入本轮清单的部分

仓库其余既有文件仍属于原发行版本，不表示已经完成这次迁移；仅 `system-manifest.json` 列出的文件是本轮候选。发布前须完成剩余部分或明确分离发行范围，更新主 README 与 INSTALL。

以下材料先保留本地，不直接带入公开候选：

- 教学个人档案：个人经历、偏好和私人会话定位；提供本地保留接口与新用户空白模板，不能覆盖原件。
- 用户提供的《数学之美》完整章节和原图：保留书目与本地自备入口，不公开全文。
- Deep Research 的旧本地研究经验案例及其历史索引：当前正文已经要求项目自己维护经验库，不将旧私人案例作为公共运行包。
- 中文样例全文库：其中各作品许可不同，公开索引与链接和本地全文分离。
- 提示词维护的私人规则来由、历史会话及配置备份：保留本地，维护操作需要它们时明确提示位置和未迁入状态。

## 第三方材料范围

根 MIT 不覆盖第三方原作。后续导入须逐项保留署名、许可、翻译与修改声明：

- 前端方法含 BaoCut Community License 1.0 适配内容；该许可允许商业内容创作和内部业务使用，对商业化软件及代码另设条件，不能被根 MIT 替换。第三方提取的 Claude Design 材料还需查清可再分发范围。
- 中文样例包含 CC BY-NC、NC-SA、NC-ND、GPL、Apache、政府开放许可和公有领域作品，不能统一作为原创 MIT 附件。
- 教学来源中的 Humanizer、Google、Microsoft、GOV.UK、ONS、W3C 等按各自材料许可处理；不与用户私有 EPUB 混为一类。
- 翻译短例保留出处，不能把被引用译句声明成仓库原创作品。

本轮许可判断来自已有材料和许可文件，完整公开发行前还需完成关联来源核查。尚未推送此分支，也未改变用户正在使用的体系。

后续六项Skill已完成公开/本地分层，当前白名单194项，具体依赖与去向见SKILL-LAYERS.md。上文批次记录保留来源沿革，不作为最新数量。
