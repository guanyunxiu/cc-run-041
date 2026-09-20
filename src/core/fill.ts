/**
 * 公式填充（特性 37）：向下 / 向右填充时的引用平移。
 *
 * 规则（与 Excel 一致）：
 *  - 相对引用随填充偏移平移：=A1*2 向下填 1 行 => =A2*2
 *  - $ 绝对标记保持不变：=$A$1*2 向下填 => =$A$1*2
 *  - 区域两端各自平移：=SUM(A1:A2) 向下填 2 行 => =SUM(A3:A4)
 *  - 只锁行 A$1：向右填列变、行不变（=B$1）
 *  - 只锁列 $A1：向下填行变、列不变（=$A2）
 *
 * 实现基于 Token 流重写（而非 AST 序列化）：原公式中的空白、
 * 字符串字面量、函数名大小写都原样保留，只有 ref token 被平移，
 * 字符串里的 "A1" 之类的文本不会被误伤。
 */
import { tokenize } from './lexer.js';
import { formatRef, parseRef } from './address.js';
import { FormulaError, type Token } from './types.js';

/** 平移单个引用文本，保留 $ 标记 */
function shiftRefToken(text: string, dRow: number, dCol: number, offset: number): string {
  let parts;
  try {
    parts = parseRef(text, offset);
  } catch {
    // 源公式本身就无法解析的引用（如超出 Excel 列上限）：原样保留
    return text;
  }
  const row = parts.absoluteRow ? parts.row : parts.row + dRow;
  const col = parts.absoluteCol ? parts.col : parts.col + dCol;
  if (row < 0 || col < 0 || row > 1048575 || col > 16383) {
    throw new FormulaError('#REF!', `填充后引用越界: ${text}`, offset, text.length);
  }
  return formatRef({
    row,
    col,
    absoluteRow: parts.absoluteRow,
    absoluteCol: parts.absoluteCol,
  });
}

/**
 * 将公式 raw（含前导 =）按 (dRow, dCol) 平移其中的相对引用。
 * 非公式（字面量、空串）原样返回。
 */
export function translateFormula(raw: string, dRow: number, dCol: number): string {
  if (!raw.startsWith('=')) return raw;
  const body = raw.slice(1);
  let tokens: Token[];
  try {
    tokens = tokenize(body);
  } catch {
    // 词法都无法解析的公式：原样复制
    return raw;
  }
  let out = '=';
  let prev = 0;
  for (const t of tokens) {
    if (t.type === 'eof') break;
    out += body.slice(prev, t.start); // 保留 token 之间的空白
    out += t.type === 'ref' ? shiftRefToken(t.value, dRow, dCol, t.start) : t.value;
    prev = t.end;
  }
  out += body.slice(prev);
  return out;
}
