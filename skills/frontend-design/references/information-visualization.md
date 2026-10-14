# 信息可视化

在页面需要呈现数量、分布、关系、时间变化或可探索的数据时，按读者当前要完成的任务选择图形、表格和交互。这里说明图形定义、编码、数据边界与图表操作；讲解页面中的因果解释、学习顺序和分段节奏继续由教学指导负责。

## 从任务选择图形和编码

先把分析目的写成读者要做的动作，例如查一个精确值、比较类别、看趋势、辨认分布、找异常、看关联或理解组成。再核对数据类型、时间或空间结构、读者基础和呈现目的。图形选择表只能提供候选，不能替代任务判断。查精确值、逐项核对或审计常适合表格；看总体形状、趋势、关系或异常通常适合图形。读者同时需要模式和精确值时，可并列图和有语义表头的数据表。

数值比较要使用能直接读出所需关系的编码。对于特定的快速比例估计任务，共同尺度上的位置判断优于长度；该结果只适用于 Heer 与 Bostock 的实验条件，不构成所有任务的完整编码排名。需要准确数值时直接标值或提供数据表。无序类别按比较目标排序；时间、阶段、等级等本身有意义的顺序继续保留。相互比较的视图保持同一变量的颜色、方向和位置含义。

空间、外观和部件用实际图像或标注；关系与传递用关系图；持续时间和重叠用共同时间轴；数量比较使用对齐的图或表。节点间距只用于布局时，不把间距伪装成精确时间或数量。箭头方向、线型、连接端点和图例应对应真实关系；关联图本身不能证明因果。

## 让定义、数据和刻度保持一致

优先采用成熟绘图与布局工具。图中的节点、边和标签从同一份图定义生成，数值、刻度、比例、汇总和结果文字从同一份数据或模型生成。检查箭头实际指向、对象身份、图例映射和标签位置。长链拥挤时重新分组或改变布局方向，保留连接关系与可读字号，并核对实际画面与说明使用同一版本。

每个比较都核对指标定义、基准、时间期间、单位、尺度方向和分母。条形长度表示数量时通常从零基线起画；若这样会遮住有意义的小变化，改用点图、折线等位置编码，并完整标注局部范围和单位。相邻比较图共用尺度；只有局部模式本身是任务时才独立缩放，同时标出各尺度并保留共同参照。比例、总量、差值和变化率须分开命名。

份额图说明总体、分母和百分比口径。普通堆叠图同时表达总量与组成，100% 堆叠表达各组内部比例；堆叠中只有共享基线的一段容易跨组精确比较。需要逐项比较多个组成时，改用分组条形、点图、小倍图或表格，必要时另列总量。

## 呈现分布、缺失和不确定性

读者要判断离散、偏态、重叠、异常值、样本量或组内差异时，保留原始观测点或适当的分布摘要；小样本可显示每个点，大样本选择不会遮住密度的表达。均值不能代替分布。箱线、区间和密度摘要各自省略不同信息，标清定义、样本量及需要理解的范围。原始点严重重叠时，点的存在本身不代表分布已经可读。

先区分真实零、未收集、未报告、被抑制、不适用和未知。时间序列只有确认实际数值为零时才落到零，缺失区间保留其缺失含义。跨缺口连线会暗示中间变化可以推断，先确认连续性或插值依据并标明方法。绘制为间断、缺失标记或其他形式应由数据含义决定。

不确定性说明具体是哪一种：样本变异、测量误差、估计量区间、预测区间还是情景范围。标明区间类型、估计对象和必要的覆盖率，不只写“误差线”。误差线重叠或分离本身不能判定显著与否；表达组间推断时，说明比较对象和检验依据，或直接显示差值及相应区间。公众沟通图只有在不确定性会改变解读时才特别强调区间；研究探索任务也可能需要保留高不确定度以显示数据或方法问题，不能把沟通型图表指南当作所有分析的禁画规则。

## 处理颜色、标签和图表替代信息

颜色类型服从数据语义：无序类别用分类色，有序数值用明度递进的顺序色，围绕有意义中点的正负变化用发散色；不需要区分系列时可用单色。不同图中的同一变量保持同一编码。颜色不单独承担类别或状态识别，补上直接标签、线型、符号或文字。

标题说明当前比较，轴说明指标、单位和必要范围，副标题或注释补充期间、定义、样本、来源和会改变判断的条件。标签尽量靠近数据，减少图与远处图例间的来回定位。悬停信息只补充细节；理解图所需的主要条件始终可见。

按图表用途提供替代信息：短 alt 识别图表并说明其主要用途，简单图表的文字描述概括关键比较，逐项精确访问可另给结构化 HTML 表格。复杂图应提供可导航的完整说明或数据表，保留关键值、单位、尺度、关系、缺失和条件；参数变化后替代信息同步更新。长说明放在可进入的标题、段落或表格结构中，不把整段内容只塞进 `aria-describedby` 连续朗读。标记结构检查与实际辅助技术操作分别记录。实际图表可用层级导航和细节读取时，应检查非视觉用户是否能完成对应的分析任务。

## 按需要加入筛选、联动和动画

交互控件表示有意义的数据条件，并给出可理解的初始情境。操作后，参数、当前数据子集、图表、数值、单位、假设和解释保持同步。真实数据与模拟数据在会影响判断的位置明确区分。过滤、排序或缩放后让用户看见当前条件、受影响视图和清除方式；筛选若改变统计总体或分母，同步更新相关说明。隐藏筛选器时，关闭状态仍显示已应用条件或数量。即时刷新或批量应用按选项数量、响应时间和工作步骤选择。

探索型分析界面可按任务组织总览、缩放或过滤、再查看数据点详情；相关图表应反映同一子集，让用户能够看见选择前后的总体关系。静态解释页直接呈现所需结论与比较，不为尚无用途的探索操作增加控件。

仅当时间变化或步骤顺序本身是对象时使用动画。关键状态要能停下、回看或逐帧观察；需要比较前后时保留静态关键帧、并排图或分步序列。检查动画和静态材料是否提供相当的信息及操作机会，避免把动画多给的信息误判为动画媒介的效果。教学讲解的停顿点、学习者控制节奏和因果分段按教学指导确定，不采用固定秒数切分。

## 来源与适用条件

- 图形选择的任务框架：[Tamara Munzner, *A Nested Model for Visualization Design and Validation*](https://vis.csail.mit.edu/classes/6.859/readings/pdfs/Munzner-ANestedModelForVisualizationDesignAndValidation.pdf)，理论模型；[Tableau, Choose the Right Chart Type](https://help.tableau.com/current/pro/desktop/en-us/what_chart_example.htm)，厂商图表指导，均把图表选择视为任务和数据相关判断，不是穷尽映射。
- 编码判断：[Heer & Bostock (2010), 实验 1A](https://idl.cs.washington.edu/files/2010-MTurk-CHI.pdf)，原始实验，结论只限图中两值的快速比例估计；不据此建立普遍的感知编码排名。
- 尺度、排序、分布、份额、缺失：[UK Government Analysis Function 图表清单](https://analysisfunction.civilservice.gov.uk/policy-store/charts-a-checklist/)与[颜色和文本替代指导](https://analysisfunction.civilservice.gov.uk/policy-store/data-visualisation-colours-in-charts/)，官方发布实践；[Statistics Canada 数据可视化实践](https://www150.statcan.gc.ca/n1/pub/89-26-0005/892600052022001-eng.htm)，官方统计图形指导；[Midway (2020), *Principles of Effective Data Visualization*](https://arinbasu.github.io/uc-shss-hlth460/midway.pdf)，同行评审的作者实践观点，面向科学出版；原始点、误差线与摘要条件按各来源说明理解。
- 不确定性：[ONS, Showing uncertainty in charts](https://service-manual.ons.gov.uk/data-visualisation/guidance/showing-uncertainty-in-charts)，面向公众沟通型图表的官方指南；[Correll、Kale 与 Hullman 的论文说明和结果摘要](https://www.microsoft.com/en-us/research/publication/how-visualizing-inferential-uncertainty-can-mislead-readers-about-treatment-effects-in-scientific-results/)，特定治疗效果判断任务的原始行为实验摘要。两者不能把估计区间等同于个体结果差异。
- 文字与交互：[IBM Data Visualization Basics](https://www.ibm.com/design/language/data-visualization/design/basics/)，设计系统指南；[Carbon Dashboards](https://www.carbondesignsystem.com/building-blocks/data-visualization/dashboards)和[Carbon Filtering](https://www.carbondesignsystem.com/building-blocks/core/patterns/filtering)，设计系统交互规范，不是普遍实验定律。
- 可访问图表：[WCAG 2.2 SC 1.4.1 Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)，规范解释；[Zong 等人屏幕阅读器可访问可视化研究](https://vis.csail.mit.edu/pubs/rich-screen-reader-vis-experiences/)，共创与探索性原型评估，13 位盲人或视障读者评价了部分原型，适合作为非视觉交互设计线索，不是通用可用性效应估计。
- 动画：[Tversky, Morrison & Bétrancourt (2002), *Animation: Can It Facilitate?*](https://www.tc.columbia.edu/faculty/bt2158/faculty-profile/files/_Morrison_Betrancourt_AnimationCanitfacilitate.pdf)，系统综述及对照实验设计评析；复杂系统讲解中动画总体优势不强，过程信息、交互和预测任务是否等价会改变比较。
