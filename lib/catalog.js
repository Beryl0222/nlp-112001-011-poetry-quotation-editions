import { readMaterials } from '../materials.js';
import { diffCharacters, stripPunctuation } from './text.js';

const SUPPLEMENT_SUFFIX = /(?:补校|补录|校补|补注|补遗|校记)$/u;
const INDEPENDENT_NOTE = /独立(?:抄录|抄本|录本)|并非[^。]*重录|不是[^。]*重录|别本/u;
const SAME_WITNESS_NOTE = /同一拓片|同一底本|原拓|复校|原校/u;
const CLAIMS_PRIOR_ERROR = /误录|讹|脱[文字]|衍[文字]|倒[文字]|原校[^。]*(?:误|非|错)|订正|改正|当为|应作/u;
const INDEPENDENT_EVIDENCE = /旁证|他本|别本|另一本|独立[^。]*(?:本|证)/u;

const VARIANT_PATTERNS = [
  {
    regex: /[“"]([^”"]+)[”"]\s*为\s*[“"]([^”"]+)[”"]\s*的?\s*(?:异体|异体字|俗字|古字)/gu,
    standardGroup: 2
  },
  {
    regex: /[“"]([^”"]+)[”"]\s*(?:与|同)\s*[“"]([^”"]+)[”"]\s*(?:互为)?\s*(?:异体|异体字|相通|通用)/gu,
    standardGroup: 2
  },
  {
    regex: /([㐀-鿿])为([㐀-鿿])的?异体/gu,
    standardGroup: 2
  }
];

function createUnionFind() {
  const parents = new Map();
  const rank = new Map();
  const find = member => {
    if (!parents.has(member)) {
      parents.set(member, member);
      rank.set(member, 0);
    }
    const parent = parents.get(member);
    if (parent !== member) {
      const root = find(parent);
      parents.set(member, root);
      return root;
    }
    return member;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const leftRank = rank.get(leftRoot) ?? 0;
    const rightRank = rank.get(rightRoot) ?? 0;
    if (leftRank < rightRank) {
      parents.set(leftRoot, rightRoot);
    } else if (leftRank > rightRank) {
      parents.set(rightRoot, leftRoot);
    } else {
      parents.set(rightRoot, leftRoot);
      rank.set(leftRoot, leftRank + 1);
    }
  };
  return { find, union };
}

function parseVariantFamilies(noteRows) {
  const unionFind = createUnionFind();
  const standardPreferences = new Map();
  const sourcesByMember = new Map();
  const editionsByMember = new Map();

  for (const row of noteRows) {
    for (const { regex, standardGroup } of VARIANT_PATTERNS) {
      const matcher = new RegExp(regex.source, regex.flags);
      for (const match of row.text.matchAll(matcher)) {
        const members = [match[1], match[2]]
          .flatMap(value => [...value])
          .filter(character => character.length === 1);
        if (members.length < 2) continue;
        for (const member of members) {
          unionFind.union(members[0], member);
          if (!sourcesByMember.has(member)) sourcesByMember.set(member, new Set());
          sourcesByMember.get(member).add(row.id);
          if (!editionsByMember.has(member)) editionsByMember.set(member, new Set());
          editionsByMember.get(member).add(row.edition);
        }
        const preferred = [...match[standardGroup]].filter(character => character.length === 1);
        for (const member of preferred) {
          if (!standardPreferences.has(member)) standardPreferences.set(member, row.id);
        }
      }
    }
  }

  const groups = new Map();
  for (const member of sourcesByMember.keys()) {
    const root = unionFind.find(member);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(member);
  }

  const families = [];
  const variantMap = new Map();
  let index = 0;
  for (const members of groups.values()) {
    index += 1;
    const sorted = [...members].sort((left, right) => left.localeCompare(right, 'zh'));
    const canonical = sorted.find(member => standardPreferences.has(member)) ?? sorted[0];
    const sourceIds = [...new Set(sorted.flatMap(member => [...(sourcesByMember.get(member) ?? [])]))].sort();
    const editions = [...new Set(sorted.flatMap(member => [...(editionsByMember.get(member) ?? [])]))].sort();
    const family = {
      id: `vf${index}`,
      members: sorted,
      canonical,
      sourceIds,
      editions,
      note: noteRows
        .filter(row => sourceIds.includes(row.id))
        .map(row => `${row.id}：${row.text}`)
        .join('；')
    };
    families.push(family);
    for (const member of sorted) variantMap.set(member, canonical);
    for (const member of sorted) variantMap.set(canonical, canonical);
  }

  return { families, variantMap };
}

function groupNotesByEdition(noteRows) {
  const grouped = new Map();
  for (const row of noteRows) {
    if (!grouped.has(row.edition)) grouped.set(row.edition, []);
    grouped.get(row.edition).push(row);
  }
  return grouped;
}

function inferEdition(name, noteRows, allEditionNames) {
  const noteText = noteRows.map(row => row.text).join(' ');
  const noteIds = noteRows.map(row => row.id);
  const parentName = name.replace(SUPPLEMENT_SUFFIX, '');
  const isSupplement = parentName !== name && allEditionNames.includes(parentName);
  const independent = INDEPENDENT_NOTE.test(noteText);
  const sameWitness = isSupplement && SAME_WITNESS_NOTE.test(noteText);
  let kind = 'base';
  if (isSupplement) kind = 'supplement';
  else if (independent) kind = 'independent';

  const relation = isSupplement
    ? {
        kind: sameWitness ? 'same-witness-supplement' : 'supplement',
        parent: parentName,
        claim: CLAIMS_PRIOR_ERROR.test(noteText) ? 'proves-prior-error' : 'unresolved',
        basis: noteText,
        sourceIds: noteIds
      }
    : independent
      ? {
          kind: 'independent-witness',
          parent: null,
          claim: 'independent-reading',
          basis: noteText,
          sourceIds: noteIds
        }
      : {
          kind: 'base-text',
          parent: null,
          claim: 'base-reading',
          basis: noteText,
          sourceIds: noteIds
        };

  return {
    name,
    kind,
    parent: isSupplement ? parentName : null,
    witnessGroup: isSupplement ? parentName : name,
    note: noteText,
    noteIds,
    relation,
    claimsPriorError: CLAIMS_PRIOR_ERROR.test(noteText),
    hasIndependentEvidence: INDEPENDENT_EVIDENCE.test(noteText)
  };
}

function parseLineNumber(row) {
  const value = Number(row.line);
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`校录.json 记录 ${row.id} 的 line 应为正整数`);
  }
  return value;
}

function sameVariantFamily(variantMap, left, right) {
  const leftCanonical = variantMap.get(left);
  const rightCanonical = variantMap.get(right);
  return leftCanonical !== undefined &&
    rightCanonical !== undefined &&
    leftCanonical === rightCanonical;
}

function isSubstantiveOperation(operation, variantMap) {
  if (operation.type === 'same') return false;
  if (operation.type === 'replace' &&
      sameVariantFamily(variantMap, operation.before, operation.after)) {
    return false;
  }
  return true;
}

export function buildCatalog(tables) {
  const lineRows = tables['校录.json'] ?? [];
  const noteRows = tables['字形与底本.json'] ?? [];
  const scriptRows = tables['讲解稿.json'] ?? [];

  const { families, variantMap } = parseVariantFamilies(noteRows);
  const normalizeText = text => [...String(text)]
    .map(character => variantMap.get(character) ?? character)
    .join('');

  const notesByEdition = groupNotesByEdition(noteRows);
  const editionNames = [...new Set([
    ...lineRows.map(row => row.edition),
    ...noteRows.map(row => row.edition)
  ])].sort((left, right) => left.localeCompare(right, 'zh'));

  const editions = new Map();
  for (const name of editionNames) {
    editions.set(name, inferEdition(name, notesByEdition.get(name) ?? [], editionNames));
  }

  const lines = [];
  const seen = new Set();
  for (const row of lineRows) {
    const lineNumber = parseLineNumber(row);
    const key = `${row.work}\u0000${row.edition}\u0000${lineNumber}`;
    if (seen.has(key)) {
      throw new TypeError(`校录.json 记录 ${row.id} 与同作品同底本的第 ${lineNumber} 行重复`);
    }
    seen.add(key);
    const plainText = stripPunctuation(row.text);
    if (plainText.length === 0) {
      throw new TypeError(`校录.json 记录 ${row.id} 的 text 去除标点后为空`);
    }
    const searchChars = [...plainText];
    const normalizedChars = searchChars.map(character => variantMap.get(character) ?? character);
    lines.push({
      id: row.id,
      work: row.work,
      edition: row.edition,
      line: lineNumber,
      lineLabel: row.line,
      text: row.text,
      plainText,
      searchChars,
      normalizedChars,
      searchText: normalizedChars.join(''),
      editionInfo: editions.get(row.edition),
      hasPunctuation: plainText !== row.text
    });
  }

  lines.sort((left, right) =>
    left.work.localeCompare(right.work, 'zh') ||
    left.edition.localeCompare(right.edition, 'zh') ||
    left.line - right.line);

  const linesById = new Map(lines.map(line => [line.id, line]));
  const linesByWork = new Map();
  for (const line of lines) {
    if (!linesByWork.has(line.work)) linesByWork.set(line.work, []);
    linesByWork.get(line.work).push(line);
  }

  const works = new Map();
  for (const [workName, workLines] of [...linesByWork.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'zh'))) {
    const byEdition = new Map();
    for (const line of workLines) {
      if (!byEdition.has(line.edition)) byEdition.set(line.edition, new Map());
      byEdition.get(line.edition).set(line.line, line);
    }
    const maxLine = Math.max(...workLines.map(line => line.line));
    const editionStates = [...byEdition.entries()]
      .sort(([left], [right]) => left.localeCompare(right, 'zh'))
      .map(([editionName, lineMap]) => {
        const present = [...lineMap.keys()].sort((left, right) => left - right);
        const missing = [];
        for (let number = 1; number <= maxLine; number += 1) {
          if (!lineMap.has(number)) missing.push(number);
        }
        return {
          edition: editionName,
          lines: lineMap,
          present,
          missing,
          complete: missing.length === 0,
          span: present.length === 0
            ? null
            : { from: present[0], to: present[present.length - 1] },
          editionInfo: editions.get(editionName)
        };
      });

    // 跨行引文必须落在同一底本的连续行内。这里保留全部连续行段，
    // 以便任意起止行都能找到同底本依据，而不必跨底本拼接。
    const runs = [];
    for (const state of editionStates) {
      const numbers = [...state.lines.keys()].sort((left, right) => left - right);
      for (let start = 0; start < numbers.length; start += 1) {
        for (let end = start + 1; end < numbers.length; end += 1) {
          if (numbers[end] !== numbers[end - 1] + 1) break;
          runs.push(numbers.slice(start, end + 1).map(number => state.lines.get(number)));
        }
      }
    }

    works.set(workName, {
      name: workName,
      maxLine,
      lines: workLines,
      editions: editionStates,
      completeEditions: editionStates.filter(state => state.complete),
      incompleteEditions: editionStates.filter(state => !state.complete),
      runs
    });
  }

  const getLine = (work, edition, line) => {
    const workEntry = works.get(work);
    if (!workEntry) return null;
    const state = workEntry.editions.find(item => item.edition === edition);
    if (!state) return null;
    return state.lines.get(Number(line)) ?? null;
  };

  const citationFor = (line, endLine = line) => {
    const range = endLine.line === line.line
      ? `第${line.line}行`
      : `第${line.line}–${endLine.line}行`;
    return `《${line.work}》${line.edition}${range}`;
  };

  const couplets = [];
  for (const work of works.values()) {
    for (const state of work.completeEditions) {
      const text = [...state.lines.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, line]) => line);
      couplets.push({
        work: work.name,
        edition: state.edition,
        lines: text,
        from: text[0].line,
        to: text[text.length - 1].line,
        text: text.map(line => line.text).join('\n'),
        inlineText: text.map(line => line.text).join('，'),
        citation: citationFor(text[0], text[text.length - 1])
      });
    }
  }

  const findEdition = name => {
    if (editions.has(name)) return editions.get(name);
    return null;
  };

  // 同一见证内部（如同一拓片的原录与补校）的差异才有资格称为“勘误”；
  // 不同见证之间的差异只能作为独立异文并列。
  const corrections = [];
  for (const work of works.values()) {
    for (let number = 1; number <= work.maxLine; number += 1) {      const readings = work.lines
        .filter(line => line.line === number)
        .sort((left, right) => {
          const leftInfo = editions.get(left.edition);
          const rightInfo = editions.get(right.edition);
          const leftOrder = leftInfo.kind === 'supplement' ? 1 : 0;
          const rightOrder = rightInfo.kind === 'supplement' ? 1 : 0;
          return leftOrder - rightOrder || left.edition.localeCompare(right.edition, 'zh');
        });
      const groups = new Map();
      for (const reading of readings) {
        const group = editions.get(reading.edition).witnessGroup;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(reading);
      }
      for (const groupReadings of groups.values()) {
        if (groupReadings.length < 2) continue;
        const base = groupReadings.find(reading => editions.get(reading.edition).kind !== 'supplement')
          ?? groupReadings[0];
        for (const other of groupReadings) {
          if (other === base) continue;
          const operations = diffCharacters(base.plainText, other.plainText)
            .filter(operation => operation.type !== 'same');
          const substantive = operations.filter(operation =>
            isSubstantiveOperation(operation, variantMap));
          if (substantive.length === 0) continue;
          const otherInfo = editions.get(other.edition);
          corrections.push({
            work: work.name,
            line: number,
            baseEdition: base.edition,
            baseText: base.text,
            baseId: base.id,
            otherEdition: other.edition,
            otherText: other.text,
            otherId: other.id,
            operations,
            substantiveOperations: substantive,
            sameWitness: true,
            claimsPriorError: otherInfo.claimsPriorError,
            hasIndependentEvidence: otherInfo.hasIndependentEvidence,
            sourceIds: [...new Set([...(otherInfo.noteIds ?? []), base.id, other.id])],
            note: otherInfo.note,
            classification: otherInfo.claimsPriorError ? 'correction' : 'same-witness-variant'
          });
        }
      }
    }
  }

  const correctionsByLine = new Map();
  for (const correction of corrections) {
    const key = `${correction.work}\u0000${correction.line}`;
    if (!correctionsByLine.has(key)) correctionsByLine.set(key, []);
    correctionsByLine.get(key).push(correction);
  }

  const editionAliases = new Map();
  for (const name of editionNames) {
    editionAliases.set(name, name);
    const compact = name.replace(/\s+/gu, '');
    if (!editionAliases.has(compact)) editionAliases.set(compact, name);
    const parent = editions.get(name).parent;
    if (parent && name.startsWith(parent)) {
      const short = name.slice(parent.length).replace(/^[·・\-—]/u, '');
      if (short && !editionAliases.has(short)) editionAliases.set(short, name);
    }
  }

  const catalog = {
    tables,
    lineRows,
    noteRows,
    scriptRows,
    editions,
    editionNames,
    editionAliases,
    works,
    lines,
    linesById,
    couples: couplets,
    couplesByWork: new Map(
      [...works.keys()].map(work => [work, couplets.filter(couplet => couplet.work === work)])
    ),
    variantFamilies: families,
    variantMap,
    corrections,
    correctionsByLine,
    normalizeText,
    getLine,
    getWork: work => works.get(work) ?? null,
    getEdition: findEdition,
    resolveEdition: name => editionAliases.get(String(name).trim()) ?? null,
    citationFor,
    lineHasSameWitnessPair: (work, line) =>
      (correctionsByLine.get(`${work}\u0000${Number(line)}`) ?? []).length > 0
  };

  catalog.couplets = couplets;
  catalog.isSubstantiveOperation = operation =>
    isSubstantiveOperation(operation, variantMap);
  return catalog;
}

export async function loadCatalog(directory) {
  return buildCatalog(await readMaterials(directory));
}
