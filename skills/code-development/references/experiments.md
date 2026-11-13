# 实验与结果归因

开始实验前，明确本步要回答的问题、真实路径或代表性数据、支持继续与触发调整的判据，以及与最终系统的差异。实验减少会改变下一步的未知，取得反馈后再决定扩大、调整、补证据或换路。

为实验选择可比较、可归因的验收单位。确定性行为使用可重放的隔离样本。随机性、并发时序、统计噪声、不可逆状态或受限外部服务使用与故障模型相称的受控工作负载、状态和版本记录、隔离环境、观测计划与判据，说明证据和真实条件的差异。

解释结果前，按会影响结果归因的因素核实实际运行环境，例如加载的工作目录或提交、未提交差异、持久化配置、构建产物、服务实例和外部依赖。结果不能归因于当前修改时，先修正环境。

确定性流程沿实际路径找到输入、状态或输出首次偏离预期的步骤。并发、性能或概率行为按预先声明的观测单位、覆盖窗口、不变量或阈值判断，不把单次轨迹当成结构性故障。统计重复或参数搜索按实验设计推进，不连续猜数字。验收工具应区分成功、明确失败、无变化、跳过等合法终态，不能把合法终态误判为无限等待。

昂贵调用本身不是停止理由。计划内的必要重复继续完成。完成约定观测后核心结果仍未成立时，交回已成立的证据、首个未成立结果、关键未知和路线假设，判断下一次实验能否改变决定。下一步不能推进结果或原因判断时停止当前循环，回到路线选择。

## 解释测量数字

报告或依据性能、吞吐和资源数字作决定前，确认测量完成了预期工作。记录输入规模、实际完成量、错误和跳过数，检查缓存、未执行路径、双方配置差异、测量工具自身开销及随机波动是否能解释差异。保留可复现命令、运行次数和结果分布，重复次数由噪声与所需判断精度决定。

用运行时剖析或系统计数器定位限制结果的资源或代码路径，再映射到实现。追问“为什么结果没有更好”，通过观测核对瓶颈。尚未定位限制因素时，将已测结果与原因未知分开，不把代码阅读中的猜测写成性能原因。

把局部收益放回完整用户路径核对。若声称节省的时间超过被改部分原有耗时，或吞吐增加伴随实际工作量减少，先查明测量差异再认定收益。

## 持续优化一个指标

用户要求持续改善可测量结果时，先选能重现其问题的实际工作负载，明确指标、改善方向、必须保持的行为和已约定的停止条件。用有实质差异的工作负载检查测量入口是否能区分结果，再固定比较用的命令、数据与配置。记录修改前基线和回归检查结果。测量方法确需改变时，重新测量基线后再比较。

每次提出一个具体机制假设，说明预期改变哪段工作及为何影响指标。保持其他条件可比，修改后运行同一测量和回归检查。改善超过噪声且行为保持时保留；无效或破坏要求的尝试撤销本次改动，保留用户及其他工作已有内容。每次记录假设、改动、前后结果、回归结果及去留依据，再开始下一次。

停滞时检查测量、共同前提和尚未尝试的不同机制，依据新证据调整探索方向。按已约定目标、投入及剩余假设的价值决定继续或结束，不擅自增加最低迭代次数，也不放宽指标或回归要求来取得通过。

## 按具体资源机制采集证据

| 变化或症状 | 观察什么、从哪里查 | 怎样区分原因并决定下一步 |
|---|---|---|
| 扇出、循环和重复求值 | trace 中每次操作的子调用数、循环次数、重试、cache hit，以及 CPU profile 的自身/含子调用耗时 | 对照相同输入和并发，核对父调用是否展开到全部功能、规则或服务，避免把嵌套成本重复求和。尾延迟与平均耗时分开看 [E1] |
| 排队与吞吐下降 | 读取到达率、完成率、队列长度/等待、在途数、拒绝与过期工作，而非只看 worker 数 | 增大实际并发观察饱和点和积压。无界队列可能让 Java ThreadPoolExecutor 的 maximumPoolSize 不生效，容量或背压按已确认需求和测量决定 [E2] |
| 连接池与端口 | 对照 pool checkout/wait/overflow/timeout、服务端活跃连接、连接建立和 DNS | 池变大可能增加争用。分别测试响应 body 未读完/未关闭、频繁创建客户端和长连接旧 DNS，观察下一次请求是否能复用或取得连接 [E3] |
| 文件描述符或生命周期泄漏 | 对照重复成功、报错、取消与初始化中断后的句柄、socket、子进程和连接占用 | 在同一长生命周期实例反复执行，确认占用随任务结束回落；查 EMFILE 等具体失败，不以一次成功代替无累积泄漏 [E4] |
| 事件循环阻塞与背压失效 | 查同步 I/O、CPU 密集处理、正则回溯、stream `write()` 返回值和缓冲增长 | 用实际规模及拒绝边界输入测 event-loop lag、内存和并发请求响应。Node stream 在 `write=false` 后需按其合同等待 drain 或使用已有 pipeline [E5] |
| 消费超时触发额外工作 | 查批处理时间、poll/heartbeat、分区接管与重复消息，结合重试次数 | Kafka 超过 max.poll.interval 可能被视为失败并 rebalance，按真实处理周期验证接管和重复，区分原始负载与恢复放大 [E6] |
| 数据规模触发慢操作 | 查 SQL plan/扫描行、每项查询、全量 Redis 命令、模糊匹配和近似失败输入 | 改变规模与重复度，比较实际完成量和最坏路径。Redis KEYS 是 O(N)，按实际键空间和一致性需要比较已有替代方式 [E7] |
| 容器退出、内存与恢复 | 查容器事件、OOMKilled、实际 RSS/峰值、limit/request、临时副本和缓存同时存活量 | 区分程序分配、容器限制和节点压力，在约定资源下验证恢复。内存、CPU、I/O、网络、存储和云计费分别记录 [E8] |
| 冷启动或故障恢复慢 | 读取冷缓存、首次加载、索引/状态恢复和启动依赖的阶段耗时 | 从真实冷态或可恢复副本执行，确认热态优化没有让重新启动依赖不可用或工作量激增；恢复目标由实际用途决定 |

这些观测按具体疑点采集，先复用现有 telemetry/profile。测量窗口、数据规模和并发条件需要能回答当前判断，监测本身的开销与采样/聚合盲区也纳入解释。

- [E1 Google The Tail at Scale](https://research.google/pubs/the-tail-at-scale/)。
- [E2 Google SRE cascading failures](https://sre.google/sre-book/addressing-cascading-failures/)、[Java ThreadPoolExecutor](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html)。
- [E3 SQLAlchemy pooling](https://docs.sqlalchemy.org/en/20/core/pooling.html)、[Go HTTP Client.Do](https://pkg.go.dev/net/http#Client.Do)、[.NET HttpClient](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/http/httpclient-guidelines)。
- [E4 Linux getrlimit](https://man7.org/linux/man-pages/man2/getrlimit.2.html)：描述符上限。
- [E5 Node event loop](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)、[stream buffering](https://nodejs.org/api/stream.html#buffering)、[Cloudflare 回溯正则事故](https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/)。
- [E6 Kafka consumer configuration](https://kafka.apache.org/documentation/#consumerconfigs)。
- [E7 Redis KEYS](https://redis.io/docs/latest/commands/keys/)。
- [E8 Kubernetes container memory](https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/)。

## 来源

- [pstack：Explain the Number](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-explain-the-number/SKILL.md) — 测量量、瓶颈和替代解释核对。
- [pstack：Hillclimb](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/playbooks/hillclimb.md) — 固定比较工具、单个机制假设及按证据取舍；轮数与停止条件沿用本任务约定。
