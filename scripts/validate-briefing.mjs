// 드라이런 결과 검증: 스키마 키·newsItem 필드·금지어·분포·업권(sectors/editions)을 출력한다. 실패 항목이 있으면 exit 1.
// 사용: node scripts/validate-briefing.mjs [docs/briefing.dryrun.json]
import { readFile } from 'node:fs/promises';

const path = process.argv[2] || 'docs/briefing.dryrun.json';
const b = JSON.parse(await readFile(path, 'utf8'));
const NEWS = ['critical', 'daily_news', 'subsidiary_news', 'additional_news'];
const top = ['executive_judgment', 'executive_judgment_bullets', ...NEWS, 'forward_looking_points', 'insights', 'monitoring_points', 'meta'];
const req = ['title', 'url', 'published', 'source_name', 'summary', 'why_woori_cro', 'entity', 'channel', 'source_type', 'risk_type', 'urgency', 'confidence', 'critical', 'window', 'watchpoints'];
const banned = ['점검해야 합니다', '확인해야 합니다', '주목해야 합니다', '검증 가능', '조사 근거', '기사가 부족'];
const SECTOR_IDS = ['bank', 'card_capital', 'insurance', 'securities_am']; // card_capital = 여전·저축은행 (savings 는 2026-10-27 card_capital 에 병합)
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); return ok; };

console.log(`file: ${path}`);
console.log('top-level keys present:', check(top.every((k) => k in b), 'top-level keys missing'), '| extra:', Object.keys(b).filter((k) => !top.includes(k)));
const line = (it) => `   ${String(it.published).padEnd(16)} | ${String(it.axis).padEnd(11)} ${String(it.score).padStart(3)} | ${String(it.sector).padEnd(13)} ${String(it.window).padEnd(7)} crit=${it.critical} ${String(it.source_type).padEnd(8)} | ${String(it.title).slice(0, 55)} | ${it.event_key}`;
let missing = 0;
for (const k of NEWS) for (const it of b[k]) { const m = req.filter((f) => !(f in it)); if (m.length) { missing += 1; console.log('MISSING', k, it.title, m); } }
console.log('newsItem required fields present:', check(missing === 0, 'newsItem required fields missing'));
const urls = new Set(); const eventKeys = new Set(); let dupUrl = 0; let dupEvent = 0;
const seen = (it) => { if (urls.has(it.url)) dupUrl += 1; urls.add(it.url); const ek = String(it.event_key || '').toLowerCase().replace(/\s/g, ''); if (ek) { if (eventKeys.has(ek)) dupEvent += 1; eventKeys.add(ek); } };
console.log('── common (기존 최상위 키) ──');
for (const k of NEWS) {
  console.log(`${k}: ${b[k].length}`);
  for (const it of b[k]) { seen(it); console.log(line(it)); check(it.sector === 'group' || it.promoted_from_sector, `common item has sector=${it.sector}: ${it.title}`); }
}
const commonTotal = NEWS.reduce((n, k) => n + b[k].length, 0);
const isFallback = Boolean(b.meta?.fallback_notice);

// ── sectors / editions ──
console.log('── sectors ──');
check(b.sectors && typeof b.sectors === 'object', 'sectors missing');
let sectorTotal = 0;
for (const id of SECTOR_IDS) {
  const s = b.sectors?.[id];
  if (!check(Boolean(s), `sectors.${id} missing`)) continue;
  for (const f of ['label_ko', 'label_en', 'companies', 'judgment', 'news', 'shortfall_reason']) check(f in s, `sectors.${id}.${f} missing`);
  check(Array.isArray(s.companies) && s.companies.length > 0, `sectors.${id}.companies empty`);
  check(isFallback || (s.judgment || '').split(/(?<=[.!?])\s+/).filter(Boolean).length >= 2, `sectors.${id}.judgment < 2 sentences`);
  check(s.news.length <= 4, `sectors.${id}.news > 4`);
  check(isFallback || s.news.length >= 2 || Boolean(s.shortfall_reason), `sectors.${id} has ${s.news.length} news and no shortfall_reason`);
  console.log(`${id} (${s.label_ko} / ${s.label_en}; ${s.companies.join('·')}): ${s.news.length}${s.shortfall_reason ? ` | shortfall: ${s.shortfall_reason}` : ''}`);
  console.log(`   judgment: ${s.judgment}`);
  for (const it of s.news) {
    seen(it); sectorTotal += 1;
    const m = req.filter((f) => !(f in it)); if (m.length) { missing += 1; console.log('MISSING', id, it.title, m); failures.push(`sector item missing fields: ${it.title}`); }
    check(it.sector === id, `sectors.${id} item has sector=${it.sector}: ${it.title}`);
    check(typeof it.sector_hook === 'string', `sectors.${id} item lacks sector_hook: ${it.title}`);
    check(s.companies.some((c) => String(it.why_woori_cro).includes(c)), `sectors.${id} why_woori_cro lacks company name: ${it.title}`);
    console.log(line(it));
  }
}
console.log('── editions ──');
check(Array.isArray(b.editions) && b.editions.length === SECTOR_IDS.length + 1, 'editions missing or wrong count');
for (const e of b.editions || []) {
  check(['all', ...SECTOR_IDS].includes(e.id) && typeof e.label_ko === 'string' && Array.isArray(e.sections) && e.sections[0] === 'common', `edition malformed: ${JSON.stringify(e)}`);
  check(e.sections.slice(1).every((sec) => SECTOR_IDS.includes(sec)), `edition ${e.id} references unknown section`);
  console.log(`   ${e.id.padEnd(14)} ${e.label_ko.padEnd(8)} sections=${e.sections.join(',')}`);
}
check(b.editions?.find((e) => e.id === 'all')?.sections.length === SECTOR_IDS.length + 1, 'edition all must include every sector');

console.log('duplicate urls:', dupUrl, '| duplicate event_keys:', dupEvent, '| total unique urls:', urls.size, `| common ${commonTotal} + sector ${sectorTotal} = ${commonTotal + sectorTotal}`);
check(dupUrl === 0, 'duplicate urls across common/sector'); check(dupEvent === 0, 'duplicate event_keys across common/sector');
const narrative = JSON.stringify([b.executive_judgment, b.executive_judgment_bullets, b.insights, b.monitoring_points, b.forward_looking_points,
  ...NEWS.flatMap((k) => b[k].map((i) => [i.summary, i.why_woori_cro, i.watchpoints])),
  ...SECTOR_IDS.flatMap((id) => [b.sectors?.[id]?.judgment, ...(b.sectors?.[id]?.news || []).map((i) => [i.summary, i.why_woori_cro, i.watchpoints])])]);
const bannedFound = banned.filter((p) => narrative.includes(p));
console.log('banned phrases found:', bannedFound); check(bannedFound.length === 0, `banned phrases: ${bannedFound.join(', ')}`);
const leak = /https?:\/\/|\]\(/.test(narrative.replace(/"url":"[^"]*"/g, ''));
console.log('markdown/url leakage:', leak); check(!leak, 'markdown/url leakage');
console.log('executive_judgment:', b.executive_judgment);
console.log(`bullets=${b.executive_judgment_bullets.length} insights.bullets=${b.insights.bullets.length} action_items=${b.insights.action_items.length} monitoring=${b.monitoring_points.length} forward=${b.forward_looking_points.length} as_of=${b.insights.as_of}`);
const sample = b.critical[0] || b.daily_news[0];
if (sample) { console.log('sample summary:', sample.summary); console.log('sample why_woori_cro:', sample.why_woori_cro); console.log('sample watchpoints:', sample.watchpoints); }
const sectorSample = SECTOR_IDS.map((id) => b.sectors?.[id]?.news?.[0]).find(Boolean);
if (sectorSample) { console.log(`sector sample (${sectorSample.sector}) why_woori_cro:`, sectorSample.why_woori_cro); console.log('sector sample sector_hook:', sectorSample.sector_hook); }
const { usage, ...meta } = b.meta;
check(meta.pipeline_version === 'v3-sectors', `pipeline_version=${meta.pipeline_version}`);
check(meta.sector_counts && typeof meta.sector_counts === 'object', 'meta.sector_counts missing');
check(meta.sector_shortfall && typeof meta.sector_shortfall === 'object', 'meta.sector_shortfall missing');
check(meta.editions === SECTOR_IDS.length + 1, `meta.editions=${meta.editions}`);
if (!isFallback) for (const id of SECTOR_IDS) check(meta.sector_counts?.[id] === (b.sectors?.[id]?.news?.length ?? -1), `meta.sector_counts.${id} mismatch`);
console.log('meta:', JSON.stringify(meta, null, 1));
console.log('usage total:', JSON.stringify(usage?.total));
if (failures.length) { console.log(`\nVALIDATION FAILED (${failures.length}):`); for (const f of failures) console.log(' - ' + f); process.exit(1); }
console.log('\nVALIDATION OK');
