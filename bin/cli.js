#!/usr/bin/env node
import { loadCatalog } from '../lib/catalog.js';
import { analyzeText, lookupLine, compareReadings } from '../lib/query.js';
import { extractScripts } from '../lib/excerpts.js';
import { auditCatalog, selectExhibit, assessNewCollation } from '../lib/audit.js';
import { qrAnswer, resolveLink, resolveLegacyQuery, linkToQr } from '../lib/links.js';

function usage() {
  return `用法：node bin/cli.js <命令> [参数]

命令：
  search <检索词> [--work 作品] [--edition 底本]
      按底本原行检索；区分整行、半句、异体命中与跨底拼合。
  line <作品> <底本> <行号>
      取一条已校录原行及其引用信息。
  compare <作品> <行号>
      对照该行各底本读法；正文与旁列异文分列。
  scripts
      抽取讲解稿中的引文、白话转述与词义解释依据。
  audit
      编校审计：列出问题、需编辑裁定的事项与再印调整点。
  exhibit <作品> <底本> <起行> <终行>
      校验展签所选底本的整联文字、分行及讲解稿是否同属一版。
  qr <检索词> [--work 作品]
      给出二维码查询答复：底本、原行、匹配原因与提示。
  link <作品> <底本> <起行> [终行]
      生成引用链接与二维码校验结果。
  resolve-link <作品> <底本> <起行> <终行> [--text 旧链接所载文字]
      解析旧链接；文字已变时给出再印裁定点。
  legacy <检索词>
      解析旧手册中的裸检索词；拒绝跨底拼合。
  assess <作品> <底本> <行号> <新录文>
      判断新校录是独立旁证还是旧录有误，并列出受影响说明。
  --json   以 JSON 输出
`;
}

function parseArgs(argv) {
  const positional = [];
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--json') {
      options.json = true;
    } else if (token.startsWith('--')) {
      const name = token.slice(2);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        options[name] = true;
      } else {
        options[name] = value;
        index += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, options };
}

function requireArgs(positional, count, command) {
  if (positional.length < count) {
    throw new Error(`${command} 需要 ${count} 个参数；运行 node bin/cli.js 查看用法。`);
  }
}

function printText(result, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result}\n`);
}

function describeAnalysis(result) {
  const lines = [];
  lines.push(`状态：${result.status}`);
  if (result.declaredWork) lines.push(`标注作品：《${result.declaredWork}》`);
  for (const claim of result.claims) {
    lines.push('');
    lines.push(`依据：${claim.citation}（${claim.matchKind}${claim.viaVariant ? '，异体相合' : ''}）`);
    for (const line of claim.lines) lines.push(`  第${line.line}行 ${line.text}`);
    for (const reason of claim.reasons) lines.push(`  原因：${reason}`);
    for (const note of claim.variantNotes) lines.push(`  提示：${note.note}`);
  }
  for (const warning of result.warnings) {
    lines.push('');
    lines.push(`警示：${warning.message}`);
    for (const item of warning.detail ?? []) {
      if (!item || typeof item !== 'object' || !item.text) continue;
      const clause = item.clause ?? (item.clauses ?? []).join('、');
      lines.push(`  ${clause ? `${clause} → ` : ''}${item.citation ?? `《${item.work}》${item.edition}第${item.line}行`} ${item.text}`);
    }
  }
  const showClauses = (result.clauseEvidence ?? []).some(evidence =>
    evidence.outsideDeclaredWork || !evidence.found);
  if (showClauses) {
    for (const evidence of result.clauseEvidence) {
      if (evidence.found && !evidence.outsideDeclaredWork) continue;
      const first = evidence.candidates[0];
      lines.push(first
        ? `分句：${evidence.clause} → ${first.citation}（不在标注作品内）`
        : `分句：${evidence.clause} → 无原行依据`);
    }
  }
  for (const fragment of result.fragments) {
    lines.push('');
    lines.push(`半句依据：${fragment.citation} ${fragment.text}`);
    lines.push(`  ${fragment.note}`);
  }
  for (const paraphrase of result.paraphraseCandidates) {
    lines.push('');
    lines.push(`白话近似：${paraphrase.citation} ${paraphrase.text}`);
    lines.push(`  ${paraphrase.note}`);
  }
  for (const note of result.notes) lines.push(`\n说明：${note}`);
  if (result.claims.length === 0 && result.warnings.length === 0 &&
      result.notes.length === 0 && result.fragments.length === 0 &&
      result.paraphraseCandidates.length === 0) {
    lines.push('没有找到原行依据。');
  }
  return lines.join('\n');
}

function main() {
  return (async () => {
    const { positional, options } = parseArgs(process.argv.slice(2));
    const [command, ...rest] = positional;
    const catalog = await loadCatalog();

    switch (command) {
      case 'search': {
        requireArgs(rest, 1, 'search');
        const query = rest.join(' ');
        const result = analyzeText(catalog, query, {
          work: options.work,
          edition: options.edition
        });
        printText(options.json ? result : describeAnalysis(result), options);
        return;
      }
      case 'line': {
        requireArgs(rest, 3, 'line');
        const result = lookupLine(catalog, rest[0], rest[1], rest[2]);
        if (!result) throw new Error('未找到该作品、底本与行号的校录。');
        printText(options.json ? result : `${result.citation}\n${result.text}`, options);
        return;
      }
      case 'compare': {
        requireArgs(rest, 2, 'compare');
        const result = compareReadings(catalog, rest[0], rest[1]);
        if (!result) throw new Error('未找到该作品与行号的校录。');
        if (options.json) {
          printText(result, options);
          return;
        }
        const lines = [`正文：${result.base.citation} ${result.base.text}`];
        if (result.apparatus.length > 0) {
          lines.push('', '旁列异文：');
          for (const item of result.apparatus) {
            lines.push(`  ${item.edition} 第${item.line}行 ${item.text}（${item.note}）`);
          }
        }
        if (result.corrections.length > 0) {
          lines.push('', '同一见证的校改候选（须编辑裁定）：');
          for (const item of result.corrections) {
            lines.push(`  ${item.edition} 第${item.line}行 ${item.text}（${item.note}）`);
          }
        }
        lines.push('', result.note);
        printText(lines.join('\n'), options);
        return;
      }
      case 'scripts': {
        const scripts = extractScripts(catalog);
        if (options.json) {
          printText(scripts, options);
          return;
        }
        const lines = [];
        for (const script of scripts) {
          lines.push(`【${script.format} ${script.id}】${script.text}`);
          for (const quote of script.quotes) {
            lines.push(`  引文：${quote.citation} ${quote.text}`);
            if (quote.differences.length > 0) {
              for (const difference of quote.differences) {
                lines.push(`    字形：稿作“${difference.queryGlyph}”，底本作“${difference.editionGlyph}”`);
              }
            }
          }
          for (const paraphrase of script.paraphrases) {
            lines.push(`  白话：${paraphrase.clause} → ${paraphrase.citation} ${paraphrase.text}`);
          }
          for (const term of script.terms) {
            if (!term.note) continue;
            lines.push(`  词义：${term.note}`);
          }
          for (const conflict of script.conflicts) lines.push(`  冲突：${conflict.message}`);
          lines.push('');
        }
        printText(lines.join('\n').trim(), options);
        return;
      }
      case 'audit': {
        const result = auditCatalog(catalog);
        if (options.json) {
          printText(result, options);
          return;
        }
        const lines = [];
        lines.push(`版本：${result.editions.map(edition => `${edition.name}（${edition.relation}）`).join('、')}`);
        lines.push('');
        lines.push('问题：');
        for (const finding of result.findings) {
          lines.push(`  [${finding.severity}] ${finding.code} ${finding.message}`);
        }
        if (result.decisions.length > 0) {
          lines.push('', '需编辑裁定：');
          for (const decision of result.decisions) {
            lines.push(`  ${decision.code}：${decision.question}`);
          }
        }
        if (result.reprint.senseChanges.length > 0) {
          lines.push('', '再印词义调整：');
          for (const change of result.reprint.senseChanges) {
            lines.push(`  ${change.format}${change.scriptId}“${change.term}”：${change.action}`);
          }
        }
        if (result.reprint.affectedScripts.length > 0) {
          lines.push('', '受影响稿件：');
          for (const script of result.reprint.affectedScripts) {
            lines.push(`  ${script.format}${script.id}（${script.issues.length} 处，${script.decisionRequired ? '需裁定' : '可直接修订'}）`);
          }
        }
        printText(lines.join('\n'), options);
        return;
      }
      case 'exhibit': {
        requireArgs(rest, 4, 'exhibit');
        const result = selectExhibit(catalog, {
          work: rest[0],
          edition: rest[1],
          from: Number(rest[2]),
          to: Number(rest[3])
        });
        if (options.json) {
          printText(result, options);
          return;
        }
        if (!result.ok) {
          printText(result.message, options);
          return;
        }
        const lines = [
          `${result.citation}`,
          ...result.lines.map(line => `  第${line.line}行 ${line.text}`),
          '',
          `分行一致：${result.lineBreakConsistent ? '是' : '否'}`
        ];
        for (const check of result.scriptChecks) {
          lines.push(`讲解稿 ${check.format}${check.scriptId}：${check.matchesExhibitEdition ? '同底本' : check.note}`);
        }
        lines.push('', result.note);
        printText(lines.join('\n'), options);
        return;
      }
      case 'qr': {
        requireArgs(rest, 1, 'qr');
        const result = qrAnswer(catalog, rest.join(' '), { work: options.work });
        if (options.json) {
          printText(result, options);
          return;
        }
        const lines = [];
        if (!result.found) {
          lines.push(`未给出可引用原行（${result.status}）。`);
          if (result.warning) lines.push(result.warning);
          for (const suggestion of result.suggestions ?? []) {
            lines.push(suggestion.message);
            for (const item of suggestion.detail ?? []) {
              lines.push(`  ${item.clause ?? ''} → 《${item.work}》${item.edition}第${item.line}行 ${item.text ?? ''}`);
            }
          }
          for (const paraphrase of result.paraphrases ?? []) {
            lines.push(`白话近似：${paraphrase.citation} ${paraphrase.text}`);
          }
          printText(lines.join('\n'), options);
          return;
        }
        lines.push(`底本：${result.edition}（${result.citation}）`);
        for (const line of result.originalLines) lines.push(`  原文：${line}`);
        lines.push(`匹配原因：${result.matchReason}`);
        if (result.warning) lines.push(`提示：${result.warning}`);
        if (result.alternatives.length > 0) {
          lines.push('其他依据：');
          for (const alternative of result.alternatives) {
            lines.push(`  ${alternative.citation} ${alternative.text}`);
          }
        }
        if (result.paraphrases.length > 0) {
          lines.push('白话近似（非原文）：');
          for (const paraphrase of result.paraphrases) {
            lines.push(`  ${paraphrase.citation} ${paraphrase.text}`);
          }
        }
        printText(lines.join('\n'), options);
        return;
      }
      case 'link': {
        requireArgs(rest, 3, 'link');
        const result = linkToQr(catalog, {
          work: rest[0],
          edition: rest[1],
          from: Number(rest[2]),
          to: Number(rest[3] ?? rest[2])
        });
        if (options.json) {
          printText(result, options);
          return;
        }
        printText(`${result.citation}\n${result.text}\n${result.reason}\n${result.warning}`, options);
        return;
      }
      case 'resolve-link': {
        requireArgs(rest, 4, 'resolve-link');
        const result = resolveLink(catalog, {
          work: rest[0],
          edition: rest[1],
          from: Number(rest[2]),
          to: Number(rest[3]),
          text: typeof options.text === 'string' ? options.text : null
        });
        if (options.json) {
          printText(result, options);
          return;
        }
        const lines = [
          `状态：${result.status}`,
          result.citation ?? '',
          result.text ?? ''
        ];
        if (result.textChanged) {
          lines.push(`链接原载：${result.historicalText}`);
          lines.push(`提示：${result.warning}`);
        }
        for (const suggestion of result.suggestions ?? []) lines.push(`再印：${suggestion.message}`);
        printText(lines.filter(Boolean).join('\n'), options);
        return;
      }
      case 'legacy': {
        requireArgs(rest, 1, 'legacy');
        const result = resolveLegacyQuery(catalog, rest.join(' '));
        if (options.json) {
          printText(result, options);
          return;
        }
        if (result.matched) {
          printText(`${result.citation}\n${result.claim.text}\n${result.warning}`, options);
        } else {
          const lines = [result.message];
          for (const item of result.detail ?? []) {
            lines.push(`  ${item.clause ?? ''} → 《${item.work}》${item.edition}第${item.line}行 ${item.text ?? ''}`);
          }
          printText(lines.join('\n'), options);
        }
        return;
      }
      case 'assess': {
        requireArgs(rest, 4, 'assess');
        const result = assessNewCollation(catalog, {
          work: rest[0],
          edition: rest[1],
          line: rest[2],
          text: rest.slice(3).join(' ')
        });
        if (options.json) {
          printText(result, options);
          return;
        }
        const lines = [`判定：${result.kind || result.classification}`, result.message];
        if (result.before) lines.push(`原录：${result.before}`);
        if (result.after) lines.push(`新录：${result.after}`);
        for (const decision of result.decisions ?? []) lines.push(`裁定：${decision.question}`);
        if (result.affectedScripts?.length) lines.push(`受影响稿件：${result.affectedScripts.join('、')}`);
        printText(lines.filter(Boolean).join('\n'), options);
        return;
      }
      default:
        printText(usage(), options);
        process.exitCode = command ? 1 : 0;
    }
  })();
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
