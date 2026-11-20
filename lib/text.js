// 文本层只做“可逆的观察”：不修改资料中的原字，只为检索建立规范形。
// 所有对外结果都要同时带回原字与原底本，规范形仅用于比对。

const PUNCTUATION = /[\p{P}\p{S}\s]+/gu;
const CLAUSE_BREAK = /[，。；：、！？,.!?;:…—\n\r]+/u;

export function stripPunctuation(text) {
  return String(text).replace(PUNCTUATION, '');
}

export function splitClauses(text) {
  return String(text)
    // 相邻的两个引号片段是两处独立引文，即便中间只用“与/和”连缀，也不能并成一句。
    .replace(/([”」』])\s*(?:以及|与|和|及|、)\s*(?=[“「『])/gu, '$1，')
    .replace(/([”」』])\s*(?=[“「『])/gu, '$1，')
    .split(CLAUSE_BREAK)
    .map(part => part.trim())
    .filter(Boolean);
}

export function stripDecorations(text) {
  return String(text)
    .replace(/[“”‘’"'《》〈〉「」『』【】（）()\[\]]/gu, '')
    .trim();
}

export function extractWorkTitle(text) {
  const match = String(text).match(/《([^》]+)》/u);
  return match ? match[1] : null;
}

export function quotedTerms(text) {
  return [...String(text).matchAll(/“([^”]+)”/gu)].map(match => match[1]);
}

export function longestCommonSubsequenceLength(a, b) {
  const left = [...a];
  const right = [...b];
  if (left.length === 0 || right.length === 0) return 0;
  let previous = new Array(right.length + 1).fill(0);
  for (const leftChar of left) {
    const current = new Array(right.length + 1).fill(0);
    for (let index = 0; index < right.length; index += 1) {
      current[index + 1] = leftChar === right[index]
        ? previous[index] + 1
        : Math.max(previous[index + 1], current[index]);
    }
    previous = current;
  }
  return previous[right.length];
}

export function similarity(a, b) {
  const left = [...a];
  const right = [...b];
  const longest = Math.max(left.length, right.length);
  if (longest === 0) return 1;
  return longestCommonSubsequenceLength(left, right) / longest;
}

// 供“改正一字”与“异文”对照使用：返回逐字的保留/替换/增删。
export function diffCharacters(before, after) {
  const left = [...before];
  const right = [...after];
  const table = Array.from({ length: left.length + 1 }, () =>
    new Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const operations = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      operations.push({ type: 'same', before: left[i], after: right[j], beforeIndex: i, afterIndex: j });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      operations.push({ type: 'delete', before: left[i], after: null, beforeIndex: i, afterIndex: null });
      i += 1;
    } else {
      operations.push({ type: 'insert', before: null, after: right[j], beforeIndex: null, afterIndex: j });
      j += 1;
    }
  }
  while (i < left.length) {
    operations.push({ type: 'delete', before: left[i], after: null, beforeIndex: i, afterIndex: null });
    i += 1;
  }
  while (j < right.length) {
    operations.push({ type: 'insert', before: null, after: right[j], beforeIndex: null, afterIndex: j });
    j += 1;
  }

  // 将紧邻的 delete + insert 合并成一次 replace，便于报告“改一字”。
  const merged = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const next = operations[index + 1];
    if (operation.type === 'delete' && next?.type === 'insert') {
      merged.push({
        type: 'replace',
        before: operation.before,
        after: next.after,
        beforeIndex: operation.beforeIndex,
        afterIndex: next.afterIndex
      });
      index += 1;
    } else {
      merged.push(operation);
    }
  }
  return merged;
}

export function changedOperations(before, after) {
  return diffCharacters(before, after).filter(operation => operation.type !== 'same');
}
