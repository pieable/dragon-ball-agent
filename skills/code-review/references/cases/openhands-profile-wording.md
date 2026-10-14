# 不同profile复用文案与已披露的取舍

记录时点：2026-10-14。原PR于10月11日合入，后续issue于10月13日创建。

OpenHands修复重复名称没有错误提示的问题时，给LLM和agent编辑器复用了Model Router的meta-profile文案。字段状态改善，但显示的对象名称不同。后续issue要求按profile类型分开文案，修复PR于10月13日合入并更新测试。

原PR有AI review批准记录，也在Notes中主动披露旧文案与后续增加key的取舍。因此可观察的是已披露差异进入合并，现有记录不足以判断此前没有识别。当前审查应另核合同负责人是否接受该取舍及其范围。

用于检查复用的对象语义，以及区分发现问题、接受取舍和交付结果。

来源：[原PR #18144](https://github.com/OpenHands/OpenHands/pull/18144)、[issue #18383](https://github.com/OpenHands/OpenHands/issues/18383)、[修复PR #18411](https://github.com/OpenHands/OpenHands/pull/18411)。
