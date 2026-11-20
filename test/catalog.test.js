import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { loadCatalog, buildCatalog } from '../lib/catalog.js';
import { analyzeText, lookupLine, compareReadings } from '../lib/query.js';
import { extractScripts, extractScript } from '../lib/excerpts.js';
import { auditCatalog, selectExhibit, assessNewCollation } from '../lib/audit.js';
import { qrAnswer, resolveLink, resolveLegacyQuery, linkToQr } from '../lib/links.js';

const catalogPromise = loadCatalog();

test('底本谱系区分原录、同一见证补校与独立抄本', async () => {
  const catalog = await catalogPromise;
  assert.equal(catalog.getEdition('石录').kind, 'base');
  assert.equal(catalog.getEdition('石录补校').kind, 'supplement');
  assert.equal(catalog.getEdition('石录补校').parent, '石录');
  assert.equal(catalog.getEdition('石录补校').witnessGroup, '石录');
  assert.equal(catalog.getEdition('抄本').kind, 'independent');
  assert.equal(catalog.getEdition('抄本').witnessGroup, '抄本');
});

test('异体查询保留底本实际字形与底本名', async () => {
  const catalog = await catalogPromise;
  const result = analyzeText(catalog, '渔灯照疏岸，风定泊秋舟');
  assert.equal(result.status, 'attested-via-variant');
  const claim = result.completeClaims[0];
  assert.equal(claim.edition, '石录');
  assert.deepEqual(claim.lines.map(line => line.text), ['渔灯照疎岸', '风定泊秋舟']);
  assert.equal(claim.variantNotes.length, 1);
  assert.equal(claim.variantNotes[0].editionGlyph, '疎');
  assert.equal(claim.variantNotes[0].queryGlyph, '疏');
  assert.equal(claim.citation, '《渡曲》石录第1–2行');
});

test('不同底本的两句不会被拼成一条引文', async () => {
  const catalog = await catalogPromise;
  const result = analyzeText(catalog, '渔灯照疏岸，潮平过晚舟');
  assert.equal(result.status, 'conflated');
  assert.equal(result.completeClaims.length, 0);
  assert.equal(result.claims.length, 0);
  const warning = result.warnings.find(item => item.code === 'MIXED_WORKS');
  assert.ok(warning, '应指出两句分属不同作品');
  assert.deepEqual(warning.detail.map(item => item.work), ['岸歌', '渡曲']);
  assert.equal(result.clauseEvidence.length, 2);
  assert.equal(result.clauseEvidence[0].candidates[0].text, '渔灯照疏岸');
  assert.equal(result.clauseEvidence[1].candidates[0].text, '潮平过晚舟');
});

test('同一作品内跨底本拼接同样被拒绝', async () => {
  const catalog = await catalogPromise;
  const result = analyzeText(catalog, '渔灯照疏浦，风定泊秋舟');
  assert.equal(result.status, 'conflated');
  const warning = result.warnings.find(item => item.code === 'MIXED_EDITIONS');
  assert.ok(warning);
  assert.deepEqual(warning.detail.map(item => item.edition), ['抄本', '石录']);
});

test('整联可在单一底本逐行核对时命中', async () => {
  const catalog = await catalogPromise;
  for (const [text, edition] of [
    ['渔灯照疎岸，风定泊秋舟', '石录'],
    ['渔灯照疏浦，潮平过晚舟', '抄本'],
    ['渔灯照疏岸，雁落听更漏', '抄本']
  ]) {
    const result = analyzeText(catalog, text);
    assert.equal(result.status, 'attested', text);
    assert.equal(result.completeClaims.length, 1);
    assert.equal(result.completeClaims[0].edition, edition);
  }
});

test('标注作品与依据不符时指出伪出处', async () => {
  const catalog = await catalogPromise;
  const result = analyzeText(catalog, '《岸歌》渔灯照疏岸，风定泊秋舟');
  assert.equal(result.status, 'other-work-only');
  assert.equal(result.claims.length, 0);
  const warning = result.warnings.find(item => item.code === 'OTHER_WORK_EVIDENCE');
  assert.ok(warning);
  assert.equal(warning.detail[0].work, '渡曲');
  assert.equal(warning.detail[0].citation, '《渡曲》石录第1–2行');
});

test('半句查询给出全行依据而不截取半句当引文', async () => {
  const catalog = await catalogPromise;
  const result = analyzeText(catalog, '渔灯照疏');
  assert.equal(result.status, 'attested-fragment');
  assert.ok(result.fragments.length > 0);
  assert.ok(result.fragments.every(fragment => fragment.text.length > 4));
  assert.ok(result.notes.some(note => note.includes('半句')));
});

test('白话转述不会被当作原文', async () => {
  const catalog = await catalogPromise;
  const result = analyzeText(catalog, '潮平后过舟');
  assert.equal(result.status, 'paraphrase-only');
  assert.equal(result.claims.length, 0);
  assert.equal(result.paraphraseCandidates.length, 1);
  assert.equal(result.paraphraseCandidates[0].edition, '抄本');
  assert.equal(result.paraphraseCandidates[0].text, '潮平过晚舟');
  assert.equal(result.paraphraseCandidates[0].nonLiteral, true);
});

test('正文引用与旁列异文、同一见证校改分列', async () => {
  const catalog = await catalogPromise;
  const comparison = compareReadings(catalog, '渡曲', 2);
  assert.equal(comparison.base.edition, '石录');
  assert.equal(comparison.base.text, '风定泊秋舟');
  assert.deepEqual(comparison.apparatus.map(item => item.edition), ['抄本']);
  assert.equal(comparison.apparatus[0].status, 'independent-witness');
  assert.deepEqual(comparison.corrections.map(item => item.edition), ['石录补校']);
  assert.equal(comparison.corrections[0].status, 'correction-claimed');
});

test('讲解稿抽取：引文、白话与字形问题各自可查', async () => {
  const catalog = await catalogPromise;
  const scripts = extractScripts(catalog);
  assert.equal(scripts.length, 3);

  const folded = scripts.find(script => script.id === 'c1');
  assert.equal(folded.quotes.length, 1);
  assert.equal(folded.quotes[0].citation, '《渡曲》石录第1行');
  assert.equal(folded.quotes[0].text, '渔灯照疎岸');
  assert.ok(folded.findings.some(finding => finding.code === 'GLYPH_SUBSTITUTION'));
  assert.ok(folded.findings.some(finding => finding.code === 'PARAPHRASE_OTHER_EDITION'));
  assert.ok(folded.conflicts.some(conflict => conflict.code === 'PARAPHRASE_FROM_OTHER_EDITION'));

  const exhibit = scripts.find(script => script.id === 'c2');
  assert.deepEqual(exhibit.quotes.map(quote => quote.edition), ['石录', '石录']);
  assert.deepEqual(exhibit.quotes.map(quote => quote.line), [1, 2]);

  const guide = scripts.find(script => script.id === 'c3');
  const term = guide.terms.find(item => item.term === '定');
  assert.ok(term);
  assert.equal(term.acceptedCorrections[0].otherEdition, '石录补校');
  assert.ok(guide.findings.some(finding => finding.code === 'TERM_SENSE_AFFECTED'));
});

test('讲解稿跨底本引文被识别为版面冲突', async () => {
  const catalog = await catalogPromise;
  const script = extractScript(catalog, {
    id: 'x1',
    format: '展签',
    text: '《渡曲》“渔灯照疏岸”与“潮平过晚舟”。'
  });
  assert.ok(script.conflicts.some(conflict => conflict.code === 'MULTIPLE_LITERAL_EDITIONS'));
  assert.deepEqual(script.quotes.map(quote => quote.edition), ['石录', '抄本']);
});

test('补校自称勘误但无独立旁证时只列为候选', async () => {
  const catalog = await catalogPromise;
  const audit = auditCatalog(catalog);
  const finding = audit.findings.find(item => item.code === 'SAME_WITNESS_DIFFERENCE');
  assert.ok(finding);
  assert.equal(finding.classification.kind, 'claimed-prior-error-unconfirmed');
  assert.equal(finding.classification.oldReadingInvalidated, false);
  assert.equal(finding.decisionRequired, true);
  const decision = audit.decisions.find(item => item.code === 'CORRECTION_ADJUDICATION');
  assert.ok(decision.question.includes('风定泊秋舟'));
  assert.ok(decision.question.includes('风静泊秋舟'));
});

test('独立抄本异文不是对原录的勘误', async () => {
  const catalog = await catalogPromise;
  const audit = auditCatalog(catalog);
  const independent = audit.findings.filter(item => item.code === 'INDEPENDENT_VARIANT');
  assert.ok(independent.length >= 2);
  assert.ok(independent.every(item => item.message.includes('不是')));
});

test('展签校验：缺行的补校本不能充当整联底本', async () => {
  const catalog = await catalogPromise;
  const impossible = selectExhibit(catalog, { work: '渡曲', edition: '石录补校', from: 1, to: 2 });
  assert.equal(impossible.ok, false);
  assert.deepEqual(impossible.missing, [1]);

  const base = selectExhibit(catalog, { work: '渡曲', edition: '石录', from: 1, to: 2 });
  assert.equal(base.ok, true);
  assert.deepEqual(base.lines.map(line => line.text), ['渔灯照疎岸', '风定泊秋舟']);
  assert.equal(base.lineBreakConsistent, true);
  const exhibitCheck = base.scriptChecks.find(check => check.scriptId === 'c2');
  assert.equal(exhibitCheck.matchesExhibitEdition, true);
  const foldedCheck = base.scriptChecks.find(check => check.scriptId === 'c1');
  assert.equal(foldedCheck.matchesExhibitEdition, false);
});

test('新校录改正一字：补校候选与独立异文判定不同', async () => {
  const catalog = await catalogPromise;
  const supplement = assessNewCollation(catalog, {
    work: '渡曲', edition: '石录补校', line: '2', text: '风静泊秋舟'
  });
  assert.equal(supplement.kind, 'unchanged');

  const baseChange = assessNewCollation(catalog, {
    work: '渡曲', edition: '石录', line: '2', text: '风静泊秋舟'
  });
  assert.equal(baseChange.kind, 'changed-character');
  assert.equal(baseChange.classification, 'claimed-prior-error-unconfirmed');
  assert.equal(baseChange.classificationDetail.oldReadingInvalidated, false);

  const independent = assessNewCollation(catalog, {
    work: '渡曲', edition: '抄本', line: '2', text: '潮平过晚舟'
  });
  assert.equal(independent.kind, 'unchanged');

  const newCopy = assessNewCollation(catalog, {
    work: '渡曲', edition: '抄本', line: '1', text: '渔灯照疏浦'
  });
  assert.equal(newCopy.kind, 'unchanged');
});

test('独立底本新增异文只影响引用说明，不判旧录有误', async () => {
  const catalog = await catalogPromise;
  // 构造一份临时资料：让独立抄本的读法变更，验证其不被判成勘误。
  const tables = structuredClone(catalog.tables);
  const independent = tables['校录.json'].find(row => row.id === 'p4');
  independent.text = '潮平送晚舟';
  const changed = buildCatalog(tables);
  const assessment = assessNewCollation(changed, {
    work: '渡曲', edition: '抄本', line: '2', text: '潮平送晚舟'
  });
  assert.equal(assessment.kind, 'unchanged');
  const variant = assessNewCollation(changed, {
    work: '渡曲', edition: '抄本', line: '1', text: '渔灯照疏浦'
  });
  assert.equal(variant.kind, 'unchanged');
  const newReading = assessNewCollation(changed, {
    work: '渡曲', edition: '抄本', line: '2', text: '潮平送客舟'
  });
  assert.equal(newReading.classification, 'independent-variant');
  assert.equal(newReading.classificationDetail.oldReadingInvalidated, false);
});

test('二维码答复给出底本、原行、原因与提示', async () => {
  const catalog = await catalogPromise;
  const answer = qrAnswer(catalog, '渔灯照疏岸，风定泊秋舟');
  assert.equal(answer.found, true);
  assert.equal(answer.edition, '石录');
  assert.deepEqual(answer.originalLines, ['渔灯照疎岸', '风定泊秋舟']);
  assert.equal(answer.citation, '《渡曲》石录第1–2行');
  assert.ok(answer.matchReason.includes('异体'));
  assert.ok(answer.warning.includes('异体'));
  assert.equal(answer.link.edition, '石录');

  const conflated = qrAnswer(catalog, '渔灯照疏岸，潮平过晚舟');
  assert.equal(conflated.found, false);
  assert.equal(conflated.status, 'conflated');
  assert.ok(conflated.warning.includes('没有刊载'));
});

test('旧链接仍可定位，并说明再印时哪处词义需调整', async () => {
  const catalog = await catalogPromise;
  const link = linkToQr(catalog, { work: '渡曲', edition: '石录', from: 1, to: 2 });
  assert.equal(link.citation, '《渡曲》石录第1–2行');

  const current = resolveLink(catalog, link);
  assert.equal(current.status, 'ok');
  assert.equal(current.textChanged, false);
  const sense = current.suggestions.find(item => item.code === 'SENSE_EXPLANATION_AFFECTED');
  assert.ok(sense);
  assert.equal(sense.term, '定');
  assert.equal(sense.otherEdition, '石录补校');
  assert.equal(sense.decisionRequired, true);
});

test('旧链接所载文字与现存校录不同时标记为已取代', async () => {
  const catalog = await catalogPromise;
  const link = linkToQr(catalog, { work: '渡曲', edition: '石录', from: 1, to: 2 });
  const superseded = resolveLink(catalog, { ...link, text: '渔灯照疎岸\n风静泊秋舟' });
  assert.equal(superseded.status, 'superseded');
  assert.equal(superseded.textChanged, true);
  assert.equal(superseded.historicalText, '渔灯照疎岸\n风静泊秋舟');
  assert.equal(superseded.text, '渔灯照疎岸\n风定泊秋舟');
  const reading = superseded.suggestions.find(item => item.code === 'READING_SUPERSEDED');
  assert.ok(reading);
  assert.equal(reading.correctedEdition, '石录补校');
});

test('损坏或缺失的旧链接不会被其他底本代填', async () => {
  const catalog = await catalogPromise;
  const missingLine = resolveLink(catalog, { work: '渡曲', edition: '石录', from: 1, to: 5 });
  assert.equal(missingLine.status, 'broken');
  assert.equal(missingLine.code, 'LINE_MISSING');

  const missingEdition = resolveLink(catalog, { work: '渡曲', edition: '佚本', from: 1, to: 1 });
  assert.equal(missingEdition.status, 'broken');
  assert.equal(missingEdition.code, 'UNKNOWN_EDITION');
  assert.ok(missingEdition.message.includes('不可用其他底本代填'));
});

test('旧手册裸检索词可解析到单一行，拒绝拼合', async () => {
  const catalog = await catalogPromise;
  const matched = resolveLegacyQuery(catalog, '渔灯照疎岸，风定泊秋舟');
  assert.equal(matched.status, 'ok');
  assert.equal(matched.claim.citation, '《渡曲》石录第1–2行');

  const variant = resolveLegacyQuery(catalog, '渔灯照疏岸，风定泊秋舟');
  assert.equal(variant.status, 'ok-via-variant');
  assert.equal(variant.claim.edition, '石录');

  const refused = resolveLegacyQuery(catalog, '渔灯照疏岸，潮平过晚舟');
  assert.equal(refused.status, 'refused-conflated');
  assert.equal(refused.matched, false);
  assert.ok(refused.detail.length >= 2);
});

test('完整文本读取与引用不依赖标点', async () => {
  const catalog = await catalogPromise;
  const line = lookupLine(catalog, '渡曲', '石录', '1');
  assert.equal(line.text, '渔灯照疎岸');
  assert.equal(line.citation, '《渡曲》石录第1行');
  assert.equal(lookupLine(catalog, '渡曲', '石录', '9'), null);
});

test('资料损坏时不悄悄返回空结果', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'catalog-'));
  try {
    const directory = join(scratch, '材料');
    await mkdir(directory);
    await cp(new URL('../资料/', import.meta.url), directory, { recursive: true });
    await writeFile(join(directory, '校录.json'), JSON.stringify([
      { id: 'x1', work: '渡曲', edition: '石录', line: '1', text: '渔灯照疎岸' },
      { id: 'x2', work: '渡曲', edition: '石录', line: '1', text: '风定泊秋舟' }
    ]));
    await assert.rejects(
      loadCatalog(pathToFileURL(directory + sep)),
      error => error instanceof TypeError && error.message.includes('重复')
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('不同作品同文时，标注作品之外的依据会作为警示列出', async () => {
  const catalog = await catalogPromise;
  const warning = (await import('../lib/query.js')).analyzeText(
    catalog,
    '《岸歌》渔灯照疏岸，风定泊秋舟'
  ).warnings.find(item => item.code === 'OTHER_WORK_EVIDENCE');
  assert.ok(warning);
  assert.equal(warning.detail[0].work, '渡曲');
  assert.equal(warning.detail[0].citation, '《渡曲》石录第1–2行');
});

test('白话说明所用的字若在展签所选行之外，会单独提示', async () => {
  const catalog = await catalogPromise;
  const check = selectExhibit(catalog, { work: '渡曲', edition: '石录', from: 1, to: 2 });
  // 导览 c3 的“定”落在第 2 行内，因此不构成越行；改取只含第 1 行的展签来验证。
  const restricted = selectExhibit(catalog, { work: '渡曲', edition: '石录', from: 1, to: 1 });
  assert.equal(check.scriptChecks.find(item => item.scriptId === 'c3'), undefined);
  const guide = restricted.scriptChecks.find(item => item.scriptId === 'c3');
  assert.ok(guide);
  assert.equal(guide.matchesExhibitEdition, false);
  assert.ok(guide.note.includes('定'));
});
