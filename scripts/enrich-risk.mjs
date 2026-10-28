// 기존 briefing.json(risk_brief·risk_tags 이전 버전)을 새 스키마로 보강한다. 모델 호출 없음(결정적 규칙).
// 사용: node scripts/enrich-risk.mjs [docs/briefing.json ...]   (기본: docs/briefing.json)
import { readFile, writeFile } from 'node:fs/promises';
import { classifyRisks, normalizeRiskTags, deriveRiskBrief } from './risk-utils.mjs';

const NEWS = ['critical', 'daily_news', 'subsidiary_news', 'additional_news'];
const files = process.argv.slice(2);
if (!files.length) files.push('docs/briefing.json');

for (const f of files) {
  const raw = await readFile(f, 'utf8');
  const crlf = raw.includes('\r\n');
  const b = JSON.parse(raw);
  let tagged = 0;
  const tag = (it) => {
    if (Array.isArray(it.risk_tags) && it.risk_tags.length) return;
    it.risk_tags = normalizeRiskTags([], `${it.title} ${it.summary} ${it.why_woori_cro}`, it.axis);
    tagged += 1;
  };
  for (const k of NEWS) for (const it of b[k] || []) tag(it);
  for (const s of Object.values(b.sectors || {})) for (const it of s.news || []) tag(it);
  let brief = false;
  if (!Array.isArray(b.risk_brief) || b.risk_brief.length < 3) {
    b.risk_brief = deriveRiskBrief(NEWS.flatMap((k) => b[k] || []));
    brief = true;
  }
  let out = `${JSON.stringify(b, null, 2)}\n`;
  if (crlf) out = out.replace(/\n/g, '\r\n');
  await writeFile(f, out, 'utf8');
  console.log(`${f}: tagged ${tagged} articles, risk_brief ${brief ? 'derived' : 'kept'} (${b.risk_brief.length})`);
}
