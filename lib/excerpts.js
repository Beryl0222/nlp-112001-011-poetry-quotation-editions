import {
  extractWorkTitle,
  quotedTerms,
  similarity,
  splitClauses,
  stripDecorations
} from './text.js';
import { analyzeText } from './query.js';

const NARRATION_PREFIX = /^(?:上句|下句|后一联|前一联|上联|下联|首句|末句|此句|本句|这里|其中|诗中说|诗里说|诗云|所谓|就是|即|也就是|意思是说?|说的是|写的是|写|说|指|讲|提到|意为)+/u;
const PARAPHRASE_THRESHOLD = 0.6;
const MIN_FRAGMENT = 3;

function charsOf(text) {
  return [...String(text)];
}

function cleanClause(clause) {
  return stripDecorations(clause).replace(NARRATION_PREFIX, '').trim();
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

function hasQuotationMarks(text) {
  return /[“”"「」『』]/u.test(text);
}

function isNarration(clause) {
  return NARRATION_PREFIX.test(stripDecorations(clause));
}

function normalizeChars(catalog, chars) {
  return chars.map(character => catalog.variantMap.get(character) ?? character);
}

function glyphDifferences(line, rawQueryChars, from, length) {
  const rawLineChars = charsOf(line.text)
    .filter(character => !/[\p{P}\p{S}\s]/u.test(character));
  const differences = [];
  for (let index = 0; index < length; index += 1) {
    const editionGlyph = rawLineChars[from + index];
    const queryGlyph = rawQueryChars[index];
    if (editionGlyph !== undefined && queryGlyph !== undefined && editionGlyph !== queryGlyph) {
      differences.push({
        position: index + 1,
        editionGlyph,
        queryGlyph
      });
    }
  }
  return differences;
}

function clauseCandidates(catalog, clause, declaredWork) {
  const cleanedChars = charsOf(cleanClause(clause));
  const normalized = normalizeChars(catalog, cleanedChars);
  if (normalized.length < MIN_FRAGMENT) return { literal: [], paraphrase: [] };
  const normalizedText = normalized.join('');
  const literal = [];
  const paraphrase = [];
  for (const line of catalog.lines) {
    if (declaredWork && line.work !== declaredWork) continue;
    const lineText = line.searchText;
    let relation = null;
    let rawQueryChars = null;
    if (lineText === normalizedText) {
      relation = 'exact';
      rawQueryChars = cleanedChars;
    } else if (lineText.length >= 4 && normalizedText.includes(lineText)) {
      const at = indexOfChars(normalized, [...lineText]);
      if (at >= 0) {
        relation = 'embedded';
        rawQueryChars = cleanedChars.slice(at, at + [...lineText].length);
      }
    } else if (lineText.includes(normalizedText)) {
      relation = 'fragment';
      rawQueryChars = cleanedChars;
    }
    if (!relation) {
      const score = similarity(normalizedText, lineText);
      if (score >= PARAPHRASE_THRESHOLD) {
        paraphrase.push({
          line,
          score,
          work: line.work,
          edition: line.edition,
          lineNumber: line.line,
          text: line.text,
          citation: catalog.citationFor(line),
          literal: false,
          note: `与${line.edition}第${line.line}行近似（相似度 ${score.toFixed(2)}），只是转述，不是原文。`
        });
      }
      continue;
    }
    const differences = glyphDifferences(line, rawQueryChars, 0, rawQueryChars.length);
    literal.push({
      line,
      relation,
      work: line.work,
      edition: line.edition,
      lineNumber: line.line,
      text: line.text,
      citation: catalog.citationFor(line),
      differences,
      viaVariant: differences.length > 0,
      literal: true
    });
  }
  literal.sort((left, right) =>
    Number(left.viaVariant) - Number(right.viaVariant) ||
    left.lineNumber - right.lineNumber);
  paraphrase.sort((left, right) => right.score - left.score || left.lineNumber - right.lineNumber);
  return { literal, paraphrase: paraphrase.slice(0, 3) };
}

function termEvidence(catalog, term) {
  const evidence = [];
  for (const line of catalog.lines) {
    const at = line.plainText.indexOf(term);
    if (at < 0) continue;
    evidence.push({
      term,
      line,
      work: line.work,
      edition: line.edition,
      lineNumber: line.line,
      text: line.text,
      citation: catalog.citationFor(line),
      offset: at
    });
  }
  return evidence;
}

function sameWitnessCorrectionsFor(catalog, work, lineNumber) {
  return catalog.correctionsByLine.get(`${work}\u0000${lineNumber}`) ?? [];
}

function cleanForMessage(clause) {
  return stripDecorations(clause) || clause;
}

function correctionTouchingTerm(correction, term) {
  return correction.operations.some(operation =>
    (operation.before && operation.before === term) ||
    (operation.after && operation.after === term));
}

function termNote(correction, term) {
  if (correction.claimsPriorError && correction.hasIndependentEvidence) {
    return `“${term}”所依据的${correction.baseEdition}原字已被${correction.otherEdition}证明误录；沿用此字的白话解释须改写。`;
  }
  if (correction.claimsPriorError) {
    return `“${term}”所依据的${correction.baseEdition}原字被${correction.otherEdition}指为误录，但尚无独立旁证；词义解释须按编辑裁定调整。`;
  }
  return `“${term}”另有${correction.otherEdition}的异文；旧解释可保留，若采用新读法须另行说明。`;
}

function claimAdoptedLine(claim, index) {
  const spans = claim.spans;
  const span = spans[Math.min(index, spans.length - 1)];
  if (!span) return null;
  const line = claim.lines.find(entry => entry.line === span.line);
  return line ?? null;
}

function describeQuote(catalog, record, claim, index) {
  if (!claim) {
    return {
      clause: record.clause,
      narration: record.narration,
      work: record.work,
      edition: record.edition,
      line: record.lineNumber,
      text: record.text,
      citation: record.citation,
      way: record.relation,
      differences: record.differences,
      viaVariant: record.viaVariant,
      expresslyQuoted: record.expresslyQuoted,
      adoptedEdition: null
    };
  }
  const adopted = claimAdoptedLine(claim, index);
  const differences = record.differences.filter(difference =>
    !adopted || adopted.plainText.includes(difference.editionGlyph) ||
    charsOf(adopted.plainText).includes(difference.editionGlyph));
  return {
    clause: record.clause,
    narration: record.narration,
    work: claim.work,
    edition: claim.edition,
    line: adopted?.line ?? record.lineNumber,
    text: adopted?.text ?? record.text,
    citation: adopted
      ? catalog.citationFor(catalog.getLine(claim.work, claim.edition, adopted.line))
      : record.citation,
    way: record.relation,
    differences,
    viaVariant: differences.length > 0,
    expresslyQuoted: record.expresslyQuoted,
    adoptedEdition: claim.edition,
    otherEditions: record.edition === claim.edition ? [] : [record.edition]
  };
}

export function extractScript(catalog, row) {
  const declaredWork = extractWorkTitle(row.text);
  // 先去掉书名号整体，避免“《渡曲》”被拆成“渡曲”混进文句；引号留给分句处理。
  const body = row.text
    .replace(/《[^》]*》/gu, '')
    .replace(/[【】（）()\[\]]/gu, '');
  const clauses = splitClauses(body)
    .map(clause => clause.trim())
    .filter(clause => charsOf(clause).length > 0);

  const records = [];
  for (const clause of clauses) {
    if (charsOf(cleanClause(clause)).length < MIN_FRAGMENT) continue;
    const candidates = clauseCandidates(catalog, clause, declaredWork);
    if (candidates.literal.length > 0) {
      records.push({
        clause,
        narration: isNarration(clause),
        expresslyQuoted: hasQuotationMarks(clause) || !isNarration(clause),
        literal: candidates.literal,
        paraphrase: []
      });
    } else {
      records.push({
        clause,
        narration: isNarration(clause),
        expresslyQuoted: hasQuotationMarks(clause),
        literal: [],
        paraphrase: candidates.paraphrase
      });
    }
  }

  const literalRecords = records.filter(record => record.literal.length > 0);
  const paraphraseRecords = records.filter(record => record.literal.length === 0 && record.paraphrase.length > 0);

  // 整段引文能否在同一底本连续行内成立；成立时以该底本为引文底本。
  let adoptedClaim = null;
  let analysis = null;
  if (literalRecords.length > 0) {
    const joined = literalRecords.map(record => cleanClause(record.clause)).join('，');
    analysis = analyzeText(catalog, declaredWork ? `《${declaredWork}》${joined}` : joined, {
      work: declaredWork
    });
    const complete = (analysis.completeClaims ?? []).filter(claim =>
      claim.spans.length === literalRecords.length);
    adoptedClaim = complete[0] ?? null;
  }

  const quotes = literalRecords.map((record, index) => {
    const best = record.literal[0];
    const claim = adoptedClaim;
    if (adoptedClaim) {
      return describeQuote(catalog, {
        clause: record.clause,
        narration: record.narration,
        expresslyQuoted: record.expresslyQuoted,
        ...best
      }, claim, index);
    }
    return describeQuote(catalog, {
      clause: record.clause,
      narration: record.narration,
      expresslyQuoted: record.expresslyQuoted,
      ...best
    }, null, index);
  });

  const paraphrases = [];
  for (const record of paraphraseRecords) {
    const best = record.paraphrase[0];
    paraphrases.push({
      clause: record.clause,
      narration: record.narration,
      work: best.work,
      edition: best.edition,
      line: best.lineNumber,
      text: best.text,
      citation: best.citation,
      score: best.score,
      candidates: record.paraphrase.map(candidate => ({
        work: candidate.work,
        edition: candidate.edition,
        line: candidate.lineNumber,
        text: candidate.text,
        citation: candidate.citation,
        score: candidate.score
      }))
    });
  }

  const terms = [];
  for (const term of quotedTerms(row.text)) {
    const evidence = termEvidence(catalog, term);
    if (evidence.length === 0) continue;
    const corrections = [];
    const seenCorrections = new Set();
    for (const item of evidence) {
      for (const correction of sameWitnessCorrectionsFor(catalog, item.work, item.lineNumber)) {
        if (!correctionTouchingTerm(correction, term)) continue;
        // 同一处校改会同时出现在原录行与补校行，只保留一条。
        const key = `${correction.work}\u0000${correction.line}\u0000${correction.baseEdition}\u0000${correction.otherEdition}`;
        if (seenCorrections.has(key)) continue;
        seenCorrections.add(key);
        corrections.push({ ...correction, term, line: item.lineNumber, work: item.work });
      }
    }
    terms.push({
      term,
      evidence: evidence.map(item => ({
        work: item.work,
        edition: item.edition,
        line: item.lineNumber,
        text: item.text,
        citation: item.citation,
        offset: item.offset
      })),
      acceptedCorrections: corrections,
      note: corrections.length > 0 ? termNote(corrections[0], term) : null
    });
  }

  const literalEditions = new Set(quotes.map(quote => quote.edition));
  const paraphraseEditions = new Set(paraphrases.map(item => item.edition));
  const literalWorks = new Set(quotes.map(quote => quote.work));
  const paraphraseWorks = new Set(paraphrases.map(item => item.work));
  const editionsMentioned = [...new Set([...literalEditions, ...paraphraseEditions])];
  const worksMentioned = [...new Set([...literalWorks, ...paraphraseWorks])];

  const conflicts = [];
  if (literalEditions.size === 1 && paraphraseEditions.size > 0 &&
      [...paraphraseEditions].some(edition => !literalEditions.has(edition))) {
    conflicts.push({
      code: 'PARAPHRASE_FROM_OTHER_EDITION',
      message: `讲解稿引${[...literalEditions][0]}原文，却借${[...paraphraseEditions].join('、')}的文句作白话转述；不能把另一底本读法当作原文解释。`,
      literalEditions: [...literalEditions],
      paraphraseEditions: [...paraphraseEditions]
    });
  }
  if (literalEditions.size > 1) {
    conflicts.push({
      code: 'MULTIPLE_LITERAL_EDITIONS',
      message: `同一讲解稿的引文分别取自${[...literalEditions].join('、')}，整联不属同一底本。`,
      literalEditions: [...literalEditions]
    });
  }
  if (worksMentioned.length > 1) {
    conflicts.push({
      code: 'MULTIPLE_WORKS',
      message: `讲解稿同时涉及${worksMentioned.join('、')}，引用时须分别标注作品。`,
      works: worksMentioned
    });
  }
  if (declaredWork && literalWorks.size > 0 && !literalWorks.has(declaredWork)) {
    conflicts.push({
      code: 'DECLARED_WORK_MISMATCH',
      message: `讲解稿标明《${declaredWork}》，但引文依据在${[...literalWorks].join('、')}。`,
      declaredWork,
      literalWorks: [...literalWorks]
    });
  }

  const findings = [];
  for (const quote of quotes) {
    if (quote.way === 'fragment') {
      findings.push({
        code: 'HALF_LINE_QUOTE',
        message: `“${cleanForMessage(quote.clause)}”只覆盖${quote.edition}第${quote.line}行的一部分；展签与导览须引全行“${quote.text}”。`,
        clause: quote.clause,
        work: quote.work,
        edition: quote.edition,
        line: quote.line,
        fullText: quote.text,
        decisionRequired: true
      });
    }
    for (const difference of quote.differences) {
      findings.push({
        code: 'GLYPH_SUBSTITUTION',
        message: `讲解稿写作“${difference.queryGlyph}”，${quote.edition}底本作“${difference.editionGlyph}”；展签引文应照底本字形。`,
        clause: quote.clause,
        work: quote.work,
        edition: quote.edition,
        line: quote.line,
        editionGlyph: difference.editionGlyph,
        queryGlyph: difference.queryGlyph,
        decisionRequired: true
      });
    }
    for (const correction of sameWitnessCorrectionsFor(catalog, quote.work, quote.line)) {
      const touched = correction.operations.some(operation =>
        operation.after && quote.text.includes(operation.after));
      if (!touched) continue;
      findings.push({
        code: 'QUOTE_SUPERSEDED_BY_CORRECTION',
        message: `引文所用${quote.edition}第${quote.line}行已有同一见证的${correction.otherEdition}修订；再印前须由编辑裁定采用哪一读法。`,
        clause: quote.clause,
        work: quote.work,
        line: quote.line,
        baseEdition: correction.baseEdition,
        baseText: correction.baseText,
        otherEdition: correction.otherEdition,
        otherText: correction.otherText,
        decisionRequired: true
      });
    }
  }

  for (const paraphrase of paraphrases) {
    if (literalEditions.size > 0 && !literalEditions.has(paraphrase.edition)) {
      findings.push({
        code: 'PARAPHRASE_OTHER_EDITION',
        message: `“${cleanForMessage(paraphrase.clause)}”的转述来自${paraphrase.edition}第${paraphrase.line}行“${paraphrase.text}”，与引文底本${[...literalEditions].join('、')}不同；白话说明须改用同一底本。`,
        clause: paraphrase.clause,
        work: paraphrase.work,
        edition: paraphrase.edition,
        line: paraphrase.line,
        text: paraphrase.text,
        literalEditions: [...literalEditions],
        decisionRequired: true
      });
    }
    findings.push({
      code: 'NONLITERAL_MATCH',
      message: `“${cleanForMessage(paraphrase.clause)}”只是白话转述，不能加引号冒充原文。`,
      clause: paraphrase.clause,
      edition: paraphrase.edition,
      line: paraphrase.line,
      text: paraphrase.text,
      decisionRequired: false
    });
  }

  for (const term of terms) {
    for (const correction of term.acceptedCorrections) {
      findings.push({
        code: 'TERM_SENSE_AFFECTED',
        message: term.note,
        term: term.term,
        work: correction.work,
        line: correction.line,
        baseEdition: correction.baseEdition,
        otherEdition: correction.otherEdition,
        baseText: correction.baseText,
        otherText: correction.otherText,
        priorErrorProven: correction.claimsPriorError && correction.hasIndependentEvidence,
        decisionRequired: !(correction.claimsPriorError && correction.hasIndependentEvidence)
      });
    }
  }

  return {
    id: row.id,
    format: row.format,
    text: row.text,
    declaredWork,
    clauses,
    quotes,
    paraphrases,
    terms,
    conflicts,
    findings,
    analysis,
    editionsMentioned,
    worksMentioned,
    hasLiteralQuote: quotes.length > 0,
    hasOnlyParaphrase: quotes.length === 0 && paraphrases.length > 0
  };
}

export function extractScripts(catalog) {
  return catalog.scriptRows.map(row => extractScript(catalog, row));
}
