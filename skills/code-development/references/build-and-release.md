# 构建、依赖与实际发布产物

变更构建脚本、依赖、生成代码、包导出、注册、平台条件、缓存或 CI 发布时，沿“输入—构建动作—实际包—安装/加载—下游操作”核对。优先使用项目已有构建和检查工具，构建、链接、加载与可操作结果分别取证。

## 构建输入与缓存

| 具体机制 | 原始材料与查法 | 验证和实现判断 |
|---|---|---|
| 未声明的文件和工具输入 | 查构建动作实际读取的模板、header、schema、代码生成器、工作区外编译器和脚本，比较依赖声明与执行 trace | 在隔离副本改变该输入，再检查是否重建正确输出。Make `.d`、构建系统 action/query 和 sandbox 可帮助发现边；工具需进入其跟踪的输入范围 [B1][B2] |
| 环境与命令不进入正确 key | 读取 action 的参数、编译 flag、工具链、PATH、平台和环境声明，核对任务缓存的 input/output 属性 | 在两种声明环境或工具版本间构建，比较 key、命中与产物。缓存 key 是否完整与缓存命中率分别核对 [B2][B3] |
| 源码在构建期间变化 | 对照构建开始/结束时输入及生成文件，查编辑器、代码生成器或并行任务是否写同一目录 | 固定输入快照再构建，检查产物对应的版本，避免将混合版本输出上传共享缓存 [B2] |
| 配置缓存与输出缓存混淆 | 查 Gradle 等系统的配置阶段输入、任务输入与实际任务执行状态 | 分别改变配置输入和任务输入，核对图重建与任务重跑。配置缓存命中不能证明构建产物已重新生成 [B3] |
| Docker 缓存失效条件 | 逐层检查 `COPY/ADD` 的输入元数据、`RUN` 指令及网络取得内容、build secret 使用 | 改变来源内容或 secret 后检查哪层实际重跑。secret 内容变化本身不进入 Docker 缓存失效 key，需要按真实刷新要求处理，不能靠“重新 build”推断依赖已更新 [B4] |
| CI restore key 与跨分支复用 | 查精确 key、前缀 restore-keys、lockfile 路径、OS/架构和访问范围，检查恢复后是否重新校验依赖 | 恢复旧/部分匹配缓存后执行真实解析与构建。缓存与发布 artifact 分开，认证材料不进入可被其他执行者读取的缓存 [B5] |

## 依赖与安装内容

| 具体机制 | 原始材料与查法 | 验证和实现判断 |
|---|---|---|
| 声明版本与实际解析图 | 查 lockfile、包管理器版本、解析 flag、peer/optional 依赖和平台条件，读取实际依赖树 | 用项目对应的锁定安装入口检查漂移。`npm ci` 会拒绝 package 与锁文件不一致，重现时也需保留影响解析的 flag [B6] |
| feature 或版本在下游合并 | 查 Cargo 各消费者启用 feature 的合集，或 Go module 最小版本选择得到的 build list | 在真实下游组合中编译，检查被上游测试漏掉的 feature/版本。单包默认配置通过不能代表下游实际组合 [B7][B8] |
| 开发安装掩盖漏打包 | 对照源码树、manifest、wheel/tarball/JAR 文件表、数据文件和原生库 | 构建实际交付包并在隔离环境普通安装，从外部工作目录运行。Python editable 直接使用开发目录，不能证明普通安装内容完整 [B9] |
| 导出、别名与条件入口 | 查 Node `exports/imports`、ESM/CJS、types、平台条件、TS paths 与 bundler alias | 从外部消费包实际 import/require 并操作，用目标运行时核对解析结果。类型检查、链接和加载覆盖不同层，详见[依赖发现](dependency-discovery-and-retirement.md) [B10] |
| 插件注册与运行时资源 | 对照 entry points、SPI、资源查找、动态库搜索路径、工作目录和实际包结构 | 从真实宿主枚举并首次调用插件，核对来源包和加载错误。开发路径、已安装旧文件或系统库可能掩盖交付遗漏 [B9][B10] |
| 可复现性与来源差异 | 查时间戳、路径、locale、压缩/归档顺序、版本嵌入和代码生成来源 | 同一已确定输入在隔离环境构建，按项目可复现要求比较 manifest/hash，定位必须变化的元数据。源码提交和发布 tarball 不同来源时核对生成与打包差异 [B1][B11] |

## CI 图与发布结果

从实际 CI 历史读取各 job/step 的运行时间、等待、setup、依赖安装、测试、重试及 artifact 上传下载。用依赖图找关键路径，并保留各平台/版本/feature matrix 的独立覆盖，优化按相同成功结果比较。

- 改 shard 或并行度时，核对测试收集与分配是否遗漏/重复，fixture/端口/临时目录是否隔离，慢 shard 是否决定总完成时间。CPU、内存与外部服务容量共同影响最优并行度。
- 改 artifact 名称或上传方式时，核对 matrix 多写者、覆盖语义和最终发布者取得的准确包，避免不同平台写到同一不可变 artifact [B12]。
- 改 concurrency group/cancel-in-progress 时，核对组名范围及 pending/run 中任务的取消语义。取消旧构建不能顺带中断需要完成的发布、迁移或证据保存 [B13]。
- 用构建系统的命中与执行统计判断实际重跑，缓存保存的 stdout/stderr 不代表动作在本轮执行。最终包身份、安装/启动结果与本轮候选对应 [B2]。

## 一手依据

- [B1 Bazel hermeticity](https://bazel.build/basics/hermeticity)、[Make 自动依赖](https://www.gnu.org/software/make/manual/html_node/Automatic-Prerequisites.html)。
- [B2 Bazel remote cache](https://bazel.build/remote/caching)：action、环境、外部工具、并发修改与输出。
- [B3 Gradle build cache](https://docs.gradle.org/current/userguide/build_cache.html)、[configuration cache](https://docs.gradle.org/current/userguide/configuration_cache.html)。
- [B4 Docker cache invalidation](https://docs.docker.com/build/cache/invalidation/)。
- [B5 GitHub Actions dependency caching](https://docs.github.com/en/actions/reference/dependency-caching-reference)。
- [B6 npm ci](https://docs.npmjs.com/cli/v10/commands/npm-ci)。
- [B7 Cargo feature unification](https://doc.rust-lang.org/cargo/reference/features.html#feature-unification)。
- [B8 Go module MVS](https://go.dev/ref/mod#minimal-version-selection)。
- [B9 pip 普通与 editable 安装](https://pip.pypa.io/en/stable/topics/local-project-installs/)。
- [B10 Node 包入口](https://nodejs.org/api/packages.html)、[PyPA entry points](https://packaging.python.org/en/latest/specifications/entry-points/)。
- [B11 SOURCE_DATE_EPOCH](https://reproducible-builds.org/docs/source-date-epoch/)。
- [B12 upload-artifact 维护者说明](https://github.com/actions/upload-artifact#not-uploading-to-the-same-artifact)。
- [B13 GitHub Actions concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。

具体工具选项、缓存保证和 artifact 行为按项目使用的版本核实。上述调查与验证组合按当前变更选择，不要求为局部修改构建全部平台。
