/**
 * WorkbookEngine：在 Worker 中运行的核心引擎。
 *
 * 职责：
 *  1. 保存原始输入（特性 1）
 *  2. 词法/语法分析 + AST 缓存（特性 8-12）
 *  3. 提取依赖、构建三类节点/两类边的依赖图（特性 16-19）
 *  4. Kahn 拓扑排序 + 三色循环检测（特性 20、23）
 *  5. 增量重算（特性 36）：只重算被修改单元格及其下游，未受影响的公式不动
 *  6. 向下/向右填充（特性 37）：相对引用随偏移平移，$ 绝对引用不动
 *  7. 分层布局并序列化快照（特性 27、31、32）
 *
 * 增量重算原理：
 *  - 引擎常驻维护：每个单元格的解析结果（含已提取的依赖）、单元格级
 *    依赖索引（depsIndex / dependentsIndex，含指向空单元格的引用）、
 *    以及每个单元格最近一次算出的值。
 *  - setCell / fill 只把单元格标记为脏；recalc 时：
 *      a. 只重新解析脏单元格并增量更新依赖索引（未改的公式不再解析）；
 *      b. 从脏单元格沿 dependentsIndex 做 BFS，得到受影响集合；
 *      c. 循环检测始终在全图上进行——任何新循环必然经过被修改的单元格，
 *         因此必然完整落在受影响集合内，局部重算不会漏报循环；
 *      d. 只对受影响集合做拓扑排序与求值，其余单元格沿用缓存值；
 *      e. 快照中的重算顺序只列出本次真正重算过的单元格。
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
import { formatAddr, type Rect } from './address.js';
import { AstCache } from './ast-cache.js';
import {
  extractDependencies,
  extractRanges,
  type RawDependency,
  type RangeRef,
} from './dependencies.js';
import { DependencyGraph, cellId, formulaId, parseCellId, rangeId } from './graph.js';
import {
  detectCycles,
  dfsTopo,
  kahnTopo,
  type AdjacencyInput,
  type CycleReport,
} from './topology.js';
import { layeredLayout } from './layout.js';
import { evaluate } from './evaluator.js';
import { createBuiltinRegistry, type EvalContext } from './functions.js';
import { translateFormula } from './fill.js';

interface RawCell {
  row: number;
  col: number;
  raw: string;
}

/** 单个单元格的解析结果（未修改的单元格不会重新解析/提取依赖） */
interface ParsedCell {
  cell: RawCell;
  ast?: A1Node;
  parseError?: { kind: ErrorKind; message: string; offset: number; length: number };
  /** 公式引用（区域已展开，含指向空单元格的引用） */
  refs: RawDependency[];
  /** 公式中的区域（未展开，可视化图的 range 节点用） */
  ranges: RangeRef[];
}

const NUMBER_LITERAL_RE = /^-?\d*\.?\d+([eE][+-]?\d+)?$/;

export interface EngineOptions {
  rows: number;
  cols: number;
  topoAlgorithm?: 'kahn' | 'dfs';
}

export class WorkbookEngine {
  private readonly cells = new Map<string, RawCell>();
  private readonly astCache = new AstCache();
  private readonly registry = createBuiltinRegistry();
  /** 每个已占用单元格的解析结果 */
  private readonly parsed = new Map<string, ParsedCell>();
  /** 公式单元格 -> 它引用的单元格集合（含空单元格引用） */
  private readonly depsIndex = new Map<string, Set<string>>();
  /** 被引用单元格 -> 引用它的公式单元格集合（脏传播用） */
  private readonly dependentsIndex = new Map<string, Set<string>>();
  /** 最近一次重算算出的值（增量重算时未受影响的单元格沿用） */
  private readonly values = new Map<string, CellValue>();
  /** 当前处于循环上的单元格（每次重算在全图上重新检测） */
  private cyclicCells = new Set<string>();
  private lastReport: CycleReport = { cyclic: new Set(), selfLoops: [], cycles: [] };
  /** setCell / fill 之后尚未重算的单元格 */
  private readonly dirtyKeys = new Set<string>();
  /** 是否已有全量基线（首次重算 / loadAll 之后必为全量） */
  private hasBaseline = false;
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
    if (raw === '') {
      this.cells.delete(k);
    } else {
      this.cells.set(k, { row, col, raw });
    }
    this.dirtyKeys.add(k);
  }

  /**
   * 填充（特性 37）：以区域首行（down）/首列（right）为源向其余部分填充。
   * 公式中的相对引用随偏移平移，$ 绝对引用不动；字面量原样复制；空源清空目标。
   * 填充产生的新公式经 setCell 进入依赖图，后续按增量重算更新。
   */
  fill(direction: 'down' | 'right', range: Rect): void {
    const top = Math.max(0, range.top);
    const left = Math.max(0, range.left);
    const bottom = Math.min(range.bottom, this.rows - 1);
    const right = Math.min(range.right, this.cols - 1);
    if (direction === 'down') {
      for (let col = left; col <= right; col++) {
        const src = this.getRaw(top, col);
        for (let row = top + 1; row <= bottom; row++) {
          this.setCell(row, col, translateFormula(src, row - top, 0));
        }
      }
    } else {
      for (let row = top; row <= bottom; row++) {
        const src = this.getRaw(row, left);
        for (let col = left + 1; col <= right; col++) {
          this.setCell(row, col, translateFormula(src, 0, col - left));
        }
      }
    }
  }

  loadAll(entries: Array<{ row: number; col: number; raw: string }>): void {
    this.cells.clear();
    this.parsed.clear();
    this.depsIndex.clear();
    this.dependentsIndex.clear();
    this.values.clear();
    this.cyclicCells = new Set();
    this.lastReport = { cyclic: new Set(), selfLoops: [], cycles: [] };
    this.dirtyKeys.clear();
    this.hasBaseline = false;
    for (const e of entries) this.setCell(e.row, e.col, e.raw);
    this.dirtyKeys.clear();
  }

  getRaw(row: number, col: number): string {
    return this.cells.get(this.key(row, col))?.raw ?? '';
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

  /** 重新解析单个单元格，并增量维护依赖索引（只处理脏单元格） */
  private reparseCell(k: string): void {
    // 1. 拆除旧依赖边
    const old = this.parsed.get(k);
    if (old) {
      const ownerId = cellId(old.cell.row, old.cell.col);
      for (const d of this.depsIndex.get(ownerId) ?? []) {
        const set = this.dependentsIndex.get(d);
        if (set) {
          set.delete(ownerId);
          if (set.size === 0) this.dependentsIndex.delete(d);
        }
      }
      this.depsIndex.delete(ownerId);
      this.parsed.delete(k);
    }

    const cell = this.cells.get(k);
    if (!cell) {
      // 单元格已删除：清掉缓存值
      if (old) this.values.delete(cellId(old.cell.row, old.cell.col));
      return;
    }

    // 2. 解析（公式经 AST 缓存，相同公式不重复解析）
    const entry: ParsedCell = { cell, refs: [], ranges: [] };
    if (cell.raw.startsWith('=')) {
      const cached = this.astCache.get(cell.raw);
      if (cached.error) {
        entry.parseError = {
          kind: cached.error.kind,
          message: cached.error.message,
          offset: cached.error.offset,
          length: cached.error.length,
        };
      } else if (cached.ast) {
        entry.ast = cached.ast;
        entry.refs = extractDependencies(cached.ast);
        entry.ranges = extractRanges(cached.ast);
      }
    }
    this.parsed.set(k, entry);

    // 3. 建立新依赖边（含指向空单元格的引用：空格日后被赋值时才能传播）
    if (entry.refs.length > 0) {
      const ownerId = cellId(cell.row, cell.col);
      const deps = new Set<string>();
      for (const r of entry.refs) deps.add(cellId(r.addr.row, r.addr.col));
      this.depsIndex.set(ownerId, deps);
      for (const d of deps) {
        let set = this.dependentsIndex.get(d);
        if (!set) {
          set = new Set();
          this.dependentsIndex.set(d, set);
        }
        set.add(ownerId);
      }
    }
  }

  /** 已占用单元格之间的依赖邻接（循环检测与拓扑排序用） */
  private occupiedAdjacency(ids: string[]): AdjacencyInput {
    const inSet = new Set(ids);
    const deps = new Map<string, Set<string>>();
    const dependents = new Map<string, Set<string>>();
    for (const id of ids) {
      deps.set(id, new Set());
      dependents.set(id, new Set());
    }
    for (const [owner, depSet] of this.depsIndex) {
      if (!inSet.has(owner)) continue;
      for (const d of depSet) {
        if (inSet.has(d)) {
          deps.get(owner)!.add(d);
          dependents.get(d)!.add(owner);
        }
      }
    }
    return { deps, dependents };
  }

  /**
   * 重建可视化依赖图（cell / formula / range 三类节点）。
   * 仅用于 SVG 展示，不做任何单元格求值。
   */
  private buildVisualGraph(): DependencyGraph {
    const graph = new DependencyGraph();
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

      // 区域节点：成员 cell -> range -> formula
      for (const r of item.ranges) {
        const rId = rangeId(r.label);
        graph.addNode({ id: rId, kind: 'range', label: r.label, ownerCell: owner });
        graph.addEdge(rId, fId);
        for (let rr = r.top; rr <= r.bottom; rr++) {
          for (let cc = r.left; cc <= r.right; cc++) {
            if (this.cells.has(this.key(rr, cc))) {
              graph.addEdge(cellId(rr, cc), rId);
            }
          }
        }
      }
      // 单引用：dep cell -> formula
      for (const d of item.refs) {
        if (d.source === 'ref' && this.cells.has(this.key(d.addr.row, d.addr.col))) {
          graph.addEdge(cellId(d.addr.row, d.addr.col), fId);
        }
      }
    }
    return graph;
  }

  /**
   * 重算入口。
   *  - 首次 / loadAll 后 / forceFull=true：全量重算（所有已占用单元格）；
   *  - 否则：增量重算，只算脏单元格及其下游，重算顺序只含这些单元格。
   */
  recalc(forceFull = false): EngineSnapshot {
    const t0 = performance.now();
    const incremental = this.hasBaseline && !forceFull;
    const changedKeys = [...this.dirtyKeys];

    // ---- 阶段 1：解析（增量模式只重新解析脏单元格） ------------------------
    if (incremental) {
      for (const k of changedKeys) this.reparseCell(k);
    } else {
      this.parsed.clear();
      this.depsIndex.clear();
      this.dependentsIndex.clear();
      this.values.clear();
      for (const k of this.cells.keys()) this.reparseCell(k);
    }
    this.dirtyKeys.clear();
    const t1 = performance.now();

    // ---- 阶段 2：可视化依赖图（全量重建，仅供 SVG 展示，不做求值） ----------
    const graph = this.buildVisualGraph();
    const t2 = performance.now();

    // ---- 阶段 3：循环检测（始终在全图上进行）+ 圈定本次重算集合 ------------
    const occupiedIds = [...this.cells.keys()].map((k) => {
      const [r, c] = k.split(',').map(Number);
      return cellId(r!, c!);
    });
    const adj = this.occupiedAdjacency(occupiedIds);
    const report = detectCycles(occupiedIds, adj);
    this.cyclicCells = report.cyclic;
    this.lastReport = report;
    // 循环节点预置 #CIRC!（特性 24）
    for (const id of report.cyclic) this.values.set(id, err('#CIRC!', '循环引用'));

    // 本次真正需要重算的单元格：脏单元格 + 沿逆邻接表可达的全部下游
    let recompute: Set<string>;
    if (incremental) {
      recompute = new Set<string>();
      const queue = changedKeys.map((k) => {
        const [r, c] = k.split(',').map(Number);
        return cellId(r!, c!);
      });
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (recompute.has(cur)) continue;
        recompute.add(cur);
        for (const down of this.dependentsIndex.get(cur) ?? []) queue.push(down);
      }
      // 已删除的单元格无需重算（其缓存值已在 reparseCell 中清除）
      const occupied = new Set(occupiedIds);
      for (const id of [...recompute]) {
        if (!occupied.has(id)) recompute.delete(id);
      }
    } else {
      recompute = new Set(occupiedIds);
    }

    // 重算集合内的拓扑排序（剔除循环入边后得到稳定顺序）
    const evalIds = [...recompute].filter((id) => !this.cyclicCells.has(id));
    const prunedDeps = new Map<string, Set<string>>();
    for (const id of evalIds) {
      prunedDeps.set(
        id,
        new Set(
          [...(adj.deps.get(id) ?? [])].filter(
            (d) => recompute.has(d) && !this.cyclicCells.has(d),
          ),
        ),
      );
    }
    const prunedAdj: AdjacencyInput = { deps: prunedDeps, dependents: adj.dependents };
    const topo =
      this.topoAlgorithm === 'dfs' ? dfsTopo(evalIds, prunedAdj) : kahnTopo(evalIds, prunedAdj);
    const t3 = performance.now();

    // ---- 阶段 4：求值（只算本次重算集合，其余单元格沿用缓存值） ------------
    const evalContext: EvalContext = {
      getCell: (row, col) => this.values.get(cellId(row, col)) ?? EMPTY,
    };
    for (const id of topo.order) {
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
    const t4 = performance.now();

    // ---- 阶段 5：组装快照 --------------------------------------------------
    const cellsOut: Record<string, ComputedCell> = {};
    const errors: ErrorEntry[] = [];
    for (const item of this.parsed.values()) {
      const id = cellId(item.cell.row, item.cell.col);
      const addr = formatAddr({ row: item.cell.row, col: item.cell.col });
      const value = this.values.get(id) ?? EMPTY;
      const dependents = [...(adj.dependents.get(id) ?? [])].map((d) => {
        const { row: r, col: c } = parseCellId(d);
        return formatAddr({ row: r, col: c });
      });
      const computed: ComputedCell = {
        row: item.cell.row,
        col: item.cell.col,
        raw: item.cell.raw,
        isFormula: item.cell.raw.startsWith('='),
        value,
        deps: item.refs.map((d) => formatAddr(d.addr)),
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
    const order: RecalcOrderEntry[] = topo.order.map((id, i) => {
      const { row: r, col: c } = parseCellId(id);
      const v = this.values.get(id);
      return {
        address: formatAddr({ row: r, col: c }),
        order: i,
        status: v?.type === 'error' ? 'error' : 'ok',
      };
    });
    for (const id of recompute) {
      if (!this.cyclicCells.has(id)) continue;
      const { row: r, col: c } = parseCellId(id);
      order.push({
        address: formatAddr({ row: r, col: c }),
        order: order.length,
        status: 'circular',
      });
    }

    // 图布局：cell 层基于单元格邻接；formula / range 节点相对 owner 放置
    const cellLayout = layeredLayout(occupiedIds, adj, this.cyclicCells, {
      colWidth: 240,
      rowHeight: 60,
    });
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
    for (const id of this.cyclicCells) {
      circularNodeIds.add(id);
      const { row: r, col: c } = parseCellId(id);
      circularNodeIds.add(formulaId(formatAddr({ row: r, col: c })));
    }

    this.hasBaseline = true;

    return {
      cells: cellsOut,
      graph: graphSnapshot,
      order,
      errors: errors.sort((a, b) => a.address.localeCompare(b.address)),
      circularNodes: [...this.cyclicCells].map((id) => {
        const { row: r, col: c } = parseCellId(id);
        return formatAddr({ row: r, col: c });
      }),
      timing: {
        parseMs: t1 - t0,
        graphMs: t2 - t1,
        topoMs: t3 - t2,
        evalMs: t4 - t3,
        totalMs: t4 - t0,
      },
      debug: {
        astCacheSize: this.astCache.size,
        astCacheHits: this.astCache.hitCount,
        nodeCount: graph.nodeCount,
        edgeCount: graph.edgeCount,
        topoAlgorithm: this.topoAlgorithm,
        cycles: this.lastReport.cycles,
        selfLoops: this.lastReport.selfLoops,
        circularNodeIds: [...circularNodeIds],
        recalcMode: incremental ? 'incremental' : 'full',
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
