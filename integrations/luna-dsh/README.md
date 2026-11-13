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
