/**
 * WorkbookEngine：在 Worker 中运行的核心引擎。
 *
 * 职责：
 *  1. 保存原始输入（特性 1）
 *  2. 词法/语法分析 + AST 缓存（特性 8-12）
 *  3. 提取依赖、构建三类节点/两类边的依赖图（特性 16-19）
 *  4. Kahn 拓扑排序 + 三色循环检测（特性 20、23）
 *  5. 增量重算（特性 36）：只重算被改动的单元格及其下游受影响集合，
 *     未受影响的单元格沿用缓存值；循环检测始终在全图上进行，不会漏报
 *  6. 向下/向右填充（特性 37）：相对引用随偏移平移，$ 锁定不动
 *  7. 分层布局并序列化快照（特性 27、31、32）
 *
 * 增量模型：
 *  - cells / parsed / values 为跨重算的持久状态
 *  - cellDeps / cellDependents 为持久“引用图”（含指向空单元格的引用，
 *    拓扑与循环检测时再过滤到已占用单元格，语义与全量重建一致）
 *  - setCell / fill 只把改动的单元格标脏；recalc 时解析脏格、更新其出边，
 *    受影响集合 = 脏格 ∪ 下游 BFS，仅对该集合做拓扑排序与求值
 */
import {
  bool,
  EMPTY,
  err,
  num,
  txt,
  type A1Node,
  type CellValue,
  type ComputedCell,
  type EngineSnapshot,
  type ErrorEntry,
  type ErrorKind,
  type RecalcOrderEntry,
} from './types.js';
import { colToLetters, formatAddr, type Rect } from './address.js';
import { AstCache } from './ast-cache.js';
import { extractDependencies, extractRanges } from './dependencies.js';
import { computeFill } from './fill.js';
import {
  DependencyGraph,
  cellId,
  formulaId,
  parseCellId,
  rangeId,
} from './graph.js';
import { dfsTopo, detectCycles, kahnTopo, type AdjacencyInput } from './topology.js';
import { layeredLayout } from './layout.js';
import { evaluate } from './evaluator.js';
import { createBuiltinRegistry, type EvalContext } from './functions.js';

interface RawCell {
  row: number;
  col: number;
  raw: string;
}

interface ParsedCell {
  cell: RawCell;
  ast?: A1Node;
  parseError?: { kind: ErrorKind; message: string; offset: number; length: number };
}

const NUMBER_LITERAL_RE = /^-?\d*\.?\d+([eE][+-]?\d+)?$/;

export interface EngineOptions {
  rows: number;
  cols: number;
  topoAlgorithm?: 'kahn' | 'dfs';
}

export class WorkbookEngine {
  private readonly cells = new Map<string, RawCell>();
  private readonly parsed = new Map<string, ParsedCell>();
  /** 持久引用图：cellDeps[id] = id 公式引用的单元格（含空单元格引用） */
  private readonly cellDeps = new Map<string, Set<string>>();
  private readonly cellDependents = new Map<string, Set<string>>();
  /** 上次重算后的值缓存：未受影响的单元格直接沿用 */
  private readonly values = new Map<string, CellValue>();
  /** 自上次重算以来被改动的单元格 key */
  private readonly dirty = new Set<string>();
  private readonly astCache = new AstCache();
  private readonly registry = createBuiltinRegistry();
  readonly rows: number;
  readonly cols: number;
  topoAlgorithm: 'kahn' | 'dfs';

  constructor(options: EngineOptions) {
    this.rows = options.rows;
    this.cols = options.cols;
    this.topoAlgorithm = options.topoAlgorithm ?? 'kahn';
  }

  private key(row: number, col: number): string {
    return `${row},${col}`;
  }

  setCell(row: number, col: number, raw: string): void {
    const k = this.key(row, col);
    const existing = this.cells.get(k);
    if (raw === '') {
      if (!existing) return;
      this.cells.delete(k);
      this.parsed.delete(k);
      this.values.delete(cellId(row, col));
      // 删除单元格的出边（它不再依赖任何人）；
      // 入边（谁引用了它）保留，重算时其下游会按空单元格求值
      this.clearOutEdges(cellId(row, col));
      this.dirty.add(k);
      return;
    }
    // 内容未变化：不标脏，避免无意义重算
    if (existing && existing.raw === raw) return;
    this.cells.set(k, { row, col, raw });
    this.dirty.add(k);
  }

  loadAll(entries: Array<{ row: number; col: number; raw: string }>): void {
    this.cells.clear();
    this.parsed.clear();
    this.cellDeps.clear();
    this.cellDependents.clear();
    this.values.clear();
    this.dirty.clear();
    for (const e of entries) this.setCell(e.row, e.col, e.raw);
  }

  /**
   * 向下/向右填充（特性 37）：dst 为 src 向下或向右延伸后的区域。
   * 填充产生的新公式经 setCell 进入依赖图，随后重算只影响相关单元格。
   */
  fill(src: Rect, dst: Rect): void {
    const cells = computeFill(src, dst, (r, c) => this.getRaw(r, c));
    for (const c of cells) this.setCell(c.row, c.col, c.raw);
  }

  getRaw(row: number, col: number): string {
    return this.cells.get(this.key(row, col))?.raw ?? '';
  }

  /** 移除某单元格的全部出边（它作为依赖方的边） */
  private clearOutEdges(id: string): void {
    const old = this.cellDeps.get(id);
    if (old) {
      for (const d of old) this.cellDependents.get(d)?.delete(id);
      this.cellDeps.set(id, new Set());
    }
  }

  /** 解析非公式字面量为单元格值（特性 5） */
  private literalValue(raw: string): CellValue {
    if (raw === '') return EMPTY;
    const upper = raw.trim().toUpperCase();
    if (upper === 'TRUE') return bool(true);
    if (upper === 'FALSE') return bool(false);
    if (NUMBER_LITERAL_RE.test(raw.trim())) return num(Number(raw.trim()));
    return txt(raw);
  }

  /**
   * 重算并输出快照。
   * force=true 时强制全量（把所有单元格标脏）；
   * 否则只重算脏格及其下游受影响集合（特性 36）。
   */
  recalc(force = false): EngineSnapshot {
    const t0 = performance.now();
    if (force) {
      for (const k of this.cells.keys()) this.dirty.add(k);
    }

    // ---- 阶段 1：解析脏单元格并更新其引用边 ------------------------------
    for (const k of this.dirty) {
      const cell = this.cells.get(k);
      if (!cell) continue; // 已删除：出边已在 setCell 中清理
      const id = cellId(cell.row, cell.col);
      this.clearOutEdges(id);
      const deps = new Set<string>();
      this.cellDeps.set(id, deps);

      if (cell.raw.startsWith('=')) {
        const entry = this.astCache.get(cell.raw);
        if (entry.error) {
          this.parsed.set(k, {
            cell,
            parseError: {
              kind: entry.error.kind,
              message: entry.error.message,
              offset: entry.error.offset,
              length: entry.error.length,
            },
          });
        } else if (entry.ast) {
          this.parsed.set(k, { cell, ast: entry.ast });
          for (const d of extractDependencies(entry.ast)) {
            const dId = cellId(d.addr.row, d.addr.col);
            deps.add(dId);
            let rev = this.cellDependents.get(dId);
            if (!rev) {
              rev = new Set();
              this.cellDependents.set(dId, rev);
            }
            rev.add(id);
          }
        }
      } else {
        this.parsed.set(k, { cell });
      }
    }
    const t1 = performance.now();

    // ---- 阶段 2：受影响集合 = 脏格 ∪ 下游 BFS -----------------------------
    const affected = new Set<string>();
    const queue: string[] = [];
    for (const k of this.dirty) {
      const [r, c] = k.split(',').map(Number);
      const id = cellId(r!, c!);
      // 已删除的单元格不入 affected（无可求值），但仍作为 BFS 起点，
      // 让引用它的单元格得到重算
      if (this.cells.has(k) && !affected.has(id)) affected.add(id);
      queue.push(id);
    }
    while (queue.length) {
      const cur = queue.shift()!;
      for (const down of this.cellDependents.get(cur) ?? []) {
        if (!affected.has(down)) {
          affected.add(down);
          queue.push(down);
        }
      }
    }
    this.dirty.clear();

    // ---- 阶段 3：全图循环检测（过滤到已占用单元格） -----------------------
    const occupiedIds = [...this.cells.values()].map((c) => cellId(c.row, c.col));
    const occupiedSet = new Set(occupiedIds);
    const fDeps = new Map<string, Set<string>>();
    const fDependents = new Map<string, Set<string>>();
    for (const id of occupiedIds) {
      fDeps.set(
        id,
        new Set([...(this.cellDeps.get(id) ?? [])].filter((d) => occupiedSet.has(d))),
      );
      fDependents.set(id, new Set());
    }
    for (const [id, deps] of fDeps) {
      for (const d of deps) fDependents.get(d)!.add(id);
    }
    const fullAdj: AdjacencyInput = { deps: fDeps, dependents: fDependents };
    const report = detectCycles(occupiedIds, fullAdj);
    const cyclicCells = report.cyclic;

    // ---- 阶段 4：仅对受影响集合做拓扑排序并求值 ---------------------------
    const evalIds = occupiedIds.filter(
      (id) => affected.has(id) && !cyclicCells.has(id),
    );
    const evalSet = new Set(evalIds);
    const subDeps = new Map<string, Set<string>>();
    const subDependents = new Map<string, Set<string>>();
    for (const id of evalIds) {
      subDeps.set(
        id,
        new Set(
          [...fDeps.get(id)!].filter((d) => evalSet.has(d) && !cyclicCells.has(d)),
        ),
      );
      subDependents.set(id, new Set());
    }
    for (const [id, deps] of subDeps) {
      for (const d of deps) subDependents.get(d)!.add(id);
    }
    const subAdj: AdjacencyInput = { deps: subDeps, dependents: subDependents };
    const safeTopo =
      this.topoAlgorithm === 'dfs' ? dfsTopo(evalIds, subAdj) : kahnTopo(evalIds, subAdj);
    const t2 = performance.now();

    // 循环且受影响的节点预置 #CIRC!（特性 24）；未受影响的循环节点沿用缓存
    for (const id of cyclicCells) {
      if (affected.has(id)) this.values.set(id, err('#CIRC!', '循环引用'));
    }

    const evalContext: EvalContext = {
      getCell: (row, col) => this.values.get(cellId(row, col)) ?? EMPTY,
    };

    for (const id of safeTopo.order) {
      const { row: r, col: c } = parseCellId(id);
      const item = this.parsed.get(this.key(r, c))!;
      if (item.parseError) {
        this.values.set(id, err(item.parseError.kind, item.parseError.message));
        continue;
      }
      if (item.ast) {
        this.values.set(
          id,
          evaluate(item.ast, evalContext, {
            registry: this.registry,
            maxRow: this.rows - 1,
            maxCol: this.cols - 1,
          }),
        );
      } else {
        this.values.set(id, this.literalValue(item.cell.raw));
      }
    }
    const t3 = performance.now();

    // ---- 阶段 5：构建 UI 依赖图（结构展示，每次全量重建） ------------------
    const graph = new DependencyGraph();
    const highlightDeps = new Map<string, string[]>();

    for (const { row, col } of this.cells.values()) {
      graph.addNode({
        id: cellId(row, col),
        kind: 'cell',
        label: formatAddr({ row, col }),
        row,
        col,
      });
    }

    for (const item of this.parsed.values()) {
      if (!item.ast) continue;
      const owner = cellId(item.cell.row, item.cell.col);
      const addr = formatAddr({ row: item.cell.row, col: item.cell.col });
      const fId = formulaId(addr);
      graph.addNode({ id: fId, kind: 'formula', label: item.cell.raw, ownerCell: owner });
      graph.addEdge(fId, owner); // 公式产出单元格的值

      const rawDeps = extractDependencies(item.ast);
      const ranges = extractRanges(item.ast);
      const depAddrs: string[] = [];
      const memberByRange = new Map<string, string[]>();

      for (const d of rawDeps) {
        depAddrs.push(formatAddr(d.addr));
      }
      highlightDeps.set(owner, depAddrs);

      // 区域节点：成员 cell -> range -> formula
      for (const r of ranges) {
        const rLabel = `${colToLetters(r.left)}${r.top + 1}:${colToLetters(r.right)}${r.bottom + 1}`;
        const rId = rangeId(rLabel);
        graph.addNode({ id: rId, kind: 'range', label: rLabel, ownerCell: owner });
        graph.addEdge(rId, fId);
        const members: string[] = [];
        for (let rr = r.top; rr <= r.bottom; rr++) {
          for (let cc = r.left; cc <= r.right; cc++) {
            members.push(formatAddr({ row: rr, col: cc }));
            if (occupiedSet.has(cellId(rr, cc))) {
              graph.addEdge(cellId(rr, cc), rId);
            }
          }
        }
        memberByRange.set(rLabel, members);
      }

      // 单引用：dep cell -> formula
      for (const d of rawDeps) {
        if (d.source === 'ref') {
          const dId = cellId(d.addr.row, d.addr.col);
          if (this.cells.has(this.key(d.addr.row, d.addr.col))) {
            graph.addEdge(dId, fId);
          }
        }
      }
      void memberByRange;
    }
    const t4 = performance.now();

    // ---- 阶段 6：组装快照 ------------------------------------------------
    const cellsOut: Record<string, ComputedCell> = {};
    const errors: ErrorEntry[] = [];
    for (const item of this.parsed.values()) {
      const id = cellId(item.cell.row, item.cell.col);
      const addr = formatAddr({ row: item.cell.row, col: item.cell.col });
      const value = this.values.get(id) ?? EMPTY;
      const deps = highlightDeps.get(id) ?? [];
      const dependents = [...(this.cellDependents.get(id) ?? [])].map((d) => {
        const { row: r, col: c } = parseCellId(d);
        return formatAddr({ row: r, col: c });
      });
      const computed: ComputedCell = {
        row: item.cell.row,
        col: item.cell.col,
        raw: item.cell.raw,
        isFormula: item.cell.raw.startsWith('='),
        value,
        deps,
        dependents,
        ast: item.ast,
        parseError: item.parseError,
      };
      cellsOut[addr] = computed;
      if (value.type === 'error') {
        errors.push({
          address: addr,
          kind: value.kind,
          message: value.message ?? this.defaultMessage(value.kind),
          offset: item.parseError?.offset,
          length: item.parseError?.length,
        });
      }
    }

    // 重算顺序（特性 22、31、36）：只列出本次真正重算过的单元格
    const order: RecalcOrderEntry[] = safeTopo.order.map((id, i) => {
      const { row: r, col: c } = parseCellId(id);
      const v = this.values.get(id);
      return {
        address: formatAddr({ row: r, col: c }),
        order: i,
        status: v?.type === 'error' ? 'error' : 'ok',
      };
    });
    for (const id of cyclicCells) {
      if (!affected.has(id)) continue;
      const { row: r, col: c } = parseCellId(id);
      order.push({
        address: formatAddr({ row: r, col: c }),
        order: order.length,
        status: 'circular',
      });
    }

    // 图布局：cell 层基于单元格邻接；formula / range 节点相对 owner 放置
    const cellLayout = layeredLayout(
      occupiedIds,
      fullAdj,
      cyclicCells,
      { colWidth: 240, rowHeight: 60 },
    );
    const layout = new Map(cellLayout);
    for (const node of graph.nodes.values()) {
      if (node.kind === 'formula' && node.ownerCell) {
        const owner = cellLayout.get(node.ownerCell);
        if (owner) layout.set(node.id, { x: owner.x - 105, y: owner.y });
      } else if (node.kind === 'range' && node.ownerCell) {
        const owner = cellLayout.get(node.ownerCell);
        if (owner) {
          const idx = graph.inEdges.get(node.id)?.size ?? 0;
          layout.set(node.id, { x: owner.x - 200, y: owner.y + 22 + ((idx % 3) - 1) * 24 });
        }
      }
    }
    const graphSnapshot = graph.serialize(layout);
    // 循环图节点：cell + 其 formula
    const circularNodeIds = new Set<string>();
    for (const id of cyclicCells) {
      circularNodeIds.add(id);
      const { row: r, col: c } = parseCellId(id);
      circularNodeIds.add(formulaId(formatAddr({ row: r, col: c })));
    }

    return {
      cells: cellsOut,
      graph: graphSnapshot,
      order,
      errors: errors.sort((a, b) => a.address.localeCompare(b.address)),
      circularNodes: [...cyclicCells].map((id) => {
        const { row: r, col: c } = parseCellId(id);
        return formatAddr({ row: r, col: c });
      }),
      timing: {
        parseMs: t1 - t0,
        graphMs: t4 - t3,
        topoMs: t2 - t1,
        evalMs: t3 - t2,
        totalMs: t4 - t0,
      },
      debug: {
        astCacheSize: this.astCache.size,
        astCacheHits: this.astCache.hitCount,
        nodeCount: graph.nodeCount,
        edgeCount: graph.edgeCount,
        topoAlgorithm: this.topoAlgorithm,
        cycles: report.cycles,
        selfLoops: report.selfLoops,
        circularNodeIds: [...circularNodeIds],
        evalCount: safeTopo.order.length,
      },
    };
  }

  private defaultMessage(kind: ErrorKind): string {
    switch (kind) {
      case '#DIV/0!':
        return '除数为零';
      case '#VALUE!':
        return '参数类型错误';
      case '#REF!':
        return '引用无效';
      case '#NAME?':
        return '名称无法识别';
      case '#N/A':
        return '值不可用';
      case '#CIRC!':
        return '循环引用';
    }
  }
}
