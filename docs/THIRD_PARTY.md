# 第三方内容

第三方文件保留自己的许可，仓库根 MIT 许可不替代它们。

| 内容 | 来源与许可 |
| --- | --- |
| `skills/frontend-design` | [Anthropic 官方原文件](https://github.com/anthropics/skills/blob/2235be7c60b551f5de82ade908fd3816455afcda/skills/frontend-design/SKILL.md)，Apache-2.0，见 [LICENSE.txt](../skills/frontend-design/LICENSE.txt)。现正文及参考文件已按维护环境扩展，保留原 Apache-2.0 许可与来源；新增引用及素材条件见各参考文件。 |

其余材料中的引用、链接和方法来源继续保留在对应文件。外部服务、模型、插件和工具有各自的使用条件，复制本仓库不包含它们的授权或账号访问权。

## 本次新增来源

- 本版教学 Skill 只保留来源索引；Humanizer 英文原文、译本及其他教学来源全文未纳入载荷，已有本地资料不删除。
- 前端参考所用 Claude 设计指导的来源与许可见 skills/frontend-design/references/claude-design-sources.md 和 claude-design-license.txt。
- 教学资料的其余研究摘要保留公开出处；书籍正文、个人范文和原始个人学习资料由接收方提供。设计原件库中的字体、图片和组件按取得的具体来源保留许可。

## 当前分层的核验

- 2026-11-13核对固定提交的 [Anthropic frontend-design许可](https://github.com/anthropics/skills/blob/2235be7c60b551f5de82ade908fd3816455afcda/skills/frontend-design/LICENSE.txt)，为Apache-2.0；许可随相应适配保留。
- [BaoCut固定版本许可](https://github.com/JimLiu/baocut/blob/7aa049e82e1367da013b7aba80f0b79033fa04ad/LICENSE)为Community License 1.0，允许商业内容创作及内部业务使用，对商业化软件本身或代码另设许可要求。本版不再分发四份来源混合的设计专题，保留本地依赖与归属说明，不将其归入根MIT。
- 前端动效脚本保留 `scripts/LICENSE.stageshow`（Benji Taylor，MIT）。Playwright保留自带LICENSE及NOTICE。
- 私人学习资料、小说/文章范文全文与现代译例未在本版公开包分发；许可未知的材料不随目录复制。

自有Luna与Antigravity包装源码按主仓库MIT分发，不包含宿主程序。Luna的npm依赖SDK（Anthropic）与zod（Colin McDonnell）各自MIT，依赖通过锁定版本与integrity从官方npm取得；本仓库不复制node_modules。
