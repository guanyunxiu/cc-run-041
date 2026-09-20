/**
 * AST 序列化器：把公式 AST 还原为可重新解析的公式字符串（不含前导 =）。
 *
 * 解析阶段丢弃了括号，因此序列化时按优先级重新补括号，
 * 保证 `=(A1+B1)*2` 不会被错误还原成 `=A1+B1*2`。
 * 优先级与 parser.ts 的 Pratt 绑定力一一对应。
 */
import type { A1Node, BinaryOperator } from './types.js';
import { formatRef } from './address.js';

/** 优先级：数值越大结合越紧（atom 最大） */
const PREC = {
  comparison: 1,
  concat: 2,
  additive: 3,
  multiplicative: 4,
  exponent: 5,
  unary: 6,
  percent: 7,
  atom: 8,
} as const;

function binaryPrec(op: BinaryOperator): number {
  switch (op) {
    case '=':
    case '<>':
    case '<':
    case '<=':
    case '>':
    case '>=':
      return PREC.comparison;
    case '&':
      return PREC.concat;
    case '+':
    case '-':
      return PREC.additive;
    case '*':
    case '/':
      return PREC.multiplicative;
    case '^':
      return PREC.exponent;
  }
}

/** 序列化节点，返回 [文本, 优先级] */
function serialize(node: A1Node): [text: string, prec: number] {
  switch (node.kind) {
    case 'number':
      return [String(node.value), PREC.atom];
    case 'text':
      return [`"${node.value.replace(/"/g, '""')}"`, PREC.atom];
    case 'boolean':
      return [node.value ? 'TRUE' : 'FALSE', PREC.atom];
    case 'ref':
      return [
        formatRef({
          col: node.col,
          row: node.row,
          absoluteCol: node.absoluteCol,
          absoluteRow: node.absoluteRow,
        }),
        PREC.atom,
      ];
    case 'range': {
      const s = formatRef({
        col: node.start.col,
        row: node.start.row,
        absoluteCol: node.start.absoluteCol,
        absoluteRow: node.start.absoluteRow,
      });
      const e = formatRef({
        col: node.end.col,
        row: node.end.row,
        absoluteCol: node.end.absoluteCol,
        absoluteRow: node.end.absoluteRow,
      });
      return [`${s}:${e}`, PREC.atom];
    }
    case 'nameError':
      return [node.name, PREC.atom];
    case 'unary': {
      const [operand, op] = serialize(node.operand);
      const text = op < PREC.unary ? `(${operand})` : operand;
      return [`${node.operator}${text}`, PREC.unary];
    }
    case 'percent': {
      const [operand, op] = serialize(node.operand);
      const text = op < PREC.percent ? `(${operand})` : operand;
      return [`${text}%`, PREC.percent];
    }
    case 'binary': {
      const p = binaryPrec(node.operator);
      const rightAssoc = node.operator === '^';
      const [ls, lp] = serialize(node.left);
      const [rs, rp] = serialize(node.right);
      // 左操作数：右结合运算符同级需要括号（(2^3)^4 ≠ 2^3^4）
      const l = lp < p || (lp === p && rightAssoc) ? `(${ls})` : ls;
      // 右操作数：左结合运算符同级需要括号（A1-(B1-C1) ≠ A1-B1-C1）
      const r = rp < p || (rp === p && !rightAssoc) ? `(${rs})` : rs;
      return [`${l}${node.operator}${r}`, p];
    }
    case 'function':
      return [
        `${node.name}(${node.args.map((a) => serialize(a)[0]).join(',')})`,
        PREC.atom,
      ];
  }
}

/** 序列化为公式文本（不含前导 =） */
export function serializeFormula(ast: A1Node): string {
  return serialize(ast)[0];
}
