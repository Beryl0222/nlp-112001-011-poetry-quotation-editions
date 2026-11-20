import { analyzeText } from './query.js';

const LINK_PREFIX = 'poetry://cite';
const LINK_VERSION = 2;

function sameWitnessCorrections(catalog, work, line) {
  return catalog.correctionsByLine.get(`${work}\u0000${Number(line)}`) ?? [];
}

function termsInScripts(catalog, work, line) {
  const affected = [];
  for (const row of catalog.scriptRows) {
    for (const match of row.text.matchAll(/“([^”]+)”/gu)) {
      const term = match[1];
      const hit = catalog.lines.some(item =>
        item.work === work &&
        item.line === Number(line) &&
        item.plainText.includes(term));
      if (!hit) continue;
      for (const correction of sameWitnessCorrections(catalog, work, line)) {
        const touched = correction.operations.some(operation =>
          operation.before === term || operation.after === term);
        if (touched) {
          affected.push({
            scriptId: row.id,
            format: row.format,
            term,
            correction: {
              baseEdition: correction.baseEdition,
              baseText: correction.baseText,
              otherEdition: correction.otherEdition,
              otherText: correction.otherText
            }
          });
        }
      }
    }
  }
  return affected;
}

export function buildCitationLink(catalog, reference) {
  const work = reference.work;
  const edition = catalog.resolveEdition(reference.edition) ?? reference.edition;
  const from = Number(reference.from ?? reference.line);
  const to = Number(reference.to ?? reference.line);
  if (!catalog.getWork(work)) throw new Error(`未知作品：${work}`);
  if (!catalog.getEdition(edition)) throw new Error(`未知底本：${edition}`);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    throw new Error(`行次无效：${from}–${to}`);
  }
  const startLine = catalog.getLine(work, edition, from);
  const endLine = catalog.getLine(work, edition, to);
  if (!startLine || !endLine) throw new Error(`《${work}》${edition}第${from}–${to}行未校录`);
  const lines = [];
  for (let number = from; number <= to; number += 1) {
    const line = catalog.getLine(work, edition, number);
    if (!line) throw new Error(`《${work}》${edition}第${number}行缺失，不能生成跨行链接`);
    lines.push(line);
  }
  // 断续行号不能拼成一条链接，哪怕首尾都存在。
  if (lines.some((line, index) => index > 0 && line.line !== lines[index - 1].line + 1)) {
    throw new Error(`《${work}》${edition}第${from}–${to}行不连续，不能生成链接`);
  }
  return {
    version: LINK_VERSION,
    scheme: LINK_PREFIX,
    work,
    edition,
    from,
    to,
    text: lines.map(line => line.text).join('\n'),
    citation: catalog.citationFor(startLine, endLine),
    editionKind: catalog.getEdition(edition).kind,
    editionParent: catalog.getEdition(edition).parent,
    payload: {
      v: LINK_VERSION,
      w: work,
      e: edition,
      f: from,
      t: to
    }
  };
}

export function linkToQr(catalog, reference) {
  const link = buildCitationLink(catalog, reference);
  const verification = resolveLink(catalog, link);
  return {
    ...link,
    qr: verification,
    reason: verification.matchReason,
    warning: verification.warning
  };
}

export function resolveLink(catalog, link) {
  const work = link.work ?? link.payload?.w;
  const editionInput = link.edition ?? link.payload?.e;
  const from = Number(link.from ?? link.payload?.f);
  const to = Number(link.to ?? link.payload?.t ?? from);
  const edition = editionInput ? catalog.resolveEdition(editionInput) : null;

  if (!catalog.getWork(work)) {
    return {
      status: 'broken',
      code: 'UNKNOWN_WORK',
      work,
      edition: editionInput ?? null,
      message: `链接所指作品《${work}》现已不在校录中；旧链接不能解析为任何原行。`
    };
  }
  if (!edition) {
    return {
      status: 'broken',
      code: 'UNKNOWN_EDITION',
      work,
      edition: editionInput ?? null,
      message: `链接所指底本“${editionInput ?? ''}”未见于馆内校录；不可用其他底本代填。`
    };
  }

  const lines = [];
  for (let number = from; number <= to; number += 1) {
    const line = catalog.getLine(work, edition, number);
    if (line) lines.push(line);
  }
  if (lines.length !== to - from + 1) {
    return {
      status: 'broken',
      code: 'LINE_MISSING',
      work,
      edition,
      from,
      to,
      found: lines.map(line => line.line),
      message: `《${work}》${edition}第${from}–${to}行未能全部找到；旧链接须由编校人核对后再印。`
    };
  }

  const currentText = lines.map(line => line.text).join('\n');
  const historical = link.text ?? null;
  const textChanged = historical !== null && historical !== currentText;

  const corrections = lines.flatMap(line =>
    sameWitnessCorrections(catalog, work, line.line).map(correction => ({ ...correction, line: line.line })));
  const supplementalEdition = lines.find(line => catalog.getEdition(line.edition)?.kind === 'supplement') ?? null;
  const suggestions = [];

  if (textChanged) {
    // 先逐行比对，只有真正变过的那一行才谈得上“被修订取代”。
    const historicalLines = historical.split('\n');
    const changedLines = lines.filter((line, index) => {
      const previous = historicalLines[index];
      return previous === undefined ||
        previous.replace(/[\p{P}\p{S}\s]/gu, '') !== line.plainText;
    });
    for (const line of changedLines) {
      for (const correction of sameWitnessCorrections(catalog, work, line.line)) {
        suggestions.push({
          code: 'READING_SUPERSEDED',
          line: line.line,
          servedEdition: edition,
          correctedEdition: correction.otherEdition,
          baseText: correction.baseText,
          otherText: correction.otherText,
          decisionRequired: true,
          message: `旧链接按${correction.baseEdition}签发，现存文字与链接记载不同；再印须由编辑裁定改用${correction.otherEdition}的“${correction.otherText}”，并同步修改据此字所作的解释。`
        });
      }
    }
    if (suggestions.length === 0) {
      suggestions.push({
        code: 'TEXT_CHANGED_WITHOUT_KNOWN_CAUSE',
        line: changedLines[0]?.line ?? to,
        from,
        decisionRequired: true,
        message: '链接所载文字与现存校录不同，但校录中没有可对应的同一见证修订；须人工核对是录入更正还是换用了另一底本。'
      });
    }
  }

  for (const correction of corrections) {
    const affected = termsInScripts(catalog, work, correction.line);
    for (const item of affected) {
      suggestions.push({
        code: 'SENSE_EXPLANATION_AFFECTED',
        line: correction.line,
        scriptId: item.scriptId,
        format: item.format,
        term: item.term,
        baseEdition: item.correction.baseEdition,
        otherEdition: item.correction.otherEdition,
        decisionRequired: true,
        message: `旧链接仍可定位到${correction.baseEdition}第${correction.line}行，但${item.format}${item.scriptId}对“${item.term}”的解释须按${item.correction.otherEdition}的读法复核；裁定前不得改写旧说明。`
      });
    }
  }

  if (supplementalEdition) {
    suggestions.push({
      code: 'SUPPLEMENT_REQUIRES_DECISION',
      line: supplementalEdition.line,
      edition: supplementalEdition.edition,
      decisionRequired: true,
      message: `链接所及行存在${supplementalEdition.edition}。该本与${catalog.getEdition(supplementalEdition.edition).parent ?? '原底本'}属同一见证；是否据以改正旧录须由编辑裁定。`
    });
  }

  return {
    status: textChanged ? 'superseded' : 'ok',
    code: textChanged ? 'TEXT_CHANGED' : 'CURRENT',
    work,
    edition,
    editionKind: catalog.getEdition(edition).kind,
    from,
    to,
    lines: lines.map(line => ({
      line: line.line,
      id: line.id,
      text: line.text,
      plainText: line.plainText
    })),
    text: currentText,
    citation: catalog.citationFor(lines[0], lines[lines.length - 1]),
    historicalText: historical,
    textChanged,
    matchReason: textChanged
      ? `按链接记录的${edition}第${from}–${to}行与所载文字定位；现存底本文字已因校录更新而不同。`
      : `按链接记录的${edition}第${from}–${to}行定位，链接所载文字与现存底本逐字相同（标点不计）。`,
    warning: textChanged
      ? '这是旧链接的当前位置，不是原链接所记文字的原文依据。请按所示底本与行次重新核对，不得跨底本补齐。'
      : '链接仅指向这一底本这一行；异体字按底本原字展示。',
    suggestions,
    decisionRequired: suggestions.some(item => item.decisionRequired)
  };
}

// 旧手册可能只印了检索词，没有版本号。只允许解析为“某一底本内的同一行或连续行”，
// 绝不把不同底本的两句拼成一条。
export function resolveLegacyQuery(catalog, text) {
  const analysis = analyzeText(catalog, text);
  if (analysis.completeClaims.length > 0) {
    const claim = analysis.completeClaims[0];
    return {
      status: analysis.status === 'attested-via-variant' ? 'ok-via-variant' : 'ok',
      matched: true,
      claim,
      citation: claim.citation,
      warning: claim.viaVariant
        ? '旧链接的写法与底本字形不同，仅经异体字族相合；再印应改照底本原字。'
        : '旧链接按单一底本解析成功。',
      analysis
    };
  }
  if (analysis.status === 'conflated') {
    const warning = analysis.warnings.find(item =>
      item.code === 'MIXED_EDITIONS' || item.code === 'MIXED_WORKS');
    return {
      status: 'refused-conflated',
      matched: false,
      message: '旧链接的检索词分别落在不同底本或作品；馆内没有任何一版刊载过这条整联，不能拼合展示。',
      detail: warning?.detail ?? [],
      analysis
    };
  }
  return {
    status: 'not-found',
    matched: false,
    message: '旧链接的检索词未能定位到单一底本的连续原行。',
    analysis
  };
}

export function qrAnswer(catalog, rawText, options = {}) {
  const analysis = analyzeText(catalog, rawText, options);
  const claim = analysis.completeClaims?.[0] ?? analysis.claims?.[0] ?? null;
  if (!claim) {
    return {
      found: false,
      status: analysis.status,
      query: rawText,
      answer: '没有可引用的单一底本原行。',
      suggestions: analysis.warnings,
      clauseEvidence: analysis.clauseEvidence ?? [],
      otherWorkEvidence: analysis.otherWorkClaims ?? [],
      paraphrases: analysis.paraphraseCandidates,
      warning: analysis.status === 'paraphrase-only'
        ? '所查只有白话转述；下方列出的是可供理解的原行，不能当作所查文字的原样引文。'
        : analysis.status === 'conflated'
          ? '检索词分别落在不同底本或作品，任一底本都没有刊载这条整联。'
          : null
    };
  }
  const link = linkToQr(catalog, {
    work: claim.work,
    edition: claim.edition,
    from: claim.from,
    to: claim.to
  });
  return {
    found: true,
    status: analysis.status,
    query: rawText,
    work: claim.work,
    edition: claim.edition,
    editionKind: claim.editionKind,
    line: claim.from,
    to: claim.to,
    originalLines: claim.lines.map(line => line.text),
    citation: claim.citation,
    matchReason: claim.reasons.join('；'),
    warning: buildWarning(claim, analysis),
    link,
    alternatives: analysis.claims
      .filter(item => !(item.work === claim.work && item.edition === claim.edition &&
        item.from === claim.from && item.to === claim.to))
      .map(item => ({
        work: item.work,
        edition: item.edition,
        citation: item.citation,
        text: item.text
      })),
    paraphrases: analysis.paraphraseCandidates,
    decisionRequired: false
  };
}

function buildWarning(claim, analysis) {
  if (claim.viaVariant) {
    return '所查用字与底本隶属同一异体字族；引文须照底本原字书写，并注“异体”。';
  }
  if (claim.fragment) {
    return '所查只是原行的一部分；完整原行与行次见上，不得截取半句当作完整引文。';
  }
  if (analysis.status === 'attested-fragment') {
    return '检索只覆盖了原行的一部分；海报应按所示全行引用。';
  }
  if (claim.editionKind === 'supplement') {
    return '该读法出自补校本；与原录是否构成勘误，须由编辑裁定后再用于新展签。';
  }
  return null;
}
