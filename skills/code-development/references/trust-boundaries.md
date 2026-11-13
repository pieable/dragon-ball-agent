# 权限与信任边界的具体检查

变更接收身份、操作资源、跨租户共享、读取不受信内容或连接外部目标时使用。先记录主体、租户、资源、动作和执行副作用的权威位置，再沿实际入口核对。保留当前用途所需能力，根据具体信任边界选择检查和已有平台机制。

## 身份、资源与缓存

| 涉及的机制 | 从哪些材料查、怎样追踪 | 反例与验收观察 |
|---|---|---|
| 对象级授权 | 从 URL/body/GraphQL 参数、队列载荷追资源 ID 到实际查询和操作，查 UI/CLI/RPC/批量与后台入口、软删除对象和父子资源归属 | 同角色不同租户互换对象 ID，修改父 ID 但保留子 ID，分别读/改/删。核对实际记录和副作用，成功登录不能代替资源授权 [S1] |
| 属性级授权与批量绑定 | 比较请求 schema、DTO、ORM 自动绑定和响应序列化，列出允许读写的属性及内部字段 | 在合法请求中加入角色、owner、tenant、审批/删除状态等内部字段，再检查响应中的隐藏字段。对象可编辑与其中每项属性可改分别验证 [S2] |
| RLS 与数据库实际身份 | 查连接使用的数据库角色、owner/BYPASSRLS、`USING/WITH CHECK`、各命令的策略和多策略组合 | 用实际应用角色执行跨租户读写，分别检查 SELECT/INSERT/UPDATE/DELETE。PostgreSQL owner 通常绕过 RLS，permissive 策略默认 OR 合并，不能只看一条策略的过滤式 [S3] |
| 委托凭证与 JWT | 追“代谁行动”的主体从会话/受信 token 到下游，核对算法允许集、issuer、audience、令牌类型、时间与取钥来源 | 用合法签名但错误 iss/aud/type 的 token，以及跨租户或过期 token，检查接收方拒绝。`kid` 查询与 `jku/x5u` 取钥也按不受信输入和外部连接检查，不能仅验证签名成功 [S4] |
| 缓存隔离与撤权 | 列出应用、代理/CDN、权限判断和序列化缓存的真实 key、Vary、可缓存状态、TTL 与失效事件，查 tenant/主体/角色/资源版本如何进入 key | A 主体先写入带哨兵的响应，再由 B 用同 URL 读取，交换匿名/管理员顺序并撤权重放。记录命中头、实际 key 与响应。身份相关响应是否可共享与 Vary 是否匹配分别核对 [S5] |

## 路径、网络与解释器

| 涉及的机制 | 从哪些材料查、怎样追踪 | 反例与验收观察 |
|---|---|---|
| 文件系统实际对象 | 沿请求名到打开/创建/删除调用，区分展示名、存储键和实际路径。查绝对/跨卷路径、规范化、根约束、符号链接和检查后再次按名字打开 | 在隔离根内测试 `..`、相似前缀目录、指向根外的链接和检查后替换目标。使用平台已有根/目录句柄能力时核对其版本与边界，观察最终被操作的对象 [S6] |
| 归档成员改变后续路径 | 读取归档全部成员的路径、链接目标、设备类型、重复名称、权限和解压顺序，核对实际过滤器及默认版本 | 构造先建链接、后写同路径成员、绝对路径、根外链接和重复条目。在隔离目录观察最终落点与失败后的部分内容。Python tarfile 不同版本默认过滤器不同，按目标运行时确认 [S7] |
| 出站请求与 SSRF | 记录 URL 校验器、实际 HTTP 解析器、DNS、代理、连接目标、重定向、重试和回退路径，按业务要求明确允许的目标范围 | 用本地模拟服务测试 userinfo、反斜杠、编码、IPv4/IPv6、允许域到禁止地址的跳转和 DNS 回答变化。核对最终 socket 目的地以及 Host/SNI/证书校验，验证后再次解析需保持同一目标策略 [S8] |
| 不受信反序列化 | 追输入字节到 parser/loader、对象构造、类型标签与执行钩子，查 pickle、YAML 对象标签及可选自定义构造器 | 在隔离测试中输入未知标签和本应作为数据的类型指令，观察是否执行构造/导入或副作用。按接口数据合同选择现有受限解析能力，不能把格式名当作安全保证 [S9] |
| SQL/命令注入边界 | 区分 SQL 值、表/列/排序标识符及 shell 命令/参数，追模板、转义、预处理和最终执行 API | 用引号、分隔符、换行、选项前缀及排序字段输入检查实际执行参数。值参数化不能绑定标识符，shell 字符串插值不能由 JSON 转义代替，按业务允许值或结构化 API 实现 [S10] |
| 敏感诊断与日志注入 | 查请求/响应转储、异常、trace、重试和落盘材料的收集点、字段、接收方和留存，核对 token、Cookie、凭证与业务秘密 | 用标记凭证和带换行输入贯穿错误路径，检查日志/APM/临时文件。保留诊断所需关联信息和最小证据，避免原始认证材料进入额外系统 [S11] |

验证使用授权的隔离对象、测试账号和本地模拟目标，观察实际读取、写入与网络连接。框架版本、连接身份、中间件顺序和部署代理会改变边界，沿当前项目核实后再决定实现。专项审计范围仍由用户任务与实际风险确定。

## 一手依据

- [S1 OWASP API1 对象级授权](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/)。
- [S2 OWASP API3 属性级授权](https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/)。
- [S3 PostgreSQL 行安全策略](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)。
- [S4 RFC 8725 JWT 最佳实践](https://www.rfc-editor.org/rfc/rfc8725.html)、[RFC 8707 resource indicators](https://www.rfc-editor.org/rfc/rfc8707.html)：验证上下文与受众。
- [S5 RFC 9111 §§3.5、4.1](https://www.rfc-editor.org/rfc/rfc9111.html)：认证请求、共享缓存和 Vary。应用自有缓存的 key/失效检查是按同一隔离职责形成的工程综合。
- [S6 Go filepath.IsLocal](https://pkg.go.dev/path/filepath#IsLocal)、[os.Root](https://pkg.go.dev/os#Root)、[CWE-367](https://cwe.mitre.org/data/definitions/367.html)：词法路径、实际解析和 TOCTOU。
- [S7 Python tarfile 过滤器](https://docs.python.org/3/library/tarfile.html#tarfile-extraction-filter)：成员顺序、链接、过滤器及版本边界。
- [S8 OWASP SSRF 防护](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)、[WHATWG URL](https://url.spec.whatwg.org/#concept-basic-url-parser)：解析、重定向与连接目标。
- [S9 Python pickle](https://docs.python.org/3/library/pickle.html)、[PyYAML safe_load](https://pyyaml.org/wiki/PyYAMLDocumentation)：解析与对象构造能力。
- [S10 OWASP SQL 注入防护](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html)、[命令注入防护](https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html)。
- [S11 OWASP 日志指导](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)：收集内容、排除秘密与日志注入。
