import type { Cue } from './types';
import { parseTimecode } from './time';

/** 每行最大宽度的默认值（可见字素宽度单位） */
export const DEFAULT_MAX_WIDTH = 20;

/**
 * 换行 token：WebVTT 内联标签 / 时间戳标签（不计宽、不可拆开）或单个可见字素。
 * 既有换行符在分词时被丢弃——确认应用时允许「删除换行」，故不参与计宽；
 * 拼接全部 token 的 text 即得去掉换行后的原文（其余字符逐字保留）。
 */
export interface WrapToken {
  /** 原始文本片段（标签整段或单个字素） */
  text: string;
  /** 是否 WebVTT 标签（<b>、</v>、<00:01.500> 等） */
  tag: boolean;
  /** 可见宽度：标签为 0；中文及全角字素为 2；其他为 1 */
  width: number;
}

/** 单条字幕的分行结果 */
export type CueWrapResult =
  | { kind: 'ok'; currentWidths: number[] }
  | { kind: 'suggest'; currentWidths: number[]; text: string; lineWidths: number[] }
  | { kind: 'unsolvable'; currentWidths: number[]; reason: string };

export interface WrapItem {
  id: string;
  result: CueWrapResult;
}

export interface SmartWrapPlan {
  maxWidth: number;
  /** 全部未锁定片段的分行结果（按传入顺序） */
  items: WrapItem[];
  /** 跳过的锁定片段数 */
  lockedCount: number;
  okCount: number;
  suggestCount: number;
  unsolvableCount: number;
}

// ---------- 字素切分 ----------

interface SegmenterLike {
  segment(input: string): Iterable<{ segment: string }>;
}

const segmenter: SegmenterLike | null = (() => {
  const Ctor = (
    Intl as unknown as {
      Segmenter?: new (locales?: string, options?: { granularity: string }) => SegmenterLike;
    }
  ).Segmenter;
  return Ctor ? new Ctor(undefined, { granularity: 'grapheme' }) : null;
})();

/** 按字素（grapheme cluster）切分；无 Intl.Segmenter 时回退为按码点切分 */
export function segmentGraphemes(input: string): string[] {
  if (!input) return [];
  if (segmenter) return Array.from(segmenter.segment(input), (s) => s.segment);
  return Array.from(input);
}

// ---------- 字素宽度 ----------

/** 全角 / 宽字符码点区间（CJK、全角形式、emoji 等），与常见 wcwidth 实现一致 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // 谚文字母
  [0x2329, 0x232a], // 〈 〉
  [0x2e80, 0x303e], // CJK 部首与符号（含表意空格 U+3000、。、「」等）
  [0x3041, 0x33ff], // 假名 / CJK 兼容
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xfe10, 0xfe19], // 竖排形式
  [0xfe30, 0xfe6f], // CJK 兼容形式 / 小写变体
  [0xff00, 0xff60], // 全角形式
  [0xffe0, 0xffe6], // 全角符号
  [0x1f000, 0x1faff], // emoji 等符号块
  [0x20000, 0x2fffd], // CJK 扩展 B 及以后
  [0x30000, 0x3fffd],
];

export function isWideCodePoint(cp: number): boolean {
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/** 单个字素的可见宽度：中文及全角字符计 2，其他计 1（组合字素取成员最大值） */
export function graphemeWidth(g: string): number {
  for (const ch of g) {
    if (isWideCodePoint(ch.codePointAt(0)!)) return 2;
  }
  return 1;
}

// ---------- 标点禁则 ----------

/** 闭合标点：禁止出现在行首（含 CJK 点号/闭括号/闭引号与 ASCII 句读、闭括号） */
const CLOSING_PUNCT = new Set([...'，。、；：？！）〕〗》」』】〙〛”’)]}»,.;:!?']);
/** 开放标点：禁止出现在行尾（开括号与开引号） */
const OPENING_PUNCT = new Set([...'（〔〖《「『【〘〚“‘([{«']);
/** 断点优先级判定：这些标点之后是天然断点 */
const BREAK_AFTER_PUNCT = new Set([...CLOSING_PUNCT, ...'-–—']);

// ---------- 分词 ----------

/**
 * 把 cue 文本切成 token 序列：
 * - `<...>`（内部不含 `<` 与换行）整体作为标签 token，不计宽、不可拆开；
 * - 其余文本按字素切分；
 * - 既有换行符被丢弃（确认时允许删除换行）。
 * 无法配对的 `<` 视为普通字素。
 */
export function tokenizeCueText(text: string): WrapToken[] {
  const tokens: WrapToken[] = [];
  let buf = '';
  const flush = () => {
    if (!buf) return;
    for (const g of segmentGraphemes(buf)) {
      if (g === '\n' || g === '\r') continue;
      tokens.push({ text: g, tag: false, width: graphemeWidth(g) });
    }
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '<') {
      const end = text.indexOf('>', i + 1);
      if (end > i) {
        const inner = text.slice(i + 1, end);
        if (!inner.includes('<') && !inner.includes('\n') && !inner.includes('\r')) {
          flush();
          tokens.push({ text: text.slice(i, end + 1), tag: true, width: 0 });
          i = end + 1;
          continue;
        }
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return tokens;
}

const isSpaceToken = (t: WrapToken) => !t.tag && (t.text === ' ' || t.text === '\t');
const isClosingPunct = (t: WrapToken) => !t.tag && CLOSING_PUNCT.has(t.text);
const isOpeningPunct = (t: WrapToken) => !t.tag && OPENING_PUNCT.has(t.text);

/** 一段 token 的可见宽度：[lo, hi)，标签不计宽，行尾空白不计 */
function rangeWidth(tokens: WrapToken[], lo: number, hi: number): number {
  let end = hi;
  while (end > lo && isSpaceToken(tokens[end - 1])) end--;
  let w = 0;
  for (let k = lo; k < end; k++) w += tokens[k].width;
  return w;
}

/** 单行文本（不含换行）的可见宽度 */
export function visibleLineWidth(line: string): number {
  const tokens = tokenizeCueText(line);
  return rangeWidth(tokens, 0, tokens.length);
}

// ---------- 断点选择 ----------

/** 标签配对类别：时间戳标签自成一体，其余按开/闭标签统计配对深度 */
function tagKind(tagText: string): 'open' | 'close' | 'neutral' {
  const inner = tagText.slice(1, -1).trim();
  if (inner.startsWith('/')) return 'close';
  if (parseTimecode(inner) !== null) return 'neutral';
  return 'open';
}

/**
 * 在 token 序列中寻找最优断点（在 tokens[i] 之后断开），返回 i；无解返回 null。
 *
 * 合法断点要求：
 * - 断点两侧都至少有一个可见字素（行不能只有标签）；
 * - 下一行不以空格开头（空格应留在上一行行尾，其宽度不计）；
 * - 闭合标点不出现在行首、开放标点不出现在行尾；
 * - 两行可见宽度均不超过 maxWidth。
 *
 * 目标（按字典序）：两行宽差最小 → 断点处未闭合标签最少 → 空格/标点后断点
 * 优于词中断点 → 下标最小（保证确定性）。
 */
function bestSplit(tokens: WrapToken[], maxWidth: number): number | null {
  const n = tokens.length;
  // firstCharAfter[i]：大于 i 的第一个非标签 token 下标
  const firstCharAfter = new Array<number>(n).fill(-1);
  let next = -1;
  for (let i = n - 1; i >= 0; i--) {
    firstCharAfter[i] = next;
    if (!tokens[i].tag) next = i;
  }
  // lastCharAtOrBefore[i]：不超过 i 的最后一个非标签 token 下标
  const lastCharAtOrBefore = new Array<number>(n).fill(-1);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (!tokens[i].tag) prev = i;
    lastCharAtOrBefore[i] = prev;
  }

  let balance = 0;
  let best: { index: number; diff: number; bal: number; kind: number } | null = null;
  for (let i = 0; i < n - 1; i++) {
    const t = tokens[i];
    if (t.tag) {
      const k = tagKind(t.text);
      if (k === 'open') balance++;
      else if (k === 'close') balance = Math.max(0, balance - 1);
    }
    const leftLast = lastCharAtOrBefore[i];
    const rightFirst = firstCharAfter[i];
    if (leftLast === -1 || rightFirst === -1) continue;
    if (isSpaceToken(tokens[rightFirst])) continue;
    if (isClosingPunct(tokens[rightFirst])) continue;
    if (isOpeningPunct(tokens[leftLast])) continue;
    const w1 = rangeWidth(tokens, 0, i + 1);
    if (w1 > maxWidth) continue;
    const w2 = rangeWidth(tokens, i + 1, n);
    if (w2 > maxWidth) continue;
    const diff = Math.abs(w1 - w2);
    const kind = isSpaceToken(t) ? 0 : !t.tag && BREAK_AFTER_PUNCT.has(t.text) ? 1 : 2;
    if (
      !best ||
      diff < best.diff ||
      (diff === best.diff && balance < best.bal) ||
      (diff === best.diff && balance === best.bal && kind < best.kind) ||
      (diff === best.diff && balance === best.bal && kind === best.kind && i < best.index)
    ) {
      best = { index: i, diff, bal: balance, kind };
    }
  }
  return best ? best.index : null;
}

// ---------- 单条字幕分行 ----------

/**
 * 为单条字幕计算分行结果：
 * - 当前排版已满足「不超过两行且每行不超宽」→ ok（不改动）；
 * - 否则给出不超过两行的建议文本（仅增删换行，其余字符/标签原样保留）；
 * - 需要超过两行、单字素超宽或受标点禁则限制时 → unsolvable 并给出原因。
 */
export function planCueWrap(text: string, maxWidth: number): CueWrapResult {
  const currentWidths = text.split('\n').map(visibleLineWidth);
  if (currentWidths.length <= 2 && currentWidths.every((w) => w <= maxWidth)) {
    return { kind: 'ok', currentWidths };
  }

  const tokens = tokenizeCueText(text);
  if (tokens.length === 0) return { kind: 'ok', currentWidths };

  // 单字素超宽：任何排版都放不下
  for (const t of tokens) {
    if (!t.tag && t.width > maxWidth) {
      return {
        kind: 'unsolvable',
        currentWidths,
        reason: `单字素超宽：“${t.text}”宽度 ${t.width} 超过每行上限 ${maxWidth}`,
      };
    }
  }

  const total = rangeWidth(tokens, 0, tokens.length);
  if (total <= maxWidth) {
    // 一行放得下：仅删除既有换行，合并为单行
    return { kind: 'suggest', currentWidths, text: tokens.map((t) => t.text).join(''), lineWidths: [total] };
  }

  const split = bestSplit(tokens, maxWidth);
  if (split !== null) {
    const line1 = tokens.slice(0, split + 1).map((t) => t.text).join('');
    const line2 = tokens.slice(split + 1).map((t) => t.text).join('');
    return {
      kind: 'suggest',
      currentWidths,
      text: `${line1}\n${line2}`,
      lineWidths: [rangeWidth(tokens, 0, split + 1), rangeWidth(tokens, split + 1, tokens.length)],
    };
  }

  const needLines = Math.ceil(total / maxWidth);
  if (needLines > 2) {
    return {
      kind: 'unsolvable',
      currentWidths,
      reason: `内容过宽：可见宽度 ${total}，每行上限 ${maxWidth}，至少需要 ${needLines} 行（超过两行）`,
    };
  }
  return {
    kind: 'unsolvable',
    currentWidths,
    reason: '受标点禁则限制（闭合标点不可在行首、开放标点不可在行尾），两行内找不到合法断点',
  };
}

/**
 * 批量分行计划：仅处理未锁定片段（锁定片段计数跳过）。
 * 不修改输入；确认时由调用方把 suggest 项的 text 写回对应 cue。
 */
export function planSmartWrap(cues: Cue[], maxWidth: number): SmartWrapPlan {
  const items: WrapItem[] = [];
  let lockedCount = 0;
  let okCount = 0;
  let suggestCount = 0;
  let unsolvableCount = 0;
  for (const cue of cues) {
    if (cue.locked) {
      lockedCount++;
      continue;
    }
    const result = planCueWrap(cue.text, maxWidth);
    if (result.kind === 'ok') okCount++;
    else if (result.kind === 'suggest') suggestCount++;
    else unsolvableCount++;
    items.push({ id: cue.id, result });
  }
  return { maxWidth, items, lockedCount, okCount, suggestCount, unsolvableCount };
}
