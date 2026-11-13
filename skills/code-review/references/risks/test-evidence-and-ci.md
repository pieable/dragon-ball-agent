# 测试、flaky 与 CI 证据

候选修改测试、fixture、skip/xfail、重试、CI 分配/缓存，或者用测试结果证明交付时，核对实际收集、执行和观察到的行为。必要的具体复现方法见[测试方法](../../../code-development/references/testing-methods.md)与[构建发布](../../../code-development/references/build-and-release.md)。

| 当前证据可能遗漏什么 | 审查动作与实际材料 | 判断依据 |
|---|---|---|
| 预期跟着实现一起改变 | 对照合同/历史故障与变更前后断言，查测试调用的是否仍是同一实现来生成 expected | 预期有独立来源，目标错误重现时测试会因正确原因失败 |
| 测试根本没有运行 | 查 discovery/collection、过滤、矩阵、分片、跳过/预期失败、命令退出及实际数量 | 零失败不能代替已执行。比对原有门槛和候选实际运行集合 |
| 只测新库或新数据 | 读取历史 fixture、旧 schema/客户端与升级入口，核对重启和存量数据用例 | 新状态成功不能关闭旧数据、迁移和回滚合同 |
| 替身吞掉真实边界错误 | 比对真实协议的分页、编码、返回码、唯一约束、事务、取消和部署配置 | fake 宽松行为不能证明数据库/HTTP/消费者兼容；按风险补经过实际边界的证据 |
| 异步结果没被等待 | 查 await/join/teardown、后台异常和成功标记，运行故障/取消路径 | handler 返回或测试进程退出前，合同要求的结果及失败已被观察 |
| flaky 被重跑或放宽掩盖 | 读取每次原始尝试、顺序/种子、worker、共享状态、时钟/浮点合同及修改理由 | 单跑、全套、串并行的差异用于定位隔离和时序。延长等待或放宽断言有具体原因并仍能发现目标错误 |
| CI 更快但覆盖或工作量减少 | 对照收集/断言、平台/feature、缓存命中、重试、错误、setup/网络及关键路径 | 相同交付结果下的耗时与资源变化才支持收益；有效测试被删或关键连接被替身替代时另查覆盖 |
| artifact 或缓存属于另一候选 | 检查提交、依赖 key、restore fallback、matrix 名称和最终发布者下载的包 | 安装/加载/验证的是同一候选，缓存旧输出与本轮执行状态可区分 |

缺陷报告指出漏检的具体输入/状态、为何现有断言仍通过、实际错误和相应生产合同。没有触及本次风险的测试形式偏好不阻塞交付。既定门槛、只读边界和候选新鲜度按 Skill 入口执行。

依据：[Google review Tests](https://google.github.io/eng-practices/review/reviewer/looking-for.html#tests)、[pytest flaky tests](https://docs.pytest.org/en/stable/explanation/flaky.html)、[Bazel remote cache](https://bazel.build/remote/caching)与所链接工程参考的一手来源。
