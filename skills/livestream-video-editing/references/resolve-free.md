# 达芬奇免费版的实测入口

2026-09-12，在 Windows 的 DaVinci Resolve 21.1.0.14 免费版完成基础接口试验。后续版本以安装目录内的 `Support/Developer/Scripting/README.md` 和 `DaVinciResolveScript.pyi`、以及实际返回为准。

## 原生控制台

通过 Workspace > Console（本机快捷键 F6）使用 Lua。`print(resolve:GetVersionString())` 可检查对象是否有效。免费版内置控制台实测可执行导入、时间线编排、属性调整、DRP 导出与 H.264 渲染；这不证明外部脚本连接或所有 Studio API 可用。

脚本只调用任务需要的 Resolve API。以英文绝对路径存放用于 `dofile` 的脚本；本机 Lua 的 `dofile` 无法直接读取中文路径，但 Resolve 的媒体导入、DRP 和 MP4 导出均已在中文目录成功。保留源码在项目内，英文路径只作执行副本。

用 Windows Computer Use 技能定位实际窗口、控制台和输入框。执行脚本导致项目或页面切换后，重新观察并点击输入框再输入下一条命令；旧焦点信息可能仍显示“编辑”却不能证明命令已提交。输出没有新命令时先看输入文字，不能重跑创建工程的脚本。

## 帧与轨道

在新工程中先设置帧率和画布，再创建时间线。`AppendToTimeline` 指定 `mediaType`（1 画面、2 音频）、`trackIndex` 和 `recordFrame`。源 `endFrame` 在本机实测为不包含结束帧：30 fps 的 35 秒素材使用 `[0,1050)`；拆成 `[0,450)` 与 `[450,1050)`，记录位置分别为时间线起点与起点加 450。

调用后读取每个片段的 `GetStart()`、`GetEnd()`，核对连续性；不要只从 API 参数推定长度。三条音轨均应与对应画面同一时间基准。`TimelineItem:SetProperty('AudioVolume', -6)` 实测可将某个配乐片段降低 6 dB，读取属性确认，并检查导出声音。

工程的播放帧率需另行检查。本机脚本把时间线设置为30 fps后，Playback frame rate仍保留24；该接口属性在文档中为只读，通过Project Settings > Master Settings修改为30并保存。不能用时间线帧率推定预览帧率。

缓存目录应选择存在且可写的目录。本机脚本设置`perfCacheClipsLocation`返回成功，Project Settings > Master Settings > Working Folders也能显示输入的Windows绝对路径，但两种方式保存重开后均变回相对路径`CacheClip`。D盘缓存持久化仍待解决；它未阻止35秒样片导出。不要照抄设置后宣称成功，需重新检查实际路径和重开状态。

## 导出与重开

先读取 `GetRenderCodecs('mp4')`。本机 `SetCurrentRenderFormatAndCodec('mp4','H264')`、`SetCurrentRenderMode(1)` 可用。设置输出目录、文件名、画布、帧率、视频/音频启用、AAC 和 48000 Hz 后提交任务。

本机 `SetRenderSettings` 的 `VideoQuality` 数值和 `High` 均返回 false；省略该项、使用默认编码质量后成功。不要写死这些失败参数。接口拒绝字典时逐项定位，避免把参数失败判断成整个免费版无法导出。

保留 `AddRenderJob()` 返回的任务 ID，调用 `StartRendering({id})` 后检查 `GetRenderJobStatus(id)` 到 Complete，再解码真实输出。不要清空整个渲染队列。

`SaveProject` 和 `ExportProject` 成功后，还需把 DRP 导入独立测试项目、加载、修改一个已知属性、保存关闭并重开核对。只修改此次测试项目，验证结束恢复该属性。DRP 依赖原素材路径，不等于包含素材的归档。

实测样片：1280×800、30 fps、35 秒、两段画面、三条音轨、配乐 -6 dB。软件报告渲染 6.3 秒；完整解码 1050 帧，导出音频与预期混音相关度 0.99998。此证据不外推到长录播、4K、重特效、语音分离质量或所有免费功能。
