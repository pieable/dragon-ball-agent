# 文件管理的专业方法与工具

用于选择现成机制。先查项目已采用的工具、实际版本及本机适配；安装、迁移、外部存储、自动删除和历史重写各自遵守授权。下列来源支持机制选择，不要求把它们全部引入项目。

## 按对象管理源文件、导出与预览

[剑桥的文件组织、命名和版本指导](https://www.data.cam.ac.uk/organising-storing/file-organisation-naming-version-control)与[纽卡斯尔的数据组织实践](https://www.ncl.ac.uk/library/academics-and-researchers/lrs/rdm/working/organise/)将一致、简洁、有意义且可查找的名称与明确的目录关系结合。按对象和工作内容命名有助于人员变化后接续；版本信息区分候选，不依赖不断叠加“最终”“修订”。这里采用可辨认和一致性的原则，具体语言、字段和层级服从项目与工具，不照搬某个领域的字符禁用表或目录数量。

[Kitsu 的资产管理](https://dev.kitsu.cloud/guides/asset-management)区分工作文件、输出和预览，并按项目、资产或镜头、任务安排文件树。可借鉴其对象与用途关系，把同一成果的可编辑源、运行资源和审核预览关联起来；小项目用已有入口和版本记录即可，无需部署制作管理系统。

[Noble 的计算项目实践](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1000424)与[Good enough practices](https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1005510)提供按项目组织、记录计算及版本控制的方法。实验记录服务于比较和重现，不把论文示例的目录名当作所有项目的强制模板。

## 让生成工具管理产物

- [CMake presets 的 binaryDir](https://cmake.org/cmake/help/latest/manual/cmake-presets.7.html#configure-preset)用于区分构建输出；[Bazel 输出布局](https://bazel.build/remote/output-directories#current-layout)说明工具管理的输出树与缓存。先用已有配置控制生成位置，不手工改造工具内部目录。
- [Snakemake 的规则](https://snakemake.readthedocs.io/en/stable/snakefiles/rules.html)提供依赖、临时输出与 shadow 工作区。目录输出可能在重跑前删除，只能指向该任务独占的输出范围，不能把共享资料目录声明为可清理输出。shadow 的部分模式会链接回原工作目录；生成器可能修改输入时，要查清链接与实际写入范围，采用能隔离该写入的模式，不能只因有独立工作区就判定共享源受保护。
- [DVC 流水线](https://doc.dvc.org/user-guide/pipelines/defining-pipelines)记录输入、命令和输出，适用于确有重复计算与大数据版本需求的项目。[Nextflow 的缓存与恢复](https://docs.seqera.io/nextflow/cache-and-resume/)说明恢复同时依赖任务缓存和工作目录中的有效输出；保留元数据却删光输出不等于还能直接恢复。工具可能限制同一缓存或状态库的并发访问，采用前核实。

## 多人协作和版本切换

- [Git worktree](https://git-scm.com/docs/git-worktree)共享 Git 对象库，各工作树拥有自己的工作文件和索引，适合文本代码分支协作。它不自动保护不受 Git 管理的大素材，也不隔离配置中的绝对输出路径。
- [Perforce 的锁与独占打开](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/P4Guide/resolve.lock.exclusive.html)区分防止他人提交的锁与防止并行打开的 `+l`。不可合并二进制需要明确单写入者；普通文字说明或仓库锁不能当作对所有外部应用写入的系统级保护。
- [Git update-ref](https://git-scm.com/docs/git-update-ref)提供“仅在旧值仍符合预期时更新”的现成例子。共享当前入口可借用这种检查思路，或直接由一个整合者负责；不要为普通文件项目自建一套事务服务。目录、文件组和多个入口的切换须按实际工具能力验证，单文件原子写入不等于整组原子发布。

## 保留、清理与占用核验

- [DVC gc](https://doc.dvc.org/command-reference/gc)按引用回收缓存；共享缓存须把相关项目纳入考虑。内容寻址降低相同内容的重复存储，但不能假设不同版本的大二进制都只保存差量。先确认现有 Git/LFS/DVC 管理范围，再决定恢复方案。
- [restic 的 forget 与 prune](https://restic.readthedocs.io/en/stable/060_forget.html)区分移除快照保留记录和实际回收存储。借鉴按用途保留检查点、验证可恢复后再回收的流程，归档与回收站本身仍占空间。
- Windows [DU](https://learn.microsoft.com/en-us/sysinternals/downloads/du)可辅助检查目录占用，[Handle](https://learn.microsoft.com/en-us/sysinternals/downloads/handle)可查当前打开的句柄。结合链接、硬链接和卷占用解释结果；没有句柄不证明未来任务、恢复或审核不再需要它。
- [树测试](https://www.nngroup.com/articles/tree-testing/)可用真实查找任务识别目录命名和入口问题；[指标解释](https://www.nngroup.com/articles/interpreting-tree-test-results/)提醒区分直接成功与绕路。它不能代替打开文件和运行成果的验证。

来源核对日期：2026-11-06。工具行为和可用平台变化时查当前官方文档。
