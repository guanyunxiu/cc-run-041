/**
 * 向下 / 向右填充（特性 37）。
 *
 * 规则与 Excel 一致：
 *  - 相对引用（A1）随填充偏移平移：B1==A1*2 填到 B2 => =A2*2
 *  - 绝对引用（$A$1）不动
 *  - 半锁定只动未锁部分：$A1 向下填行变列不变；A$1 向右填列变行不变
 *  - 区域引用整体平移：=SUM(A1:A2) 向下填两行 => =SUM(A3:A4)
 *  - 非公式字面量原样复制
 */
import type { A1Node, RefNode } from './types.js';
import type { Rect } from './address.js';
import { parseFormula } from './parser.js';
import { serializeFormula } from './serialize.js';
import { walkAst, type AstVisitor } from './visitor.js';

/** 将引用按 (dRow, dCol) 平移，$ 锁定的维度不动 */
function shiftRef(node: RefNode, dRow: number, dCol: number): RefNode {
  return {
    ...node,
    row: node.absoluteRow ? node.row : node.row + dRow,
    col: node.absoluteCol ? node.col : node.col + dCol,
  };
}

class ShiftVisitor implements AstVisitor<A1Node> {
  constructor(
    private readonly dRow: number,
    private readonly dCol: number,
  ) {}

  visitNumber(node: Extract<A1Node, { kind: 'number' }>): A1Node {
    return node;
  }
  visitText(node: Extract<A1Node, { kind: 'text' }>): A1Node {
    return node;
  }
  visitBoolean(node: Extract<A1Node, { kind: 'boolean' }>): A1Node {
    return node;
  }
  visitNameError(node: Extract<A1Node, { kind: 'nameError' }>): A1Node {
    return node;
  }
  visitRef(node: Extract<A1Node, { kind: 'ref' }>): A1Node {
    return shiftRef(node, this.dRow, this.dCol);
  }
  visitRange(node: Extract<A1Node, { kind: 'range' }>): A1Node {
    return {
      ...node,
      start: shiftRef(node.start, this.dRow, this.dCol),
      end: shiftRef(node.end, this.dRow, this.dCol),
    };
  }
  visitUnary(node: Extract<A1Node, { kind: 'unary' }>, operand: A1Node): A1Node {
    return { ...node, operand };
  }
  visitPercent(node: Extract<A1Node, { kind: 'percent' }>, operand: A1Node): A1Node {
    return { ...node, operand };
  }
  visitBinary(
    node: Extract<A1Node, { kind: 'binary' }>,
    left: A1Node,
    right: A1Node,
  ): A1Node {
    return { ...node, left, right };
  }
  visitFunction(node: Extract<A1Node, { kind: 'function' }>, args: A1Node[]): A1Node {
    return { ...node, args };
  }
}

/**
 * 平移公式中的相对引用，返回带前导 = 的新公式。
 * dRow / dCol 为目标单元格相对源单元格的偏移。
 */
export function shiftFormula(source: string, dRow: number, dCol: number): string {
  const ast = parseFormula(source);
  const shifted = walkAst(ast, new ShiftVisitor(dRow, dCol));
  return `=${serializeFormula(shifted)}`;
}

export interface FillCell {
  row: number;
  col: number;
  raw: string;
}

/**
 * 计算填充结果：dst 必须是 src 向下或向右延伸后的区域（包含 src）。
 * 源区域为多行/多列时按源尺寸平铺（与 Excel 填充柄一致）。
 * 源为公式 => 相对引用平移；源为字面量或空 => 原样复制。
 */
export function computeFill(
  src: Rect,
  dst: Rect,
  getRaw: (row: number, col: number) => string,
): FillCell[] {
  const srcHeight = src.bottom - src.top + 1;
  const srcWidth = src.right - src.left + 1;
  const fillDown =
    dst.top === src.top &&
    dst.left === src.left &&
    dst.right === src.right &&
    dst.bottom > src.bottom;
  const fillRight =
    dst.left === src.left &&
    dst.top === src.top &&
    dst.bottom === src.bottom &&
    dst.right > src.right;
  if (!fillDown && !fillRight) return [];

  const out: FillCell[] = [];
  const rowBegin = fillDown ? src.bottom + 1 : dst.top;
  const rowEnd = dst.bottom;
  const colBegin = fillRight ? src.right + 1 : dst.left;
  const colEnd = dst.right;

  for (let r = rowBegin; r <= rowEnd; r++) {
    for (let c = colBegin; c <= colEnd; c++) {
      // 目标格映射回源区域中对应的源格（平铺）
      const srcRow = fillDown ? src.top + ((r - src.top) % srcHeight) : r;
      const srcCol = fillRight ? src.left + ((c - src.left) % srcWidth) : c;
      const srcRaw = getRaw(srcRow, srcCol);
      let raw: string;
      if (srcRaw.startsWith('=')) {
        raw = shiftFormula(srcRaw, r - srcRow, c - srcCol);
      } else {
        raw = srcRaw;
      }
      out.push({ row: r, col: c, raw });
    }
  }
  return out;
}
