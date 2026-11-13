# Antigravity Gemini MCP

用户自有的 MCP / App agentapi 适配器。提供会话路由、任务与结果记录、项目工件访问以及原生 App 调用。代码按主仓库 MIT 许可提供；不包含 Google 的 App、可执行程序、SDK、账号状态或运行回执。

## 候选状态与依赖

这是公开迁移候选，不会自动注册、启动或修改现有 App。需要本机安装 Antigravity、可用的 App agentapi，以及支持 `node:sqlite` 的 Node（本次离线验证使用 Node 26.5.0）。App 配置排他写入目前依赖 Windows PowerShell/.NET，其他平台该分支拒绝执行。

`SOURCE.json` 列出原始模块与候选模块 SHA-256 及局部变更。原始运行目录保持不变。生产依赖只有 Node 内置模块和本目录模块。

## 本地绑定

新部署自行提供私有 bindings 与 App 配置路径；不要将真实项目标识、会话、目录、凭据或回执提交仓库。入口 `server.mjs` 接收本地 bindings 文件路径；注册与诊断可能访问或修改 App 配置，必须在有对应授权的部署步骤执行。未提供配置时原注册器会使用当前用户的 App 配置默认位置，因此不要用裸启动作为测试。

sidecar 适配器使用以下环境绑定。v3 worker也导入同一个agentapi适配器，因此wrapper/native路径绑定同样适用；旧协议另需固定项目、工作区和会话身份。它们没有内置个人默认值：

- `ANTIGRAVITY_REVIEWED_WRAPPER`、`ANTIGRAVITY_REVIEWED_NATIVE`：已经核对的 wrapper 与 native 文件完整路径；只接受原有精确两行静态 batch 委托格式，仍拒绝其他 shell wrapper 与符号链接。
- `ANTIGRAVITY_EXPECTED_PROJECT_ID`、`ANTIGRAVITY_EXPECTED_WORKSPACE`、`ANTIGRAVITY_CONVERSATION_ID`：明确指定的目标身份；元数据与请求仍须匹配。
- `ANTIGRAVITY_LEGACY_IDENTITY_DIGEST`：仅迁移已审核旧回执时提供其准确 SHA-256。默认不接受旧部署的无身份字段回执；新部署使用诊断生成的完整身份结果。

仅在 App 注入的受信 PATH 中使用原生 agentapi。公开代码不分发 `language_server.exe` 或重建厂商接口。`official-agentapi.mjs` 是此项目的适配器文件名，不代表厂商发布的库。

## 离线验证

先把 `TMP`、`TEMP`、`TMPDIR` 三者设为明确的独立测试目录，再执行 `npm test`。测试创建伪 App 配置、伪 agentapi 和临时会话，不使用真实账号，不调用真实 App；不要传入真实 sidecar 或生产 bindings。测试不提供端到端 App 可用性的结论。

本地生产配置、运行记录、旧 docs 中的个人现场及私有 README 均未迁入。实际接入由部署方提供绑定并独立验收。

部署缺口：当前registry生成的sidecar描述不会自动分发这些环境绑定，必须在真实App worker进程中验证它们可用，再验收wrapper解析与会话访问。只在启动MCP的shell里设置变量不等于App启动的worker也继承；缺失绑定时保留拒绝，不绕开检查。

## App worker 的绑定传播

`createRegistry({ localBindingsPath })` 或注册进程环境变量 `ANTIGRAVITY_LOCAL_BINDINGS_FILE` 指向私有 JSON。它只允许上文五个 wrapper/native/project/workspace/conversation 字段，至少提供两条已审核可执行路径，不接受凭据、`NODE_OPTIONS` 或其他任意环境变量。

registry 将文件路径与 SHA-256 写入 sidecar 的 `args`；worker 启动先检查普通非符号链接文件、哈希及字段，清除同名旧环境绑定，再加载适配器。argv 只有路径与摘要，不含绑定内容。绑定文件改变后旧 descriptor 拒绝启动，应先审查变更，再重新生成／处理 descriptor 冲突；不会自动覆盖现有登记。

此方式依据本机 `antigravity/builtin/skills/automation/SKILL.md` 记载的 `command` / `args` 接口。没有采用未经验证的 sidecar `env` 字段。独立进程测试通过实际生成的 descriptor 启动 worker、加载绑定并取得 `reviewed-app-wrapper` 心跳，无任务入队或模型调用。
