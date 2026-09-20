/**
 * 填充测试（特性 37）：
 * 相对引用随偏移平移，$ 绝对引用不动；区域两端各自平移；
 * 填充产生的新公式进入依赖图，之后按增量重算更新。
 */
import { describe, expect, it } from 'vitest';
import { translateFormula } from '../src/core/fill.js';
import { WorkbookEngine } from '../src/core/workbook.js';

describe('translateFormula 引用平移', () => {
  it('相对引用随行偏移：=A1*2 向下 1 行 => =A2*2', () => {
    expect(translateFormula('=A1*2', 1, 0)).toBe('=A2*2');
  });

  it('$A$1 完全锁定，任何偏移都不动', () => {
    expect(translateFormula('=$A$1*2', 1, 0)).toBe('=$A$1*2');
    expect(translateFormula('=$A$1*2', 3, 2)).toBe('=$A$1*2');
  });

  it('区域两端一起平移：=SUM(A1:A2) 向下 2 行 => =SUM(A3:A4)', () => {
    expect(translateFormula('=SUM(A1:A2)', 2, 0)).toBe('=SUM(A3:A4)');
  });

  it('只锁行 A$1：向右填列变、行不变', () => {
    expect(translateFormula('=A$1', 0, 1)).toBe('=B$1');
    expect(translateFormula('=A$1', 5, 3)).toBe('=D$1');
  });

  it('只锁列 $A1：向下填行变、列不变', () => {
    expect(translateFormula('=$A1', 1, 0)).toBe('=$A2');
    expect(translateFormula('=$A1', 2, 5)).toBe('=$A3');
  });

  it('混合引用各自按规则平移', () => {
    expect(translateFormula('=$A1+B$2+$C$3+D4', 1, 1)).toBe('=$A2+C$2+$C$3+E5');
  });

  it('字符串字面量中的 A1 不是引用', () => {
    expect(translateFormula('="A1"&B1', 1, 0)).toBe('="A1"&B2');
  });

  it('保留空白与函数名写法', () => {
    expect(translateFormula('=sum( A1 , B2 )', 1, 1)).toBe('=sum( B2 , C3 )');
  });

  it('非公式原样返回', () => {
    expect(translateFormula('hello', 1, 0)).toBe('hello');
    expect(translateFormula('42', 1, 0)).toBe('42');
    expect(translateFormula('', 1, 0)).toBe('');
  });
});

describe('fill 向下 / 向右填充', () => {
  function makeEngine(entries: Array<[string, string]>): WorkbookEngine {
    const engine = new WorkbookEngine({ rows: 100, cols: 26, topoAlgorithm: 'kahn' });
    for (const [a, raw] of entries) {
      const m = /^([A-Z])(\d+)$/.exec(a)!;
      engine.setCell(Number(m[2]) - 1, m[1]!.charCodeAt(0) - 65, raw);
    }
    return engine;
  }

  it('相对引用跟着走：B1==A1*2 填到 B2 => =A2*2，结果 60', () => {
    const engine = makeEngine([
      ['A1', '10'],
      ['A2', '30'],
      ['B1', '=A1*2'],
    ]);
    engine.recalc();
    engine.fill('down', { top: 0, left: 1, bottom: 1, right: 1 });
    const snap = engine.recalc();
    expect(snap.cells.B2!.raw).toBe('=A2*2');
    expect(snap.cells.B2!.value).toEqual({ type: 'number', value: 60 });
  });

  it('$A$1 不动：填到 B2 仍是 =$A$1*2，结果跟着 A1', () => {
    const engine = makeEngine([
      ['A1', '10'],
      ['A2', '30'],
      ['B1', '=$A$1*2'],
    ]);
    engine.recalc();
    engine.fill('down', { top: 0, left: 1, bottom: 1, right: 1 });
    const snap = engine.recalc();
    expect(snap.cells.B2!.raw).toBe('=$A$1*2');
    expect(snap.cells.B2!.value).toEqual({ type: 'number', value: 20 });
  });

  it('区域填充：=SUM(A1:A2) 填到 B3 => =SUM(A3:A4)', () => {
    const engine = makeEngine([
      ['A1', '1'],
      ['A2', '2'],
      ['A3', '3'],
      ['A4', '4'],
      ['B1', '=SUM(A1:A2)'],
    ]);
    engine.recalc();
    engine.fill('down', { top: 0, left: 1, bottom: 2, right: 1 });
    const snap = engine.recalc();
    expect(snap.cells.B2!.raw).toBe('=SUM(A2:A3)');
    expect(snap.cells.B2!.value).toEqual({ type: 'number', value: 5 });
    expect(snap.cells.B3!.raw).toBe('=SUM(A3:A4)');
    expect(snap.cells.B3!.value).toEqual({ type: 'number', value: 7 });
  });

  it('只锁行往右填：=A$1 从 B1 填到 C1 => =B$1', () => {
    const engine = makeEngine([
      ['A1', '10'],
      ['B1', '7'],
      ['C1', '=A$1'],
    ]);
    engine.recalc();
    engine.fill('right', { top: 0, left: 2, bottom: 0, right: 3 });
    const snap = engine.recalc();
    expect(snap.cells.D1!.raw).toBe('=B$1');
    expect(snap.cells.D1!.value).toEqual({ type: 'number', value: 7 });
  });

  it('只锁列往下填：=$A1 填到 B2 => =$A2', () => {
    const engine = makeEngine([
      ['A1', '10'],
      ['A2', '30'],
      ['B1', '=$A1'],
    ]);
    engine.recalc();
    engine.fill('down', { top: 0, left: 1, bottom: 1, right: 1 });
    const snap = engine.recalc();
    expect(snap.cells.B2!.raw).toBe('=$A2');
    expect(snap.cells.B2!.value).toEqual({ type: 'number', value: 30 });
  });

  it('字面量原样复制，空源清空目标', () => {
    const engine = makeEngine([
      ['A1', '5'],
      ['A2', '99'],
      ['B2', '=1+1'],
    ]);
    engine.recalc();
    engine.fill('down', { top: 0, left: 0, bottom: 1, right: 0 }); // A1 -> A2
    engine.fill('down', { top: 0, left: 1, bottom: 1, right: 1 }); // B1(空) -> B2
    const snap = engine.recalc();
    expect(snap.cells.A2!.raw).toBe('5');
    expect(snap.cells.B2).toBeUndefined();
  });

  it('多列区域一次向下填充', () => {
    const engine = makeEngine([
      ['A1', '1'],
      ['B1', '=A1*2'],
      ['A2', '3'],
    ]);
    engine.recalc();
    engine.fill('down', { top: 0, left: 0, bottom: 1, right: 1 });
    const snap = engine.recalc();
    expect(snap.cells.A2!.raw).toBe('1'); // 字面量复制
    expect(snap.cells.B2!.raw).toBe('=A2*2');
    expect(snap.cells.B2!.value).toEqual({ type: 'number', value: 2 });
  });

  it('填充后的公式进入依赖图：改被引用格只重算受影响格', () => {
    const engine = makeEngine([
      ['A1', '10'],
      ['A2', '30'],
      ['B1', '=A1*2'],
      ['C1', '=100+1'],
    ]);
    engine.recalc();
    engine.fill('down', { top: 0, left: 1, bottom: 1, right: 1 });
    let snap = engine.recalc();
    expect(snap.cells.B2!.raw).toBe('=A2*2');
    // 新公式进入依赖图
    expect(snap.graph.nodes.map((n) => n.id)).toContain('formula@B2');
    expect(snap.cells.B2!.deps).toEqual(['A2']);
    expect(snap.cells.A2!.dependents).toContain('B2');

    // 修改被引用的 A2：只有 A2 和 B2 重算，C1 不动
    engine.setCell(1, 0, '40');
    snap = engine.recalc();
    expect(snap.debug.recalcMode).toBe('incremental');
    expect(snap.cells.B2!.value).toEqual({ type: 'number', value: 80 });
    expect(snap.cells.C1!.value).toEqual({ type: 'number', value: 101 });
    expect(snap.order.map((o) => o.address).sort()).toEqual(['A2', 'B2']);
  });

  it('填充本身也是增量重算：只算新填入的格子及其下游', () => {
    const engine = makeEngine([
      ['A1', '10'],
      ['A2', '30'],
      ['B1', '=A1*2'],
      ['C1', '=100+1'],
    ]);
    engine.recalc();
    engine.fill('down', { top: 0, left: 1, bottom: 1, right: 1 });
    const snap = engine.recalc();
    expect(snap.debug.recalcMode).toBe('incremental');
    // 只有新填入的 B2 被重算；B1、C1 都不在重算顺序里
    expect(snap.order.map((o) => o.address)).toEqual(['B2']);
    expect(snap.cells.B2!.value).toEqual({ type: 'number', value: 60 });
  });
});
