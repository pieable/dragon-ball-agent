# 间接依赖发现与安全退出

删除、改名、内联常量、移除开关/配置/实验/层、裁剪公开接口或退出旧实现时使用。先明确拟采取的动作和必须保持的行为，再建立受影响对象及其消费者关系。一次调用点简化、删除本地分支、删除公开符号和删除远端对象分别判断。

## 从名称、值和入口追到实际使用

先在授权范围内列出相关源文件、配置、schema、注册清单、生成步骤、构建及发布入口。查明默认搜索是否忽略隐藏文件、生成目录、子模块或部署清单，有关部分按需显式纳入。对每个候选记录“源码符号—实际值—运行时名称—注册/发布对象”的对应关系，再用语言引用、结构化搜索和文本搜索互相补充。

| 引用可能藏在哪里 | 具体材料与查法 | 对删除或改名的判断 |
|---|---|---|
| 枚举与常量 | 从枚举成员、常量和共享字面量分别追引用，查 `.name/.value`、遍历、反向映射及序列化输出。同一值可能被多个符号表示 | 既检查符号消费者，也检查保存或传输该值的读取方。代码引用为零后仍核对存量数据与旧客户端 |
| 包装器与适配器 | 找到 SDK/平台调用入口，向上追通用 helper、decorator、代理、依赖注入与参数透传，核对是否添加前缀、改默认值、缓存或产生记录副作用 | 检查包装器所有调用形态和实际参数来源，保留合同要求的曝光、审计、错误处理及其他副作用 |
| 导入别名、重导出与路径映射 | 顺着 `import ... as`、`export ... as`、barrel 文件、模块级 `__getattr__`、Node `imports/exports` 和 TS `paths` 追回定义，再反向查消费端 | `__all__` 只定义 Python 星号导入范围。TS `paths` 不改写编译后的 import，仍需核对运行时解析 [R1][R2][R3] |
| 动态组合名称 | 枚举 `getattr`、`import_module`、反射 `Class.forName/getMethod/invoke`、映射表索引、字符串拼接、模板及环境输入。结构化查询区分字面量、变量、调用和拼接参数，继续追每个动态来源 | 无法静态求出名称时，结合配置实例、解析日志和代表性输入验证。执行动态代码或加载插件前确认其副作用与权限 [R4][R5] |
| DI 与条件注册 | 查扫描根包、bean 名、qualifier、别名、注解、profile 和条件装配。对生产使用的条件枚举实际注册对象及来源 | 类型引用之外还有字符串和隐式扫描引用。一个 profile 的空注册结果不能替代其他生产条件 [R6] |
| 插件与服务清单 | 查 Python entry points、已安装 `dist-info`、Java `META-INF/services` 与模块 `provides ... with`、路由和命令注册表 | 核对实际 wheel/JAR/包内清单，并从宿主发现入口解析和调用。声明可能来自另一个已安装包，懒加载也可能把错误推迟到首次消费 [R7][R8][R11] |
| schema 与生成代码 | 从 `.proto`、OpenAPI、GraphQL SDL、ORM/数据库定义追到生成器、版本、语言绑定、网关和发布包。查已持久化的查询、事件名及字段编号/名称 | 弃用标记不阻止旧客户端调用。用契约差异检查、历史报文和真实下游编译/解码判断兼容性，详见[接口与数据演进](contracts-and-data-evolution.md) [R9][R10] |
| 跨服务与跨仓库消费者 | 从服务目录、API/事件契约、包依赖、客户端发布、消息订阅、任务/运维脚本和路由注册反查消费端。沿共享常量和值继续找外部名字 | 当前仓库的空引用只能关闭本仓库已查范围。取得下游版本、调用/订阅证据，按当前访问范围标明仍未核实的消费者 |
| 配置对象之间的引用 | 从控制面清单和导出规则找父子开关、segment、层参数、委派和条件依赖，建立有方向的关系，并核对被依赖对象 | 一个常量开关可以被其他开关继续使用。调用点没有出现该名字时，控制面仍可能需要它 [R12] |
| 数据库目录外的引用 | 将 `pg_depend`、函数/view/trigger 定义、schema dump 与应用/任务 SQL 合并检查，追表名、旧名、search_path 和动态片段 | PostgreSQL 字符串函数体的内部表依赖可能不被记录，SQL-standard 函数体在定义时解析可记录。目录或 RESTRICT 检查未发现依赖后，仍核对函数体与外部 SQL [R13] |
| 基础设施行为依赖 | 对照资源图、显式引用、depends_on、字符串资源名/ARN、启动脚本、IAM/DNS 和其他仓库配置 | Terraform 图表示工具已知的边；依赖另一资源行为而未读取其属性的关系可能隐藏。按已授权范围读配置/state/plan，实际销毁不作为取证步骤 [R14] |

工具选择取决于引用形式：语言服务器/编译器用于语义引用，AST/Semgrep 类结构化查询用于调用形态及参数来源，文本搜索补配置和字符串，运行时枚举与 trace 补动态装配。检查解析失败、未扫描文件和工具边界，把它们作为覆盖缺口继续处理。

静态工具的 confidence 需连同输入文件、解析结果、exclude/ignore 与白名单解释。例如 Vulture 会按 AST 名称判断使用，动态 `getattr` 可被报为 unused；高 confidence 的结论仍受已分析范围限制。对白名单条目核对当前对象与真实注册用途，删除后再查新暴露的不可达项 [R15]。

## 核对生产值与仍承担的职责

对“已经常量化、已弃用、已发布、没有流量”的候选，取得对象 ID、项目、环境、规则及读取时点，逐项核对：

- 相关生产区域、服务、租户/用户条件、客户端版本及 target/segment/override 是否得到相同结果。比例发布和条件优先级可能使默认值不能代表最终值。
- SDK 的默认参数、初始化前读取、配置缺失/网络失败、缓存旧值和本地覆盖分别经过什么路径。用已部署配置和实际 SDK 版本判断，开发用覆盖与生产有效值分别记录。
- 永久开关、killswitch、事故缓解、容量保护、回滚和测试职责是否仍有明确使用场景。当前长期不变可说明观测现状，退出这些职责需要对应的有效决定。
- 简化返回值是否同时移除了曝光记录、审计、指标、缓存刷新、初始化或注册副作用。对需要保留的部分明确替代位置。
- 对象历史、相关 PR 和并行修改是否说明它仍在迁移、等待旧客户端退出或承担曾经事故后的保护。历史用于恢复理由，当前配置和实际消费者用于核对现状。

源码足以证明的确定性关系直接核对。动态依赖、生产规则或运行职责决定结论时，取得相应只读配置、实际消费证据或可重放输入。无法访问的决定性材料保留为明确待补项，不把空搜索结果当作删除依据。

### Statsig 控制面的具体取证

使用当前账号允许的项目清单、SDK key/environment 映射及导出规则对账。对 gate 可读取 `GET /console/v1/gates/{id}/gate_references`，按 `limit/page` 完成分页，保留引用实体和 `passes_gate/fails_gate` 条件。接口没有声明已返回传递闭包时，沿返回关系继续追并记录已访问对象，核对跨类型与跨项目覆盖，不能默认一次调用已包括全部依赖 [R16]。

Config History 不列出嵌套配置的上游变化，历史记录与当前依赖图分别查。Stale/Permanent、生命周期状态、checks 与 billable exposure 也分别解释，曝光量下降不能直接替代调用量。控制台或工具返回空引用时，继续核对代码、动态名称与其他服务；SDK 默认/错误回退按实际版本读取 [R17]。

## 全面审计与成本排序

用户要求全量审计时，从所有相关项目/清单建立全集，处理分页和别名，给每个对象记录已验证可移除、应保留或待补证据及理由，并对账代码引用中出现但清单没有的值、清单有但代码未见的对象、未能求值的动态名称。普通局部变更只展开其实际影响范围。

按请求/任务频率、每次触发次数、依赖展开和实际 profile 查重复检查。关注一个父开关映射所有功能、循环内求值、包装器重复读取、规则/segment 计算及曝光记录成本。核对 CPU profile 的调用栈、采样方式和时间窗口，区分自身耗时与含子调用耗时，避免将同一展开成本重复归到多层。

观测到的评估次数、CPU/内存/I/O 与云费用分别记录单位、服务和测量条件。没有直接成本归因时写清可确认的调用量与尚未测得的资源量，按[实验方法](experiments.md)取得可比较证据。采样中未出现某条路径，还需核对是否覆盖低频任务、条件流量、故障和恢复路径。

将“零 trace”用作退出证据前，读取 SDK sampler、parent-based 传播、collector filter/tail sampling、导出失败/队列丢弃、保留期、查询条件及 service/environment 标签。head sampling 已丢弃的数据不能由下游 tail sampling 恢复。结合覆盖相同窗口的计数/日志与受控哨兵调用核对采集到查询的链路，再解释零命中 [R18]。

把已经验证的结果按所有者、共享文件和依赖组织成可独立执行的工作组。每项带上对象与生产值、调用点/控制面关系、替代行为、证据、成本、保护职责与验证方式。共享 wrapper、常量和配置依赖先明确共同负责人及顺序，再安排并行修改。报告授权不扩大为修改在线配置或服务。

## 一手依据

- [R1 Python 包导入](https://docs.python.org/3/tutorial/modules.html#importing-from-a-package)、[模块属性钩子 PEP 562](https://peps.python.org/pep-0562/)。
- [R2 Node 包入口与子路径映射](https://nodejs.org/api/packages.html#package-entry-points)。
- [R3 TypeScript paths](https://www.typescriptlang.org/tsconfig/paths.html)。
- [R4 Python getattr](https://docs.python.org/3/library/functions.html#getattr)、[importlib.import_module](https://docs.python.org/3/library/importlib.html#importlib.import_module)。
- [R5 Java Class.forName](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Class.html#forName(java.lang.String))、[反射 Method.invoke](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/reflect/Method.html)。
- [R6 Spring 组件扫描](https://docs.spring.io/spring-framework/reference/core/beans/classpath-scanning.html)、[qualifier](https://docs.spring.io/spring-framework/reference/core/beans/annotation-config/autowired-qualifiers.html)。
- [R7 PyPA entry points 规范](https://packaging.python.org/en/latest/specifications/entry-points/)。
- [R8 Java ServiceLoader](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ServiceLoader.html)。
- [R9 Protobuf 更新规则](https://protobuf.dev/programming-guides/proto3/#updating)、[Buf breaking](https://buf.build/docs/breaking/)。
- [R10 GraphQL 字段弃用](https://spec.graphql.org/October2021/#sec-Field-Deprecation)。
- [R11 Pygments 插件](https://pygments.org/docs/plugins/)。
- [R12 OpenAI 软件维护案例](https://developers.openai.com/blog/maintaining-software-with-the-gpt-6-family#tracking-down-stale-experiments)：代码/配置间接关系、生产取证、运维职责、CPU fan-out 与按所有权组织结果。
- [R13 PostgreSQL 18 依赖跟踪](https://www.postgresql.org/docs/18/ddl-depend.html)：字符串函数体与定义时解析的区别。
- [R14 Terraform depends_on](https://developer.hashicorp.com/terraform/language/meta-arguments/depends_on)、[graph](https://developer.hashicorp.com/terraform/cli/commands/graph)：隐藏行为依赖与已知关系图。
- [R15 Vulture 官方方法与动态调用例子](https://github.com/jendrikseipp/vulture#how-does-it-work)：置信度、范围和动态引用。
- [R16 Statsig Gate References](https://docs.statsig.com/api-reference/gates/list-gate-references)：只读引用接口及分页。
- [R17 Statsig Config History](https://docs.statsig.com/guides/config-history#entity-change-history)、[Permanent/Stale](https://docs.statsig.com/feature-flags/permanent-and-stale-gates)、[生命周期](https://docs.statsig.com/feature-flags/feature-flags-lifecycle)、[工具 Check responses](https://docs.statsig.com/integrations/mcp/tool-reference#check-responses)。
- [R18 OpenTelemetry sampling](https://opentelemetry.io/docs/concepts/sampling/)：采样决策、范围和 tail 条件。

名称和值的联合追踪、覆盖对账及工作组组织，是结合这些机制与本 Skill 责任形成的工程综合。来源中特定平台的行为仅用于相应条件。
