# 六个 Skill 的公开与本地分层

公开主干来自实际运行文件，不以仓库旧版替代。只改部署材料说明、私人授权与路径绑定；真实安装目录未修改。

## 安装白名单

每个 `skills/<name>/LOCAL-DEPENDENCIES.json` 的 `public_files` 给出准确候选路径。本JSON自身作为构建元数据，不自动当运行Skill。总表 `skills/local-dependencies.json` 给出原runtime路径、使用条件、本地保留状态。不要用目录递归复制取代白名单。

## 材料去向

| Skill | 公开载荷 | 本地保留及调用条件 |
|---|---|---|
| book-translation-zh | 入口、agent描述、EPUB流程、现代中文方法、验证脚本 | translation-examples.md含现代译者摘句，保留来源但未核实公开再分发；指定翻译分支必须有该文件或取得可用原件才能完成 |
| frontend-design | 入口、非排除专题、页面资产、动效脚本及许可 | aesthetic-direction、visual-quality、design-system、visual-critique含BaoCut受限许可或第三方提取/混合来源；相应专题保留本地，缺少时报告该专题尚未加载，不用通用描述冒充 |
| markitdown-files | 入口与agent描述 | 可执行文件通过MARKITDOWN_EXE或PATH解析，不复制机器Python环境 |
| teach-and-explain | 入口、方法参考、词汇表模板与脚本、空白学习档案模板 | user/学习档案.md、来源全文与私人学习项目保持本地；模板只在assets，不覆盖档案、不代表维护授权 |
| write-instructions-zh | 入口、agent描述、方法参考与评测案例 | RULE_RATIONALE.md、MODIFICATION_LOG.md为个人共同决定与版本历史，维护本Skill时按影响读取本地原件；不假造新的历史 |
| writing-zh | 入口、三个编辑方法参考、公开样例查找入口 | samples原全文、私人认可状态、混合版权库保持本地；公共入口不声明用户已认可任何作品 |

## 路径与权限

- imagegen从当前宿主实际Skill入口读取，不固定Codex个人目录。
- DESIGN_RESOURCE_LIBRARY是可选本地原件库绑定，未绑定走现场来源发现。
- 教学无所属项目时使用当前授权工作区artifacts目录。
- 个性化档案及认可状态只从当前用户和本地profile取得；没有授权不维护跨项目档案。原主干仍有系统设计教学/HTML-MD等工作方案，这些属于该体系的方法配置，不冒充新用户已经作出的授权。
- local依赖原路径是目标上的未托管文件；部署应保留，不因公开仓库没携带而删除。缺少条件必需依赖时，预检和执行报告都须显示对应未就绪分支。公共包不是这几个分支的完整自足安装。
- sources/index.md与samples/index.md是公开导航候选；若目标已有私人索引，首次安装保持冲突并保留私人索引，不覆盖。

## 第三方许可

frontend的Anthropic许可、BaoCut完整许可和来源说明保留；motion-capture脚本保留LICENSE.stageshow。保留许可文件并不把被排除正文重新纳入公开载荷。其他外部正文未获再分发核验，本批不发布。未读取或复制个人教材全文与样例语料。

## 历史发布检查

本次仅改工作树，没有重写Git历史。以下本地依赖路径在已缓存origin/main树中已存在，删除当前文件不会从既有远端历史撤回；公开前由主负责人决定是否需另处理历史：
- `skills/frontend-design/references/aesthetic-direction.md`
- `skills/frontend-design/references/visual-quality.md`
- `skills/frontend-design/references/design-system.md`
- `skills/frontend-design/references/visual-critique.md`
- `skills/write-instructions-zh/MODIFICATION_LOG.md`
- `skills/write-instructions-zh/RULE_RATIONALE.md`

检查依据是本地origin/main，不代表新拉取远端。

缓存origin/main引入记录：frontend aesthetic-direction由提交3bd6a73（作者pieable，2026-10-15）加入；write-instructions RULE_RATIONALE由beeda8a（作者pieable，2026-08-30）加入。未重写这些历史。
