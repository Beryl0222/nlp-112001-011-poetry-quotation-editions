import {
  changedOperations,
  extractWorkTitle,
  similarity,
  splitClauses,
  stripDecorations
} from './text.js';

const NARRATION_PREFIX = /^(?:上句|下句|后一联|前一联|上联|下联|首句|末句|此句|本句|这里|其中|诗中说|诗里说|诗云|所谓|即|也就是|意思是说?|说的是|写的是|写|说|指|讲|提到|意为|一作|又作|或作|底本作|原校作|补校作)+/u;
const PARAPHRASE_THRESHOLD = 0.6;
const MIN_FRAGMENT = 3;
const MIN_EMBEDDED_LINE = 4;

const RELATION_PRIORITY = {
  exact: 4,
  'quotes-line': 3,
  fragment: 2
};

function charsOf(text) {
  return [...String(text)];
}

function charsEqual(left, right) {
  return left.length === right.length && left.every((char, index) => char === right[index]);
}

function indexOfChars(haystack, needle) {
  if (needle.length === 0) return 0;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

function lineNumberList(lines) {
  return lines.map(line => line.line);
}

function isConsecutive(numbers) {
  return numbers.every((number, index) => index === 0 || number === numbers[index - 1] + 1);
}

export function glyphDifference(line, offset, length, rawQueryChars) {
  const rawLineChars = charsOf(line.text).filter(character => !/[\p{P}\p{S}\s]/u.test(character));
  const differences = [];
  const limit = Math.min(length, rawQueryChars.length);
  for (let index = 0; index < limit; index += 1) {
    const editionGlyph = rawLineChars[offset + index];
    const queryGlyph = rawQueryChars[index];
    if (editionGlyph !== queryGlyph) {
      differences.push({
        position: index + 1,
        editionGlyph,
        queryGlyph
      });
    }
  }
  return differences;
}

function candidateFor(line, rawClause, normalizedClause) {
  const clauseNormChars = normalizedClause;
  const lineChars = line.normalizedChars;
  let relation = null;
  let offset = 0;
  let length = 0;

  if (charsEqual(lineChars, clauseNormChars)) {
    relation = 'exact';
    offset = 0;
    length = lineChars.length;
  } else if (lineChars.length >= MIN_EMBEDDED_LINE) {
    const embedded = indexOfChars(clauseNormChars, lineChars);
    if (embedded >= 0) {
      relation = 'quotes-line';
      offset = 0;
      length = lineChars.length;
    }
  }

  if (!relation && clauseNormChars.length >= MIN_FRAGMENT) {
    const inside = indexOfChars(lineChars, clauseNormChars);
    if (inside >= 0) {
      relation = 'fragment';
      offset = inside;
      length = clauseNormChars.length;
    }
  }

  if (!relation) return null;

  const plainChars = charsOf(line.plainText);
  const rawClauseChars = charsOf(rawClause);
  let queryRawChars;
  if (relation === 'quotes-line') {
    // 整行被夹在白话叙述中时，按行首在白话中的位置截取原字。
    const embedded = indexOfChars(clauseNormChars, lineChars);
    queryRawChars = rawClauseChars.slice(embedded, embedded + length);
  } else {
    queryRawChars = rawClauseChars;
  }
  const differences = glyphDifference(line, offset, length, queryRawChars);
  const viaVariant = differences.length > 0;

  return {
    line,
    relation,
    offset,
    length,
    queryChars: queryRawChars,
    differences,
    viaVariant,
    rawGlyphExact: !viaVariant,
    declaredMatch: null,
    plainChars
  };
}

function prepareClauses(catalog, rawText) {
  const declaredWork = extractWorkTitle(rawText);
  // 书名号须整体去掉，不能先剥符号再删，否则“《渡曲》”会留下“渡曲”混入检索词。
  // 引号保留到分句之后，才能把相邻的两处独立引文拆开。
  const body = rawText.replace(/《[^》]*》/gu, '');
  const clauses = splitClauses(body)
    .map(clause => stripDecorations(clause))
    .filter(clause => charsOf(clause).length > 0);
  return { declaredWork, clauses, body };
}

function collectCandidates(catalog, rawClause, options) {
  const clauseChars = charsOf(rawClause);
  const normalizedClause = clauseChars.map(character =>
    catalog.variantMap.get(character) ?? character);
  const candidates = [];
  const allowedWorks = options.works ?? null;
  const allowedEditions = options.editions ?? null;
  for (const line of catalog.lines) {
    if (allowedWorks && !allowedWorks.has(line.work)) continue;
    if (allowedEditions && !allowedEditions.has(line.edition)) continue;
    const candidate = candidateFor(line, rawClause, normalizedClause);
    if (!candidate) continue;
    candidate.clause = rawClause;
    candidate.normalizedClause = normalizedClause.join('');
    candidate.declaredMatch = options.declaredWork
      ? line.work === options.declaredWork
      : null;
    if (options.declaredWork) {
      candidate.priority = (line.work === options.declaredWork ? 10 : 0) +
        RELATION_PRIORITY[candidate.relation];
    } else {
      candidate.priority = RELATION_PRIORITY[candidate.relation];
    }
    candidates.push(candidate);
  }
  candidates.sort((left, right) =>
    right.priority - left.priority ||
    Number(left.viaVariant) - Number(right.viaVariant) ||
    left.line.line - right.line.line ||
    left.offset - right.offset ||
    left.line.edition.localeCompare(right.line.edition, 'zh'));
  return candidates;
}

function solveEditionChains(clauses, candidatesByClause, workName, editionName) {
  const solutions = [];
  const chosen = [];

  const walk = (clauseIndex, previous) => {
    if (solutions.length >= 200) return;
    if (clauseIndex === clauses.length) {
      solutions.push([...chosen]);
      return;
    }
    const candidates = candidatesByClause[clauseIndex].filter(candidate =>
      candidate.line.work === workName && candidate.line.edition === editionName);
    for (const candidate of candidates) {
      const number = candidate.line.line;
      let accepted = false;
      if (!previous) {
        accepted = true;
      } else if (number === previous.number + 1) {
        accepted = true;
      } else if (
        number === previous.number &&
        candidate.relation === 'fragment' &&
        previous.relation === 'fragment' &&
        candidate.offset >= previous.offset + previous.length
      ) {
        accepted = true;
      }
      if (!accepted) continue;
      chosen.push(candidate);
      walk(clauseIndex + 1, {
        number,
        relation: candidate.relation,
        offset: candidate.offset,
        length: candidate.length
      });
      chosen.pop();
    }
  };

  walk(0, null);

  const seen = new Set();
  const unique = [];
  for (const solution of solutions) {
    const lines = [];
    for (const candidate of solution) {
      if (!lines.includes(candidate.line)) lines.push(candidate.line);
    }
    const key = lines.map(line => line.line).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ solution, lines });
  }
  unique.sort((left, right) => {
    const leftExact = left.solution.filter(candidate => candidate.relation === 'exact').length;
    const rightExact = right.solution.filter(candidate => candidate.relation === 'exact').length;
    const leftVariant = left.solution.filter(candidate => candidate.viaVariant).length;
    const rightVariant = right.solution.filter(candidate => candidate.viaVariant).length;
    return rightExact - leftExact || leftVariant - rightVariant ||
      left.lines.length - right.lines.length ||
      left.lines[0].line - right.lines[0].line;
  });
  return unique;
}

function buildClaim(catalog, work, editionState, solution, lines) {
  const editionInfo = editionState.editionInfo;
  const from = lines[0].line;
  const to = lines[lines.length - 1].line;
  const reasons = [];
  const variantNotes = [];
  let fragment = false;
  let embedded = false;
  let exact = true;

  for (const candidate of solution) {
    const line = candidate.line;
    if (candidate.relation === 'fragment') {
      fragment = true;
      exact = false;
      reasons.push(`所查为第${line.line}行第${candidate.offset + 1}–${candidate.offset + candidate.length}字`);
    } else if (candidate.relation === 'quotes-line') {
      embedded = true;
      reasons.push(`句中包含${editionState.edition}第${line.line}行全文`);
    } else {
      reasons.push(`${editionState.edition}第${line.line}行逐字相同（标点不计）`);
    }
    for (const difference of candidate.differences) {
      variantNotes.push({
        line: line.line,
        editionGlyph: difference.editionGlyph,
        queryGlyph: difference.queryGlyph,
        note: `底本第${line.line}行作“${difference.editionGlyph}”，所查作“${difference.queryGlyph}”，二字同属异体字族；展示以底本原字为准。`
      });
    }
  }

  if (variantNotes.length > 0) {
    reasons.push('经异体字归一后才与底本相合，实际字形见下');
  }

  const citation = catalog.citationFor(lines[0], lines[lines.length - 1]);
  return {
    work,
    edition: editionState.edition,
    editionKind: editionInfo.kind,
    editionParent: editionInfo.parent,
    from,
    to,
    lines: lines.map(line => ({
      id: line.id,
      line: line.line,
      text: line.text,
      plainText: line.plainText
    })),
    text: lines.map(line => line.text).join('\n'),
    inlineText: lines.map(line => line.text).join('，'),
    citation,
    reasons,
    variantNotes,
    fragment,
    embedded,
    exact,
    viaVariant: variantNotes.length > 0,
    matchKind: fragment ? 'fragment' : lines.length > 1 ? 'couplet' : 'line',
    lineNumbers: lineNumberList(lines),
    clauses: solution.map(candidate => candidate.clause),
    spans: solution.map(candidate => ({
      line: candidate.line.line,
      relation: candidate.relation,
      offset: candidate.offset,
      length: candidate.length
    }))
  };
}

function claimKey(claim) {
  return `${claim.work}\u0000${claim.edition}\u0000${claim.from}-${claim.to}`;
}

function bestCandidatePerClause(candidatesByClause) {
  return candidatesByClause.map(candidates => {
    if (candidates.length === 0) return null;
    const exactGlyph = candidates.find(candidate => !candidate.viaVariant);
    return exactGlyph ?? candidates[0];
  });
}

function paraphraseCandidates(catalog, clause, options, limit = 3) {
  const clean = stripDecorations(clause).replace(NARRATION_PREFIX, '');
  const cleanChars = charsOf(clean);
  if (cleanChars.length < MIN_FRAGMENT) return [];
  const allowedWorks = options.works ?? null;
  const scored = [];
  for (const line of catalog.lines) {
    if (allowedWorks && !allowedWorks.has(line.work)) continue;
    const score = similarity(clean, line.plainText);
    if (score < PARAPHRASE_THRESHOLD) continue;
    scored.push({
      line,
      score,
      nonLiteral: true,
      note: `近似白话改写（相似度 ${score.toFixed(2)}），仅供理解，不能作为原文引用。`
    });
  }
  scored.sort((left, right) => right.score - left.score || left.line.line - right.line.line);
  return scored.slice(0, limit);
}

function searchClaims(catalog, clauses, candidatesByClause, workFilter) {
  const claims = [];
  for (const work of catalog.works.values()) {
    if (workFilter && work.name !== workFilter) continue;
    for (const editionState of work.editions) {
      const solutions = solveEditionChains(clauses, candidatesByClause, work.name, editionState.edition);
      for (const solution of solutions) {
        claims.push(buildClaim(catalog, work.name, editionState, solution.solution, solution.lines));
      }
    }
  }

  const uniqueClaims = [];
  const seenClaims = new Set();
  for (const claim of claims) {
    const key = claimKey(claim);
    if (seenClaims.has(key)) continue;
    seenClaims.add(key);
    uniqueClaims.push(claim);
  }
  uniqueClaims.sort((left, right) =>
    Number(right.exact) - Number(left.exact) ||
    Number(left.viaVariant) - Number(right.viaVariant) ||
    left.from - right.from ||
    left.edition.localeCompare(right.edition, 'zh'));
  return uniqueClaims;
}

export function analyzeText(catalog, rawText, options = {}) {
  const { declaredWork, clauses } = prepareClauses(catalog, rawText);
  const effectiveWork = options.work ?? declaredWork;
  const workEntry = effectiveWork ? catalog.getWork(effectiveWork) : null;
  const contextOptions = {
    declaredWork: effectiveWork,
    works: workEntry ? new Set([effectiveWork]) : null,
    editions: options.edition ? new Set([catalog.resolveEdition(options.edition) ?? options.edition]) : null
  };

  if (clauses.length === 0) {
    return {
      query: rawText,
      declaredWork: effectiveWork,
      clauses,
      status: 'empty',
      claims: [],
      fragments: [],
      unresolved: [],
      warnings: [],
      paraphraseCandidates: [],
      notes: ['查询中没有可检索的正文。']
    };
  }

  const candidatesByClause = clauses.map(clause =>
    collectCandidates(catalog, clause, {
      ...contextOptions,
      declaredWork: effectiveWork
    }));

  const warnings = [];

  // 先求整段引文可否在同一底本的连续行中得到完整依据。
  const uniqueClaims = searchClaims(catalog, clauses, candidatesByClause, effectiveWork);

  // 若按标注作品查不到，另行检查其他作品：这往往正是“伪出处”的来源。
  const otherWorkClaims = [];
  if (effectiveWork && uniqueClaims.length === 0) {
    const unconstrained = clauses.map(clause =>
      collectCandidates(catalog, clause, {
        declaredWork: null,
        works: null,
        editions: contextOptions.editions
      }));
    const found = searchClaims(catalog, clauses, unconstrained, null);
    for (const claim of found) {
      if (claim.work !== effectiveWork) otherWorkClaims.push(claim);
    }
  }

  const completeClaims = uniqueClaims.filter(claim =>
    claim.spans.length === clauses.length &&
    claim.spans.every(span => span.relation !== 'fragment'));
  const fragmentClaims = uniqueClaims.filter(claim => claim.fragment);

  const fragments = uniqueClaims
    .filter(claim => claim.fragment)
    .map(claim => ({
      work: claim.work,
      edition: claim.edition,
      line: claim.lines[0]?.line,
      text: claim.lines[0]?.text,
      citation: claim.citation,
      note: '所查只是该行的一部分；海报引文应引全行。',
      reasons: claim.reasons
    }));

  // 逐句找最佳落点，用来解释“为何不能拼成一条”。
  const perClause = bestCandidatePerClause(candidatesByClause);
  const unresolved = clauses
    .map((clause, index) => ({ clause, candidate: perClause[index] }))
    .filter(entry => !entry.candidate)
    .map(entry => entry.clause);

  if (completeClaims.length === 0) {
    const covered = perClause.filter(Boolean);
    if (covered.length === clauses.length) {
      const editions = [...new Set(covered.map(candidate => candidate.line.edition))];
      const works = [...new Set(covered.map(candidate => candidate.line.work))];
      const numbers = covered.map(candidate => candidate.line.line);
      if (editions.length > 1) {
        warnings.push({
          code: 'MIXED_EDITIONS',
          message: '各句分别见于不同底本，任一底本都没有刊载这一整联；不能拼成一条引文。',
          detail: covered.map((candidate, index) => ({
            clause: clauses[index],
            work: candidate.line.work,
            edition: candidate.line.edition,
            line: candidate.line.line,
            text: candidate.line.text
          }))
        });
      } else if (works.length > 1) {
        warnings.push({
          code: 'MIXED_WORKS',
          message: '各句分别见于不同作品，不能当作同一首诗的整联。',
          detail: covered.map((candidate, index) => ({
            clause: clauses[index],
            work: candidate.line.work,
            edition: candidate.line.edition,
            line: candidate.line.line,
            text: candidate.line.text
          }))
        });
      } else if (!isConsecutive(numbers)) {
        warnings.push({
          code: 'NON_CONTIGUOUS',
          message: '所查各行在原底本中并不相邻，分行引用时不能略去中间行。',
          detail: numbers
        });
      }
    }
  }

  const workMismatch = otherWorkClaims;
  if (workMismatch.length > 0) {
    const matchedClauses = [...new Set(workMismatch.flatMap(claim => claim.clauses ?? []))];
    warnings.push({
      code: 'OTHER_WORK_EVIDENCE',
      message: `所查字句的原文依据不在《${effectiveWork}》，而在另一作品；按《${effectiveWork}》检索会指向伪出处。`,
      detail: workMismatch.map(claim => ({
        work: claim.work,
        edition: claim.edition,
        line: claim.lines[0]?.line,
        to: claim.lines[claim.lines.length - 1]?.line,
        text: claim.lines.map(line => line.text).join('，'),
        citation: claim.citation,
        clauses: claim.clauses ?? []
      })),
      clauses: matchedClauses
    });
  }

  const variantOnly = uniqueClaims.length > 0 && uniqueClaims.every(claim => claim.viaVariant);
  const fragmentOnly = uniqueClaims.length > 0 && fragmentClaims.length === uniqueClaims.length;

  // 逐句可核实的依据（即便整段不能拼成一条，也要让读者看到每句各自落在哪一版哪一行）。
  const clauseEvidence = clauses.map((clause, index) => {
    const candidates = candidatesByClause[index];
    const fallback = effectiveWork && candidates.length === 0
      ? collectCandidates(catalog, clause, { declaredWork: null, works: null, editions: contextOptions.editions })
      : [];
    const shown = candidates.length > 0 ? candidates : fallback;
    return {
      clause,
      found: shown.length > 0,
      outsideDeclaredWork: candidates.length === 0 && fallback.length > 0,
      candidates: shown.slice(0, 6).map(candidate => ({
        work: candidate.line.work,
        edition: candidate.line.edition,
        line: candidate.line.line,
        text: candidate.line.text,
        citation: catalog.citationFor(candidate.line),
        relation: candidate.relation,
        offset: candidate.offset,
        length: candidate.length,
        viaVariant: candidate.viaVariant,
        differences: candidate.differences
      }))
    };
  });

  let status = 'not-found';
  if (completeClaims.length > 0) {
    status = variantOnly ? 'attested-via-variant' : 'attested';
  } else if (fragmentClaims.length > 0) {
    status = 'attested-fragment';
  } else if (uniqueClaims.length > 0) {
    status = 'partial';
  } else if (warnings.some(warning =>
    warning.code === 'MIXED_EDITIONS' || warning.code === 'MIXED_WORKS')) {
    status = 'conflated';
  } else if (warnings.some(warning => warning.code === 'NON_CONTIGUOUS')) {
    status = 'non-contiguous';
  } else if (otherWorkClaims.length > 0) {
    status = 'other-work-only';
  }

  const paraphrases = [];
  if (completeClaims.length === 0) {
    clauses.forEach((clause, index) => {
      if (perClause[index]) return;
      for (const paraphrase of paraphraseCandidates(catalog, clause, contextOptions)) {
        paraphrases.push({
          clause,
          work: paraphrase.line.work,
          edition: paraphrase.line.edition,
          line: paraphrase.line.line,
          text: paraphrase.line.text,
          score: paraphrase.score,
          citation: catalog.citationFor(paraphrase.line),
          note: paraphrase.note,
          nonLiteral: true
        });
      }
    });
  }

  if (status === 'not-found' && paraphrases.length > 0) {
    status = 'paraphrase-only';
  }

  const notes = [];
  if (fragmentOnly) {
    notes.push('所查是半句。检索给出的全行与底本行次才是可引依据。');
  }
  if (variantOnly) {
    notes.push('该结果只能经异体字归一得到；引用时应保留底本实际字形，并注明“异体”。');
  }
  if (uniqueClaims.length > 0 && completeClaims.length === 0 &&
      fragmentClaims.length > 0 &&
      uniqueClaims.some(claim => !claim.fragment)) {
    notes.push('另有整行依据未覆盖全部文句，请分别按行核对。');
  }
  const otherEditionEvidence = uniqueClaims.filter(claim =>
    effectiveWork && claim.work === effectiveWork).length;
  if (otherEditionEvidence === 0 && effectiveWork) {
    notes.push(`未在《${effectiveWork}》中找到完整依据。`);
  }

  return {
    query: rawText,
    declaredWork: effectiveWork,
    clauses,
    status,
    claims: uniqueClaims,
    otherWorkClaims,
    clauseEvidence,
    completeClaims,
    fragmentClaims,
    fragments,
    unresolved,
    warnings,
    paraphraseCandidates: paraphrases,
    notes,
    qr: null
  };
}

export function queryCatalog(catalog, rawText, options = {}) {
  return analyzeText(catalog, rawText, options);
}

// 便捷入口：按作品、底本、行号取一条已校录的原行。
export function lookupLine(catalog, work, edition, line) {
  const resolvedEdition = catalog.resolveEdition(edition);
  if (!resolvedEdition) return null;
  const result = catalog.getLine(work, resolvedEdition, line);
  if (!result) return null;
  return {
    work: result.work,
    edition: result.edition,
    line: result.line,
    text: result.text,
    plainText: result.plainText,
    citation: catalog.citationFor(result),
    editionInfo: result.editionInfo
  };
}

export function compareReadings(catalog, work, line) {
  const workEntry = catalog.getWork(work);
  if (!workEntry) return null;
  const readings = workEntry.lines.filter(entry => entry.line === Number(line));
  if (readings.length === 0) return null;
  const base = readings.find(entry => entry.editionInfo.kind === 'base')
    ?? readings.find(entry => entry.editionInfo.kind === 'independent')
    ?? readings[0];
  const apparatus = [];
  const corrections = [];
  const others = [];
  for (const reading of readings) {
    if (reading === base) continue;
    const operations = changedOperations(base.plainText, reading.plainText);
    const substantive = operations.filter(operation =>
      catalog.isSubstantiveOperation(operation));
    const entry = {
      edition: reading.edition,
      text: reading.text,
      id: reading.id,
      line: reading.line,
      citation: catalog.citationFor(reading),
      editionInfo: reading.editionInfo,
      operations,
      substantiveOperations: substantive,
      glyphOnly: substantive.length === 0
    };
    const groupBase = base.editionInfo.witnessGroup;
    const groupOther = reading.editionInfo.witnessGroup;
    const sameWitness = groupBase === groupOther;
    if (sameWitness && !entry.glyphOnly) {
      corrections.push({
        ...entry,
        status: reading.editionInfo.claimsPriorError ? 'correction-claimed' : 'same-witness-uncertain',
        note: reading.editionInfo.claimsPriorError
          ? `${reading.edition}自称核对同一底本，指${base.edition}误录；仍应由编辑确认。`
          : `${reading.edition}与${base.edition}属同一见证，差异应按勘误处理，须由编辑裁定。`
      });
    } else {
      apparatus.push({
        ...entry,
        status: sameWitness ? 'same-witness-glyph' : 'independent-witness',
        note: sameWitness
          ? '同一见证内的字形差异，不改变文句。'
          : `${reading.editionInfo.kind === 'independent' ? '独立抄本' : '另一底本'}的独立异文，不是对${base.edition}的勘误。`
      });
    }
    others.push(entry);
  }

  return {
    work,
    line: Number(line),
    base: {
      edition: base.edition,
      text: base.text,
      id: base.id,
      citation: catalog.citationFor(base),
      editionInfo: base.editionInfo
    },
    apparatus,
    corrections,
    readings: others,
    note: '正文引用只取所选底本的原行；旁列异文单独列出，不能当作原版勘误。'
  };
}
