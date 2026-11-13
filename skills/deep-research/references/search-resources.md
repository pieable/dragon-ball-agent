# 搜索资源表

按当前要找的材料选择入口。表内是起点，不限制研究范围；领域专用数据库、所在地语言和相关专业群体需要按问题继续发现。通用引擎、学术索引和数据目录负责发现，最终证据回到原文、原数据或实际记录。

核验日期：2026-10-27 至 2026-10-28。以下核验以官方帮助和文档为主，链接即相应依据；没有统一测试查询结果、地区可达性或完整召回。API、付费与登录条件在实际使用时重新检查，不把文档可访问写成接口已运行。

## 从哪里开始

| 材料与用途 | 入口及官方说明 | 使用边界 |
| --- | --- | --- |
| 通用网页、机构与专业术语 | [Google 搜索帮助](https://support.google.com/websearch/answer/2466433?hl=en)、[Bing 高级搜索](https://support.microsoft.com/en-us/bing/advanced-search-options)、[Brave Search](https://search.brave.com/help/goggles) | 根据实际可用工具选择；不同引擎的索引、排序、语言与语法不同。必要时换入口补缺，不把多引擎重复结果当独立证据。Goggles 是结果过滤/重排，不是可靠性认证 |
| 跨学科论文、引用与全文版本 | [Google Scholar](https://scholar.google.com/intl/en/scholar/help.html) | 按 References、Cited by、Related articles、All versions 追踪；全文可能需订阅，收录与结果展示不支持声称穷尽。不要默认存在可用的官方批量搜索 API |
| 学术关系与批量书目发现 | [OpenAlex 搜索](https://help.openalex.org/api/searching/) 与 [访问条件](https://help.openalex.org/api/authentication/)、[Semantic Scholar API](https://www.semanticscholar.org/product/api) | 适合关键词、作者、引用关系与相关文献；元数据和排序不是研究结论。OpenAlex 游标分页需密钥；Semantic Scholar 存在共享限流及端点权限差异 |
| 精确题名、DOI 与出版元数据 | [Crossref REST API](https://api.crossref.org/swagger-docs) | 查注册元数据与原出版入口；字段由成员提交，可能不全，仍核对原文与版本 |
| 图书、版本与馆藏 | [WorldCat FAQ](https://search.worldcat.org/faq)、[中国国家图书馆馆藏目录](https://meta.nlc.cn/v2/index.html) 与 [数字资源](https://www.nlc.cn/web/select.html) | 按题名、作者、ISBN、主题与分类发现版本，再查持有馆和原书；目录不等于全文，部分详情、数字资源和借阅服务涉及登录与授权 |
| 中文社会科学与人文文献 | [国家哲学社会科学文献中心使用指南](https://www.ncpssd.cn/service/guide) | 可发现期刊、古籍与相关学术资源；指南要求注册登录后使用相应检索、阅读和下载服务，单篇全文仍看权限。无人授权时不自行注册 |
| 生物医学与生命科学 | [PubMed 帮助](https://pubmed.ncbi.nlm.nih.gov/help/)、[Europe PMC](https://dev.europepmc.org/RestfulWebService) | 使用领域主题词、原文与相关数据链接；PubMed 网页与 API 功能有差异。索引不等于全文可得 |
| 预印本与新近技术方法 | [arXiv](https://info.arxiv.org/help/api/user-manual.html)，以及目标领域的机构仓储 | 比较版本及后续正式出版、勘误与复现；预印本不是同行评审定稿的自动替代 |
| 发明、功能分解与跨行业技术机制 | [Google Patents](https://support.google.com/faqs/answer/7049475?hl=en)、[EPO Espacenet](https://www.epo.org/en/searching-for-patents/technical/espacenet) | 可沿技术分类、专利族和引用扩展；申请文本不证明已实现或有效。法律状态回主管专利局；Espacenet 不支持机器人批量抓取，自动取数另查 OPS 条件 |
| 标准、术语与工程约束 | [ISO 浏览平台说明](https://helpdesk-docs.iso.org/article/596-online-browsing-platform-obp)，目标领域标准机构与监管机关 | 核对版本及适用范围；预览与目录不是全文，完整标准可能需购买/订阅。标准约束与可选设计方案分别处理 |
| 中国国家标准 | [国家标准全文公开系统](https://openstd.samr.gov.cn/)、[阅读帮助](https://openstd.samr.gov.cn/bzgk/std/help) | 按标准号、状态及分类定位；平台内部分采用国际标准的条目仅供阅读或仅有题录，按具体条目确认全文范围 |
| 跨国与地区官方统计 | [World Bank API](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392)、[Eurostat](https://ec.europa.eu/eurostat/en/web/user-guides/data-browser/api-data-access/api-introduction) | 查询指标定义、原始生产者、统计期和修订口径；World Bank API 无需 key，Eurostat 数据库主要提供最新版本，历史比较需保留取数时点 |
| 政府开放数据集发现 | [Data.gov 用户指南](https://data.gov/user-guide/) 与 [Catalog API](https://resources.data.gov/catalog-api/)，目标国家统计局、部委及地方数据门户 | 目录链接回生产机构，不保证数据完整或及时。Data.gov 网页指南与新版 API 认证说明有差异，自动调用按当前端点文档核验 |
| 中国官方统计 | [国家数据](https://data.stats.gov.cn/)、[国家统计局数据获取说明](https://www.stats.gov.cn/hd/cjwtjd/202302/t20230207_1902282.html) | 按指标、时期和地区查统计及年鉴；核对定义、修订与下载条件。2026-10-28 直连检查出现超时，入口状态需在实际使用时重查 |
| 真实实现、故障与版本变化 | [GitHub 搜索帮助](https://docs.github.com/en/search-github/getting-started-with-searching-on-github/about-searching-on-github)、[Stack Overflow 搜索](https://stackoverflow.com/help/searching) | 源码、提交和测试用于核验具体实现；问题区与问答用于发现症状和实践。代码搜索可能需登录，关键行为需匹配版本并复现；详见 [代码来源表](code-research.md) |
| 使用经验、行业困难与反例 | [Reddit 搜索](https://support.reddithelp.com/hc/en-us/articles/19695647891988-How-does-Reddit-search-work)，相关行业论坛、协会和专业社区 | 按领域语言与工作场景查；保留自我报告、删帖和选择偏差，原帖只直接支持其作者的陈述。中文与地区实践需另查相应社区 |
| 失效页面与历史变化 | [Internet Archive 开发者入口](https://archivesupport.zendesk.com/hc/en-us/articles/360001495812-Developer-Resources)、[Wayback CDX 文档](https://github.com/internetarchive/wayback/blob/master/wayback-cdx-server/README.md) | 查已保存的 URL 与时间快照；快照缺资源或没有收录均可能发生，存档时间不等于原始发布时间 |

## 选择与维护

陌生领域先找能够揭示术语与专业来源的材料。需要广度时组合一般检索与专门索引；需要深度时沿具体对象、引用和实现追查。找不到结果时检查查询词、语言、索引范围、版本和访问方式，再判断是否需要换入口。

登记新入口时保留：它能找到什么、在哪些地区/语言/时间/对象范围有效、原始材料在哪里、访问与分页条件、实际核验日期和级别。入口失败、登录限制、未检查和确实无结果分别记录。项目特定入口与运行状态先保存在项目研究资料；全局资源表的修改按相应维护授权处理。
