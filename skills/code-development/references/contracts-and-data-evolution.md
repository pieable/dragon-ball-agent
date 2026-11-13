# 接口、数据与版本演进

修改 API、消息、schema、持久数据、分页或跨语言表示时，从实际生产者和消费者取得原始报文、定义、生成配置、存量样本及部署版本。设计和实现采用下列与本次变化有关的方法，评审用相同材料检查候选的反例。平台行为以项目实际版本为准。

## 生产者、消费者与协议版本

先列出实际共存组合：旧写新读、新写旧读、历史数据由新读器回放，以及回滚后的旧代码读取新代码已写数据。把代理、转换器、生成客户端、后台任务和消息保留期内的读者纳入，按实际需要验证这些组合。

| 涉及的机制 | 读取与追踪 | 验证及对实现的影响 |
|---|---|---|
| 字段缺失、默认值与显式值 | 查 schema 的 presence、默认值和实际解析库，区分缺字段、null、`0/false/空串` | Proto3 隐式 presence 会合并缺失与默认值。构造两种读器的往返样本，核对 presence 和业务分支，再决定 optional、默认行为及 PATCH 语义 [P1][P2] |
| 字段号与枚举身份 | 比较历史 descriptor、生成器的编号方式、字段名/号码/类型和 reserved 区间 | Protobuf 删除后保留原字段号及需要保护的名称，检查枚举的旧值/未知值。回放旧字节并比较生成 tag map，避免重排字段导致自动编号变化 [P1] |
| 中间层丢失未知字段或改变 oneof | 标出二进制转 JSON、逐字段复制、脱敏、反射 setter 及重新构造消息的位置 | 让含新字段的报文经过旧代理后由新消费者读取，比较 unknown fields、presence、oneof、map key 和实际字节。验证整体复制与字段级转换的差异 [P1][P3] |
| reader/writer schema 匹配 | 对照 Avro 实际写 schema ID 和读 schema，检查字段名、alias、缺字段的默认值、类型提升及 union 分支 | 用历史写器与当前读器解析真实编码数据，检查新增默认值是否只在读取缺字段时使用。兼容方向不能从同版本序列化成功推定 [P4] |
| 缺字段与 null 的更新含义 | 读取 JSON Merge Patch、GraphQL input、OpenAPI 及后端绑定规则 | 分别提交省略、null、空值和正常值。Merge Patch 的 null 可表示删除，OpenAPI `nullable`、`required` 与默认值分别核对，不把解析成功当作更新语义相同 [P2][P5] |
| 版本头和开放枚举 | 查未传版本头时的默认版本、SDK 固定版本、账号/endpoint 版本及 exhaustive switch | 对已发布旧客户端验证新增响应字段、未知枚举和默认版本行为。序列化类型、枚举零值及错误表示改变时检查业务分支 [P6] |
| Registry 兼容级别 | 读取实际 subject 的兼容模式、历史版本及保留的数据范围 | Confluent `BACKWARD` 默认只比上一版，不能证明新写旧读或读取更早版本。按所需方向与保留历史检查相应组合，核对是否需要 transitive 检查 [P7] |
| 事件版本与交付顺序 | 核对 endpoint/订阅版本、事件 ID、对象版本、创建时间精度和重复/乱序合同 | 旧事件与当前对象分别解析。重复去重和顺序更新分别验证，不用时间戳顺序代替交付合同，也不把所有同对象同类型事件合并。恢复方法见[状态与可靠性](state-and-reliability.md) [P8] |

## 存量数据与在线迁移

迁移前读取实际 schema、数据分布、运行中版本、锁/长事务、后台作业及复制状态。根据现有发布方式决定扩展、兼容读写、回填、切换和退出的顺序，每步说明失败后可继续使用哪份状态。

| 涉及的机制 | 读取与追踪 | 验证及对实现的影响 |
|---|---|---|
| 删除/重命名列与旧进程缓存 | 查旧进程、ORM schema cache、后台任务及新旧写入方实际 SQL | 在旧进程仍运行时升级并调用，再重启调用。按框架能力先让旧代码停止引用/忽略列，待相关版本退出再收缩 schema [M1] |
| 默认值与省略写入 | 核对数据库默认值、应用默认值、ORM 缓存及显式写入 | 对升级前已启动和新启动的进程分别插入记录，检查省略字段时使用哪个值，避免只改数据库默认却仍由旧代码写旧值 [M1] |
| 回填覆盖并发更新 | 查双写路径、回填读取与写回之间的间隔、条件更新、进度游标及切换判据 | 在回填读取后插入在线写，再恢复回填，检查新值是否被旧快照覆盖。用项目支持的条件更新、版本检查或新格式写入优先规则收敛，进度与提交对应 [M2] |
| 数据库提交与外部发布 | 查业务写入、消息发布、ack 和完成标记的顺序，确认事务实际覆盖范围 | 分别在提交前后和发布前后中断，检查丢消息与重复副作用。按现有事务/消息能力选择恢复机制，不能让数据库事务假装覆盖第三方服务 [M3] |
| DDL 锁与等待队列 | 查语句需要的锁、长事务、锁等待及复制延迟，使用实际规模评估 | 在长事务占锁时执行隔离迁移样例，观察后续读写排队。按维护窗口和已约定运行约束安排锁等待/中断处理 [M4] |
| 并发索引构建的残留 | 查 PostgreSQL 索引有效状态、旧快照和构建失败点 | 检查失败后的 INVALID 索引、更新开销及唯一性执行状态，恢复从实际残留继续。`CONCURRENTLY` 仍可能等待旧事务，且不在普通事务块内执行 [M5] |
| 约束扫描与新写入 | 查现有违规数据、支持的 `NOT VALID` 约束类型及验证锁 | 按目标 PostgreSQL 版本决定是否分成先约束新写入、再清理/验证旧数据，测试两个阶段的读写与违规拒绝，不能把未验证约束说成全表已满足 [M4] |
| 类型变化、表重写及隐式提交 | 查目标数据库/version 对具体 ALTER 的重写、空间、锁和事务保证 | 在代表性数据和长快照下验证。MySQL 某些 DDL 隐式提交，失败回滚不能恢复此前全部步骤，恢复按已发生的实际状态设计 [M4][M6] |
| JSON/JSONB 内部 schema | 查 JSON 内的键、类型、时间/金额单位和版本标记，追到所有解析方 | 用历史行、新行及中断后的混合数据检查转换，不因外层数据库列类型未改就跳过内部格式迁移 [M1] |
| 回滚后的读写兼容 | 查新版本已写出的字段/单位/状态与旧代码理解，核对信息丢失是否可逆 | 将新版本数据交给真实旧读器并执行必要写操作。`down` 脚本执行成功与业务数据可恢复分别验证，保留迁移退出条件 [M1] |

## 分页与集合完整性

| 涉及的机制 | 读取与追踪 | 验证及对实现的影响 |
|---|---|---|
| 空页仍有后续页 | 核对原始响应中的续页标记、扫描量、返回量和 SDK 分页器，查 `items` 为空或不足整页即结束的代码 | 构造首个读取页全被过滤、下一页仍有匹配项。按接口规定的续页标记判断结束。DynamoDB Query 的过滤发生在读取后，返回零项仍可能附带 `LastEvaluatedKey` [D1] |
| 排序相同的记录跨页 | 读取最终 SQL 和 ORM 生成查询，核对排序字段是否唯一、可空或会更新 | 让同时间戳或同分数记录跨过页边界，改变页大小并比较 ID 多重集合。需要稳定顺序时补足确定的排序依据。PostgreSQL 的 `LIMIT/OFFSET` 本身不提供唯一顺序 [D2] |
| 分页期间数据变化 | 核对接口是否承诺快照、游标有效期、过期响应及恢复语义 | 在页间增删改记录，检查漏项、重复和不同世代混合。Kubernetes `continue` 链提供一致快照，过期后的 `410 Gone` 需要按一致性要求重新列举。普通 cursor 与唯一排序各自不能证明跨页快照成立 [D3] |
| 续页地址与游标方向 | 读取原始 `nextLink`、`first/after`、`last/before` 和 `pageInfo`，追踪 URL 重建与嵌套连接状态 | 对服务端不透明 token 按契约传递，保留网络访问的信任边界。正向核对 `endCursor/hasNextPage`，反向核对 `startCursor/hasPreviousPage`。每个连接独立推进，测试零项、整页、末页与反向遍历 [D4][D5] |
| 空集、全 null 和顺序聚合 | 核对 `count(*)`、`count(column)`、`sum`、数组/JSON 聚合，以及聚合内的排序 | 分别输入零行、全 null 和混合值，检查映射到应用后的零值、null、空数组是否符合合同。有顺序语义的聚合明确其排序，外层排序不能代替聚合内部顺序 [D6] |
| 排除集合包含 null | 读取 `NOT IN` 子查询的可空性和真实数据 | 构造右侧含 null 且无相等项、左值也可能为 null 的情况，检查最终 WHERE 选择结果。按业务语义比较 `NOT EXISTS` 或显式过滤，保留需要的 null 行为 [D7] |
| map 遍历进入有序输出或任务调度 | 查遍历结果是否用于签名、快照、构建文件、优先级或当轮待处理集合 | Go map 的遍历顺序未指定，遍历中新增项可能被处理也可能跳过。需要稳定顺序或完整任务集合时，按该语言合同选择排序或显式队列，并验证遍历期间增删的行为 [D8] |

## 数值、文本与时间表示

| 涉及的机制 | 读取与追踪 | 验证及对实现的影响 |
|---|---|---|
| 大整数跨 JSON 与语言边界 | 对照数据库类型、JSON 原文、SDK 类型和实际消费值，查 ID/金额到普通浮点数的隐式转换 | 用 `2^53-1`、`2^53`、`2^53+1` 贯穿生产者和消费者，逐位比较往返结果。按合同选择精确数值或字符串表示 [D9] |
| JSON 重复键和成员顺序 | 保留原始字节，比较网关校验器、签名器和业务解析器的实际解释 | 输入同名字段的冲突值，检查校验值和执行值是否相同。解析后对象已丢失的信息不能用于证明原始报文没有重复键 [D9] |
| 字符串长度单位与截断 | 核对字节、UTF-16 代码单元、码点及数据库列限制，沿截断后编码和下游解析追踪 | 用非 BMP 字符跨越截断点，检查代理对是否被拆开。数值长度相等时仍核对实际编码后的完整性 [D9] |
| 超时使用墙上时钟 | 查 `now/time.time` 与 elapsed/deadline 运算，查单调时钟值是否被保存或跨进程比较 | 注入系统时钟前后跳变。持续时间使用平台支持的单调时钟差值，持久期限另外定义跨重启可恢复的时间语义 [D10] |
| 本地时刻、时区与夏令时 | 读取输入的 offset/zone、调度按当地日期还是 UTC 瞬间、`replace` 与实际时区换算 | 测试春季不存在的时刻、秋季重复时刻和 `fold`。需要换算时检查 `astimezone`，单纯 `replace(tzinfo=...)` 只改变标签。当地日程采用实际时区规则 [D11] |

为相关边界保留最小代表性样本和真实消费路径。表示、排序、快照和业务合同分别取得证据，再据此决定类型、查询、恢复和兼容处理。

## 一手依据

- [P1 Protobuf 语言与更新规则](https://protobuf.dev/programming-guides/proto3/)、[presence](https://protobuf.dev/programming-guides/field_presence/)：字段身份、未知字段、oneof 和默认值。
- [P2 RFC 7396 Merge Patch](https://www.rfc-editor.org/rfc/rfc7396.html#section-2)、[GraphQL Input Objects](https://spec.graphql.org/October2021/#sec-Input-Objects)：省略与 null。
- [P3 Confluent 字段变换修复 PR #4492](https://github.com/confluentinc/schema-registry/pull/4492)：反射转换改变未设置 message 的 presence。
- [P4 Avro schema resolution](https://avro.apache.org/docs/1.12.0/specification/#schema-resolution)：writer/reader 对照。
- [P5 OpenAPI 3.0.3 Schema Object](https://spec.openapis.org/oas/v3.0.3.html#schema-object)：默认值、required 与 nullable。
- [P6 AIP-180](https://google.aip.dev/180)、[GitHub API 版本](https://docs.github.com/en/rest/about-the-rest-api/api-versions)：公开 API 兼容与版本合同。
- [P7 Confluent Schema Registry 演进](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html)：方向、历史范围和部署次序。
- [P8 Stripe webhooks](https://docs.stripe.com/webhooks)：事件版本、重复与顺序。
- [M1 GitLab 避免迁移停机](https://docs.gitlab.com/development/database/avoiding_downtime_in_migrations/)：旧进程、默认值、JSON 格式与分阶段迁移。
- [M2 Stripe 在线迁移实践](https://stripe.com/blog/online-migrations)：双写、回填与切换。
- [M3 Transactional Outbox](https://microservices.io/patterns/data/transactional-outbox.html)、[Debezium Outbox](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)：本地事务与外部发布。
- [M4 PostgreSQL 18 ALTER TABLE](https://www.postgresql.org/docs/18/sql-altertable.html)：锁、重写及分阶段验证。
- [M5 PostgreSQL 18 CREATE INDEX](https://www.postgresql.org/docs/18/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY)：并发索引与失败残留。
- [M6 MySQL 8.4 隐式提交](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html)：DDL 事务边界。

- [D1 DynamoDB Query](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html)：过滤、扫描量、空页和续页 key。
- [D2 PostgreSQL LIMIT/OFFSET](https://www.postgresql.org/docs/18/queries-limit.html)：唯一排序与跳过行的计算。
- [D3 Kubernetes API 分块列表](https://kubernetes.io/docs/reference/using-api/api-concepts/#retrieving-large-results-sets-in-chunks)：快照、continue 与过期。
- [D4 OData 8 服务端分页](https://learn.microsoft.com/en-us/odata/webapi-8/fundamentals/server-driven-paging)：不透明 nextLink/token。
- [D5 GitHub GraphQL 分页](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)：游标方向和 pageInfo。
- [D6 PostgreSQL 聚合](https://www.postgresql.org/docs/18/functions-aggregate.html)：空集、null 与聚合顺序。
- [D7 PostgreSQL 子查询表达式](https://www.postgresql.org/docs/18/functions-subquery.html#FUNCTIONS-SUBQUERY-NOTIN)：三值逻辑。
- [D8 Go 规范 range](https://go.dev/ref/spec#For_statements)：map 遍历顺序和遍历中的修改。
- [D9 RFC 8259 §§4、6、8.2](https://www.rfc-editor.org/rfc/rfc8259.html)：JSON 互操作的成员、数值和字符串边界。
- [D10 Python time.monotonic](https://docs.python.org/3.14/library/time.html#time.monotonic)：时钟差值与未定义参考点。
- [D11 Python datetime](https://docs.python.org/3.14/library/datetime.html#datetime.datetime.astimezone)：fold、替换时区标签与换算。

表中的查法与验证输入为按来源行为形成的工程综合，平台特有保证仅在对应平台与版本成立。
