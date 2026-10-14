# 一次性Iterable与失败后的数据库残留

记录时点：2026-10-14。Issue于2026-10-11创建，致错代码最早引入日期未确认。

sqlite-utils的`enable_fts()`声明接受`Iterable[str]`，但构造全文检索表、填充索引及生成trigger重复使用同一输入。列表可以重复遍历；一次性iterator第一轮耗尽，后续SQL失败，已创建的FTS表仍留下，普通重试又遇到表已存在。

报告给出同一组列使用列表与iterator的对照，并说明FTS4/5及trigger组合。候选PR将输入一次物化并增加iterator测试；记录时尚未合入。Codex参与检查和运行复现，问题代码的模型来源未知。

用于辨明输入消费语义和失败后的副作用。当前候选仍需按自己的接口、操作顺序及证据判断。

来源：[issue #902](https://github.com/simonw/sqlite-utils/issues/902)、[候选PR #903](https://github.com/simonw/sqlite-utils/pull/903)。
