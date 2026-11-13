# 候选收集工具

这些程序从原搜索来源注册表并入，辅助枚举与覆盖记录；研究者负责查询含义、候选充分性和采用判断。命令中的脚本路径相对本 Skill 根目录，运行时使用实际绝对路径；任务状态、游标和输出保存在项目内，不写入 Skill 目录。

## 代码与依赖候选

`python scripts/discover_code_candidates.py --query "<功能描述>" --ecosystem <生态> --output <json路径>`

支持 `github`、`python`、`npm`、`rust`、`go`、`nuget`，查询与生态可重复指定。程序保存许可证、维护和使用信号及入口覆盖状态；`source_queries_completed` 只表示查询完成。GitHub token 仅从 `GITHUB_TOKEN` 环境变量读取，无 token 使用公开接口限额。具体发现路径与 Python 生态限制见 [代码来源表](code-research.md)。

现有程序的 `--max-results` 默认 10、可设 1–50，`--enrich` 默认 5、可设 0–10；这些是收集程序的局部上限，不是研究停止条件。要求广覆盖或结果触及上限时，另用相应注册表/API 分页或继续检索，不以此程序单次输出声称列全。

## 半导体新闻候选

`python scripts/collect_candidates.py --since <带时区ISO时间> --until <带时区ISO时间> --output <json路径>`

默认读取 [sources.json](sources.json)，这是已有的半导体专题来源清单，不是通用资源表。时间窗为左闭右开；`candidates` 是待核验材料，`source_checks_completed` 和 `coverage` 只记录机械检查。`error`、`manual_required` 不算已检查，已检查也不表示候选已列全。

该清单随本次合并保留，条目状态并未在 2026-10-27 全部重新联网验证；用于当前任务前核对相关入口与时间覆盖，补查缺失来源。通用发现使用 [搜索资源表](search-resources.md)。

运行前可用 `--help` 检查实际参数，无需为普通使用先读全部源码。分页、返回条数和接口限额只表示本次程序覆盖，不能作为研究完整性的依据；发现截断或入口失败时继续适当分页、调整查询或转人工取证，并报告实际范围。
