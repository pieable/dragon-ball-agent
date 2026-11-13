# 离线验证记录

- 环境：Windows，Node v26.5.0。
- 命令：`node --test *.offline.test.mjs`。
- TMP / TEMP / TMPDIR：均显式指定工作区的 `test-temp`。
- 结果：63 tests，63 pass，0 fail，0 skipped。
- 覆盖：fixture MCP stdio、任务路由和状态、App 配置模拟、原生命令边界、会话边界、日志、v3 worker 拒绝未核验调用、无本地绑定拒绝、wrapper 精确委托校验。
- 测试仅使用临时伪配置和伪 agentapi。未启动实际 App 或模型，未连接真实账号，未部署实际 MCP。

初次迁移测试发现一个旧 protocol fixture 未赋合成会话身份，随后改为独立合成绑定；新增回归测试修正了测试字符串转义后，完整套件通过。

## 私有绑定传播回归

完整套件现为 65 项通过，0 失败、0 跳过。新增实际 descriptor 启动 worker 的独立进程测试：伪 wrapper 仅指向临时复制的 Node，任务队列为空；worker 完成严格 wrapper 解析及合成 App 配置核对并发布 ready 心跳，未执行原生发送命令。篡改绑定文件后重新启动被 SHA 检查拒绝。另覆盖环境字段白名单、清除旧绑定、保留无关环境、符号链接拒绝。

首次边界测试发现 appProvider 的默认配置从 os.homedir 读取；该轮只读注册信息后退出。测试已将 USERPROFILE/HOME 指向独立 fixture，最终完整回归使用隔离配置。
