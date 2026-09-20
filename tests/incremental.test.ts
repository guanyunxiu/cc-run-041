/**
 * 增量重算测试（特性 36）：
 * 只重算被改动单元格及其下游受影响集合；
 * 重算顺序只包含本次真正重算的单元格；
 * 循环检测不因局部重算而漏报。
 */
import { describe, expect, it } from 'vitest';
import { WorkbookEngine } from '../src/core/workbook.js';

function makeEngine() {
  return new WorkbookEngine({ rows: 100, cols: 26, topoAlgorithm: 'kahn' });
}

/** 按 A1 地址设置单元格 */
function set(engine: WorkbookEngine, addr: string, raw: string): void {
  const m = /^([A-Z])(\d+)$/.exec(addr)!;
  engine.setCell(Number(m[2]) - 1, m[1]!.charCodeAt(0) - 65, raw);
}

function orderAddrs(snap: { order: Array<{ address: string }> }): string[] {
  return snap.order.map((o) => o.address);
}

describe('增量重算：只重算受影响的单元格（特性 36）', () => {
  it('改 A1 只重算 A1/B1/D1，C1 不动', () => {
    const engine = makeEngine();
    set(engine, 'A1', '10');
    set(engine, 'B1', '=A1*2');
    set(engine, 'C1', '=100+1');
    set(engine, 'D1', '=B1+1');
    let snap = engine.recalc();
    // 首次全量：四个单元格都参与
    expect(orderAddrs(snap).sort()).toEqual(['A1', 'B1', 'C1', 'D1']);
    expect(snap.cells.C1!.value).toEqual({ type: 'number', value: 101 });

    set(engine, 'A1', '20');
    snap = engine.recalc();

    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 40 });
    expect(snap.cells.D1!.value).toEqual({ type: 'number', value: 41 });
    // C1 不依赖 A1：值不变，且不在本次重算顺序中
    expect(snap.cells.C1!.value).toEqual({ type: 'number', value: 101 });
    expect(orderAddrs(snap).sort()).toEqual(['A1', 'B1', 'D1']);
    expect(snap.debug.evalCount).toBe(3);
    // 顺序仍按依赖拓扑：A1 在 B1 前，B1 在 D1 前
    const idx = Object.fromEntries(snap.order.map((o) => [o.address, o.order]));
    expect(idx.A1!).toBeLessThan(idx.B1!);
    expect(idx.B1!).toBeLessThan(idx.D1!);
  });

  it('更长的依赖链逐层传播', () => {
    const engine = makeEngine();
    set(engine, 'A1', '1');
    set(engine, 'B1', '=A1+1');
    set(engine, 'C1', '=B1+1');
    set(engine, 'D1', '=C1+1');
    set(engine, 'E1', '=D1+1');
    engine.recalc();

    set(engine, 'A1', '10');
    const snap = engine.recalc();
    expect(snap.cells.E1!.value).toEqual({ type: 'number', value: 14 });
    expect(orderAddrs(snap).sort()).toEqual(['A1', 'B1', 'C1', 'D1', 'E1']);
  });

  it('改动公式本身：只重算该格与其下游', () => {
    const engine = makeEngine();
    set(engine, 'A1', '10');
    set(engine, 'B1', '=A1*2');
    set(engine, 'C1', '=100+1');
    engine.recalc();

    set(engine, 'B1', '=A1*3');
    const snap = engine.recalc();
    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 30 });
    expect(orderAddrs(snap).sort()).toEqual(['B1']);
  });

  it('公式改换依赖后，旧上游的改动不再波及它', () => {
    const engine = makeEngine();
    set(engine, 'A1', '1');
    set(engine, 'C1', '5');
    set(engine, 'B1', '=A1*2');
    engine.recalc();

    set(engine, 'B1', '=C1*2');
    let snap = engine.recalc();
    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 10 });
    // B1 的依赖图已更新
    expect(snap.cells.B1!.deps).toEqual(['C1']);
    expect(snap.cells.A1!.dependents).not.toContain('B1');

    set(engine, 'A1', '999');
    snap = engine.recalc();
    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 10 });
    expect(orderAddrs(snap)).toEqual(['A1']);
  });

  it('删除单元格触发下游重算，被删格不入重算顺序', () => {
    const engine = makeEngine();
    set(engine, 'A1', '10');
    set(engine, 'B1', '=A1*2');
    engine.recalc();

    set(engine, 'A1', '');
    const snap = engine.recalc();
    // A1 已空 => B1 = 0*2 = 0
    expect(snap.cells.A1).toBeUndefined();
    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 0 });
    expect(orderAddrs(snap)).toEqual(['B1']);
  });

  it('删除后重新添加：下游跟着空值和新值各重算一次', () => {
    const engine = makeEngine();
    set(engine, 'A1', '10');
    set(engine, 'B1', '=A1*2');
    engine.recalc();

    set(engine, 'A1', '');
    let snap = engine.recalc();
    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 0 });

    set(engine, 'A1', '7');
    snap = engine.recalc();
    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 14 });
    expect(orderAddrs(snap).sort()).toEqual(['A1', 'B1']);
    // 依赖边恢复
    expect(snap.cells.A1!.dependents).toContain('B1');
  });

  it('写入相同内容不触发任何重算', () => {
    const engine = makeEngine();
    set(engine, 'A1', '10');
    set(engine, 'B1', '=A1*2');
    engine.recalc();

    set(engine, 'A1', '10');
    const snap = engine.recalc();
    expect(snap.order).toEqual([]);
    expect(snap.debug.evalCount).toBe(0);
    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 20 });
  });

  it('force 全量重算：所有单元格都进重算顺序', () => {
    const engine = makeEngine();
    set(engine, 'A1', '10');
    set(engine, 'B1', '=A1*2');
    set(engine, 'C1', '=100+1');
    engine.recalc();

    const snap = engine.recalc(true);
    expect(orderAddrs(snap).sort()).toEqual(['A1', 'B1', 'C1']);
  });

  it('DFS 拓扑模式下增量重算同样只算受影响格', () => {
    const engine = new WorkbookEngine({ rows: 100, cols: 26, topoAlgorithm: 'dfs' });
    set(engine, 'A1', '10');
    set(engine, 'B1', '=A1*2');
    set(engine, 'C1', '=100+1');
    engine.recalc();

    set(engine, 'A1', '20');
    const snap = engine.recalc();
    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 40 });
    expect(orderAddrs(snap).sort()).toEqual(['A1', 'B1']);
  });
});

describe('增量重算下的循环检测（特性 23、24 不回归）', () => {
  it('改动无关单元格时，既有循环仍然报循环', () => {
    const engine = makeEngine();
    set(engine, 'A1', '=A1+1');
    set(engine, 'C1', '=100+1');
    let snap = engine.recalc();
    expect(snap.circularNodes).toContain('A1');

    set(engine, 'C1', '=200+1');
    snap = engine.recalc();
    // 本次只重算 C1，但 A1 的循环状态与 #CIRC! 值都保留
    expect(orderAddrs(snap)).toEqual(['C1']);
    expect(snap.circularNodes).toContain('A1');
    expect(snap.cells.A1!.value).toEqual({
      type: 'error',
      kind: '#CIRC!',
      message: '循环引用',
    });
  });

  it('编辑引入自引用循环：立即检出', () => {
    const engine = makeEngine();
    set(engine, 'A1', '1');
    engine.recalc();

    set(engine, 'A1', '=A1+1');
    const snap = engine.recalc();
    expect(snap.circularNodes).toContain('A1');
    expect(snap.cells.A1!.value.type).toBe('error');
    if (snap.cells.A1!.value.type === 'error') {
      expect(snap.cells.A1!.value.kind).toBe('#CIRC!');
    }
    expect(snap.order.find((o) => o.address === 'A1')?.status).toBe('circular');
  });

  it('编辑引入间接循环：环上节点全部 #CIRC!，下游传播', () => {
    const engine = makeEngine();
    set(engine, 'A1', '=B1+1');
    set(engine, 'B1', '5');
    set(engine, 'C1', '=A1*2');
    let snap = engine.recalc();
    expect(snap.cells.A1!.value).toEqual({ type: 'number', value: 6 });

    set(engine, 'B1', '=A1+1'); // A1 <-> B1
    snap = engine.recalc();
    expect(snap.circularNodes.sort()).toEqual(['A1', 'B1']);
    expect(snap.cells.A1!.value.type).toBe('error');
    expect(snap.cells.B1!.value.type).toBe('error');
    // C1 不在环上但读到 #CIRC!，被波及重算
    expect(snap.cells.C1!.value.type).toBe('error');
    expect(orderAddrs(snap).sort()).toEqual(['A1', 'B1', 'C1']);
  });

  it('打破循环后，环上节点恢复正常值', () => {
    const engine = makeEngine();
    set(engine, 'A1', '=B1+1');
    set(engine, 'B1', '=A1+1');
    let snap = engine.recalc();
    expect(snap.circularNodes.sort()).toEqual(['A1', 'B1']);

    set(engine, 'B1', '5');
    snap = engine.recalc();
    expect(snap.circularNodes).toEqual([]);
    expect(snap.cells.B1!.value).toEqual({ type: 'number', value: 5 });
    expect(snap.cells.A1!.value).toEqual({ type: 'number', value: 6 });
    expect(orderAddrs(snap).sort()).toEqual(['A1', 'B1']);
  });
});

describe('增量重算与错误传播（特性 25、26 不回归）', () => {
  it('上游出错只波及下游', () => {
    const engine = makeEngine();
    set(engine, 'A1', '1');
    set(engine, 'B1', '=A1+1');
    set(engine, 'C1', '=100+1');
    engine.recalc();

    set(engine, 'A1', '=1/0');
    const snap = engine.recalc();
    expect(snap.cells.B1!.value.type).toBe('error');
    if (snap.cells.B1!.value.type === 'error') {
      expect(snap.cells.B1!.value.kind).toBe('#DIV/0!');
    }
    expect(snap.cells.C1!.value).toEqual({ type: 'number', value: 101 });
    expect(orderAddrs(snap).sort()).toEqual(['A1', 'B1']);
    // 错误列表仍包含传播错误
    const kinds = Object.fromEntries(snap.errors.map((e) => [e.address, e.kind]));
    expect(kinds.A1).toBe('#DIV/0!');
    expect(kinds.B1).toBe('#DIV/0!');
  });
});
