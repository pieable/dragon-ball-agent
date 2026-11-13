# 工具集成与本地绑定

`catalog.json` 是集成目录，不是宿主配置。自有工具源码经许可、依赖及隐私检查后在这里或独立上游维护一份；适配器保存装配方式。运行路径、浏览器会话、模型路由、凭据、宿主注入的环境与权限留在本机。

当前 FastCtx、Playwright Chrome、Chrome DevTools 保留原安装。`node_repl` 依赖宿主分发的程序、受信服务和动态环境，不复制安装目录、不转成通用插件。Antigravity 会话 MCP 候选已分离身份绑定并导入 `antigravity-gemini/`；Luna 执行层公开候选已导入 `luna-dsh/`，来源版本和公开变更有逐文件校验。现役源未切换，不把候选当成第二维护入口。

## 检查现有配置

```sh
python tools/integration_inventory.py codex --config /path/to/codex/config.toml
python tools/integration_inventory.py claude-code --config /path/to/.claude.json
python tools/integration_inventory.py antigravity --config /path/to/config/mcp_config.json
```

输出只含目录内工具标识、传输类型、显式停用状态与配置存在情况，不输出命令、参数、URL、环境变量名称和值、请求头或未知项目名称。它不写配置、不启动服务、不发起模型请求。一个配置文件未列出某工具，不代表宿主通过插件或项目配置加载的工具不存在。

DSH 经 profile / Cordis plugin 组装工具，尚未映射其完整装配入口，工具不会套用其他宿主的 JSON 结构读取它。

## 接入约定

通用目录记录工具目的和审查过的来源版本。每个宿主的启动字段、变量机制、传输协议、权限与加载作用域分别验证。转换配置不能激活已停用服务、扩大允许工具列表或替换原安全设置。新增服务先形成配置片段与差异，凭据通过本机绑定进入，不写入 Git；现有配置不同的同名项视为冲突，不以公共示例覆盖。

同步器只处理候选白名单中的文件。当前目录不含可自动部署的 MCP 配置；原有可用连接继续由其宿主管理。

Luna四个角色（Worker、Explorer、Code Executor、Web Researcher）待逐项适配验证；Default、Content Designer和视觉检查角色继续留在Codex，原角色不删除。通用执行层验收不替代角色履职验收，映射见 `adapters/deepseek-harness/luna-role-plan.json`。
