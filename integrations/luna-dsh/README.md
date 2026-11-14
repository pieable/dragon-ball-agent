# Luna 执行层候选

通过 MCP 把独立任务交给 DeepSeek Harness 中的 Luna API agent。这里承接已经过评审的自有插件源码，来源提交及逐文件哈希见 `SOURCE.json`。

## 源与运行的关系

此目录是统一仓库中的待切换源候选。现役执行层仍使用原项目，当前没有搬迁进程、配置、凭据或状态。正式接管时需要比较现役源码、停止旧host、更新本机启动路径及profile包链接，验证握手和恢复，再把维护入口切到本目录；不能让两份代码长期同时维护。

## 组件

- `mcp.mjs`：MCP入口，包含创建、消息、状态、等待、中断与关闭。
- `plugin.mjs`、`plugin-state.mjs`、`plugin-transport.mjs`：真实DSH上下文、任务状态与本地传输。
- `host-launcher.mjs`：专用profile的单实例生命周期与重连。
- `plugin.patch.yml`、`luna.patch.yml`：专用执行profile和API路由。不能应用到用户的一般DSH profile。

## 本机绑定

需要兼容的DSH runtime、Node.js、`LUNA_OPENAI_API_KEY`。自定义DSH安装位置通过 `LUNA_DSH_EXECUTABLE` 指定；标准安装位置可自动发现。密钥由本机环境或私有启动包装提供，不写入仓库、配置片段或测试结果。模型标识及思考深度沿当前候选，不通过安装器替用户切换模型或购买额度。

包依赖用 `npm ci --ignore-scripts` 安装。此操作不启动执行层。显式运行 `node mcp.mjs` 后，实际任务会使用API；不要把它当作离线检查命令。

## 离线验证

设置 TEMP/TMP/TMPDIR 到允许的测试目录后，`npm test` 使用人工fixture验证状态、传输与启动器。`npm run test:native` 使用已安装DSH和本地模拟Responses服务，测试中覆盖API路由，不读取真实密钥、不调用付费API。自定义安装先设置 `LUNA_DSH_EXECUTABLE`。

不包含本机安装回执、旧配置备份、运行日志或现场注册脚本。变更真实Codex配置属于单独部署步骤，不能只复制当前运行回执。

## 许可

自有包装和插件代码随主仓库采用MIT。npm依赖 `@modelcontextprotocol/sdk` 和 `zod` 各自采用MIT，其许可随npm包提供；DSH宿主程序不包含在此仓库。`SOURCE.json`标记公开候选相对现役源码的路径可移植性改动。

Windows可用 `installation/Start-LunaMcp.py` 从当前用户环境注册表读取密钥并只传给子进程，脚本不会把密钥写入仓库。其 `--verify-live` 是显式付费API验收入口，默认不运行，不能用于离线测试。

## 角色、协作与思考深度

角色提示词不在此插件复制。`DSH_AGENTS_HOME` 指向由主仓库 Codex adapter 部署的本地 Codex home，`role-catalog.mjs` 读取其 `config.toml` 的角色注册与对应角色文件，逐次保留原件路径和哈希。需要 Python 3.11+（标准库 `tomllib`）。Worker、Explorer、Code Executor、Web Researcher 四类使用 Luna；Default、Content Designer、Visual Usability Tester 保留 Codex。缺少原件、错误模型或无效 effort 明确报错，不自行改角色规则。

Code Executor 可派发受归属和权限约束的子任务；reviewer 与视觉验收请求由 Codex 父层接收、执行后回传，插件不会声称已经启动这些 Codex 任务。`list_roles` 可读当前角色原件；这一步不调用模型。

`spawn_agent`、`send_message` 支持 `reasoning_effort`；`set_reasoning_effort` 保持同一会话与权限、不唤醒 agent，从下一次模型请求生效，在途请求不变。允许 off/low/medium/high/xhigh/max，Codex 原件的 none 对应 off。角色默认值仍来自部署原件。

专用 profile 的新会话使用 openai provider；旧 luna-api 会话保留其路由。Web Researcher 的 hosted search 是单独 OpenAI API 请求，记录请求与工具使用量；运行会计费，离线测试使用模拟响应。

## 可选 worktree 工作流

默认关闭。显式开启 `LUNA_ENABLE_WORKTREE_WORKFLOW=1` 时，同时指定 `LUNA_WORKTREE_ALLOWED_ROOT` 和 `LUNA_WORKTREE_STATE_DIR` 为本机授权目录。MCP 默认 13 项工具，开启后 20 项。工作流建立独立 Git worktree，记录原始字节基线、选择性导入、结果核对、回写与回滚；遇到源变化或冲突即停止。它不会修改 ACL，也不会把父仓库未提交内容假定为 HEAD。

保持 `.luna-worktree-jobs`、`.bridge-state`、`.runtime-home`、测试证据及私有绑定在 Git 之外。Windows DSH 沙箱权限由部署方针对具体工作目录处理，安装此候选不授权修改权限。
