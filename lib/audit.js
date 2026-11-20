import { analyzeText } from './query.js';
import { extractScripts } from './excerpts.js';

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

export function classifyCorrection(correction) {
  if (!correction.sameWitness) {
    return {
      kind: 'independent-variant',
      label: '独立异文',
      oldReadingInvalidated: false,
      newPosterImpact: '可在新海报中并列，但不能取代原底本，也不能称作勘误。',
      paraphraseImpact: '旧白话说明仍可成立；若引用新读法，须注明来自另一底本。'
    };
  }
  if (!correction.claimsPriorError) {
    if (correction.hasIndependentEvidence) {
      return {
        kind: 'additional-attested-variant',
        label: '有独立旁证的异文',
        oldReadingInvalidated: false,
        newPosterImpact: '可作为有旁证的新异文与旧读并列，但不能宣称旧录有误。',
        paraphraseImpact: '旧白话说明仍成立；若新海报采用新读法，须另行说明依据，不能沿用旧解释。'
      };
    }
    return {
      kind: 'same-witness-uncertain',
      label: '同见证未定异文',
      oldReadingInvalidated: false,
      newPosterImpact: '须由编辑裁定后方可用于新海报。',
      paraphraseImpact: '旧白话说明暂予保留，待裁定。'
    };
  }
  if (!correction.hasIndependentEvidence) {
    return {
      kind: 'claimed-prior-error-unconfirmed',
      label: '自称勘误、尚无独立旁证',
      oldReadingInvalidated: false,
      newPosterImpact: '新海报不得径改；补校只是候选人，须经编辑核实拓片。',
      paraphraseImpact: '旧白话说明不得据补校单方面改写，只能在裁定后调整。'
    };
  }
  return {
    kind: 'prior-error-proven',
    label: '旧录确有误',
    oldReadingInvalidated: true,
    newPosterImpact: '新海报应采用改正后的读法，并注明据同一见证的补校。',
    paraphraseImpact: '沿用旧字所作的白话解释须改写，再印前须逐条复核。'
  };
}

function findingKey(finding) {
  return `${finding.code}\u0000${finding.scriptId ?? ''}\u0000${finding.work ?? ''}\u0000${finding.line ?? ''}\u0000${finding.term ?? ''}`;
}

function decisionQuestion(finding, script) {
  if (finding.code === 'TERM_SENSE_AFFECTED') {
    return `${script.format}${script.id}对“${finding.term}”的解释应随${finding.otherEdition}改写吗？`;
  }
  if (finding.code === 'GLYPH_SUBSTITUTION') {
    return `${script.format}${script.id}第${finding.line}行应照${finding.edition}底本写作“${finding.editionGlyph}”，还是保留现稿“${finding.queryGlyph}”？`;
  }
  if (finding.code === 'PARAPHRASE_OTHER_EDITION') {
    return `${script.format}${script.id}的白话“${finding.clause}”是否改用与引文同版的读法？现依据为${finding.edition}“${finding.text}”。`;
  }
  if (finding.code === 'QUOTE_SUPERSEDED_BY_CORRECTION') {
    return `${script.format}${script.id}第${finding.line}行应采用${finding.baseEdition}“${finding.baseText}”还是${finding.otherEdition}“${finding.otherText}”？`;
  }
  return `${script.format}${script.id}应改用哪一底本的读法？`;
}

function addFinding(findings, finding) {
  findings.push({
    severity: 'warning',
    decisionRequired: false,
    ...finding
  });
}

export function auditCatalog(catalog) {
  const scripts = extractScripts(catalog);
  const findings = [];
  const decisions = [];
  const seen = new Set();

  const push = finding => {
    const key = findingKey(finding);
    if (seen.has(key)) {
      const existing = findings.find(item => findingKey(item) === key);
      if (existing) existing.occurrences = (existing.occurrences ?? 1) + 1;
      return;
    }
    seen.add(key);
    addFinding(findings, finding);
  };

  // 底本完整性：缺行的底本不能用来支撑整联。
  for (const work of catalog.works.values()) {
    for (const state of work.editions) {
      if (state.complete) continue;
      const apparatus = state.editionInfo.kind === 'supplement';
      push({
        code: apparatus ? 'APPARATUS_EDITION_INCOMPLETE' : 'INCOMPLETE_EDITION',
        severity: apparatus ? 'info' : 'warning',
        decisionRequired: false,
        work: work.name,
        edition: state.edition,
        missing: state.missing,
        message: apparatus
          ? `《${work.name}》${state.edition}是只收录校改行的补校本，缺第${state.missing.join('、')}行；可作旁证，不能单独充当整联底本。`
          : `《${work.name}》${state.edition}缺第${state.missing.join('、')}行；不能以该底本为单位引用整联。`
      });
    }
  }

  // 同见证内部的差异：只能作为勘误候选，不能自动改成正文。
  for (const correction of catalog.corrections) {
    const classification = classifyCorrection(correction);
    push({
      code: 'SAME_WITNESS_DIFFERENCE',
      severity: classification.kind === 'prior-error-proven' ? 'error' : 'warning',
      decisionRequired: true,
      work: correction.work,
      line: correction.line,
      baseEdition: correction.baseEdition,
      otherEdition: correction.otherEdition,
      baseText: correction.baseText,
      otherText: correction.otherText,
      classification,
      sources: correction.sourceIds,
      message: `${correction.baseEdition}“${correction.baseText}”与${correction.otherEdition}“${correction.otherText}”属同一见证的差异，归为${classification.label}。${classification.oldReadingInvalidated ? '旧录已被证明有误。' : '尚未证明旧录有误，须由编辑裁定。'}`
    });
    if (!classification.oldReadingInvalidated) {
      decisions.push({
        code: 'CORRECTION_ADJUDICATION',
        work: correction.work,
        line: correction.line,
        baseEdition: correction.baseEdition,
        otherEdition: correction.otherEdition,
        baseText: correction.baseText,
        otherText: correction.otherText,
        classification,
        sources: correction.sourceIds,
        question: `再印时${correction.baseEdition}第${correction.line}行应采用“${correction.baseText}”还是“${correction.otherText}”？`,
        basis: correction.note
      });
    }
  }

  // 独立异文不是勘误：相同行号的异本须并列。
  for (const work of catalog.works.values()) {
    for (let number = 1; number <= work.maxLine; number += 1) {
      const readings = work.lines.filter(line => line.line === number);
      const independent = readings.filter(line => line.editionInfo.kind === 'independent');
      const baseReadings = readings.filter(line =>
        line.editionInfo.kind === 'base' || line.editionInfo.kind === 'supplement');
      if (independent.length === 0 || baseReadings.length === 0) continue;
      for (const other of independent) {
        if (!baseReadings.some(base => base.plainText !== other.plainText)) continue;
        push({
          code: 'INDEPENDENT_VARIANT',
          severity: 'info',
          decisionRequired: false,
          work: work.name,
          line: number,
          editions: [...new Set([...baseReadings.map(base => base.edition), other.edition])],
          message: `《${work.name}》第${number}行在${other.edition}中另有独立读法“${other.text}”；这是别本异文，不是对${baseReadings.map(base => base.edition).join('、')}的勘误。`
        });
      }
    }
  }

  // 每篇讲解稿的引文、转述与词义解释。
  for (const script of scripts) {
    if (script.conflicts.length > 0) {
      for (const conflict of script.conflicts) {
        push({
          code: conflict.code,
          severity: conflict.code === 'MULTIPLE_LITERAL_EDITIONS' ? 'error' : 'warning',
          decisionRequired: conflict.code !== 'MULTIPLE_WORKS',
          scriptId: script.id,
          format: script.format,
          message: conflict.message,
          detail: conflict
        });
      }
    }
    for (const finding of script.findings) {
      push({
        ...finding,
        scriptId: script.id,
        format: script.format,
        severity: finding.code === 'NONLITERAL_MATCH' ? 'info' : 'warning'
      });
      if (finding.decisionRequired) {
        decisions.push({
          code: finding.code,
          scriptId: script.id,
          format: script.format,
          work: finding.work,
          line: finding.line,
          term: finding.term ?? null,
          question: decisionQuestion(finding, script),
          detail: finding
        });
      }
    }

    // 引文分行是否与底本行次一致。
    if (script.quotes.length > 1) {
      const numbers = script.quotes.map(quote => quote.line);
      const editions = new Set(script.quotes.map(quote => quote.edition));
      if (editions.size > 1) {
        push({
          code: 'EXHIBIT_EDITION_MISMATCH',
          severity: 'error',
          decisionRequired: true,
          scriptId: script.id,
          format: script.format,
          editions: [...editions],
          message: `${script.format}${script.id}各句取自不同底本，整联的文字与分行不能同属一版；新海报须固定单一底本。`
        });
      } else if (numbers.some((number, index) => index > 0 && number !== numbers[index - 1] + 1)) {
        push({
          code: 'EXHIBIT_LINE_ORDER',
          severity: 'error',
          decisionRequired: true,
          scriptId: script.id,
          format: script.format,
          lineNumbers: numbers,
          message: `${script.format}${script.id}所引行次不连续，分行与底本不一致。`
        });
      }
    }
  }

  findings.sort((left, right) =>
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
    String(left.scriptId ?? '').localeCompare(String(right.scriptId ?? '')) ||
    (left.line ?? 0) - (right.line ?? 0));

  const reprint = buildReprintPlan(catalog, scripts, findings);

  return {
    generatedFrom: {
      lines: catalog.lineRows.length,
      notes: catalog.noteRows.length,
      scripts: catalog.scriptRows.length
    },
    editions: [...catalog.editions.values()].map(edition => ({
      name: edition.name,
      kind: edition.kind,
      parent: edition.parent,
      relation: edition.relation.kind,
      claim: edition.relation.claim,
      note: edition.note
    })),
    works: [...catalog.works.values()].map(work => ({
      name: work.name,
      completeEditions: work.completeEditions.map(state => state.edition),
      incompleteEditions: work.incompleteEditions.map(state => ({
        edition: state.edition,
        missing: state.missing
      })),
      couplets: work.completeEditions.map(state => {
        const lines = [...state.lines.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, line]) => line);
        return {
          edition: state.edition,
          from: lines[0].line,
          to: lines[lines.length - 1].line,
          text: lines.map(line => line.text).join('\n'),
          citation: catalog.citationFor(lines[0], lines[lines.length - 1])
        };
      })
    })),
    scripts: scripts.map(script => ({
      id: script.id,
      format: script.format,
      declaredWork: script.declaredWork,
      quotes: script.quotes,
      paraphrases: script.paraphrases,
      terms: script.terms,
      editionsMentioned: script.editionsMentioned,
      status: script.conflicts.length > 0 ? 'conflict' : script.findings.length > 0 ? 'review' : 'clear'
    })),
    findings,
    decisions,
    reprint
  };
}

function buildReprintPlan(catalog, scripts, findings) {
  const affectedScripts = [];
  for (const script of scripts) {
    const scriptFindings = findings.filter(finding => finding.scriptId === script.id);
    if (scriptFindings.length === 0) continue;
    affectedScripts.push({
      id: script.id,
      format: script.format,
      issues: scriptFindings.map(finding => ({
        code: finding.code,
        line: finding.line ?? null,
        term: finding.term ?? null,
        message: finding.message
      })),
      decisionRequired: scriptFindings.some(finding => finding.decisionRequired)
    });
  }

  const senseChanges = [];
  for (const script of scripts) {
    for (const term of script.terms) {
      for (const correction of term.acceptedCorrections) {
        const classification = classifyCorrection(correction);
        senseChanges.push({
          scriptId: script.id,
          format: script.format,
          term: term.term,
          work: correction.work,
          line: correction.line,
          baseEdition: correction.baseEdition,
          newEdition: correction.otherEdition,
          baseText: correction.baseText,
          newText: correction.otherText,
          classification: classification.kind,
          action: classification.oldReadingInvalidated
            ? `按${correction.otherEdition}的“${correction.otherText}”改写“${term.term}”的解释。`
            : classification.kind === 'independent-variant'
              ? `保留${correction.baseEdition}原解释；若增加${correction.otherEdition}读法，须注明出处。`
              : `暂保留原解释，待编辑裁定。`,
          decisionRequired: !classification.oldReadingInvalidated &&
            classification.kind !== 'independent-variant'
        });
      }
    }
  }

  const editionChoices = [];
  for (const work of catalog.works.values()) {
    editionChoices.push({
      work: work.name,
      complete: work.completeEditions.map(state => state.edition),
      cannotSupportCouplet: work.incompleteEditions.map(state => ({
        edition: state.edition,
        missing: state.missing
      }))
    });
  }

  return {
    affectedScripts,
    senseChanges,
    editionChoices,
    note: '再印时先固定每一展签的底本：整联文字、分行、地点与人物称谓及白话说明须同属该底本；补校是否构成勘误由编辑裁定。'
  };
}

export function selectExhibit(catalog, { work, edition, from, to }) {
  const resolved = catalog.resolveEdition(edition);
  if (!catalog.getWork(work)) throw new Error(`未知作品：${work}`);
  if (!resolved) throw new Error(`未知底本：${edition}`);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    throw new Error(`行次无效：${from}–${to}`);
  }
  const lines = [];
  for (let number = from; number <= to; number += 1) {
    const line = catalog.getLine(work, resolved, number);
    if (!line) {
      return {
        ok: false,
        work,
        edition: resolved,
        from,
        to,
        missing: [number],
        message: `《${work}》${resolved}缺第${number}行，不能作为展签底本。`
      };
    }
    lines.push(line);
  }
  const editionInfo = catalog.getEdition(resolved);
  const scriptChecks = [];
  for (const script of extractScripts(catalog)) {
    const quotes = script.quotes.filter(quote => quote.work === work);
    const paraphrases = script.paraphrases.filter(item => item.work === work);
    const quoteEditions = [...new Set(quotes.map(quote => quote.edition))];
    const paraphraseEditions = [...new Set(paraphrases.map(item => item.edition))];
    const committed = [...new Set([...quoteEditions, ...paraphraseEditions])];

    // 导览中的称谓、地名与词义解释同样须落在所选底本内。
    const termChecks = [];
    for (const term of script.terms) {
      const evidenceEditions = [...new Set(term.evidence
        .filter(item => item.work === work)
        .map(item => item.edition))];
      if (evidenceEditions.length === 0) continue;
      const inExhibit = lines.some(line => line.plainText.includes(term.term));
      if (inExhibit) continue;
      const sameEdition = evidenceEditions.includes(resolved);
      termChecks.push({
        term: term.term,
        evidenceEditions,
        note: sameEdition
          ? `“${term.term}”虽见于${resolved}，却不在所选第${from}–${to}行内；导览不得把别行的说法挂到这条展签上。`
          : `“${term.term}”只见于${evidenceEditions.join('、')}，不见于所选底本${resolved}；展签上的称谓与词义解释须改用同一底本的说法。`
      });
    }

    if (quotes.length === 0 && paraphrases.length === 0 && termChecks.length === 0) continue;
    const matches = committed.every(item => item === resolved);
    if (termChecks.length > 0) {
      scriptChecks.push({
        scriptId: script.id,
        format: script.format,
        quotedEditions: quoteEditions,
        paraphraseEditions,
        matchesExhibitEdition: false,
        termChecks,
        note: termChecks[0].note
      });
      continue;
    }
    scriptChecks.push({
      scriptId: script.id,
      format: script.format,
      quotedEditions: quoteEditions,
      paraphraseEditions,
      termChecks,
      matchesExhibitEdition: matches,
      note: matches
        ? null
        : `该讲解稿的依据涉及${committed.join('、')}，与展签底本${resolved}不一致；导览中的称谓与白话说明也须随底本统一。`
    });
  }
  return {
    ok: true,
    work,
    edition: resolved,
    editionKind: editionInfo.kind,
    parent: editionInfo.parent,
    from,
    to,
    lines: lines.map(line => ({ line: line.line, text: line.text, id: line.id })),
    text: lines.map(line => line.text).join('\n'),
    inlineText: lines.map(line => line.text).join('，'),
    citation: catalog.citationFor(lines[0], lines[lines.length - 1]),
    lineBreakConsistent: lines.length === to - from + 1,
    scriptChecks,
    warnings: scriptChecks.filter(check => !check.matchesExhibitEdition),
    note: '展签的整联文字与分行均取这一底本；引文之外的导览说明也须指向同一底本。'
  };
}

export function assessNewCollation(catalog, row) {
  if (!catalog.getWork(row.work)) throw new Error(`未知作品：${row.work}`);
  const edition = catalog.resolveEdition(row.edition);
  if (!edition) throw new Error(`未知底本：${row.edition}`);
  const line = Number(row.line);
  if (!Number.isInteger(line) || line < 1) throw new Error('line 应为正整数');
  const existing = catalog.getLine(row.work, edition, line);
  const plain = [...String(row.text)].filter(character => !/[\p{P}\p{S}\s]/u.test(character)).join('');

  if (!existing) {
    return {
      kind: 'new-line',
      work: row.work,
      edition,
      line,
      text: row.text,
      message: '这是新增行，不涉及改字；须确认底部本已完整收录上下文。'
    };
  }

  const differences = [];
  const before = [...existing.plainText];
  const after = [...plain];
  const limit = Math.min(before.length, after.length);
  for (let index = 0; index < limit; index += 1) {
    if (before[index] !== after[index]) {
      differences.push({ position: index + 1, before: before[index], after: after[index] });
    }
  }
  if (before.length !== after.length) {
    differences.push({ position: limit + 1, before: before.slice(limit).join(''), after: after.slice(limit).join('') });
  }

  if (differences.length === 0) {
    return { kind: 'unchanged', work: row.work, edition, line, message: '新校录与现有录文一致。' };
  }

  const editionInfo = catalog.getEdition(edition);
  const witnessBase = editionInfo.parent
    ? catalog.getLine(row.work, editionInfo.parent, line)
    : existing;
  const sameWitnessCorrections = (catalog.correctionsByLine.get(`${row.work}\u0000${line}`) ?? [])
    .filter(correction => correction.otherEdition === edition);
  const matchesSupplement = [...catalog.editions.values()]
    .filter(item => item.kind === 'supplement' && item.parent === edition)
    .map(item => ({ edition: item.name, line: catalog.getLine(row.work, item.name, line) }))
    .filter(item => item.line && item.line.plainText === plain);

  let classification;
  if (editionInfo.kind === 'supplement') {
    const claimsError = editionInfo.claimsPriorError;
    const hasEvidence = editionInfo.hasIndependentEvidence;
    classification = claimsError && hasEvidence
      ? 'prior-error-proven'
      : claimsError
        ? 'claimed-prior-error-unconfirmed'
        : 'same-witness-variant';
  } else if (editionInfo.kind === 'independent') {
    classification = 'independent-variant';
  } else if (matchesSupplement.length > 0) {
    // 底本被改成一个已有补校读法：这是对旧录的修订，不是独立异文。
    classification = copiesSupplementClaim(matchesSupplement, catalog)
      ? 'prior-error-proven'
      : 'claimed-prior-error-unconfirmed';
  } else {
    classification = 'base-revision';
  }

  const classificationDetail = classification === 'prior-error-proven'
    ? classifyCorrection({ sameWitness: true, claimsPriorError: true, hasIndependentEvidence: true })
    : classification === 'claimed-prior-error-unconfirmed'
      ? classifyCorrection({ sameWitness: true, claimsPriorError: true, hasIndependentEvidence: false })
      : classification === 'independent-variant'
        ? classifyCorrection({ sameWitness: false })
        : classification === 'same-witness-variant'
          ? classifyCorrection({ sameWitness: true, claimsPriorError: false })
          : {
              kind: 'base-revision',
              label: '底本自身改录',
              oldReadingInvalidated: false,
              newPosterImpact: '须核对拓片或原件；在确认前新旧读法只能并列。',
              paraphraseImpact: '旧白话说明暂不据改。'
            };

  const affects = catalog.scriptRows
    .filter(script => script.text.includes(before.join('')) ||
      differences.some(difference =>
        (difference.before && script.text.includes(difference.before)) ||
        (difference.after && script.text.includes(difference.after))))
    .map(script => script.id);

  return {
    kind: 'changed-character',
    work: row.work,
    edition,
    line,
    before: existing.text,
    after: row.text,
    differences,
    classification,
    witnessBase: witnessBase
      ? { edition: witnessBase.edition, text: witnessBase.text }
      : null,
    matchesSupplement,
    classificationDetail,
    affectedScripts: affects,
    decisions: (catalog.correctionsByLine.get(`${row.work}\u0000${line}`) ?? []).map(correction => ({
      baseEdition: correction.baseEdition,
      otherEdition: correction.otherEdition,
      baseText: correction.baseText,
      otherText: correction.otherText,
      question: `应采用“${correction.baseText}”还是“${correction.otherText}”？`
    })),
    message: classification === 'prior-error-proven'
      ? '新录证明了旧录有误；新海报应改，已沿用旧字的白话说明也须复核。'
      : classification === 'independent-variant'
        ? '新录只是另一底本的独立异文，不是对旧录的勘误；旧海报与旧说明可保留，但不得混引。'
        : classification === 'claimed-prior-error-unconfirmed'
          ? '新录自称勘误但缺少独立旁证；在编辑裁定前只算候选异文，旧说明不动。'
          : classification === 'same-witness-variant'
            ? '新录与原录属同一见证差异，须由编辑裁定是否构成勘误。'
            : '新录是底本自身改录，校录中没有同见证的旁证；须核对原件后再用，旧说明暂不据改。'
  };
}

export function checkQuote(catalog, rawText, options = {}) {
  const analysis = analyzeText(catalog, rawText, options);
  return {
    query: rawText,
    status: analysis.status,
    claims: analysis.claims,
    warnings: analysis.warnings,
    notes: analysis.notes
  };
}

function copiesSupplementClaim(matchesSupplement, catalog) {
  return matchesSupplement.some(match => {
    const editionInfo = catalog.getEdition(match.edition);
    return editionInfo?.claimsPriorError && editionInfo?.hasIndependentEvidence;
  });
}
