/**
 * Worker 消息协议（技术 5：postMessage 通信）。
 *
 * 主线程 -> Worker：编辑单元格 / 批量加载 / 填充 / 切换拓扑算法 / 请求重算
 * Worker -> 主线程：快照
 */
import type { EngineSnapshot } from '../core/types.js';
import type { Rect } from '../core/address.js';

export type WorkerRequest =
  | {
      type: 'set-cell';
      row: number;
      col: number;
      raw: string;
    }
  | {
      type: 'load';
      entries: Array<{ row: number; col: number; raw: string }>;
    }
  | {
      /** 以区域首行/首列为源填充，相对引用随偏移平移（特性 37） */
      type: 'fill';
      direction: 'down' | 'right';
      range: Rect;
    }
  | {
      type: 'set-algorithm';
      algorithm: 'kahn' | 'dfs';
    }
  | { type: 'recalc' };

export type WorkerResponse =
  | { type: 'snapshot'; snapshot: EngineSnapshot; requestId: number }
  | { type: 'ready' };
