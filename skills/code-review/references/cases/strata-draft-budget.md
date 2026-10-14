# 词表数据扩张后挤占显存保留空间

记录时点：2026-10-14。数据提交于2026-09-29，issue于9月30日创建。

Strata扩大draft词表后，较大的head在专家缓存定额之后分配，额外占用原先保留的显存。报告者给出同机、同配置替换draft的A/B：16GB加vision场景空余显存由336MiB降到156MiB，进入程序自己的低余量警告区间。

维护者确认缓存先定额、head后分配的次序，修复把head预估占用计入reserve，并发布0.1.28。数据提交与修复提交记录Claude Opus 5.5共同署名及会话链接；旧预算逻辑来源和此前review未知。

用于检查数据、配置或模型产物变更对共存资源及分配次序的影响，预算值仍取当前项目的有效合同。

来源：[issue #199](https://github.com/Niko1221/Strata/issues/199)、[数据提交](https://github.com/Niko1221/Strata/commit/6e153c96deef2e8de53db89db42f37979afd163b)、[修复提交](https://github.com/Niko1221/Strata/commit/b981f63)、[发行0.1.28](https://github.com/Niko1221/Strata/releases/tag/v0.1.28)。
