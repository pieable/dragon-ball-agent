# 构建、预览与恢复

需要 Python 3.11 或更新版本，无第三方 Python 依赖。所有命令在仓库根目录执行；候选、测试和私有安装状态放在明确允许的工作目录，不能与源仓库或目标配置重叠。

## 构建候选

```sh
python tools/build_harness.py codex --output /work/candidate-codex --target-home /actual/codex-home
python tools/build_harness.py claude-code --output /work/candidate-claude --target-home /actual/.claude
python tools/build_harness.py deepseek-harness --output /work/candidate-dsh --target-home /actual/.dsh
python tools/build_harness.py antigravity --output /work/candidate-agy --target-home /actual/.gemini/config
```

Windows 可使用完整盘符路径，包含空格时加引号。输出目录必须不存在。构建不会创建或改动目标目录；路径渲染绑定指定目标，换机器或目标目录后重新构建。

## 安装已验证的组件

不带 `--components` 的命令继续生成完整检查候选，不可直接安装。明确选择组件后，构建器依据当前原生加载验证范围生成子集：

| 宿主 | 当前可安装组件 | 尚未开放 |
| --- | --- | --- |
| Codex | `rules skills` | 原生角色及其生命周期 |
| DeepSeek Harness | `skills` | 根规则、角色与 preset 语义 |
| Claude Code | 暂无 | 已证明插件探针发现 18 个 Skills，尚未证明这里的全局加载入口 |
| Antigravity | 暂无 | 隔离加载器仍受 OAuth 前置条件阻塞 |

```sh
python tools/build_harness.py codex --components rules skills --mode fresh --output /work/candidate-codex --target-home /actual/codex-home
python tools/build_harness.py deepseek-harness --components skills --mode migrate --output /work/candidate-dsh --target-home /actual/.dsh
```

`fresh` 用于新装，不要求原维护者的个人文件。`migrate` 用于已有环境，在预览中列出须原样保留的本地差异文件；缺少它们不阻止其他独立组件安装。两种模式均将语义未定的差异 Skill 整组排除，清单 `excluded_skill_groups` 明确列出，避免安装缺入口的碎片。当前 DSH 排除 5 组，Claude 排除公司研究组。被排除的目录与其他不在清单中的文件不会被删除或覆盖。私有依赖仅随对应已选择的 Skill 输出；必需依赖缺失仍阻止安装。

选择中含未验证组件，整个选择仍只生成预览候选；先缩小选择，不手改 `deployment_ready`。同步器也核对组件验证范围。验证证据与宿主加载边界见 [验证记录](docs/SYNC-VERIFICATION.md)。组件可安装表示该范围能够独立部署，不表示整个体系已经迁移完成。

## 查看差异

```sh
python tools/sync_engine.py --source /work/candidate-codex --target /actual/codex-home --state /private/sync-state --manifest /work/candidate-codex/candidate-manifest.json
```

未加动作参数就是只读预览。`new/update/unchanged` 表示候选变化；`local-change/local-deletion/conflict` 保留本地状态。首次接管不同内容也算冲突。报告同时列出保留的宿主文件与本地材料是否存在，路径存在不代表材料已经加载或内容完整。

完整候选保持 `deployment_ready: false`；显式选择已验证组件的子集可安装。候选不覆盖权限、安全设置、MCP、账号或其他 preset。

## 安装事务和回滚

已选择的可安装子集使用同一预览命令加 `--apply`。同步器先检查全部路径、哈希、冲突和必需本地依赖，然后保存备份与日志，原子替换托管文件。任何冲突阻止整批写入；用户删除过的文件不擅自补回。状态目录保留敏感的安装前字节，不提交到 Git。

```sh
python tools/sync_engine.py --target /actual/codex-home --state /private/sync-state --inspect TRANSACTION_ID
python tools/sync_engine.py --target /actual/codex-home --state /private/sync-state --rollback TRANSACTION_ID
```

中断后先 inspect，再显式回滚。安装后又有本地修改时，回滚拒绝覆盖。源、目标与状态目录不支持符号链接或 Windows junction，以免写入超出检查对象。

## 首次接管与私有差异回收

已有同名文件与候选不一致时，先预览，再生成接管计划：

```sh
python tools/sync_engine.py --source /work/candidate-codex --target /actual/codex-home --state /private/sync-state --manifest /work/candidate-codex/candidate-manifest.json --prepare-adoption > /private/adoption.json
```

PowerShell 5 请用 `| Out-File -Encoding utf8 /private/adoption.json` 代替 `>`。计划含私有文件名与哈希，保存在私有目录。只修改各项 `decision`，其余证据字段保持不动：

- `preserve`：保留本地文件，不接管，移除该项旧托管基线。
- `export`：同样保留本地文件，并把现有字节复制到此次私有事务的 `local-exports/`，便于人工比较、回收至核心源或宿主适配层。该副本不自动进入公共仓库。
- `adopt`：仅用于尚无托管基线的首次接管；确认候选已包含要保留的有效规则后，采用候选，先备份原字节。已有托管文件的双向冲突先导出、合并并重新构建，不用该选项强压覆盖。

所有 `unresolved` 必须处理。执行必须明确给出 `--apply` 和计划：

```sh
python tools/sync_engine.py --source /work/candidate-codex --target /actual/codex-home --state /private/sync-state --manifest /work/candidate-codex/candidate-manifest.json --apply --adoption-plan /private/adoption.json
```

计划绑定目标、完整候选清单、候选字节、本地字节与原托管基线；任一变化都会拒绝使用旧计划。重新生成、重新审核，不修改哈希来绕过检查。`preserve/export` 不记录虚假的“已安装”状态，后续包含这些同名差异的同步仍会提示冲突。需要持续不托管时，从下一次构建范围排除对应组件；需要回收时，审查导出内容、更新权威源、重建，再生成新的首次接管计划。

接管与普通更新共用事务、备份、inspect 和 rollback。输出的 transaction ID 对应私有备份目录；恢复会还原原本地字节与原状态。原文件随后被用户修改时，回滚拒绝覆盖。不要把 `installed.json` 手工伪造成已有基线。

## 运行测试

先把 `TEMP`、`TMP`、`TMPDIR` 指向获准的测试目录，然后执行：

```sh
python -m unittest discover -s tools -p 'test_*.py'
```

测试在临时子目录模拟部署和故障，不调用模型、不启动 MCP。完成文件测试后仍需通过目标宿主的真实入口验证 Skill 发现、角色权限、工具调用与上下文行为。

## 私人材料

[Skill 分层](docs/SKILL-LAYERS.md) 列出公开白名单、条件依赖和许可。已有私人索引与候选不同会触发冲突，保留原索引后由维护者合并；不得用模板替换私人档案。外部工具安装、模型路由和凭据绑定与文件同步分开处理。

发布前在已提交版本运行 `python tools/check_release.py` 核对Git导出字节，再在干净导出副本执行完整测试。仓库.gitattributes保留源文件原始换行，不能单独格式化受哈希保护的文件而不更新审查清单。
