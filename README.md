# 浏览器端电子表格公式引擎与依赖追踪

纯 TypeScript（strict 模式）实现的浏览器电子表格：手写 Lexer/Parser 生成 AST，
基于邻接表构建依赖图，拓扑排序驱动全量与增量重算，三色标记检测循环引用，
并用 SVG 可视化依赖图。所有解析、求值、建图、重算运行在 **Web Worker** 中，
主线程只负责 UI 与 SVG 渲染。

## 快速开始

```bash
npm install
npm run dev        # 启动开发服务器
npm test           # 运行 109 个单元测试（Vitest）
npm run typecheck  # TypeScript 严格类型检查
npm run build      # 类型检查 + 生产构建（Worker 独立分包）
```

## 架构

```
src/
├── core/                  # 与 DOM 无关的纯逻辑（可全部在 Worker / Node 中运行）
│   ├── types.ts           # 单元格值、AST、Token、快照等核心类型
│   ├── address.ts         # A1 / $A$1 地址解析、区域归一化与展开
│   ├── lexer.ts           # 手写词法分析器（特性 8）
│   ├── parser.ts          # 递归下降 + Pratt 优先级解析（特性 9-11）
│   ├── visitor.ts         # AST 访问者模式（技术 9）
│   ├── ast-cache.ts       # AST 缓存（技术 10）
│   ├── dependencies.ts    # 从 AST 提取引用 / 区域 / 依赖（特性 13、14、19）
│   ├── fill.ts            # 填充时的引用平移（特性 37）
│   ├── functions.ts       # 函数注册表、签名校验、12 个内置函数（特性 15）
│   ├── evaluator.ts       # AST 求值、类型转换、错误传播、IF 惰性求值
│   ├── graph.ts           # 依赖图：邻接表 + 逆邻接表、3 类节点（特性 16-18）
│   ├── topology.ts        # Kahn、DFS 拓扑与三色循环检测（特性 20、23）
│   ├── layout.ts          # 基础分层布局（技术 22）
│   └── workbook.ts        # 引擎编排：解析→建图→拓扑→增量/全量重算→快照
├── worker/
│   ├── protocol.ts        # postMessage 协议（技术 5）
│   └── engine.worker.ts   # Worker 入口（特性 34）
├── ui/                    # 主线程 UI（特性 35）
│   ├── grid.ts            # 网格：标题、选区/多选/框选、编辑、高亮
│   ├── formula-bar.ts     # 公式栏 + 语法错误定位
│   ├── graph-view.ts      # SVG 依赖图：缩放/平移/悬停/点击/上下游高亮
│   ├── ast-tree.ts        # AST 树展示
│   ├── panel-recalc.ts    # 重算顺序面板
│   ├── panel-errors.ts    # 错误列表面板
│   └── panel-debug.ts     # 调试面板
├── worker-client.ts
├── app.ts
└── main.ts
```

## 功能实现对照

| # | 功能 | 位置 |
|---|------|------|
| 1-4 | 网格 / 行列标题 / 选区多选框选 / 公式栏 | `ui/grid.ts`、`ui/formula-bar.ts` |
| 5 | 数字/文本/布尔/空/错误/公式 | `core/types.ts` 的 `CellValue` |
| 6 | A1、$A$1、A$1、$A1 | `core/address.ts` |
| 7、13、14 | 区域引用 A1:B10、解析、展开 | `address.ts`、`dependencies.ts` |
| 8 | 词法分析 | `core/lexer.ts` |
| 9-11 | 递归下降+Pratt、AST、错误 offset/length | `core/parser.ts` |
| 12 | AST 树展示 | `ui/ast-tree.ts` |
| 15 | SUM/AVERAGE/MIN/MAX/ROUND/ABS/IF/AND/OR/NOT/COUNT/COUNTA | `core/functions.ts` |
| 16-18 | cell/formula/range 节点、depends/depended-by 边、邻接表+逆邻接表 | `core/graph.ts` |
| 19 | AST 依赖提取 | `core/dependencies.ts` |
| 20 | Kahn 与 DFS 拓扑（工具栏可切换） | `core/topology.ts` |
| 21、22 | 全量重算、重算顺序 | `workbook.ts`、`ui/panel-recalc.ts` |
| 23 | 自引用 / 直接 / 间接循环（DFS 三色标记） | `detectCycles` |
| 24 | 循环单元格结果为 `#CIRC!` | `workbook.ts` |
| 25 | `#DIV/0! #VALUE! #REF! #NAME? #N/A`（另含 `#CIRC!`） | `types.ts`、各求值点 |
| 26 | 错误值参与后续计算时继续传播 | `evaluator.ts` 的 `EvalFlow` |
| 27、28 | SVG 图、滚轮缩放、拖拽平移、悬停、点击 | `ui/graph-view.ts` |
| 29、30 | 上下游高亮、网格 ↔ 依赖图联动 | `graph-view.ts`、`state.ts` |
| 31-33 | 重算顺序 / 错误列表 / 调试面板 | `ui/panel-*.ts` |
| 34、35 | Worker 计算，主线程渲染 | `worker/`、`worker-client.ts` |
| 36 | 增量重算：只重算受影响单元格，重算顺序只列本次算过的格子 | `workbook.ts` |
| 37 | 向下/向右填充：相对引用随偏移平移，`$` 锁定不动（Ctrl+D / Ctrl+R） | `core/fill.ts`、`workbook.ts`、`ui/grid.ts` |

## 关键设计

- **数据流方向**：图中边 `source -> target` 表示 `target` 依赖 `source`。
  邻接表 (`outEdges`) 记录下游，逆邻接表 (`inEdges`) 记录上游，
  拓扑排序基于入边（依赖数）归零驱动求值。
- **三类图节点**：`cell` 承载值；`formula` 节点表达公式产出（cell→formula→ownerCell）；
  `range` 节点聚合区域依赖（成员 cell→range→formula）。单元格级邻接另外维护，
  专门用于拓扑和求值，图结构与计算结构解耦。
- **循环检测与重算**：DFS 三色标记识别“真循环节点”（自/直接/间接），
  剔除循环入边后再做 Kahn/DFS 得到稳定重算顺序；循环节点求值为 `#CIRC!`，
  依赖它们的普通节点通过错误传播拿到 `#CIRC!`，但自身不被标记为循环。
- **增量重算**：引擎常驻维护每个单元格的解析结果、单元格级依赖索引
  （含指向空单元格的引用）与最近的计算值。编辑只标记脏单元格；重算时
  沿逆邻接表 BFS 圈出受影响集合，只对该集合做拓扑排序与求值，其余单元格
  沿用缓存值，重算顺序只列出本次真正算过的格子。循环检测始终在全图上
  运行——任何新循环必然经过被修改的单元格，因此局部重算不会漏报循环。
  `loadAll` / 切换拓扑算法 / “强制全量重算”按钮仍会触发全量重算。
- **填充**：`core/fill.ts` 基于 Token 流重写公式（保留空白与字符串字面量），
  相对引用随行/列偏移平移，`$` 绝对标记不动；区域两端各自平移。
  填充产生的新公式经 `setCell` 进入依赖图，之后同样按增量重算更新。
- **错误传播**：求值器内部用 `EvalFlow` 异常短路，任何操作数/区域成员为错误值时
  立即向上传播；`IF` 是特例，未命中分支不进行惰性求值。
- **跨线程**：Worker 输出不可变 `EngineSnapshot`（结构化克隆），包含单元格结果、
  图布局坐标、重算顺序、错误列表、计时与调试信息；主线程据此纯渲染。

## 测试

109 个测试覆盖：词法/语法/AST、地址与区域、求值与错误、函数库、
依赖图、Kahn/DFS 拓扑、三类循环检测、引擎端到端重算、增量重算、填充引用平移、jsdom UI 冒烟。
