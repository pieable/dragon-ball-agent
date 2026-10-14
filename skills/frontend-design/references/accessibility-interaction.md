# 可访问性交互

新增或重塑界面时，按实际平台和操作方式检查键盘、焦点、放大、指针替代及动态状态。对比度、控件目标尺寸、通用状态清单和成品检查沿用[视觉质量与具体检查](visual-quality.md)及[界面设计交接](design-handoff.md)；本文件补充需要结合流程判断的行为。

判断合规时以适用标准的规范正文为准：[WCAG 2.2](https://www.w3.org/TR/WCAG22/)中的成功准则规定符合性条件；[Understanding 文档](https://www.w3.org/WAI/WCAG22/Understanding/)解释意图和例外；[ARIA Authoring Practices Guide（APG）](https://www.w3.org/WAI/ARIA/apg/)给出模式实现建议，不是 WCAG 条款；[COGA 补充指导](https://www.w3.org/WAI/WCAG2/supplemental/)帮助处理认知和学习需要，也不定义 WCAG 符合性。记录采用的标准、版本、级别与应用范围；AA 和 AAA 的要求分别核对。

## 键盘路径、焦点与对话框

用 Tab 和 Shift+Tab 沿有意义的顺序操作全部控件，检查动态插入内容是否位于合理的继续位置。焦点顺序无需复刻像素布局，但不能使用户误解页面关系或操作顺序。焦点进入固定栏、浮层或面板附近时，确保焦点控件至少部分可见；WCAG 2.2 AA 的 SC 2.4.11 要求“不被完全遮挡”，AAA 的 SC 2.4.12 要求完全不遮挡。适用条件见[SC 2.4.11](https://www.w3.org/TR/WCAG22/#focus-not-obscured-minimum)与[SC 2.4.12](https://www.w3.org/TR/WCAG22/#focus-not-obscured-enhanced)。

模态对话框开启后将焦点移入，并使 Tab 与 Shift+Tab 留在对话框内；Escape 和可见关闭控件应能关闭它，关闭后焦点返回触发控件，或转到合乎后续任务逻辑的位置。初始焦点由内容和任务决定：长内容或含标题、列表、表格等结构时，先聚焦标题或开头的静态元素（需要时用 `tabindex="-1"` 让它可程序化聚焦），避免正文开头被滚出视野；不可逆操作可将初始焦点放在较安全的选择上。只有背景确实不能操作且视觉上被遮蔽时才将对话框标为模态。[WAI-ARIA APG 模态对话框模式](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)是非规范交互指导；不要把这套焦点循环强加给非模态面板。

## 放大、回流与文字覆盖

检查文字放大到 200% 时内容和功能仍可用（WCAG 2.2 AA，[SC 1.4.4](https://www.w3.org/TR/WCAG22/#resize-text)）。回流按 [视觉质量](visual-quality.md) 中的适用条件检查，真正需要二维布局的地图、数据表、代码或图表可以保留局部二维滚动，页面其他内容继续回流。

文字间距的覆盖值、适用范围与来源集中在 [视觉质量](visual-quality.md)。实际覆盖标题、表单、按钮和长标签，核实裁切、重叠、滚动和操作结果，确保用户改变排版后仍能完成流程。

## 拖动、触控与键盘替代路径

拖动操作还要提供无需拖动即可完成同一结果的单指针路径，例如选择对象后点击目标位置、点击滑块轨道或输入数值。键盘操作另行检查；键盘路径不能代替 WCAG 2.2 AA 的单指针拖动替代要求（SC 2.5.7）。仅当拖动本身是功能必要部分，或由用户代理控制且作者没有修改时，才适用标准例外。用鼠标、触屏或等效指针实际走完替代操作，并检查结果与拖动一致。[SC 2.5.7](https://www.w3.org/TR/WCAG22/#dragging-movements)。

平台目标尺寸沿[视觉质量与具体检查](visual-quality.md)按标准级别与单位核对。网页 CSS px、Android dp、Windows epx 和 WCAG 条件不能互换；若使用平台建议，注明平台、文档版本和所测控件范围。扩大图标的实际命中区后，检查相邻操作是否重叠或被遮挡。

## 错误、重复输入与认证

输入错误应以文字指出字段和问题；可安全确定修正方法时一并给出。错误提示与字段建立程序化关联，必需的标签和说明对用户可见，不能只靠颜色或仅供读屏器读取的名称。错误摘要、焦点和字段输入共同形成能回到答案并修正的路径；表单错误何时触发、答案怎样保留和恢复，按[表单流程](form-workflows.md)设计。

同一多步骤流程要再次使用已有答案时，自动带入或允许用户选择已有值，并保留其他已填字段。认证流程允许粘贴、自动填充和密码管理器，验证码也提供粘贴或自动填写支持。涉及记忆、转录或解题的步骤时核对辅助机制、替代路径与适用例外。WCAG 2.2 AA 的 SC 3.3.7 与 3.3.8 分别涵盖重复录入和可访问认证，并各有适用范围和例外，AAA 的认证准则不含 AA 中对象识别与个人内容两类例外。核对[SC 3.3.7](https://www.w3.org/TR/WCAG22/#redundant-entry)、[SC 3.3.8](https://www.w3.org/TR/WCAG22/#accessible-authentication-minimum)、[SC 3.3.9](https://www.w3.org/TR/WCAG22/#accessible-authentication-enhanced)。

## 动态消息、帮助与上下文变化

保存、搜索或异步操作若在原位置更新且没有移动焦点，用程序可识别的状态语义通报成功、错误、等待或进度；例如宣布简短的“18 条结果”，不必把整份结果列表当作一条消息。普通状态不要突然抢焦点。WCAG 2.2 AA 的 SC 4.1.3 要求不改变上下文呈现的状态消息可由辅助技术确定；若页面刷新或焦点实际移动，则按对应导航与焦点行为检查。[SC 4.1.3](https://www.w3.org/TR/WCAG22/#status-messages)。

同一组页面重复提供客服、帮助中心或自助支持时，保持帮助入口相对其他内容的顺序稳定（WCAG 2.2 A，SC 3.2.6）。聚焦控件或修改输入值时，不应未经预告就跳页、开新窗口或提交；局部校验和普通视觉更新本身不一定是上下文变化（A，SC 3.2.1、3.2.2）。长流程在开始前说明所需资料和步骤，并减少会打断任务的自动内容；这些是 COGA 补充指导，按确有准备成本的复杂任务采用，不为简单操作加步骤噪声。[SC 3.2.6](https://www.w3.org/TR/WCAG22/#consistent-help)、[SC 3.2.1](https://www.w3.org/TR/WCAG22/#on-focus)、[SC 3.2.2](https://www.w3.org/TR/WCAG22/#on-input)、[COGA 任务预期](https://www.w3.org/WAI/WCAG2/supplemental/patterns/o5p04-task-expectations/)与[减少打断](https://www.w3.org/WAI/WCAG2/supplemental/patterns/o5p01-minimal-interruptions/)。

## 检查

从正常入口分别用键盘、实际指针方式和浏览器缩放操作受影响流程。检查模态打开、内部移动与关闭后的焦点，错误修复，动态消息是否可感知，以及控件能否在放大和文字间距覆盖后继续操作。把规范符合性与 APG/COGA 的实践建议分开记录；只完成静态阅读时，说明尚未操作验证的行为。
