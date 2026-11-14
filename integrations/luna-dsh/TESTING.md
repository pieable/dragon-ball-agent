# Luna 增量回收验证

来源：现役自有组件提交 `17fba9f`，候选保留机器路径绑定与 MIT/npm 官方源改动，逐文件实际源字节、Git blob、公开候选哈希见 SOURCE.json。未修改现役源码或安装配置。

## 原生本地模拟

`npm run test:native` 成功退出。使用已安装 DSH runtime，通过显式 `LUNA_DSH_EXECUTABLE` 选择；专用临时 profile、合成 Codex home 和角色原件、本机 `127.0.0.1` Responses 服务。37 次模拟请求，无付费 API。

覆盖全局与项目指令、Skill 发现、四角色原件与权限、实际文件读取和写入／只读拒绝、Code Executor 四子任务并行、父层审查任务回传、同一会话 effort 切换、消息去重、取消、关闭和恢复。

## 单元与工作流

`npm test` 包含本地状态与传输、角色读取、effort 选择、计量搜索模拟、worktree 基线／增删／冲突／回滚测试；TEMP/TMP/TMPDIR 指向工作区测试目录。首次未给非标准 DSH 安装位置，60 项通过，1 项缺 runtime 绑定；补充明确绑定后重跑完整套件。重跑结果：61 项全部通过，0 失败，0 跳过，退出码 0。

本轮没有运行现场 API、ACL 更改脚本、安装器或现役切换。工作区和模拟日志保留本地，不随公开源码发布。
