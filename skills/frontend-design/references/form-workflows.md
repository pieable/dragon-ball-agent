# 表单流程

设计表单前先弄清用户要完成的整体事务、谁会使用答案，以及数据从输入到核验、更新和保护的过程。沿[界面设计交接](design-handoff.md)记录本次流程和状态；需要逐项确定复杂表单题序、校验、返回与保存时使用本参考。采用政府设计系统的指导时，保留其机构、任务和版本条件，并在当前流程中验证效果。

## 先确认字段用途和进入条件

对每个字段说明服务为何需要这个答案、谁会使用、怎样核验、用户答错或不答时如何处理，以及数据如何更新和保护。若服务已有可靠数据，先研究能否取回或让用户确认；用途无法说明的字段应先查清业务约束。对敏感信息，解释用途和保护方式，并检查是否可接受真实的“不知道”或“不确定”。[GOV.UK 表单结构](https://www.gov.uk/service-manual/design/form-structure)；[NHS：确认每个问题确有必要](https://service-manual.nhs.uk/content/how-to-write-good-questions-for-forms/make-sure-you-need-each-question)。

先按用户任务设计事务边界，不要求用户理解组织或技术部门。复杂资格、费用、金额或服务版本适合用少量路由问题尽早确定适用分支；普适、简短的资格和准备规则放在开始说明。已经能在开始页讲清的固定规则无需另造筛选流程；不符合资格是业务结果，要解释原因并给下一步，不能伪装成输入错误。[GOV.UK 服务适用性检查](https://design-system.service.gov.uk/patterns/check-a-service-is-suitable/)、[事务范围](https://www.gov.uk/service-manual/design/scoping-your-service)。

## 按任务节奏安排页面和导航

陌生、一次性的事务先从每页一件事的原型开始：一项信息、决定或问题，再通过真实用户研究决定是否合并。一个问题可以用多个输入控件表达，例如日期拆为日、月、年；这仍可能是一个问题。高频内部工作、需要快速重复或切换的场景，可以把相关字段合并在一页，合并方式由用户研究确认。问题标题要能预告任务，解释较长时将说明与字段问题分开；必需、常见、容易回答的题通常先于少见、敏感或需查资料的题。急需判断的资格和路由问题可能优先。[GOV.UK 表单结构](https://www.gov.uk/service-manual/design/form-structure)；[NHS 问题页](https://service-manual.nhs.uk/design-system/patterns/question-pages)与[问题排序](https://service-manual.nhs.uk/content/how-to-write-good-questions-for-forms/get-the-questions-into-order)。

短且顺序固定的旅程不需要任务列表或服务导航。长流程若跨多个任务/会话，或用户确实可选择完成顺序，再用任务列表呈现每项任务和真实状态；有依赖的任务须标明何时可开始，任务列表在开始流程和用户返回时都应可找到。反复使用且没有固定任务顺序的服务才考虑服务级导航。只有系统能判断实际完整性时才自动标为完成；含可选信息、长文本或外部核对的任务，可让用户说明是否完成或稍后继续。[GOV.UK 多任务服务](https://design-system.service.gov.uk/patterns/complete-multiple-tasks/)与[服务导航](https://design-system.service.gov.uk/patterns/navigate-a-service/)。

对复杂、较长或可能中断的事务，开始页说明服务作用、预备资料、费用、预期步骤、保存能力和替代渠道；用户进行到某一步时，在附近提供完成该步所需的细节。进度指示器先用真实流程测试；只有用户难以判断当前位置且总数能随分支正确更新时再显示，不把步骤条当作装饰。[GOV.UK 开始服务](https://design-system.service.gov.uk/patterns/start-using-a-service/)；[NHS 问题页进度说明](https://service-manual.nhs.uk/design-system/patterns/question-pages)。

## 返回、保存与复核

服务内的返回入口和浏览器返回都应让用户回到预期页面并保留当时答案。校验失败后保留已输入值；从答案复核页修改某一节时，只回到相关问题、预填旧答案，并允许直接回到复核页。复杂路径可让返回链接说清目的地。不要让用户重复完成后续步骤才能回到答案检查。[GOV.UK 返回链接](https://design-system.service.gov.uk/components/back-link/)、[答案复核](https://design-system.service.gov.uk/patterns/check-answers/)与[校验错误恢复](https://design-system.service.gov.uk/patterns/validation/)。

跨会话保存适用于长、复杂、敏感或常被中断的流程，不是每个短表单的默认功能。采用保存恢复时，在开始前说清楚如何暂停、如何回来，以及登出或未保存会丢失什么；保存和恢复入口应与真实账号和存储机制一致。[USWDS 复杂表单进度](https://designsystem.digital.gov/patterns/complete-a-complex-form/progress-easily/)；[GOV.UK One Login 保存进度](https://www.sign-in.service.gov.uk/documentation/design-recommendations/save-progress)是具体账号系统的实例，其细节不等于平台通用要求。

提交前提供完整答案复核和局部修改。小到中型事务可采用一个复核页；非常大的事务可以逐节复核，但应结合协作者、分节方式和研究决定。仅问“是否已完成”不能代替提交授权；最终确认应说明用户将确认什么、接下来发生什么。将检查页、真实完整性状态和提交声明对应到不同决定，避免重复提问。[GOV.UK 答案复核](https://design-system.service.gov.uk/patterns/check-answers/)与[多任务状态](https://design-system.service.gov.uk/patterns/complete-multiple-tasks/)。

## 校验与修复路径

先区分用户答案错误、答案不完整、资格不符和服务故障。只拒绝服务无法使用、必要但缺失或有歧义的输入；可无歧义接受的格式变体应接受。对用户可修的错误说明字段、问题和具体修法，答案留在原处；资格或权限不符、系统故障则给出解释与可行下一步，不把它们显示成字段错误。[GOV.UK 校验错误恢复](https://design-system.service.gov.uk/patterns/validation/)；[NHS 错误消息](https://service-manual.nhs.uk/design-system/components/error-message)。

校验时机按任务类型决定。问答式、陌生事务默认在用户选择继续或提交时做服务端校验；不要仅因用户离开一个字段就立即报错，也不要在答案尚未输入完整时打断。客户端实时校验只在用户研究发现净收益时加入，并确保提示能被不同浏览器和辅助技术理解。GOV.UK 还建议在其表单模式中关闭原生 HTML5 验证提示，以维持一致的错误修复路径。[GOV.UK 校验](https://design-system.service.gov.uk/patterns/validation/)。

频繁批量编辑属于另一种任务节奏：SAP Fiori Mass Edit v1.108 要求 Input 字段在失去焦点或按 Enter 时验证。引用此做法时保留其 SAP 批量编辑场景；目前没有问答事务与熟练批量编辑之间的直接比较研究，因此按各自的输入节奏和错误恢复路径确定校验时机。[SAP Fiori Mass Edit v1.108](https://www.sap.com/design-system/fiori-design-web/v1-108/foundations/best-practices/global-patterns/object-handling/mass-editing)。

## 必填标记按机构语境决定

不同官方指南对必填标记和 HTML 属性的建议并不相同。NHS 表单内容指导建议标出可选字段；USWDS 组件指导用星号或文字说明必填项，也建议标明可选项，并列出单字段表单例外；GOV.UK 校验模式建议不要使用 HTML `required` 属性，以避免原生浏览器提示取代其错误路径。视觉标记、屏幕阅读器可获得的信息和浏览器原生验证是不同决策。确定所用模式后，保持全流程一致，并用真实输入方式和辅助技术检查用户能否辨别、修复错误。[NHS 字段问题](https://service-manual.nhs.uk/content/how-to-write-good-questions-for-forms/make-sure-you-need-each-question)、[USWDS Form](https://designsystem.digital.gov/components/form/)、[GOV.UK Validation](https://design-system.service.gov.uk/patterns/validation/)。

## 验证流程

让目标用户实际完成表单，观察停顿、误解、错误、返回、分支、恢复和中断；同时向处理答案的工作人员核实数据是否足够可用。纸面题目测试通过后，再测交互原型，因为焦点、消息、输入保留和页面关系会改变真实操作。校验失败后将焦点移到错误摘要，即使只有一项错误也显示摘要并链接到字段；摘要与字段提示使用相同措辞，输入值保留。[GOV.UK 错误摘要](https://design-system.service.gov.uk/components/error-summary/)和[NHS 错误摘要](https://service-manual.nhs.uk/design-system/components/error-summary)。状态消息和认证支持按[可访问性交互](accessibility-interaction.md)检查。记录测试使用的流程、用户和版本，结合实际操作结果判断其效果。
