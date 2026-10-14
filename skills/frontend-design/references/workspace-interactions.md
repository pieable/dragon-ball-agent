# 工作台查找与集合操作

当界面供用户查找记录、比较多项属性、调整结果集合或批量处理对象时，先明确当前集合怎样形成、用户能否读懂查询范围、选择将作用于哪些对象。这里的行数、控件尺寸和等待数值不作为跨系统常数；引用某组件建议时保留系统、版本和适用对象。

## 让目标容易找到

按用户的查找任务和理解方式组织类别，不照搬组织内部结构；类别标题应准确预告其中的内容。用户是否找得到，要用真实查找任务检查，而非只从静态布局判断。卡片分类可以了解用户如何归组和命名，另安排不使用站内搜索的找寻任务来验证建成后的导航，并记录找到时间、误选、成功率和返回。若有真实查询日志，查看未命中和反复改写的词来发现入口缺失，再复测；日志只覆盖已发起搜索并表达需求的人，需与实际找寻任务一同看。[Hollands 与 Merikle 的类别菜单研究](https://doi.org/10.1177/001872088702900507)、[MRSA-net 信息架构研究](https://doi.org/10.1016/j.ijmedinf.2015.12.003)。

隐藏层级可减少当前画面内容，也会增加进入下一层的成本。为菜单、筛选和详情选择层级时，检查下一层提示是否准确描述实际内容；分开观察简单查找和需要跨类别比较的任务，并覆盖新手与熟练用户。菜单项数量由实际查找任务检验。Miller 的原始讨论涉及不同任务和熟悉组块，没有给出现代菜单的数量阈值。[信息气味与渐进披露研究](https://doi.org/10.1037/0033-295X.106.4.643)、[导航分类与任务研究](https://doi.org/10.1016/j.chb.2010.09.009)、[Miller 1956](https://cse.buffalo.edu/~rapaport/575/F01/miller56.html)。

## 查询、结果和已保存视图

按任务选择入口：简单列表的基本查找使用搜索；反复查询或包含多个条件的工作流可用专用筛选栏。避免在筛选栏和表格工具栏重复放置含义相同的搜索。无论采用实时更新还是用户按 Apply/Go 提交，都让界面显示实际已应用的条件、作用范围及当前结果状态。简单筛选可实时更新；只有用户需要组合多个条件或未筛选数据量会造成问题时，才考虑显式提交模式。这里的 SAP Fiori Filter Bar v1.148 是组件指导，其“数据量过大”没有通用数值阈值。[SAP Filter Bar v1.148](https://www.sap.com/design-system/fiori-design-web/v1-148/ui-elements/filter-bar)。

让用户看得出当前筛选条件，即使筛选栏已折叠或条件来自不在当前显示的字段。区分清空当前条件、恢复当前视图的保存条件和恢复产品默认值；分别说明各动作会影响哪些条件、列和顺序。SAP Filter Bar v1.148 的 Adapt Filters 中，Reset 会立即恢复当前 view 的筛选值，即使对话框仍打开，随后按 Cancel 不会撤销 Reset；其保存 view 还包括筛选值、可见字段与顺序。这些行为只作为该组件的具体实例，不能假定其他产品相同。检查用户取消、清空、重置和切换保存视图后的真实状态。[SAP Filter Bar v1.148](https://www.sap.com/design-system/fiori-design-web/v1-148/ui-elements/filter-bar)。

查询条件改变后，重新确认旧选择的含义。如果选择范围应随当前结果集变化，就清除或更新旧选择并向用户说明；若业务要求跨查询保留，持续显示选择数量和真实范围。SAP Filter Bar v1.148 建议筛选条件更新时清空旧行选择，避免旧选择跨查询残留；把它用于其他产品前，先确认其选择语义和后端集合模型。[SAP Filter Bar v1.148](https://www.sap.com/design-system/fiori-design-web/v1-148/ui-elements/filter-bar)。

## 记录表、密度与选择范围

需要按多个属性逐列比较、排序或选择记录时使用数据表；只需从少量候选中选择一个简单对象时，列表或选择控件更合适。明确当前排序列和方向，只对真正可排序的列显示可操作提示。行选择、打开记录、展开详情和行级操作各有独立目标；整行 hover 可以帮助横向追踪，但不应暗示不可点击的行可以点击。表级操作与单行操作的位置和状态应能区分。

表格密度跟实际内容相配：用真实长标签、换行和多属性检查行高，按内容需要选择行型并避免裁切。响应式展示先保留记录身份与关键属性，隐藏或移入详情的字段仍要有明确找回路径。需要分页时，同时说明当前位置、所见记录范围和每页条数；空间不足时优先让用户看清范围及翻页入口。分页应由数据量、加载或浏览需要决定。[Carbon Pagination 指导，2026-09-30 更新](https://www.carbondesignsystem.com/building-blocks/core/components/pagination/guidelines)。行高和列行为按当前组件及真实内容核对。

选择工具应说明它选择的是当前页、当前已加载记录，还是整个查询结果。将“选当前可见项”和“选全部结果”作为不同范围；若后端只加载一部分，提示中直接写出数量或范围，让用户知道批量动作将作用于哪些记录。SAP Table Features 的 URL 标为 v1.148，页面注明已停止维护且内容反映 SAPUI5 1.136；将其作为该组件版本的历史实现案例时保留这些条件。[SAP Table Features v1.148（内容反映 SAPUI5 1.136）](https://www.sap.com/design-system/fiori-design-web/v1-148/discover/frameworks/sap-fiori-elements/tables-and-lists/table-features-sap-fiori-elements)。

多选后显示批量操作和选中数量，并让用户退出批量模式；批量模式下避免继续显示会作用于单行的冲突操作。批量编辑要把“保留现值”“设为某值”“清空”分开表达：未修改字段不能被误解成空值；混合值、相同值和空值都要显示其真实状态。限制规则若来自特定系统，注明组件和版本，例如 [SAP Mass Edit v1.108](https://www.sap.com/design-system/fiori-design-web/v1-108/foundations/best-practices/global-patterns/object-handling/mass-editing)。

## 局部反馈、等待和恢复

消息放在受影响对象附近，并具体说明发生了什么、能做什么。字段问题贴近字段，表级错误靠近表格，整页服务状态使用页面级说明；普通成功可短暂提示，必须采取行动或用户离开前要读到的错误应持续显示。异步状态还需让辅助技术可感知，细节见[可访问性交互](accessibility-interaction.md)。

区分首次没有数据、查询无匹配、无权限和服务错误：各自说明不同原因及有用的下一步。搜索无结果时建议用户修改条件；没有可行后续操作时不要制造空洞按钮。[Carbon 空状态指导](https://www.carbondesignsystem.com/building-blocks/core/patterns/empty-states)、[Carbon 通知指导](https://www.carbondesignsystem.com/building-blocks/core/patterns/notifications)。

批量操作后报告总数、成功对象和失败对象的范围；部分成功时保留已成功结果，给出失败记录的筛选、查看和重试/修正路径，并按实际后端恢复机制说明可恢复的结果。SAP Table Features 中过滤错误行的交互属于其表格行错误模式；SAP Mass Edit v1.108 页面说明完整端到端消息处理仍待完善。[SAP Table Features（v1.148 URL，内容反映 SAPUI5 1.136）](https://www.sap.com/design-system/fiori-design-web/v1-148/discover/frameworks/sap-fiori-elements/tables-and-lists/table-features-sap-fiori-elements)、[SAP Mass Edit v1.108](https://www.sap.com/design-system/fiori-design-web/v1-108/foundations/best-practices/global-patterns/object-handling/mass-editing)。

等待样式按未知时间、已知进度和受阻范围选择，局部查询只覆盖局部结果区，允许其他工作继续。普通且真实可撤销的动作可以执行后提供可用撤销；不可逆或损失重大的操作再要求确认，并说明具体对象和后果。撤销必须实际恢复受影响的数据与选择状态；依赖外部系统、无法回滚的副作用要单独核实。[Carbon 加载指导](https://www.carbondesignsystem.com/building-blocks/core/patterns/loading)、[Apple 撤销与重做](https://developer.apple.com/design/human-interface-guidelines/undo-and-redo)。

## 检查

从正常入口用代表性数据完成查找、筛选、选择、批量编辑和返回恢复。核对清空与重置后哪些状态仍保留，筛选改变后选择范围是否真实，空结果和部分成功能否继续处理，以及高密度和窄屏下记录内容能否找回。采用 SAP Filter Bar/Table Features、SAP Mass Edit、Carbon 或 Apple 的具体行为时，记录对应系统、版本和适用对象。
