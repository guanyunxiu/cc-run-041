/**
 * 增量（局部）重算测试（特性 36）：
 * 只重算受影响的单元格，未依赖修改点的公式不重算、不出现在重算顺序里；
 * 循环检测不因局部重算而漏报。
 */
import { describe, expect, it } from 'vitest';
import { WorkbookEngine } from '../src/core/workbook.js';
import type { EngineSnapshot } from '../src/core/types.js';

function addr(a1: string): [number, number] {
  const m = /^([A-Z])(\d+)$/.exec(a1)!;
  return [Number(m[2]) - 1, m[1]!.charCodeAt(0) - 65];
}

function makeEngine(entries: Array<[string, string]>): WorkbookEngine {
  const engine = new WorkbookEngine({ rows: 100, cols: 26, topoAlgorithm: 'kahn' });
  for (const [a, raw] of entries) {
    const [r, c] = addr(a);
    engine.setCell(r, c, raw);
  }
  return engine;
}

function set(engine: WorkbookEngine, a1: string, raw: string): EngineSnapshot {
  const [r, c] = addr(a1);
  engine.setCell(r, c, raw);
  return engine.recalc();
}

function orderAddrs(snap: EngineSnapshot): string[] {
  return snap.order.map((o) => o.address).sort();
}

describe('增量重算：只重算受影响的格子', () => {
  it('改 A1 只重算 A1/B1，C1(=100+1) 不动且不进重算顺序', () => {
    const engine = makeEngine([
      ['A1', '10'],
      ['B1', '=A1*2'],
      ['C1', '=100+1'],
    ]);
    const full = engine.recalc();
    expect(full.debug.recalcMode).toBe('full');
    expect(orderAddrs(full)).toEqual(['A1', 'B1', 'C1']);

    const snap = set(engine, 'A1', '20');
    expect(snap.debug.recalcMode).toBe('incremental');
    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 40 });
    expect(snap.cells.C1!.value).toEqual({ type: 'number', value: 101 });
    // 重算顺序只含本次真正重算的格子，C1 不在其中
    expect(orderAddrs(snap)).toEqual(['A1', 'B1']);
  });

  it('依赖链再长一层也跟着变：A1 -> B1 -> D1', () => {
    const engine = makeEngine([
      ['A1', '10'],
      ['B1', '=A1*2'],
      ['C1', '=100+1'],
      ['D1', '=B1+1'],
    ]);
    engine.recalc();
    const snap = set(engine, 'A1', '20');
    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 40 });
    expect(snap.cells.D1!.value).toEqual({ type: 'number', value: 41 });
    expect(snap.cells.C1!.value).toEqual({ type: 'number', value: 101 });
    expect(orderAddrs(snap)).toEqual(['A1', 'B1', 'D1']);
    const idx = Object.fromEntries(snap.order.map((o) => [o.address, o.order]));
    expect(idx.A1!).toBeLessThan(idx.B1!);
    expect(idx.B1!).toBeLessThan(idx.D1!);
  });

  it('区域依赖同样增量：改 A2 只重算 A2 与 SUM 所在格', () => {
    const engine = makeEngine([
      ['A1', '1'],
      ['A2', '2'],
      ['C1', '=SUM(A1:A2)'],
      ['D1', '=100+1'],
    ]);
    engine.recalc();
    const snap = set(engine, 'A2', '5');
    expect(snap.cells.C1!.value).toEqual({ type: 'number', value: 6 });
    expect(orderAddrs(snap)).toEqual(['A2', 'C1']);
  });

  it('公式引用的空单元格被赋值时，公式跟着重算', () => {
    const engine = makeEngine([
      ['B1', '=A1*2'],
      ['C1', '=100+1'],
    ]);
    const full = engine.recalc();
    expect(full.cells.B1!.value).toEqual({ type: 'number', value: 0 });
    const snap = set(engine, 'A1', '10');
    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 20 });
    expect(orderAddrs(snap)).toEqual(['A1', 'B1']);
  });

  it('删除被引用的单元格，下游按空值重算', () => {
    const engine = makeEngine([
      ['A1', '10'],
      ['B1', '=A1*2'],
      ['C1', '=100+1'],
    ]);
    engine.recalc();
    const snap = set(engine, 'A1', '');
    expect(snap.cells.A1).toBeUndefined();
    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 0 });
    expect(snap.cells.C1!.value).toEqual({ type: 'number', value: 101 });
    expect(orderAddrs(snap)).toEqual(['B1']);
  });

  it('公式改动后旧依赖解除、新依赖生效', () => {
    const engine = makeEngine([
      ['A1', '1'],
      ['B1', '2'],
      ['C1', '=A1+1'],
    ]);
    engine.recalc();
    let snap = set(engine, 'C1', '=B1+1');
    expect(snap.cells.C1!.value).toEqual({ type: 'number', value: 3 });

    // 改 A1 不再影响 C1
    snap = set(engine, 'A1', '100');
    expect(snap.cells.C1!.value).toEqual({ type: 'number', value: 3 });
    expect(orderAddrs(snap)).toEqual(['A1']);

    // 改 B1 影响 C1
    snap = set(engine, 'B1', '5');
    expect(snap.cells.C1!.value).toEqual({ type: 'number', value: 6 });
    expect(orderAddrs(snap)).toEqual(['B1', 'C1']);
  });

  it('连续多次编辑各自只重算受影响部分，其余沿用缓存值', () => {
    const engine = makeEngine([
      ['A1', '1'],
      ['A2', '2'],
      ['B1', '=A1*10'],
      ['B2', '=A2*10'],
    ]);
    engine.recalc();
    let snap = set(engine, 'A1', '5');
    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 50 });
    expect(orderAddrs(snap)).toEqual(['A1', 'B1']);

    snap = set(engine, 'A2', '7');
    expect(snap.cells.B2!.value).toEqual({ type: 'number', value: 70 });
    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 50 });
    expect(orderAddrs(snap)).toEqual(['A2', 'B2']);
  });

  it('未受影响的错误单元格保留在错误列表中', () => {
    const engine = makeEngine([
      ['A1', '=1/0'],
      ['B1', '1'],
      ['C1', '=B1*2'],
    ]);
    engine.recalc();
    const snap = set(engine, 'B1', '2');
    expect(snap.cells.C1!.value).toEqual({ type: 'number', value: 4 });
    const kinds = Object.fromEntries(snap.errors.map((e) => [e.address, e.kind]));
    expect(kinds.A1).toBe('#DIV/0!');
    expect(orderAddrs(snap)).toEqual(['B1', 'C1']);
  });

  it('增量重算后依赖图快照仍然完整', () => {
    const engine = makeEngine([
      ['A1', '10'],
      ['B1', '=A1*2'],
      ['C1', '=100+1'],
    ]);
    engine.recalc();
    const snap = set(engine, 'A1', '20');
    const nodeIds = snap.graph.nodes.map((n) => n.id);
    expect(nodeIds).toContain('formula@B1');
    expect(nodeIds).toContain('formula@C1');
    const edgeIds = snap.graph.edges.map((e) => e.id);
    expect(edgeIds).toContain('cell@0,0->formula@B1');
    expect(snap.cells.B1!.deps).toEqual(['A1']);
    expect(snap.cells.A1!.dependents).toContain('B1');
  });

  it('强制全量重算列出所有单元格', () => {
    const engine = makeEngine([
      ['A1', '10'],
      ['B1', '=A1*2'],
      ['C1', '=100+1'],
    ]);
    engine.recalc();
    set(engine, 'A1', '20');
    const snap = engine.recalc(true);
    expect(snap.debug.recalcMode).toBe('full');
    expect(orderAddrs(snap)).toEqual(['A1', 'B1', 'C1']);
  });
});

describe('增量重算下的循环检测', () => {
  it('编辑引入自引用仍报 #CIRC!，下游传播但不标记为循环', () => {
    const engine = makeEngine([
      ['A1', '1'],
      ['B1', '=A1+1'],
    ]);
    engine.recalc();
    const snap = set(engine, 'A1', '=A1+1');
    expect(snap.cells.A1!.value.type).toBe('error');
    if (snap.cells.A1!.value.type === 'error') {
      expect(snap.cells.A1!.value.kind).toBe('#CIRC!');
    }
    expect(snap.circularNodes).toContain('A1');
    // B1 依赖循环节点：传播错误，但自身不是循环节点
    expect(snap.cells.B1!.value.type).toBe('error');
    expect(snap.circularNodes).not.toContain('B1');
    // 循环格出现在本次重算顺序中，状态为 circular
    const entry = snap.order.find((o) => o.address === 'A1');
    expect(entry?.status).toBe('circular');
  });

  it('编辑引入间接循环仍被检测', () => {
    const engine = makeEngine([
      ['A1', '=B1'],
      ['B1', '5'],
    ]);
    engine.recalc();
    const snap = set(engine, 'B1', '=A1'); // A1 -> B1 -> A1
    expect(snap.circularNodes.sort()).toEqual(['A1', 'B1']);
    expect(snap.cells.A1!.value.type).toBe('error');
    expect(snap.cells.B1!.value.type).toBe('error');
  });

  it('打破循环后相关单元格恢复正常值', () => {
    const engine = makeEngine([
      ['A1', '=B1+1'],
      ['B1', '=A1+1'],
    ]);
    const before = engine.recalc();
    expect(before.circularNodes.sort()).toEqual(['A1', 'B1']);

    const snap = set(engine, 'A1', '5');
    expect(snap.circularNodes).toEqual([]);
    expect(snap.cells.A1!.value).toEqual({ type: 'number', value: 5 });
    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 6 });
    expect(snap.errors).toEqual([]);
  });

  it('与本次修改无关的既有循环保持 #CIRC! 且不参与重算', () => {
    const engine = makeEngine([
      ['A1', '=A2'],
      ['A2', '=A1'],
      ['C1', '1'],
      ['D1', '=C1*2'],
    ]);
    const full = engine.recalc();
    expect(full.circularNodes.sort()).toEqual(['A1', 'A2']);

    const snap = set(engine, 'C1', '3');
    expect(snap.circularNodes.sort()).toEqual(['A1', 'A2']);
    expect(snap.cells.A1!.value.type).toBe('error');
    expect(snap.cells.D1!.value).toEqual({ type: 'number', value: 6 });
    expect(orderAddrs(snap)).toEqual(['C1', 'D1']);
    // 错误列表仍包含循环格
    const kinds = Object.fromEntries(snap.errors.map((e) => [e.address, e.kind]));
    expect(kinds.A1).toBe('#CIRC!');
    expect(kinds.A2).toBe('#CIRC!');
  });
});
