// =====================================================================================
// CRO STAFF 데일리 브리핑 생성 파이프라인 (v3-sectors)
//
// 목표: 실패 없이, 고품질로, 매일 '전체본 1 + 업권본 5'를 만든다.
//   - 공통(그룹 공통, sector=group): 7건(6~8). 지주 관점 — 감독당국·거시·지주·경쟁 금융그룹·해외법인 소재국.
//   - 업권(bank / card_capital(여전·저축은행) / insurance / securities_am): 각 3건(2~4, 업권별 target 은 config/sectors.json). 해당 계열사 관점.
//   - 총량 약 20~23건. 업권 정의는 config/sectors.json 이 가진다 (코드가 읽는다).
//
// 단계 개요
//   0. 설정·환경변수 로드 (OPENAI_MODEL_RESEARCH / SCORING / WRITING, DRY_RUN, FORCE_REGENERATE) + sectors.json
//   1. 이전 브리핑 이력 로드 (docs/briefing_history/*.json + docs/briefing.json, 최근 3개; 공통+업권 기사 모두)
//   2. 수집: researchStage() 8회 = 기존 5 (국내 언론 / 우리금융 계열사 / 경쟁사 / 글로벌 / 감독당국·공식자료)
//      + 업권 3 (여전·저축은행 / 보험 / 증권·운용; sectors.json 의 keywords·companies·sources_hint 를 프롬프트에 주입)
//      → 각 stage는 조사 메모 + [[SOURCE_METADATA]] (url,title,published) 를 돌려준다.
//   3. 날짜 검증: published가 비어 있는 후보를 web_search 1회로 보강한다.
//   4. 채점(CRO scoring): 후보 전체를 LLM이 채점한다 (axis / sector / score / event_key / promo·political 플래그 /
//      one_line_fact / cro_hook / sector_hook). json_schema strict. 실패 시 휴리스틱 채점으로 대체한다.
//   5. 확정(selectArticles): 코드가 결정론적으로 선정한다.
//      공통: sector=group 후보 → 3일 윈도우 → promo·political·저점수 제외 → 사건 중복 제거(event_key+제목 유사도,
//            이전 3개 브리핑과 비교) → 축별 슬롯 보장 → 점수순 채움(목표 7, 최소 6, 최대 8, 글로벌 단독 ≤2)
//            → 폴백 사다리(4일 윈도우 → 점수 임계 25 → 업권 고득점 기사 승격) → critical 판정(≤2) → 카테고리 배치.
//      업권: sector=X 후보 중 공통에 안 들어간 것 → 같은 필터·중복 제거(공통/다른 업권 선정분과도 비교)
//            → 자사 계열사 기사 1건 우선 → 점수순(목표 3, 최소 2, 최대 4) → 폴백 사다리(4일 → 임계 25)
//            → 그래도 부족하면 적게 싣고 meta.sector_shortfall[sector] 기록. score≥90 & severity 면 섹션 내 critical:true.
//   6. 작성(CRO writing): 공통 1회(summary / why_woori_cro / watchpoints / executive_judgment / insights 등)
//      + 업권 2회 묶음 호출(bank+card_capital / insurance+securities_am; 기사 작성 + sector judgment 2문장).
//      summary·why_woori_cro·judgment 는 서술문만 허용 — 의문문('?', '까요', '합니까' 로 끝나는 문장)은 금지어처럼 검출해 재요청하고, 남으면 문장 단위로 제거한다.
//      각 호출은 json_schema strict. 품질 위반(금지어·해라체·누락) 시 해당 호출만 1회 재요청, 그래도 실패하면
//      one_line_fact / cro_hook / sector_hook 으로 코드가 조립한다 (실패 종료 금지).
//   7. 후처리: 마크다운·URL 제거, 금지어 문장 제거, url/title/published 강제 덮어쓰기, 플래그 정리.
//   8. 메타·이력: meta(pipeline_version, slots, sector_counts, sector_shortfall, models, usage, changes) 기록,
//      docs/briefing.json 저장, docs/briefing_history/<date>.json 사본 저장(30일 유지).
//
// 출력 JSON (하위 호환):
//   - 기존 최상위 키(executive_judgment, critical, daily_news, subsidiary_news, additional_news, insights …)에는
//     **공통 기사만** 들어간다. 기존 웹/메일은 그대로 전체본의 공통부를 렌더한다. newsItem 에 sector/sector_hook 추가.
//   - 신규 `sectors`: { bank: {label_ko, label_en, companies, judgment, news[], shortfall_reason}, card_capital, … }
//   - 신규 `editions`: [{id:'all', label_ko:'전체본', sections:['common','bank',…]}, {id:'bank', sections:['common','bank']}, …]
//
// 테스트: DRY_RUN=1 이면 OpenAI 호출을 scripts/dry-run-fixtures.mjs 의 목 응답으로 대체하고
//         결과를 docs/briefing.dryrun.json 에 저장한다 (briefing.json은 건드리지 않는다).
// =====================================================================================

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';

// ---------------------------------------------------------------------------------
// 0. 설정 · 환경변수
// ---------------------------------------------------------------------------------
const DRY_RUN = process.env.DRY_RUN === '1';
const FORCE_REGENERATE = process.env.FORCE_REGENERATE === '1';
const apiKey = process.env.OPENAI_API_KEY || '';
const baseModel = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const MODELS = {
  research: process.env.OPENAI_MODEL_RESEARCH || baseModel,
  scoring: process.env.OPENAI_MODEL_SCORING || 'gpt-5.4-mini',
  writing: process.env.OPENAI_MODEL_WRITING || 'gpt-5.4',
  writing_fallback: baseModel
};
const cooldownMilliseconds = DRY_RUN ? 0 : Number(process.env.OPENAI_COOLDOWN_MS || 30_000);

const outputPath = new URL(DRY_RUN ? '../docs/briefing.dryrun.json' : '../docs/briefing.json', import.meta.url);
const liveBriefingPath = new URL('../docs/briefing.json', import.meta.url);
const historyDir = new URL('../docs/briefing_history/', import.meta.url);

// 공통(그룹 공통) 확정 목표
const COMMON_TARGET = 7;
const COMMON_MIN = 6;
const COMMON_MAX = 8;
const HIGH_VALUE_SCORE = 80; // 목표를 넘겨 최대치까지 추가하는 기준
const MAX_GLOBAL_ONLY = 2; // 공통 7건 중 글로벌 단독 기사 상한 (v2의 10건 중 3건과 같은 비율)
const MAX_CRITICAL = 2;
const PROMOTE_MIN_SCORE = 70; // 공통이 최소치에 못 미칠 때 업권 후보를 공통으로 승격하는 하한
// 업권별 확정 목표
const SECTOR_TARGET = 3; // 기본값. 업권별 target 은 config/sectors.json 의 `target` 으로 덮어쓴다 (여전·저축은행 4)
const SECTOR_MIN = 2;
const SECTOR_MAX = 4;
const SECTOR_CRITICAL_SCORE = 90; // 업권 섹션 내 critical 표시 기준 (score≥90 & severity_flag)
const CATEGORY_CAPS = { critical: 2, daily_news: 8, subsidiary_news: 5, additional_news: 3 };
const HISTORY_RETENTION_DAYS = 30;
const HISTORY_COMPARE_COUNT = 3;
const PIPELINE_VERSION = 'v3-sectors';

if (!DRY_RUN && !apiKey.startsWith('sk-')) throw new Error('OPENAI_API_KEY is missing.');

// ==== 업권 정의 (config/sectors.json) ====
const sectorConfig = JSON.parse(await readFile(new URL('../config/sectors.json', import.meta.url), 'utf8'));
const GROUP_DEF = sectorConfig.group;
const SECTORS = sectorConfig.sectors; // 순서 = 출력 순서
const SECTOR_IDS = SECTORS.map((s) => s.id);
const SECTOR_ENUM = ['group', ...SECTOR_IDS];
const sectorById = Object.fromEntries(SECTORS.map((s) => [s.id, s]));
const SECTOR_WRITING_BATCHES = [['bank', 'card_capital'], ['insurance', 'securities_am']]
  .map((ids) => ids.filter((id) => sectorById[id]));
for (const id of SECTOR_IDS) if (!SECTOR_WRITING_BATCHES.some((b) => b.includes(id))) SECTOR_WRITING_BATCHES[SECTOR_WRITING_BATCHES.length - 1].push(id);
const EDITIONS = [
  { id: 'all', label_ko: GROUP_DEF.edition_label_ko || '전체본', sections: ['common', ...SECTOR_IDS] },
  ...SECTORS.map((s) => ({ id: s.id, label_ko: s.edition_label_ko || `${s.label_ko}본`, sections: ['common', s.id] }))
];
function sectorLabel(id) { return id === 'group' ? GROUP_DEF.label_ko : (sectorById[id]?.label_ko || id); }
function sectorTarget(id) { const t = Number(sectorById[id]?.target); return Number.isFinite(t) && t > 0 ? Math.min(SECTOR_MAX, Math.max(SECTOR_MIN, t)) : SECTOR_TARGET; }
function sectorCompanies(id) { return id === 'group' ? GROUP_DEF.companies : (sectorById[id]?.companies || []); }

// ==== 비용/사용량 추적 (모델별) ====
const usageByModel = {};
const RATES = {
  'gpt-5.4-mini': { in: 0.75, out: 4.50 },
  'gpt-5.4': { in: 2.50, out: 15.00 },
  'gpt-5.5': { in: 5.00, out: 30.00 },
  'gpt-5.5-pro': { in: 30.00, out: 180.00 }
};
function recordUsage(model, usage) {
  const slot = usageByModel[model] ||= { input: 0, output: 0, calls: 0 };
  slot.input += Number(usage?.input_tokens || usage?.prompt_tokens || 0);
  slot.output += Number(usage?.output_tokens || usage?.completion_tokens || 0);
  slot.calls += 1;
}
function usageSummary() {
  const total = { input: 0, output: 0, calls: 0, estimated_cost_usd: 0 };
  for (const [model, u] of Object.entries(usageByModel)) {
    const r = RATES[model] || RATES['gpt-5.4'];
    const cost = (u.input / 1e6) * r.in + (u.output / 1e6) * r.out;
    total.input += u.input; total.output += u.output; total.calls += u.calls; total.estimated_cost_usd += cost;
    console.log(`[COST] model=${model} calls=${u.calls} input_tokens=${u.input} output_tokens=${u.output} estimated_cost_usd=${cost.toFixed(4)}`);
  }
  console.log(`[COST] total calls=${total.calls} input_tokens=${total.input} output_tokens=${total.output} estimated_cost_usd=${total.estimated_cost_usd.toFixed(4)}`);
  total.estimated_cost_usd = Number(total.estimated_cost_usd.toFixed(4));
  return { by_model: usageByModel, total };
}

// ---------------------------------------------------------------------------------
// 1. 날짜 · URL · 텍스트 유틸
// ---------------------------------------------------------------------------------
const KST_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
function kstDate() { return KST_FMT.format(new Date()); }

// 실행일. 테스트 목적으로만 BRIEFING_DATE 로 덮어쓸 수 있다 (운영에서는 설정하지 않는다).
const date = /^\d{4}-\d{2}-\d{2}$/.test(process.env.BRIEFING_DATE || '') ? process.env.BRIEFING_DATE : kstDate();

function dateToUtcDays(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}
function shiftDate(ymd, days) {
  const t = (dateToUtcDays(ymd) + days) * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function parsePublishedKst(publishedText) {
  const text = String(publishedText || '').trim();
  let year = null; let month = null; let day = null; let m;
  if ((m = text.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/))) { year = +m[1]; month = +m[2]; day = +m[3]; }
  else if ((m = text.match(/(\d{4})(\d{2})(\d{2})/))) { year = +m[1]; month = +m[2]; day = +m[3]; }
  else if ((m = text.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/))) { year = +m[1]; month = +m[2]; day = +m[3]; }
  else if ((m = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/))) { year = Number(date.slice(0, 4)); month = +m[1]; day = +m[2]; }
  if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) return { ymd: '', time: '' };
  const ymd = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const timeMatch = text.match(/(\d{1,2}):(\d{2})/);
  const time = timeMatch ? `${String(+timeMatch[1]).padStart(2, '0')}:${timeMatch[2]}` : '';
  return { ymd, time };
}
function normalizePublished(publishedText) {
  const { ymd, time } = parsePublishedKst(publishedText);
  if (!ymd) return '';
  return time ? `${ymd} ${time}` : ymd;
}
// 실행일 기준 며칠 전 기사인지 (0=오늘, 1=어제). 날짜 없으면 null.
function ageInDays(publishedText) {
  const { ymd } = parsePublishedKst(publishedText);
  if (!ymd) return null;
  return dateToUtcDays(date) - dateToUtcDays(ymd);
}

const disposableQueryParams = new Set([
  'curpage', 'page', 'pageno', 'pageindex', 'srchbegindt', 'srchctgry', 'srchenddt', 'srchkey', 'srchtext',
  'source', 'ref', 'referrer', 'trc'
]);
function canonicalUrlKey(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    const value = url.searchParams.get(key);
    if (!value || lower.startsWith('utm_') || disposableQueryParams.has(lower)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const query = url.searchParams.toString();
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${pathname}${query ? `?${query}` : ''}`;
}
function safeCanonical(rawUrl) { try { return canonicalUrlKey(rawUrl); } catch { return ''; } }
function hostMatchesDomain(hostname, domain) { return hostname === domain || hostname.endsWith(`.${domain}`); }
function hostnameOf(rawUrl) { try { return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } }

function isLikelyListingUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return true;
    const path = url.pathname.replace(/\/+$/, '');
    const hasArticleId = /\d{4,}/.test(path) || [...url.searchParams.keys()].some((key) =>
      /^(idx|id|no|seq|article|article_id|nttId|bbsId|rcpNo|rcp_no)$/i.test(key) && url.searchParams.get(key));
    const looksLikeSearch = !hasArticleId && [...url.searchParams.keys()].some((key) =>
      /^(query|keyword|search|searchword|srchtext|srchkey)$/i.test(key) && url.searchParams.get(key));
    const knownBoardRoot = /\/(no\d{6}|po\d{6})$/i.test(path);
    return looksLikeSearch || knownBoardRoot || (!hasArticleId && /\/(news|search|list|bbs)$/i.test(path));
  } catch { return true; }
}

const koreanMediaDomains = [
  'n.news.naver.com', 'news.naver.com', 'finance.naver.com', 'yna.co.kr', 'news1.kr', 'hankyung.com', 'mk.co.kr',
  'sedaily.com', 'edaily.co.kr', 'mt.co.kr', 'news.bizwatch.co.kr', 'biz.chosun.com', 'fnnews.com', 'asiae.co.kr',
  'etoday.co.kr', 'ytn.co.kr', 'infomax.co.kr', 'heraldcorp.com', 'donga.com', 'joongang.co.kr'
];
const globalMediaDomains = [
  'reuters.com', 'bloomberg.com', 'ft.com', 'wsj.com', 'cnbc.com', 'apnews.com', 'nikkei.com', 'economist.com',
  'marketwatch.com', 'finance.yahoo.com'
];
const officialResearchDomains = ['fss.or.kr', 'fsc.go.kr', 'bok.or.kr', 'dart.fss.or.kr', 'kdic.or.kr'];
const officialDomains = [
  ...officialResearchDomains, 'moef.go.kr', 'kofia.or.kr', 'krx.co.kr', 'woorifg.com', 'wooribank.com',
  'bis.org', 'fsb.org', 'imf.org', 'federalreserve.gov', 'ecb.europa.eu'
];
function isOfficialUrl(rawUrl) {
  const hostname = hostnameOf(rawUrl);
  if (!hostname) return false;
  return hostname.endsWith('.go.kr') || hostname.endsWith('.gov') || officialDomains.some((d) => hostMatchesDomain(hostname, d));
}
function isGlobalMediaUrl(rawUrl) {
  const hostname = hostnameOf(rawUrl);
  return Boolean(hostname) && globalMediaDomains.some((d) => hostMatchesDomain(hostname, d));
}
const sourceNameByHost = {
  'n.news.naver.com': '네이버뉴스', 'news.naver.com': '네이버뉴스', 'finance.naver.com': '네이버금융', 'yna.co.kr': '연합뉴스',
  'news1.kr': '뉴스1', 'hankyung.com': '한국경제', 'mk.co.kr': '매일경제', 'sedaily.com': '서울경제', 'edaily.co.kr': '이데일리',
  'mt.co.kr': '머니투데이', 'news.bizwatch.co.kr': '비즈워치', 'biz.chosun.com': '조선비즈', 'fnnews.com': '파이낸셜뉴스',
  'asiae.co.kr': '아시아경제', 'etoday.co.kr': '이투데이', 'ytn.co.kr': 'YTN', 'infomax.co.kr': '연합인포맥스',
  'heraldcorp.com': '헤럴드경제', 'donga.com': '동아일보', 'joongang.co.kr': '중앙일보', 'reuters.com': '로이터',
  'bloomberg.com': '블룸버그', 'ft.com': '파이낸셜타임스', 'wsj.com': '월스트리트저널', 'cnbc.com': 'CNBC', 'apnews.com': 'AP',
  'nikkei.com': '닛케이', 'dart.fss.or.kr': 'DART 전자공시', 'fss.or.kr': '금융감독원', 'fsc.go.kr': '금융위원회', 'bok.or.kr': '한국은행',
  'kdic.or.kr': '예금보험공사'
};
function guessSourceName(rawUrl) {
  const hostname = hostnameOf(rawUrl);
  for (const [host, name] of Object.entries(sourceNameByHost)) if (hostMatchesDomain(hostname, host)) return name;
  return hostname || '출처 미확인';
}

const wooriSubsidiaryKeywords = [
  '우리금융', '우리금융지주', '우리은행', '우리카드', '우리금융캐피탈', '우리종합금융', '우리자산운용', '우리금융저축은행',
  '우리투자증권', '우리에프아이에스', '우리글로벌자산운용', '동양생명', 'ABL생명', '우리아메리카', 'Woori America', '우리소다라',
  'Woori Saudara', 'Bank Woori Saudara', '우리은행 캄보디아', '우리은행 브라질', '우리은행 중국', '베트남우리은행', 'Woori Bank', 'Woori'
];
const competitorKeywords = [
  'KB금융', 'KB국민', 'KB국민은행', '국민은행', '신한금융', '신한은행', '신한카드', '신한투자증권', '하나금융', '하나은행', '하나카드',
  '하나증권', 'NH농협', '농협금융', '농협은행', 'IBK기업은행', '기업은행', '한국금융지주', '한국투자증권', 'BNK금융', 'iM금융', 'DGB금융',
  'JB금융', '카카오뱅크', '케이뱅크', '토스뱅크'
];
function mentionsWooriSubsidiary(text) {
  const haystack = String(text || '');
  if (!haystack) return false;
  if (competitorKeywords.some((k) => haystack.includes(k))) return false;
  return wooriSubsidiaryKeywords.some((k) => haystack.includes(k));
}
function competitorOf(text) {
  const t = String(text || '')
    .replace(/하나은행|하나카드|하나증권/g, '하나금융').replace(/KB국민은행|국민은행|KB국민/g, 'KB금융')
    .replace(/신한은행|신한카드|신한투자증권/g, '신한금융').replace(/IBK기업은행|기업은행/g, 'IBK기업은행')
    .replace(/농협은행|농협금융/g, 'NH농협').replace(/한국투자증권/g, '한국금융지주');
  return ['하나금융', 'KB금융', 'IBK기업은행', '신한금융', 'NH농협', '한국금융지주', 'BNK금융', 'iM금융', 'DGB금융', 'JB금융', '카카오뱅크', '케이뱅크', '토스뱅크']
    .find((k) => t.includes(k)) || '';
}

function titleSimilarity(a, b) {
  const normalize = (s) => String(s || '').replace(/\s+/g, '').replace(/[-_|\u00b7,.\[\](){}'"“”‘’…]/g, '').toLowerCase();
  const na = normalize(a); const nb = normalize(b);
  if (na.length < 4 || nb.length < 4) return 0;
  const bigrams = (s) => { const set = new Set(); for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2)); return set; };
  const sa = bigrams(na); const sb = bigrams(nb);
  let intersection = 0;
  for (const bg of sa) if (sb.has(bg)) intersection += 1;
  return intersection / Math.max(sa.size, sb.size);
}
function normalizeEventKey(key) {
  return String(key || '').toLowerCase()
    .replace(/\|후속.*$/, '')
    .replace(/[\s·,.'"“”()\[\]]/g, '')
    .replace(/(은|는|이|가|의|을|를|에|로|과|와)(?=\||$)/g, '');
}
function isFollowUpEventKey(key) { return /\|\s*후속/.test(String(key || '')); }

function splitSentences(text) { return String(text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean); }
function sentenceCount(text) { return splitSentences(text).length; }
function usesNonFormalKorean(text) {
  return String(text || '').split(/[.!?]+/).map((s) => s.trim()).filter(Boolean)
    .some((s) => s.endsWith('다') && !s.endsWith('니다'));
}
const MD_LINK_RE = /\s*\(\[[^\]]*\]\([^)]*\)\)|\[([^\]]*)\]\((https?:[^)]*)\)/g;
const cleanText = (v) => typeof v === 'string'
  ? v.replace(MD_LINK_RE, (m, label) => (label ? label : '')).replace(/https?:\/\/\S+/g, '').replace(/[*#`_]{1,3}/g, '').replace(/\s{2,}/g, ' ').trim()
  : v;
// 상투어·작업 메모. 이 문구가 포함된 문장은 제거하고, 작성 단계에서 발견되면 1회 재요청한다.
const BANNED_PHRASES = [
  '점검해야 합니다', '확인해야 합니다', '주목해야 합니다', '검증 가능한', '검증 가능', '풀이 좁', '기사가 부족', '조사 근거',
  '기사 풀', '엄격히 적용', '생각보다 좁', '확인된 어제·오늘 기사', '조사 메모', '후보 기사', '선정된 기사', '이번 브리핑에서는'
];
function findBannedPhrases(text) { return BANNED_PHRASES.filter((p) => String(text || '').includes(p)); }
// 의문문 검출: '?' 또는 '까요/합니까/습니까/입니까/ㄹ까/나요/인가요' 로 끝나는 문장. summary·why_woori_cro·judgment·executive_judgment 에서는 금지어와 같이 취급한다.
const QUESTION_END_RE = /(\?|까요|합니까|습니까|입니까|[을를일할될볼]까|나요|인가요|인가|일까|할까|될까)[\s.!"”’')\]]*$/;
function isQuestionSentence(sentence) { return QUESTION_END_RE.test(String(sentence || '').trim()); }
function findQuestionSentences(text) { return splitSentences(text).filter(isQuestionSentence); }
function dropQuestionSentences(text) {
  if (typeof text !== 'string') return text;
  const sentences = splitSentences(text);
  const kept = sentences.filter((s) => !isQuestionSentence(s));
  return (kept.length ? kept : []).join(' ').trim();
}
function dropBannedSentences(text) {
  if (typeof text !== 'string') return text;
  const sentences = splitSentences(text);
  const kept = sentences.filter((s) => findBannedPhrases(s).length === 0);
  return (kept.length ? kept : sentences).join(' ').replace(/^(그럼에도 불구하고|그럼에도|하지만|다만),?\s*/, '').trim();
}

const NEWS_KEYS = ['critical', 'daily_news', 'subsidiary_news', 'additional_news'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------
// 2. OpenAI Responses API 호출 (DRY_RUN이면 목 응답)
// ---------------------------------------------------------------------------------
let mockResponse = null;
if (DRY_RUN) {
  ({ mockResponse } = await import('./dry-run-fixtures.mjs'));
  console.log(`[DRY_RUN] OpenAI calls are mocked. Output → docs/briefing.dryrun.json (scenario=${process.env.DRY_RUN_SCENARIO || 'default'})`);
}

function extractOutputText(response) {
  const parts = [];
  for (const item of response.output || []) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) if (content.type === 'output_text' && content.text) parts.push(content.text);
  }
  return parts.join('\n').trim();
}
function retryDelayMs(response, body, attempt) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(60_000, Math.ceil(retryAfter * 1000) + 1000);
  const match = String(body?.error?.message || '').match(/try again in\s+([\d.]+)(ms|s)/i);
  if (match) {
    const amount = Number(match[1]);
    const ms = match[2].toLowerCase() === 's' ? amount * 1000 : amount;
    return Math.min(60_000, Math.max(2_000, Math.ceil(ms) + 1000));
  }
  return Math.min(60_000, 5_000 * (2 ** (attempt - 1)));
}

async function requestOpenAi(label, requestBody, maxAttempts = 3) {
  if (DRY_RUN) {
    const body = await mockResponse(label, requestBody, { date });
    recordUsage(requestBody.model, body.usage);
    return body;
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000);
    let response;
    try {
      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
    } catch (fetchError) {
      clearTimeout(timeout);
      if (attempt === maxAttempts) throw new Error(`${label} timed out or failed to connect after ${maxAttempts} attempts: ${fetchError.message}`);
      const delay = Math.min(60_000, 15_000 * attempt);
      console.warn(`${label} request failed (${fetchError.message}). Retrying in ${delay}ms (${attempt}/${maxAttempts}).`);
      await sleep(delay);
      continue;
    } finally { clearTimeout(timeout); }

    const body = await response.json().catch(() => ({}));
    if (response.ok) { recordUsage(requestBody.model, body?.usage); return body; }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxAttempts) {
      const error = new Error(`${label} failed (${response.status}): ${body?.error?.message || 'unknown error'}`);
      error.status = response.status;
      error.code = body?.error?.code || '';
      throw error;
    }
    const delay = response.status === 429 ? Math.max(90_000, retryDelayMs(response, body, attempt)) : Math.min(60_000, 15_000 * attempt);
    console.warn(`${label} received HTTP ${response.status}. Retrying in ${delay}ms (${attempt}/${maxAttempts}).`);
    await sleep(delay);
  }
  throw new Error(`${label} exhausted all retry attempts.`);
}

function isModelUnavailableError(error) {
  return [400, 404].includes(Number(error?.status)) && /model|not found|does not exist|unsupported/i.test(String(error?.message || ''));
}

function parseStructuredOutput(body, label) {
  const status = String(body?.status || 'unknown');
  const reason = String(body?.incomplete_details?.reason || body?.error?.message || '');
  if (status === 'incomplete') throw new Error(`${label} response was incomplete: ${reason || 'unknown reason'}`);
  if (status === 'failed') throw new Error(`${label} response failed before completion.`);
  const rawText = extractOutputText(body);
  if (!rawText) throw new Error(`${label} did not contain structured output (status=${status}).`);
  const text = rawText.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(text); } catch (error) {
    console.error(`${label} JSON parse failed: ${error.message}; preview: ${rawText.slice(0, 400)}`);
    throw new Error(`${label} returned invalid JSON.`);
  }
}

async function coolDown(label) {
  if (cooldownMilliseconds <= 0) return;
  console.log(`${label} complete. Cooling down OpenAI TPM for ${cooldownMilliseconds / 1000} seconds.`);
  await sleep(cooldownMilliseconds);
}

// ---------------------------------------------------------------------------------
// 3. 이전 브리핑 이력 로드 (briefing_history + briefing.json, 실행일 이전 최근 3개)
// ---------------------------------------------------------------------------------
async function loadBriefingJson(url) { try { return JSON.parse(await readFile(url, 'utf8')); } catch { return null; } }

// 브리핑 객체에서 공통 + 업권 기사를 모두 꺼낸다 (sectors 키가 없는 v2 이하 이력도 그대로 동작).
function allItemsOf(b) {
  const common = NEWS_KEYS.flatMap((k) => (Array.isArray(b?.[k]) ? b[k] : []));
  const sectorItems = b?.sectors && typeof b.sectors === 'object'
    ? Object.values(b.sectors).flatMap((s) => (Array.isArray(s?.news) ? s.news : []))
    : [];
  return [...common, ...sectorItems];
}

async function loadPreviousBriefings() {
  const byDate = new Map();
  try {
    for (const name of await readdir(historyDir)) {
      const m = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m || m[1] >= date) continue;
      const b = await loadBriefingJson(new URL(name, historyDir));
      if (b && !b?.meta?.fallback_notice) byDate.set(m[1], b);
    }
  } catch {}
  const live = await loadBriefingJson(liveBriefingPath);
  const liveDate = String(live?.meta?.briefing_date || '');
  if (live && liveDate && liveDate < date && !byDate.has(liveDate) && !live?.meta?.fallback_notice) byDate.set(liveDate, live);
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, HISTORY_COMPARE_COUNT)
    .map(([briefingDate, b]) => ({ date: briefingDate, items: allItemsOf(b) }));
}

const previousBriefings = await loadPreviousBriefings();
const previousItems = previousBriefings.flatMap((b) => b.items.map((it) => ({
  date: b.date, title: String(it.title || ''), entity: String(it.entity || ''), url: String(it.url || ''),
  canonical: safeCanonical(it.url), event_key: String(it.event_key || ''), event_key_norm: normalizeEventKey(it.event_key || '')
})));
const previousCanonicalUrls = new Set(previousItems.map((it) => it.canonical).filter(Boolean));
console.log(`Loaded ${previousBriefings.length} previous briefing(s) [${previousBriefings.map((b) => b.date).join(', ') || 'none'}] with ${previousItems.length} article(s) for cross-day dedupe.`);

// 중복 실행 가드: 오늘 브리핑이 이미 있으면 종료 (FORCE_REGENERATE=1 또는 DRY_RUN이면 무시)
if (!DRY_RUN && !FORCE_REGENERATE) {
  const existing = await loadBriefingJson(liveBriefingPath);
  if (existing?.meta?.briefing_date === date && !existing?.meta?.fallback_notice) {
    console.log(`Briefing for ${date} already exists. Skipping duplicate run (set FORCE_REGENERATE=1 to override).`);
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------------
// 4. 수집: 8개 조사 단계 (기존 5 + 업권 3)
// ---------------------------------------------------------------------------------
const previousTitlesForPrompt = previousItems.slice(0, 30).map((it) => it.title);

const commonResearchRules = `
실행일은 ${date} KST다. ${shiftDate(date, -2)} ~ ${date} (최근 3일, KST) 사이에 게시된 공개 정보만 후보로 삼아라. 어제·오늘 기사를 우선하라.
후보는 8~12건을 제시하라. 각 후보는 서로 다른 단일 사건이어야 하며, 같은 사건의 반복 보도는 가장 상세한 원문 하나로 통합하라.
URL은 실제 검색으로 확인한 개별 기사·개별 발표의 직접 링크만 사용하라. 검색결과·섹션·게시판 목록 URL은 금지한다.
각 후보마다 (1) 원문 실제 헤드라인 (2) 매체·기관 (3) 게시 일시 KST (4) 직접 URL (5) 확인된 핵심 사실 2~3줄(수치·날짜·주체 포함) (6) 우리금융 CRO 관점 한 줄을 적어라.
제목은 원문 헤드라인을 그대로 가져와라. "금융권 동향관련보도", "계열사 관련보도"처럼 요약형 제목을 만들지 마라.
게시 일시를 확인할 수 없는 후보는 published를 빈 문자열로 두되 가능한 한 검색으로 확인하라. 날짜 없는 후보는 자동 검증 단계를 거치지만, 확인된 날짜가 있는 후보가 우선 선정된다.
다음은 후보에서 제외하라: 내부 교육·세미나·행사, 후원·CSR·봉사, 인사 발령·조직 개편, 홍보·상품 출시·설계사 수·체크카드 출시, 체육대회·시상식·채용박람회, 기획 칼럼·사설·인터뷰, 정치인 발언 모음·선거·정쟁, 통화안정증권 입찰·정례 모집, 리스크 영향 분석이 없는 단순 정기 통계.
이전 브리핑 제목(사실상 같은 사건이면 새 수치·조치가 있을 때만 후보에 포함하고 '후속'이라고 표시하라): ${JSON.stringify(previousTitlesForPrompt)}
이전 브리핑 URL은 제외하라: ${JSON.stringify([...previousCanonicalUrls].slice(0, 40))}
검색은 주제·기관·계열사별로 개별 쿼리를 최소 10회 이상 수행하라.
한국어 서술은 합니다체로 쓴다. 조사 메모를 모두 작성한 뒤 반드시 마지막에 아래 블록을 붙여라. 이 블록은 후보 선정에 직접 사용되므로 모든 후보를 빠짐없이, 정확하게 적어라:
[[SOURCE_METADATA]]
[{"url":"직접URL","title":"원문 헤드라인","published":"YYYY-MM-DD HH:MM 또는 YYYY-MM-DD 또는 빈 문자열"}]
[[/SOURCE_METADATA]]
`;

function parseSourceMetadata(narrative) {
  const text = String(narrative || '');
  const out = [];
  const push = (item) => {
    if (!item?.url || !item?.title) return;
    const url = String(item.url).trim();
    if (!safeCanonical(url) || isLikelyListingUrl(url)) return;
    const key = canonicalUrlKey(url);
    if (out.some((o) => o.key === key)) return;
    out.push({ key, url, title: String(item.title).trim(), published: normalizePublished(item.published || item.publish_date || item.date || '') });
  };
  const block = text.match(/\[\[SOURCE_METADATA\]\]([\s\S]*?)\[\[\/SOURCE_METADATA\]\]/);
  if (block) { try { const parsed = JSON.parse(block[1].trim()); if (Array.isArray(parsed)) parsed.forEach(push); } catch {} }
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  if (fenced) { try { const parsed = JSON.parse(fenced[1].trim()); if (Array.isArray(parsed)) parsed.forEach(push); } catch {} }
  return out;
}
// web_search_call.action.sources 등 응답 본문에 섞여 있는 url/title/published 객체를 긁어 보강한다.
function extractSourceData(response) {
  const sourceMap = new Map();
  const visit = (value) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    if (typeof value.url === 'string' && safeCanonical(value.url) && !isLikelyListingUrl(value.url)) {
      const key = canonicalUrlKey(value.url);
      if (!sourceMap.has(key)) {
        sourceMap.set(key, {
          key, url: value.url, title: String(value.title || '').trim(),
          published: normalizePublished(value.publishedAt || value.datePublished || value.publishDate || value.published_date || value.publish_date || value.date || value.published || '')
        });
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(response.output || []);
  return [...sourceMap.values()];
}
// 조사 메모에서 특정 URL/제목 주변의 핵심 사실 몇 줄을 발췌한다 (채점·작성 입력용).
function excerptFor(narrative, url, title) {
  const lines = String(narrative || '').replace(/\[\[SOURCE_METADATA\]\][\s\S]*$/, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const urlKey = safeCanonical(url);
  let idx = lines.findIndex((l) => l.includes(url) || (urlKey && l.includes(urlKey)));
  if (idx < 0) idx = lines.findIndex((l) => titleSimilarity(l, title) >= 0.45);
  if (idx < 0) return '';
  return cleanText(lines.slice(Math.max(0, idx - 1), idx + 5).join(' ')).slice(0, 500);
}

async function researchStage(stageId, label, scope, allowedDomains, minimumSources = 4) {
  let best = { stage: stageId, narrative: '', sources: [] };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let body;
    try {
      body = await requestOpenAi(label, {
        model: MODELS.research,
        input: `당신은 우리금융그룹 CRO STAFF의 조사 담당자다.\n\n조사 범위:\n${scope}\n\n공통 조사 규칙:\n${commonResearchRules}`,
        tools: [{
          type: 'web_search', search_context_size: 'high',
          ...(allowedDomains?.length ? { filters: { allowed_domains: allowedDomains } } : {}),
          user_location: { type: 'approximate', country: 'KR', timezone: 'Asia/Seoul' }
        }],
        max_tool_calls: 15, include: ['web_search_call.action.sources'], store: false,
        reasoning: { effort: 'low' }, text: { verbosity: 'medium' }, max_output_tokens: 14000
      });
    } catch (error) {
      console.warn(`${label} failed (attempt ${attempt}/2): ${error.message}`);
      if (attempt < 2) await coolDown(`${label} error retry`);
      continue;
    }
    const narrative = extractOutputText(body);
    const sources = parseSourceMetadata(narrative);
    for (const sd of extractSourceData(body)) {
      const existing = sources.find((s) => s.key === sd.key);
      if (existing) { if (!existing.published && sd.published) existing.published = sd.published; }
      else if (sd.title) sources.push(sd);
    }
    if (narrative && sources.length > best.sources.length) best = { stage: stageId, narrative, sources };
    if (narrative && sources.length >= minimumSources) {
      console.log(`${label} collected ${sources.length} candidate sources (${sources.filter((s) => s.published).length} dated).`);
      return best;
    }
    if (attempt < 2) { console.warn(`${label} returned ${sources.length} sources (< ${minimumSources}). Retrying.`); await coolDown(`${label} retry`); }
  }
  console.warn(`${label} finished with ${best.sources.length} candidate sources.`);
  return best;
}

const stageDefinitions = [
  {
    id: 'korean_media', label: 'Korean financial media research', minimum: 6, domains: koreanMediaDomains, sectors: ['group'],
    scope: `한국 금융시장·금융회사 리스크 관련 언론기사를 조사하라. 네이버뉴스(n.news.naver.com, news.naver.com, finance.naver.com) 직접 링크를 최우선으로 쓰고, 부족할 때만 연합뉴스·경제지 원문 링크를 보완하라.
금리·환율·채권·유동성·부동산 PF·가계부채·기업 신용·연체율·자본규제·소비자보호·사이버·운영리스크와 금융회사 사건을 점검하라. 수치가 있는 기사를 우선하라.
기자가 작성한 기사 원문만 후보로 제시하라. 우리금융 계열사 전용 기사와 경쟁사 전용 기사는 다른 조사팀이 다루므로 여기서는 시장·정책·업권 전반 기사에 집중하라.`
  },
  {
    id: 'woori_media', label: 'Woori Financial Group media research', minimum: 5, domains: koreanMediaDomains, sectors: ['group', ...SECTOR_IDS],
    scope: `우리금융그룹 및 계열사 관련 언론기사를 전용으로 조사하라. 계열사명을 각각 네이버뉴스로 검색하라: 우리금융지주, 우리은행, 우리카드, 우리금융캐피탈, 우리종합금융, 우리자산운용, 우리금융저축은행, 우리투자증권, 우리에프아이에스, 우리글로벌자산운용, 동양생명, ABL생명.
우리은행 해외법인·지점(우리아메리카은행, 우리소다라은행(인도네시아), 베트남우리은행, 우리은행 캄보디아·중국·브라질·러시아·방글라데시·미얀마)의 건전성·제재·사고·현지 감독 이슈도 조사하라.
건전성·자본·실적·금융사고·제재·소송·시장평가(증권사 리포트 포함)에 집중하고, 상품 출시·행사·CSR·인사 기사는 제외하라.`
  },
  {
    id: 'peer_media', label: 'Peer competitor media research', minimum: 5, domains: koreanMediaDomains, sectors: ['group', 'bank'],
    scope: `국내 주요 경쟁 금융회사의 언론기사를 전용으로 조사하라: KB금융, 신한금융, 하나금융, NH농협금융, IBK기업은행, 한국금융지주, BNK·iM·JB금융, 인터넷은행, 주요 증권·보험·카드사.
금융사고·제재·대규모 손실·건전성 악화·자본비율·유동성·인수합병·소비자보호 이슈를 우선하고, 단순 실적 호조·수상·홍보 기사는 후순위로 두어라.
같은 회사에 대해서는 가장 중요한 사건 1~2건만 제시하라. 우리금융 기사는 여기서 제외하라.`
  },
  {
    id: 'global_media', label: 'Global financial media research', minimum: 4, domains: globalMediaDomains, sectors: ['group'],
    scope: `Reuters, Bloomberg, FT, WSJ, CNBC, Nikkei 등 글로벌 언론에서 한국 금융시장 또는 우리금융그룹으로 전이될 수 있는 금융기사를 조사하라.
미 연준·주요 중앙은행 결정, 달러·국채금리 급변, 은행 건전성·상업용 부동산 손실, 글로벌 제재·AML, 사이버 사고, 그리고 우리은행 해외법인 소재국(베트남·인도네시아·캄보디아·미국·중국·브라질·러시아·방글라데시·미얀마)의 감독·시장 리스크를 점검하라.
정치인 발언 모음·일반 시황 소개 기사는 제외하고, 수치와 정책 결정이 있는 기사만 최대 10건 제시하라.`
  },
  {
    id: 'official', label: 'Regulator and official source research', minimum: 2, domains: officialResearchDomains, sectors: ['group'],
    scope: `감독당국·공식자료를 조사하라. 대상: 금융감독원(fss.or.kr), 금융위원회(fsc.go.kr), 한국은행(bok.or.kr), DART 전자공시(dart.fss.or.kr), 예금보험공사(kdic.or.kr).
허용 범위는 다음만이다: 제재·검사결과 공개, 규정 제·개정(입법예고·규정변경예고 포함), 금융위 의결·결정, 한국은행 금통위 결정·금융안정 보고·거시건전성 조치, 우리금융 계열사의 DART 공시 중 자본·충당금·대규모 손실·소송·임원 제재.
정기 통계·정례 보도자료·통화안정증권 입찰·행사·채용·일반 공지는 제외하라. 후보는 3~8건이면 충분하며, 허용 범위에 맞는 자료가 없으면 억지로 채우지 마라.
각 후보에 발표 기관·발표일·핵심 수치(제재 수위·과태료·비율 등)를 반드시 적어라.`
  },
  // 업권 조사 단계 (config/sectors.json 의 research_stages + 각 업권 정의에서 프롬프트를 조립한다)
  ...sectorConfig.research_stages.map((rs) => {
    const defs = rs.sectors.map((id) => sectorById[id]).filter(Boolean);
    const sectorBlocks = defs.map((s) => `■ ${s.label_ko} (우리금융 계열사: ${s.companies.join(', ')})
  - 조사 범위: ${s.scope_ko}
  - 검색 키워드(각각 개별 쿼리로): ${s.keywords_ko.join(', ')}${s.keywords_en?.length ? ` / ${s.keywords_en.join(', ')}` : ''}
  - 업권 전문 출처(언론기사가 부족할 때 보완): ${(s.sources_hint || []).join(', ')}`).join('\n');
    return {
      id: rs.id, label: rs.label, minimum: rs.minimum ?? 4,
      domains: [...koreanMediaDomains, ...defs.flatMap((s) => s.source_domains || [])],
      sectors: rs.sectors,
      scope: `다음 업권의 리스크 관련 언론기사를 전용으로 조사하라. 이 업권의 우리금융 계열사 리스크관리부가 아침에 읽을 기사다.
${sectorBlocks}
각 업권에서 (1) 우리금융 해당 계열사 기사 (2) 업권 전체 건전성·감독·규제 기사 (3) 경쟁사 사고·제재·손실 기사 순으로 찾아라. 업권당 후보 4~6건, 합계 8~12건을 제시하라.
금감원·금융위의 업권 검사·제재·규정 변경, 업권 통계 중 연체율·자본비율·PF 등 리스크 수치가 있는 발표는 포함하라. 단순 상품 출시·실적 홍보·수상 기사는 제외하라.
우리금융지주 차원 기사, 은행 일반 기사, 거시·환율 기사는 다른 조사팀이 다루므로 여기서는 이 업권 전용 기사에 집중하라.`
    };
  })
];

const researchStages = [];
for (const def of stageDefinitions) {
  researchStages.push(await researchStage(def.id, def.label, def.scope, def.domains, def.minimum));
  await coolDown(def.label);
}

// 후보 풀 조립 (URL 기준 중복 통합)
const stageSectorHint = Object.fromEntries(stageDefinitions.map((d) => [d.id, d.sectors || ['group']]));
const candidateByKey = new Map();
for (const stage of researchStages) {
  for (const s of stage.sources) {
    if (previousCanonicalUrls.has(s.key)) { console.log(`Skipped candidate already used in a previous briefing: ${s.title}`); continue; }
    const existing = candidateByKey.get(s.key);
    if (existing) {
      if (!existing.published && s.published) existing.published = s.published;
      if (!existing.excerpt) existing.excerpt = excerptFor(stage.narrative, s.url, s.title);
      existing.stages.add(stage.stage);
      continue;
    }
    candidateByKey.set(s.key, {
      id: candidateByKey.size + 1, key: s.key, url: s.url, title: s.title, published: s.published,
      stage: stage.stage, stages: new Set([stage.stage]), excerpt: excerptFor(stage.narrative, s.url, s.title),
      stage_sector_hint: stageSectorHint[stage.stage] || ['group'],
      source_type: isOfficialUrl(s.url) ? 'official' : 'media',
      is_global_only: stage.stage === 'global_media' || isGlobalMediaUrl(s.url)
    });
  }
}
const candidates = [...candidateByKey.values()];
console.log(`Candidate pool: ${candidates.length} unique URLs (${candidates.filter((c) => c.published).length} dated, ${candidates.filter((c) => c.source_type === 'official').length} official) from ${researchStages.length} stages [${researchStages.map((s) => `${s.stage}=${s.sources.length}`).join(', ')}].`);

// 빈 업권 섹션 (실패 브리핑·shortfall 공용)
function emptySectorSection(id, reason) {
  const def = sectorById[id];
  return { id, label_ko: def.label_ko, label_en: def.label_en, companies: def.companies, judgment: '', news: [], shortfall_reason: reason || '' };
}

// 실패 브리핑: 8개 조사 단계가 모두 비었을 때(API 전면 장애)만 사용한다. 그 외에는 항상 실제 기사로 출력한다.
function createFailureBriefing(reason) {
  return {
    executive_judgment: '오늘의 CRO 브리핑은 조사 단계에서 후보를 전혀 수집하지 못해 자동 생성하지 않았습니다. 검증되지 않은 기사나 수치를 임의로 포함하지 않았습니다. 다음 실행에서 재생성이 필요합니다.',
    executive_judgment_bullets: [
      '여덟 개 조사 단계가 모두 빈 결과를 돌려주었습니다. OpenAI API 장애 또는 웹 검색 도구 장애 가능성이 있습니다.',
      '이번 결과는 기사 부재가 아니라 수집 실패에 따른 안전 조치입니다. 본 결과를 의사결정 자료로 사용하지 않습니다.',
      'GitHub Actions 로그에서 각 조사 단계의 응답 상태를 확인한 뒤 force_regenerate 옵션으로 재실행합니다.'
    ],
    critical: [], daily_news: [], subsidiary_news: [], additional_news: [], forward_looking_points: [],
    insights: {
      headline: '조사 단계 수집 실패로 자동 브리핑을 생성하지 않았습니다.',
      bullets: ['조사 단계가 후보를 수집하지 못했습니다.', '검증되지 않은 기사 정보를 포함하지 않았습니다.', '다음 실행에서 로그 확인 후 재생성합니다.'],
      action_items: ['OpenAI API 상태를 확인합니다.', '워크플로를 force_regenerate=true 로 수동 재실행합니다.', '재발 시 모델·검색 도구 설정을 점검합니다.'],
      stance: '수집이 정상화될 때까지 자동 브리핑을 의사결정에 사용하지 않습니다.',
      as_of: `${date} KST`
    },
    monitoring_points: [`${date} KST 조사 단계 응답 상태`, 'OpenAI API 상태 페이지', '다음 자동 실행의 정상 생성 여부', `직전 실패 사유: ${reason}`],
    sectors: Object.fromEntries(SECTOR_IDS.map((id) => [id, emptySectorSection(id, reason)])),
    editions: EDITIONS,
    meta: {
      fallback_notice: true, product: 'CRO Staff News & Critical Monitor', perspective: '우리금융그룹 CRO', mode: 'daily',
      briefing_date: date, generated_at: new Date().toISOString(), pipeline_version: PIPELINE_VERSION, dry_run: DRY_RUN,
      candidates_total: 0, selected_total: 0, shortfall_reason: reason, models: MODELS, usage: usageSummary(),
      source_mix: { media: 0, official: 0 },
      sector_counts: Object.fromEntries(['group', ...SECTOR_IDS].map((id) => [id, 0])),
      sector_shortfall: Object.fromEntries(SECTOR_IDS.map((id) => [id, reason])),
      editions: EDITIONS.length
    }
  };
}
if (candidates.length === 0) {
  const reason = '모든 조사 단계에서 후보를 수집하지 못했습니다 (OpenAI API 또는 web_search 장애 가능성).';
  console.error(`Total research failure: ${reason}`);
  await writeFile(outputPath, `${JSON.stringify(createFailureBriefing(reason), null, 2)}\n`, 'utf8');
  process.exit(0);
}

// ---------------------------------------------------------------------------------
// 5. 날짜 검증: published가 비어 있는 후보를 1회 web_search로 보강
// ---------------------------------------------------------------------------------
async function verifyUndatedCandidates() {
  const undated = candidates.filter((c) => !c.published).slice(0, 20);
  if (undated.length === 0) return;
  const list = undated.map((c, i) => `${i + 1}. ${c.title} (${c.url})`).join('\n');
  try {
    const body = await requestOpenAi('Date verification', {
      model: MODELS.research,
      input: `다음 기사·발표의 게시일시를 웹 검색으로 확인하라 (오늘 ${date} KST).\n\n${list}\n\n각 항목에 대해 다음 형식으로만 답하라:\n번호. URL | YYYY-MM-DD 또는 YYYY-MM-DD HH:MM 또는 '확인불가'`,
      tools: [{ type: 'web_search', search_context_size: 'medium', user_location: { type: 'approximate', country: 'KR', timezone: 'Asia/Seoul' } }],
      max_tool_calls: 10, include: ['web_search_call.action.sources'], store: false,
      reasoning: { effort: 'low' }, text: { verbosity: 'low' }, max_output_tokens: 4000
    });
    let verified = 0;
    for (const line of extractOutputText(body).split('\n')) {
      const um = line.match(/https?:\/\/[^\s|]+/);
      const published = normalizePublished(line.replace(um?.[0] || '', ''));
      if (!um || !published) continue;
      const key = safeCanonical(um[0]);
      const target = undated.find((c) => c.key === key);
      if (target && !target.published) { target.published = published; verified += 1; }
    }
    console.log(`Date verification: checked ${undated.length} undated candidates, verified ${verified}.`);
  } catch (error) {
    console.warn(`Date verification failed (continuing): ${error.message}`);
  }
}
await verifyUndatedCandidates();

// ---------------------------------------------------------------------------------
// 6. 채점 (CRO scoring)
// ---------------------------------------------------------------------------------
const AXES = ['supervision', 'group', 'peer', 'market', 'overseas', 'none'];
const scoringSchema = {
  type: 'object', additionalProperties: false, required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'url', 'title', 'published', 'source_type', 'entity', 'event_key', 'axis', 'sector', 'score', 'is_promo',
          'is_political_or_column', 'is_repeat_of_previous', 'severity_flag', 'one_line_fact', 'cro_hook', 'sector_hook'],
        properties: {
          id: { type: 'integer' }, url: { type: 'string' }, title: { type: 'string' }, published: { type: 'string' },
          source_type: { type: 'string', enum: ['media', 'official'] },
          entity: { type: 'string' }, event_key: { type: 'string' },
          axis: { type: 'string', enum: AXES }, sector: { type: 'string', enum: SECTOR_ENUM }, score: { type: 'integer' },
          is_promo: { type: 'boolean' }, is_political_or_column: { type: 'boolean' }, is_repeat_of_previous: { type: 'boolean' },
          severity_flag: { type: 'boolean' }, one_line_fact: { type: 'string' }, cro_hook: { type: 'string' }, sector_hook: { type: 'string' }
        }
      }
    }
  }
};

const sectorGuideForScoring = SECTORS.map((s) => `- ${s.id} (${s.label_ko}; 계열사 ${s.companies.join('·')}): ${s.scope_ko}`).join('\n');

function buildScoringPrompt(batch) {
  const previousForPrompt = previousItems.slice(0, 40).map((it) => ({ date: it.date, title: it.title, entity: it.entity, event_key: it.event_key || '' }));
  return `당신은 우리금융그룹 CRO를 지원하는 CRO STAFF의 선별 심사관이다. 실행일은 ${date} KST다.
아래 후보 각각을 채점하라. 후보를 추가하거나 빼지 말고, 입력된 id·url·title·published는 글자 그대로 복사하라 (published가 비어 있으면 빈 문자열 유지).

축(axis)과 점수(score, 0~100 정수) 기준:
- supervision: 금감원·금융위 제재·검사결과·규정 제·개정·의결, 한국은행 금통위·금융안정·거시건전성 조치 → 기본 80~100.
- group: 우리금융지주·계열사·해외법인의 건전성·자본·실적·금융사고·제재·소송·시장평가 → 70~100. 금융사고·제재·대규모 손실은 90 이상.
- peer: 경쟁사의 금융사고·제재·대규모 손실·건전성 악화·자본비율 급변 → 40~85. 단순 실적 호조·목표가 상향·수상은 40 이하.
- market: 금리·환율·채권·PF·가계부채·연체율·유동성의 급변 중 수치가 있는 것 → 40~80. 수치 없는 일반 시황은 40 이하.
- overseas: 우리은행 해외법인 소재국(베트남·인도네시아·캄보디아·미국·중국·브라질·러시아·방글라데시·미얀마)의 감독·시장 리스크, 글로벌 은행 건전성·제재·AML → 40~80.
- none: 위 어디에도 해당하지 않으면 none, score 0~20.
- 홍보·상품 출시·CSR·인사·행사·설계사 수·체크카드 출시·수상 → is_promo=true, score 0. 기획 칼럼·사설·인터뷰·정치인 발언·선거·정쟁 → is_political_or_column=true, score 0. 통안증권 입찰·정례 통계·정례 보도자료도 is_promo=true, score 0.
- severity_flag: 금융사고·제재·대규모 손실·급변(하루 1% 이상 환율 변동, 연체율 급등 등)이면 true.

업권(sector): 이 기사가 가장 직접 닿는 업권 하나. 감독당국 전반 조치·거시·시장 급변·우리금융지주·그룹 단위 이슈·경쟁 금융그룹(지주) 사고·해외법인 소재국 리스크는 group 이다.
특정 업권의 계열사·업권 통계·업권 규제·업권 경쟁사(은행/카드사·캐피탈/저축은행/보험사/증권사·운용사)에 관한 기사는 그 업권이다. 금감원 제재라도 대상이 특정 업권 회사면 그 업권으로 둔다 (예: 특정 증권사 기관경고 → securities_am, 은행업감독규정 개정 → bank, 금융그룹 전반 규정 → group).
${sectorGuideForScoring}
sector_hook: sector가 group이 아니면 그 업권 우리금융 계열사(위 괄호 안 회사명) 관점에서 어느 포트폴리오·지표·절차에 닿는지 1문장(합니다체, 계열사명 명시). group이면 빈 문자열.

event_key: '주체|사건요지' 형식의 짧은 키 (예: '우리금융|3Q실적', '금감원|○○은행 기관경고', '환율|1450원 돌파'). 같은 사건을 다룬 후보는 매체가 달라도 동일한 event_key를 써라. 실적 기사와 그 실적에 대한 증권사 분석 기사는 같은 사건이다.
is_repeat_of_previous: 아래 이전 브리핑 목록과 사실상 같은 사건이면 true. 다만 새로운 수치·조치·처분이 확인되면 false로 두고 event_key 끝에 '|후속'을 붙여라.
one_line_fact: 확인된 핵심 사실 1문장 (수치·날짜·주체 포함, 합니다체). 분석 주체가 있으면 '○○증권은 …라고 분석했습니다'처럼 밝혀라.
cro_hook: 우리금융의 어느 계열사·포트폴리오·지표에 닿는지 1문장 (합니다체). '점검해야 합니다', '확인해야 합니다' 같은 상투어는 쓰지 마라.
entity: 기사 주체(기관·기업·시장). source_type: 감독당국·공시·중앙은행 자료면 official, 언론기사면 media.

이전 브리핑 기사 목록(최근 ${HISTORY_COMPARE_COUNT}일):
${JSON.stringify(previousForPrompt)}

[[CANDIDATES]]
${JSON.stringify(batch.map((c) => ({ id: c.id, url: c.url, title: c.title, published: c.published, stage: c.stage, stage_sector_hint: c.stage_sector_hint, source_type: c.source_type, excerpt: c.excerpt })))}
[[/CANDIDATES]]

반드시 제공된 JSON 스키마에 맞춰 답하라.`;
}

// 제목·발췌 키워드로 업권을 추정한다 (휴리스틱 채점 및 LLM sector 보정용). group 이면 ''.
function guessSectorByKeywords(text, hint) {
  const t = String(text || '');
  let best = ''; let bestHits = 0;
  for (const s of SECTORS) {
    const hits = [...s.companies, ...s.keywords_ko].filter((k) => k.length >= 2 && t.includes(k)).length;
    const bonus = Array.isArray(hint) && hint.includes(s.id) && !hint.includes('group') ? 1 : 0;
    if (hits + bonus > bestHits) { best = s.id; bestHits = hits + bonus; }
  }
  return bestHits > 0 ? best : '';
}

// 채점 호출이 실패했을 때 쓰는 보수적 휴리스틱 채점 (stage·키워드 기반).
function heuristicScore(c) {
  const t = `${c.title} ${c.excerpt}`;
  const promo = /출시|후원|봉사|CSR|시상|수상|채용|박람회|체육대회|기념식|캠페인|통화안정증권|입찰|정례/.test(t);
  const political = /\[칼럼\]|\[사설\]|\[기자수첩\]|인터뷰|의원|대통령|선거|정쟁|Trump|트럼프/.test(t);
  const severity = /사고|제재|횡령|손실|급등|급락|급증|돌파|기관경고|과태료|영업정지/.test(t);
  let axis = 'market'; let score = 45;
  if (c.source_type === 'official' || c.stage === 'official') { axis = 'supervision'; score = 70; }
  else if (c.stage === 'woori_media' || mentionsWooriSubsidiary(c.title)) { axis = 'group'; score = 65; }
  else if (c.stage === 'peer_media' || competitorOf(c.title)) { axis = 'peer'; score = severity ? 65 : 38; }
  else if (c.stage === 'global_media') { axis = 'overseas'; score = 45; }
  else if (String(c.stage).startsWith('sector_')) { axis = 'market'; score = 50; }
  if (severity) score += 10;
  const sector = guessSectorByKeywords(t, c.stage_sector_hint) || 'group';
  return {
    id: c.id, url: c.url, title: c.title, published: c.published, source_type: c.source_type, entity: competitorOf(c.title) || '',
    event_key: `${c.title.slice(0, 20)}`, axis, sector, score: promo || political ? 0 : score, is_promo: promo, is_political_or_column: political,
    is_repeat_of_previous: false, severity_flag: severity, one_line_fact: cleanText(c.excerpt || c.title).slice(0, 160), cro_hook: '', sector_hook: ''
  };
}

async function scoreCandidates() {
  const BATCH = 30;
  const scored = new Map();
  let fallbackUsed = false;
  for (let start = 0; start < candidates.length; start += BATCH) {
    const batch = candidates.slice(start, start + BATCH);
    let parsed = null;
    for (let attempt = 1; attempt <= 2 && !parsed; attempt += 1) {
      try {
        const body = await requestOpenAi('CRO scoring', {
          model: MODELS.scoring, input: buildScoringPrompt(batch), store: false, reasoning: { effort: 'low' },
          text: { verbosity: 'low', format: { type: 'json_schema', name: 'cro_scoring', strict: true, schema: scoringSchema } },
          max_output_tokens: 24000
        });
        parsed = parseStructuredOutput(body, 'CRO scoring');
      } catch (error) {
        console.warn(`CRO scoring batch ${start / BATCH + 1} attempt ${attempt}/2 failed: ${error.message}`);
        if (attempt < 2) await coolDown('CRO scoring retry');
      }
    }
    for (const c of batch) {
      const s = parsed?.candidates?.find((x) => Number(x.id) === c.id || safeCanonical(x.url) === c.key);
      if (s) scored.set(c.id, s);
      else { fallbackUsed = true; scored.set(c.id, heuristicScore(c)); }
    }
  }
  if (fallbackUsed) console.warn('CRO scoring used heuristic fallback for some candidates.');
  return { scored, fallbackUsed };
}
const { scored: scoreById, fallbackUsed: scoringFallbackUsed } = await scoreCandidates();

// 채점 결과를 후보에 병합한다 (url/title/published는 입력값 유지, axis는 코드가 한 번 더 보정).
for (const c of candidates) {
  const s = scoreById.get(c.id);
  c.axis = AXES.includes(s.axis) ? s.axis : 'none';
  c.score = Math.max(0, Math.min(100, Math.round(Number(s.score) || 0)));
  c.is_promo = Boolean(s.is_promo);
  c.is_political_or_column = Boolean(s.is_political_or_column);
  c.is_repeat_of_previous = Boolean(s.is_repeat_of_previous);
  c.severity_flag = Boolean(s.severity_flag);
  c.entity = String(s.entity || '').trim();
  c.event_key = String(s.event_key || '').trim() || c.title.slice(0, 30);
  c.event_key_norm = normalizeEventKey(c.event_key);
  c.one_line_fact = cleanText(String(s.one_line_fact || '')).trim();
  c.cro_hook = cleanText(String(s.cro_hook || '')).trim();
  c.sector = SECTOR_ENUM.includes(s.sector) ? s.sector : (guessSectorByKeywords(`${c.title} ${c.excerpt}`, c.stage_sector_hint) || 'group');
  c.sector_hook = c.sector === 'group' ? '' : cleanText(String(s.sector_hook || '')).trim();
  if (s.source_type === 'official' && !c.is_global_only) c.source_type = 'official';
  // 축 보정: 경쟁사 기사를 group으로, 우리금융 기사를 peer로 잘못 찍은 경우
  const titleEntity = `${c.title} ${c.entity}`;
  if (c.axis === 'group' && !mentionsWooriSubsidiary(titleEntity)) c.axis = competitorOf(titleEntity) ? 'peer' : (c.source_type === 'official' ? 'supervision' : 'market');
  if (c.axis === 'peer' && mentionsWooriSubsidiary(titleEntity) && !competitorOf(titleEntity)) c.axis = 'group';
  // 업권 보정: 우리금융지주 자체 기사·글로벌 전용 기사가 업권으로 찍히면 group으로 되돌린다
  if (c.sector !== 'group' && (/우리금융지주|우리금융그룹|Woori Financial Group/.test(c.title) || c.is_global_only)) c.sector = 'group';
  if (c.sector === 'group') c.sector_hook = '';
  if (c.is_promo || c.is_political_or_column) c.score = 0;
}
console.log(`Scoring complete: ${candidates.filter((c) => c.score >= 35).length} candidates scored ≥35, ${candidates.filter((c) => c.is_promo || c.is_political_or_column).length} flagged promo/political. By sector: ${JSON.stringify(Object.fromEntries(SECTOR_ENUM.map((id) => [id, candidates.filter((c) => c.sector === id).length])))}`);

// ---------------------------------------------------------------------------------
// 7. 확정 (deterministic selection)
// ---------------------------------------------------------------------------------
function isRepeatOfPrevious(c) {
  if (isFollowUpEventKey(c.event_key)) return false;
  if (c.is_repeat_of_previous) return true;
  for (const prev of previousItems) {
    if (prev.event_key_norm && c.event_key_norm && prev.event_key_norm === c.event_key_norm) return true;
    if (titleSimilarity(prev.title, c.title) >= 0.5) return true;
  }
  return false;
}
function sameEvent(a, b) {
  if (a.event_key_norm && b.event_key_norm && a.event_key_norm === b.event_key_norm) return true;
  return titleSimilarity(a.title, b.title) >= 0.55;
}

// 공통 필터: 윈도우·플래그·점수·축. 점수순 정렬.
function filterEligible(pool, { windowDays, minScore }, log) {
  const eligible = [];
  for (const c of pool) {
    const age = ageInDays(c.published);
    if (age === null) { log.push(`drop(no date): ${c.title}`); continue; }
    if (age < -1 || age > windowDays - 1) { log.push(`drop(out of ${windowDays}-day window, age=${age}): ${c.title}`); continue; }
    if (c.is_promo) { log.push(`drop(promo): ${c.title}`); continue; }
    if (c.is_political_or_column) { log.push(`drop(political/column): ${c.title}`); continue; }
    if (c.score < minScore) { log.push(`drop(score ${c.score} < ${minScore}): ${c.title}`); continue; }
    if (c.axis === 'none') { log.push(`drop(axis none): ${c.title}`); continue; }
    eligible.push(c);
  }
  eligible.sort((a, b) => b.score - a.score || (ageInDays(a.published) ?? 9) - (ageInDays(b.published) ?? 9));
  return eligible;
}
// 사건 중복 제거: 이전 브리핑 재등장 차단 → 이미 다른 섹션에 확정된 기사와 같은 사건 제외 → 풀 내부 같은 사건은 최고점 1건
// → (공통만) 경쟁사는 회사당 1건
function dedupeEvents(eligible, taken, log, { perCompetitor }) {
  const unique = [];
  const seenCompetitors = new Set();
  for (const c of eligible) {
    if (isRepeatOfPrevious(c)) { log.push(`drop(repeat of previous briefing): ${c.title} [${c.event_key}]`); continue; }
    const takenDup = taken.find((t) => t.key === c.key || sameEvent(t, c));
    if (takenDup) { log.push(`drop(same event already selected in ${takenDup.selected_section}: "${takenDup.title}"): ${c.title}`); continue; }
    const dup = unique.find((u) => sameEvent(u, c));
    if (dup) { log.push(`drop(same event as "${dup.title}" score ${dup.score}): ${c.title} (score ${c.score})`); continue; }
    if (perCompetitor) {
      const company = c.axis === 'peer' ? competitorOf(`${c.title} ${c.entity}`) : '';
      if (company) {
        if (seenCompetitors.has(company)) { log.push(`drop(same competitor ${company}): ${c.title}`); continue; }
        seenCompetitors.add(company);
      }
    }
    unique.push(c);
  }
  return unique;
}

// 공통(그룹 공통) 확정: 축별 슬롯 보장 → 점수순 채움 (목표 7; 넘기는 추가 선정은 score≥80 만, 최대 8; 글로벌 단독 ≤2)
function selectCommon(pool, step, taken = []) {
  const log = [];
  const eligible = filterEligible(pool, step, log);
  const unique = dedupeEvents(eligible, taken, log, { perCompetitor: true });
  const selected = [];
  const slots = { supervision: 0, group: 0, peer: 0, market: 0, overseas: 0 };
  const take = (c, reason) => { selected.push(c); slots[c.axis] = (slots[c.axis] || 0) + 1; log.push(`select(${reason}, ${c.axis}, score ${c.score}): ${c.title}`); };
  for (const axis of ['supervision', 'group', 'peer', 'market', 'overseas']) {
    const pick = unique.find((c) => c.axis === axis && !selected.includes(c));
    if (pick) take(pick, `slot:${axis}`);
  }
  for (const c of unique) {
    if (selected.length >= COMMON_MAX) break;
    if (selected.includes(c)) continue;
    if (selected.length >= COMMON_TARGET && c.score < HIGH_VALUE_SCORE) { log.push(`skip(target ${COMMON_TARGET} reached, score ${c.score} < ${HIGH_VALUE_SCORE}): ${c.title}`); continue; }
    if (c.is_global_only && selected.filter((s) => s.is_global_only).length >= MAX_GLOBAL_ONLY) { log.push(`skip(global cap ${MAX_GLOBAL_ONLY}): ${c.title}`); continue; }
    take(c, selected.length >= COMMON_TARGET ? 'high-value overflow' : 'score');
  }
  return { selected: selected.slice(0, COMMON_MAX), slots, log, eligibleCount: eligible.length, uniqueCount: unique.length };
}

// 업권 확정: 자사 계열사 기사 1건 우선 → 점수순 (목표 3; 넘기는 추가 선정은 score≥80 만, 최대 4)
function selectSector(sectorId, pool, step, taken) {
  const log = [];
  const companies = sectorCompanies(sectorId);
  const eligible = filterEligible(pool, step, log);
  const unique = dedupeEvents(eligible, taken, log, { perCompetitor: false });
  const selected = [];
  const take = (c, reason) => { selected.push(c); log.push(`select(${sectorId}:${reason}, ${c.axis}, score ${c.score}): ${c.title}`); };
  const own = unique.find((c) => companies.some((name) => `${c.title} ${c.entity}`.includes(name)));
  if (own) take(own, 'slot:own-company');
  for (const c of unique) {
    if (selected.length >= SECTOR_MAX) break;
    if (selected.includes(c)) continue;
    const target = sectorTarget(sectorId);
    if (selected.length >= target && c.score < HIGH_VALUE_SCORE) { log.push(`skip(${sectorId} target ${target} reached, score ${c.score} < ${HIGH_VALUE_SCORE}): ${c.title}`); continue; }
    take(c, selected.length >= target ? 'high-value overflow' : 'score');
  }
  return { selected: selected.slice(0, SECTOR_MAX), log, eligibleCount: eligible.length, uniqueCount: unique.length };
}

// 폴백 사다리: ① 3일/35 → ② 목표 미달이면 4일 윈도우(related) → ③ 그래도 최소치 미달이면 점수 임계 25.
// 점수 임계를 낮추는 단계는 최소치를 못 채울 때만 쓴다 (수량보다 품질 우선).
const ladder = [
  { windowDays: 3, minScore: 35, label: '3-day window, score≥35' },
  { windowDays: 4, minScore: 35, label: '4-day window (related), score≥35' },
  { windowDays: 4, minScore: 25, label: '4-day window (related), score≥25' }
];
function runLadder(name, run, target, minimum) {
  const attempt = (step) => {
    const result = run(step);
    console.log(`Selection ${name} [${step.label}]: eligible=${result.eligibleCount}, unique=${result.uniqueCount}, selected=${result.selected.length}`);
    return { ...result, step };
  };
  let best = attempt(ladder[0]);
  if (best.selected.length < target) { const wider = attempt(ladder[1]); if (wider.selected.length > best.selected.length) best = wider; }
  if (best.selected.length < minimum) { const looser = attempt(ladder[2]); if (looser.selected.length > best.selected.length) best = looser; }
  return best;
}
const markTaken = (items, section) => items.map((c) => { c.selected_section = section; return c; });

// ── 공통 확정 ──
const commonPool = candidates.filter((c) => c.sector === 'group');
let selection = runLadder('common', (step) => selectCommon(commonPool, step), COMMON_TARGET, COMMON_MIN);
let shortfallReason = '';
// ④ 공통이 최소치에 못 미치면 업권 후보 중 고득점(≥70) 기사를 공통으로 승격한다 (sector→group).
if (selection.selected.length < COMMON_MIN) {
  const sectorPool = candidates.filter((c) => c.sector !== 'group' && c.score >= PROMOTE_MIN_SCORE);
  const promoted = selectCommon(sectorPool, selection.step, markTaken(selection.selected, 'common'));
  const room = COMMON_MIN - selection.selected.length;
  const extra = promoted.selected.filter((c) => !selection.selected.includes(c)).slice(0, room);
  for (const c of extra) {
    c.promoted_from_sector = c.sector; c.sector = 'group'; c.sector_hook = '';
    selection.selected.push(c); selection.slots[c.axis] = (selection.slots[c.axis] || 0) + 1;
    selection.log.push(`select(promoted from ${c.promoted_from_sector}, ${c.axis}, score ${c.score}): ${c.title}`);
  }
  if (extra.length) console.log(`Selection common: promoted ${extra.length} sector candidate(s) with score≥${PROMOTE_MIN_SCORE} to reach the minimum.`);
}
for (const line of selection.log) console.log(`  ${line}`);
if (selection.selected.length < COMMON_MIN) {
  shortfallReason = `최근 ${selection.step.windowDays}일 내 중복·홍보·정치 기사를 제외한 그룹 공통 검증 후보가 ${selection.selected.length}건에 그쳤습니다 (공통 후보 ${commonPool.length}건, 적격 ${selection.eligibleCount}건, 사건 중복 제거 후 ${selection.uniqueCount}건).`;
  console.warn(`Shortfall(common): ${shortfallReason}`);
}
const selected = markTaken(selection.selected, 'common');
console.log(`Selected ${selected.length} common articles (slots: ${JSON.stringify(selection.slots)}).`);

// ── 업권 확정 (공통 우선: 공통에 들어간 기사·같은 사건은 업권에서 제외) ──
const sectorSelections = {};
const sectorShortfall = {};
const taken = [...selected];
for (const id of SECTOR_IDS) {
  const pool = candidates.filter((c) => c.sector === id && !taken.some((t) => t.key === c.key));
  const result = runLadder(id, (step) => selectSector(id, pool, step, taken), sectorTarget(id), SECTOR_MIN);
  for (const line of result.log) console.log(`  ${line}`);
  if (result.selected.length < SECTOR_MIN) {
    sectorShortfall[id] = `최근 ${result.step.windowDays}일 내 ${sectorLabel(id)} 업권 검증 후보가 ${result.selected.length}건에 그쳤습니다 (업권 후보 ${pool.length}건, 적격 ${result.eligibleCount}건, 사건 중복 제거 후 ${result.uniqueCount}건).`;
    console.warn(`Shortfall(${id}): ${sectorShortfall[id]}`);
  }
  for (const c of result.selected) c.sector_critical = c.score >= SECTOR_CRITICAL_SCORE && c.severity_flag;
  sectorSelections[id] = { ...result, selected: markTaken(result.selected, id) };
  taken.push(...result.selected);
}
const sectorSelected = Object.fromEntries(SECTOR_IDS.map((id) => [id, sectorSelections[id].selected]));
const allSelected = [...selected, ...SECTOR_IDS.flatMap((id) => sectorSelected[id])];
console.log(`Selected sector articles: ${SECTOR_IDS.map((id) => `${id}=${sectorSelected[id].length}`).join(', ')} → total ${allSelected.length} (common ${selected.length}).`);

// 6) critical 판정(공통만): score≥85 이고 (supervision/group 또는 severity_flag) → 최대 2건
const criticalKeys = new Set(
  selected.filter((c) => c.score >= 85 && (['supervision', 'group'].includes(c.axis) || c.severity_flag))
    .sort((a, b) => b.score - a.score).slice(0, MAX_CRITICAL).map((c) => c.key)
);
// 7) 카테고리 배치 (상한 초과분은 인접 카테고리로 넘긴다)
function categorize(items) {
  const buckets = { critical: [], daily_news: [], subsidiary_news: [], additional_news: [] };
  for (const c of items) {
    let category;
    if (criticalKeys.has(c.key)) category = 'critical';
    else if (c.axis === 'group') category = 'subsidiary_news';
    else if (c.axis === 'overseas' && mentionsWooriSubsidiary(`${c.title} ${c.entity}`)) category = 'subsidiary_news';
    else if (c.is_global_only) category = 'additional_news';
    else category = 'daily_news';
    const order = { subsidiary_news: ['subsidiary_news', 'daily_news', 'additional_news'], additional_news: ['additional_news', 'daily_news'], daily_news: ['daily_news', 'additional_news'], critical: ['critical', 'daily_news'] }[category];
    const target = order.find((k) => buckets[k].length < CATEGORY_CAPS[k]) || 'daily_news';
    if (target !== category) console.log(`Category overflow: ${category} → ${target}: ${c.title}`);
    c.category = target;
    buckets[target].push(c);
  }
  for (const key of NEWS_KEYS) buckets[key].sort((a, b) => b.score - a.score);
  return buckets;
}
const buckets = categorize(selected);
for (const id of SECTOR_IDS) { for (const c of sectorSelected[id]) c.category = `sector:${id}`; sectorSelected[id].sort((a, b) => b.score - a.score); }
console.log(`Categories: critical=${buckets.critical.length}, daily=${buckets.daily_news.length}, subsidiary=${buckets.subsidiary_news.length}, additional=${buckets.additional_news.length}`);

function windowOf(c) { const age = ageInDays(c.published); return age !== null && age <= 1 ? 'primary' : 'related'; }
function urgencyOf(c) { return c.score >= 85 ? '높음' : c.score >= 60 ? '중간' : '낮음'; }
function confidenceOf(c) { return c.source_type === 'official' ? '높음' : c.excerpt && c.published ? '중간' : '낮음'; }
function channelOf(c) {
  return { supervision: '감독당국·정책', group: '우리금융그룹 계열사', peer: '경쟁사 동향', market: '금융시장', overseas: '해외·글로벌', none: '기타' }[c.axis] || '금융시장';
}
function riskTypeOf(c) {
  return { supervision: '준법·규제', group: '자본·건전성·운영', peer: '신용·운영·평판', market: '시장·신용·유동성', overseas: '해외·시장·준법', none: '기타' }[c.axis] || '시장';
}

// ---------------------------------------------------------------------------------
// 8. 작성 (CRO writing): 공통 1회 + 업권 묶음 2회
// ---------------------------------------------------------------------------------
const newsItemSchema = {
  type: 'object', additionalProperties: false,
  required: ['title', 'url', 'published', 'source_name', 'summary', 'why_woori_cro', 'entity', 'channel', 'source_type', 'risk_type', 'urgency', 'confidence', 'critical', 'window', 'watchpoints'],
  properties: {
    title: { type: 'string' }, url: { type: 'string' }, published: { type: 'string' }, source_name: { type: 'string' },
    summary: { type: 'string' }, why_woori_cro: { type: 'string' }, entity: { type: 'string' }, channel: { type: 'string' },
    source_type: { type: 'string', enum: ['media', 'official'] }, risk_type: { type: 'string' },
    urgency: { type: 'string', enum: ['높음', '중간', '낮음'] }, confidence: { type: 'string', enum: ['높음', '중간', '낮음'] },
    critical: { type: 'boolean' }, window: { type: 'string', enum: ['primary', 'related'] },
    watchpoints: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' } }
  }
};
const briefingSchema = {
  type: 'object', additionalProperties: false,
  required: ['executive_judgment', 'executive_judgment_bullets', 'critical', 'daily_news', 'subsidiary_news', 'additional_news', 'forward_looking_points', 'insights', 'monitoring_points'],
  properties: {
    executive_judgment: { type: 'string' },
    executive_judgment_bullets: { type: 'array', minItems: 3, maxItems: 4, items: { type: 'string' } },
    critical: { type: 'array', minItems: 0, maxItems: CATEGORY_CAPS.critical, items: newsItemSchema },
    daily_news: { type: 'array', minItems: 0, maxItems: CATEGORY_CAPS.daily_news, items: newsItemSchema },
    subsidiary_news: { type: 'array', minItems: 0, maxItems: CATEGORY_CAPS.subsidiary_news, items: newsItemSchema },
    additional_news: { type: 'array', minItems: 0, maxItems: CATEGORY_CAPS.additional_news, items: newsItemSchema },
    forward_looking_points: {
      type: 'array', minItems: 2, maxItems: 4,
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'horizon', 'likelihood', 'cro_angle', 'trigger'],
        properties: { title: { type: 'string' }, horizon: { type: 'string' }, likelihood: { type: 'string', enum: ['높음', '중간', '낮음'] }, cro_angle: { type: 'string' }, trigger: { type: 'string' } }
      }
    },
    insights: {
      type: 'object', additionalProperties: false, required: ['headline', 'bullets', 'action_items', 'stance'],
      properties: {
        headline: { type: 'string' }, bullets: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string' } },
        action_items: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string' } }, stance: { type: 'string' }
      }
    },
    monitoring_points: { type: 'array', minItems: 4, maxItems: 7, items: { type: 'string' } }
  }
};
// 업권 묶음 작성 스키마: sectors[] 각 항목 = {sector, judgment(2문장), news[]}
const sectorWritingSchema = {
  type: 'object', additionalProperties: false, required: ['sectors'],
  properties: {
    sectors: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['sector', 'judgment', 'news'],
        properties: {
          sector: { type: 'string', enum: SECTOR_IDS },
          judgment: { type: 'string' },
          news: { type: 'array', minItems: 0, maxItems: SECTOR_MAX, items: newsItemSchema }
        }
      }
    }
  }
};

function writingItem(c, critical) {
  return {
    url: c.url, title: c.title, published: c.published, source_name: guessSourceName(c.url), source_type: c.source_type,
    axis: c.axis, sector: c.sector, score: c.score, entity: c.entity, one_line_fact: c.one_line_fact, cro_hook: c.cro_hook,
    sector_hook: c.sector_hook, window: windowOf(c), critical, research_excerpt: c.excerpt
  };
}
function writingInput() {
  const out = {};
  for (const key of NEWS_KEYS) out[key] = buckets[key].map((c) => writingItem(c, key === 'critical'));
  return out;
}
const ARTICLE_RULES = `기사별 작성 규칙:
- summary는 기사 내용의 사실 요약 2~3문장만 쓴다(수치·주체·날짜를 명시; 증권사·신평사 분석은 '○○증권은 …라고 분석했습니다'처럼 분석 주체 표기). 우리금융 관점·질문·당부·'확인 필요' 류 문장은 summary에 넣지 않는다.
- why_woori_cro는 이 사안이 우리금융(업권이면 해당 계열사)에 닿는 지점을 1~2문장 서술문으로 쓴다. 질문 금지.
- 의문문 절대 금지: summary·why_woori_cro·judgment·executive_judgment 어디에도 '?'나 '까요', '합니까', '습니까', '인가요'로 끝나는 문장을 쓰지 마라. 질문 대신 '○○ 지표가 기준치 안에 있는지가 오늘의 확인 사항입니다'처럼 서술문으로 쓴다.
- watchpoints는 2~3개이며, 각 항목은 '지표·일정·기준값'을 명사형으로 쓴다 (예: '그룹 연체율 1.4% 이상 지속 여부', '금감원 제재 확정 공시 일정'). 의문문 금지.
- source_name은 매체·기관명(입력값 참고). entity는 기사 주체. channel·risk_type은 짧은 한국어 명사구. urgency·confidence는 높음/중간/낮음.
- 금지어(절대 사용 금지): '점검해야 합니다', '확인해야 합니다', '주목해야 합니다', '검증 가능한', '풀이 좁', '기사가 부족', '조사 근거', '조사 메모', '후보 기사'. 브리핑 작성 과정·데이터 수집 상황에 대한 언급은 어떤 필드에도 쓰지 마라.
- 입력된 one_line_fact·cro_hook·sector_hook·research_excerpt 에 없는 수치·사실을 만들지 마라. 마크다운·URL·괄호 속 도메인을 쓰지 마라.`;

function buildWritingPrompt(feedback) {
  const input = writingInput();
  return `당신은 우리금융그룹 CRO를 지원하는 CRO STAFF다. 실행일은 ${date} KST다.
아래 [[SELECTED]] 블록의 기사들은 그룹 공통(지주 관점) 섹션으로 이미 선정·분류가 끝났다. 기사를 추가·삭제·이동하지 말고, 각 카테고리의 순서를 그대로 유지하며 모든 기사를 작성하라.
title, url, published, source_type, window, critical 은 입력값을 글자 그대로 복사하라.

${ARTICLE_RULES}
- why_woori_cro(공통): 그룹에 닿는 영향 경로를 1~2문장 서술문으로 쓴다 (어느 계열사·포트폴리오·지표인지, 30~90일 의사결정 포인트).

종합 섹션 (전체본 기준, 그룹 공통 기사를 중심으로):
- executive_judgment는 정확히 3문장의 서술문: (1) 오늘 가장 큰 리스크 1개 (2) 그룹에 닿는 경로 (3) 오늘 주시할 것(지표·일정·기준값을 서술문으로). 첫 문장부터 리스크 판단으로 시작하고, 의문문은 쓰지 마라.
- executive_judgment_bullets는 3~4개. 선정 기사 중 score가 높은 순으로 '사실 → 의미'를 자연스러운 2문장으로 쓴다. 라벨 단어('확인된 변화는' 등)로 시작하지 마라.
- forward_looking_points 2~4개(title, horizon 예: '1~2주', likelihood, cro_angle 2문장, trigger 1문장).
- insights: headline 1문장, bullets 3~5개(기사 간 공통 동인·전이경로), action_items 3~5개(담당 조직과 기한이 드러나는 행동), stance 1~2문장.
- monitoring_points 4~7개(지표명과 기준값·일정).
모든 서술은 정중한 합니다체이며 '한다·이다·있다·된다'로 문장을 끝내지 마라.
${feedback ? `\n이전 시도의 품질 문제 (모두 고쳐라):\n${feedback}\n` : ''}
[[SELECTED]]
${JSON.stringify(input)}
[[/SELECTED]]

반드시 제공된 JSON 스키마에 맞춰 한국어로 답하라.`;
}
function buildSectorWritingPrompt(batchIds, feedback) {
  const input = batchIds.map((id) => ({
    sector: id, label_ko: sectorLabel(id), companies: sectorCompanies(id), scope: sectorById[id].scope_ko,
    news: sectorSelected[id].map((c) => writingItem(c, Boolean(c.sector_critical)))
  }));
  return `당신은 우리금융그룹 CRO STAFF다. 실행일은 ${date} KST다. 이번 호출은 업권본(해당 업권 계열사 리스크관리부용) 섹션을 작성한다.
아래 [[SECTORS]] 블록은 업권별로 이미 선정된 기사다. 업권·기사를 추가·삭제·이동하지 말고, 입력된 순서를 유지하며 모든 업권의 모든 기사를 작성하라. 기사가 0건인 업권은 news를 빈 배열로 두되 judgment는 작성하라.
title, url, published, source_type, window, critical 은 입력값을 글자 그대로 복사하라. sector는 입력값과 같은 id를 쓴다.

${ARTICLE_RULES}
- why_woori_cro(업권): '그룹 관점 1문장 + ○○(해당 업권 계열사명, companies 참고) 관점 1문장'의 서술문 2문장으로 쓴다. 계열사명을 반드시 명시하고, sector_hook 의 내용을 구체화하라. 질문 금지.

업권별 judgment: 정확히 2문장의 서술문. (1) 오늘 이 업권(해당 계열사)의 최대 리스크 1개와 그 경로 (2) 해당 계열사 리스크관리부가 오늘 주시할 지표·기준값(서술문, 의문문 금지). 기사가 없는 업권이면 '오늘 (업권명) 업권에서 새로 확인된 리스크 사건은 없습니다.'로 시작하고 두 번째 문장은 상시 지표를 서술문으로 쓴다.
모든 서술은 정중한 합니다체이며 '한다·이다·있다·된다'로 문장을 끝내지 마라.
${feedback ? `\n이전 시도의 품질 문제 (모두 고쳐라):\n${feedback}\n` : ''}
[[SECTORS]]
${JSON.stringify(input)}
[[/SECTORS]]

반드시 제공된 JSON 스키마에 맞춰 한국어로 답하라.`;
}

// 기사 단위 품질 검사 (공통·업권 공용)
function itemProblems(it, { requireCompany } = {}) {
  const problems = [];
  const banned = [it.summary, it.why_woori_cro, ...(it.watchpoints || [])].flatMap(findBannedPhrases);
  if (banned.length) problems.push(`금지어 사용 (${[...new Set(banned)].join(', ')}): ${it.title}`);
  const questions = [it.summary, it.why_woori_cro, ...(it.watchpoints || [])].flatMap(findQuestionSentences);
  if (questions.length) problems.push(`의문문 사용 금지 (${questions.slice(0, 2).map((q) => `'${q.slice(0, 40)}'`).join(', ')}): ${it.title}`);
  if (sentenceCount(it.summary) < 2) problems.push(`summary가 2문장 미만: ${it.title}`);
  if (sentenceCount(it.summary) > 3) problems.push(`summary가 3문장 초과: ${it.title}`);
  if (sentenceCount(it.why_woori_cro) < 1) problems.push(`why_woori_cro 누락: ${it.title}`);
  if (sentenceCount(it.why_woori_cro) > 2) problems.push(`why_woori_cro가 2문장 초과: ${it.title}`);
  if ([it.summary, it.why_woori_cro, ...(it.watchpoints || [])].some(usesNonFormalKorean)) problems.push(`해라체 사용: ${it.title}`);
  if (requireCompany?.length && !requireCompany.some((name) => String(it.why_woori_cro || '').includes(name))) problems.push(`why_woori_cro에 계열사명(${requireCompany.join('/')}) 누락: ${it.title}`);
  return problems;
}
// 작성 결과 검사: 누락 기사, 금지어, 해라체, 문장 수. 문제 목록을 돌려준다.
function writingProblems(draft) {
  const problems = [];
  for (const key of NEWS_KEYS) {
    const expected = buckets[key];
    const got = draft[key] || [];
    const gotKeys = new Set(got.map((it) => safeCanonical(it.url)));
    for (const c of expected) if (!gotKeys.has(c.key)) problems.push(`${key}에서 기사 누락: ${c.title}`);
    for (const it of got) problems.push(...itemProblems(it));
  }
  const narrative = [draft.executive_judgment, ...(draft.executive_judgment_bullets || []), draft.insights?.headline, ...(draft.insights?.bullets || []), ...(draft.insights?.action_items || []), draft.insights?.stance, ...(draft.monitoring_points || [])];
  const bannedNarrative = narrative.flatMap(findBannedPhrases);
  if (bannedNarrative.length) problems.push(`종합 섹션 금지어 사용: ${[...new Set(bannedNarrative)].join(', ')}`);
  if (narrative.some(usesNonFormalKorean)) problems.push('종합 섹션 해라체 사용');
  if (findQuestionSentences(draft.executive_judgment).length) problems.push('executive_judgment에 의문문 사용 금지 (서술문 3문장)');
  if (sentenceCount(draft.executive_judgment) < 3) problems.push('executive_judgment가 3문장 미만');
  return problems;
}
function sectorWritingProblems(draft, batchIds) {
  const problems = [];
  for (const id of batchIds) {
    const got = (draft.sectors || []).find((s) => s.sector === id);
    if (!got) { problems.push(`업권 누락: ${id}`); continue; }
    const gotKeys = new Set((got.news || []).map((it) => safeCanonical(it.url)));
    for (const c of sectorSelected[id]) if (!gotKeys.has(c.key)) problems.push(`${id}에서 기사 누락: ${c.title}`);
    for (const it of got.news || []) problems.push(...itemProblems(it, { requireCompany: sectorCompanies(id) }));
    if (findBannedPhrases(got.judgment).length) problems.push(`${id} judgment 금지어 사용`);
    if (usesNonFormalKorean(got.judgment)) problems.push(`${id} judgment 해라체 사용`);
    if (findQuestionSentences(got.judgment).length) problems.push(`${id} judgment에 의문문 사용 금지 (서술문 2문장)`);
    if (sentenceCount(got.judgment) < 2) problems.push(`${id} judgment가 2문장 미만`);
  }
  return problems;
}

// 공통 호출 1회 + 업권 묶음 호출 N회를 같은 루프로 돌린다 (모델 404 폴백 1회, 품질 재요청 1회, 그래도 안 되면 최선 초안 또는 null).
let writingModel = MODELS.writing;
let writingModelFallbacks = 0;
async function writeWithRetry(label, schemaName, schema, buildPrompt, checkProblems) {
  let feedback = '';
  let best = null;
  let bestProblemCount = Infinity;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let draft;
    try {
      const body = await requestOpenAi(label, {
        model: writingModel, input: buildPrompt(feedback), store: false, reasoning: { effort: 'medium' },
        text: { verbosity: 'medium', format: { type: 'json_schema', name: schemaName, strict: true, schema } },
        max_output_tokens: 32000
      });
      draft = parseStructuredOutput(body, label);
    } catch (error) {
      if (isModelUnavailableError(error) && writingModel !== MODELS.writing_fallback && writingModelFallbacks === 0) {
        console.warn(`Writing model ${writingModel} unavailable (${error.message}). Falling back to ${MODELS.writing_fallback}.`);
        writingModel = MODELS.writing_fallback;
        writingModelFallbacks += 1;
        attempt -= 1; // 모델 폴백은 시도 횟수에 세지 않는다 (1회만, 이후 호출은 모두 폴백 모델 사용).
        continue;
      }
      console.warn(`${label} attempt ${attempt}/2 failed: ${error.message}`);
      feedback = '이전 응답이 유효한 JSON 스키마로 완성되지 않았습니다. 분량을 줄이더라도 유효한 JSON 객체 하나를 끝까지 완성하십시오.';
      if (attempt < 2) await coolDown(`${label} retry`);
      continue;
    }
    const problems = checkProblems(draft);
    if (problems.length < bestProblemCount) { best = draft; bestProblemCount = problems.length; }
    if (problems.length === 0) { console.log(`${label} accepted on attempt ${attempt} (model=${writingModel}).`); return { draft, fallback: false }; }
    console.warn(`${label} attempt ${attempt}/2 had ${problems.length} quality problem(s): ${problems.slice(0, 5).join(' | ')}`);
    feedback = problems.join('\n');
    if (attempt < 2) await coolDown(`${label} quality retry`);
  }
  if (best) { console.warn(`${label}: using best draft with ${bestProblemCount} remaining problem(s); code will patch them.`); return { draft: best, fallback: false }; }
  console.warn(`${label} failed twice. Assembling from scoring output.`);
  return { draft: null, fallback: true };
}

const writing = await writeWithRetry('CRO writing', 'cro_staff_daily_briefing', briefingSchema, buildWritingPrompt, writingProblems);
await coolDown('CRO writing');
const sectorWriting = {}; // sectorId → { judgment, news[] } | null
const sectorWritingFallback = [];
for (const batchIds of SECTOR_WRITING_BATCHES) {
  if (!batchIds.length) continue;
  const label = `CRO sector writing (${batchIds.join('+')})`;
  const result = await writeWithRetry(label, 'cro_staff_sector_briefing', sectorWritingSchema,
    (feedback) => buildSectorWritingPrompt(batchIds, feedback), (draft) => sectorWritingProblems(draft, batchIds));
  for (const id of batchIds) {
    const got = result.draft ? (result.draft.sectors || []).find((s) => s.sector === id) : null;
    sectorWriting[id] = got || null;
    if (!got) sectorWritingFallback.push(id);
  }
  await coolDown(label);
}

// 작성 실패 시 코드가 조립하는 기사 본문
function assembleItem(c) {
  const sourceName = guessSourceName(c.url);
  const fact = c.one_line_fact || `${c.title}라고 보도했습니다.`;
  const hook = c.cro_hook || `${channelOf(c)} 영역에서 우리금융 관련 포트폴리오에 영향을 줄 수 있는 사안입니다.`;
  const isSector = c.sector && c.sector !== 'group';
  const companyName = isSector ? sectorCompanies(c.sector).join('·') : '';
  const sectorLine = isSector ? (c.sector_hook || `${companyName} 관점에서는 ${sectorLabel(c.sector)} 업권 익스포저와 관련 지표에 닿는 사안입니다.`) : '';
  return {
    title: c.title, url: c.url, published: c.published, source_name: sourceName,
    summary: `${sourceName}이(가) ${c.published.slice(0, 10)}에 보도한 내용입니다. ${fact}`,
    why_woori_cro: isSector
      ? `${hook} ${sectorLine}`
      : `${hook} 30~90일 안에 관련 한도·충당금·자본 지표의 변화 여부가 의사결정 포인트입니다.`,
    entity: c.entity || '', channel: channelOf(c), source_type: c.source_type, risk_type: riskTypeOf(c),
    urgency: urgencyOf(c), confidence: confidenceOf(c), critical: isSector ? Boolean(c.sector_critical) : c.category === 'critical', window: windowOf(c),
    watchpoints: [`${c.entity || channelOf(c)} 관련 지표의 다음 발표·공시 일정`, `${riskTypeOf(c)} 익스포저 한도 대비 사용률`]
  };
}
function assembleSectorJudgment(id) {
  const items = [...sectorSelected[id]].sort((a, b) => b.score - a.score);
  const top = items[0];
  const company = sectorCompanies(id).join('·');
  if (!top) return `오늘 ${sectorLabel(id)} 업권에서 새로 확인된 리스크 사건은 없습니다. ${company} 리스크관리부는 연체율·자본비율 등 상시 지표가 내부 기준치 안에 있는지를 오늘의 확인 사항으로 둡니다.`;
  const path = top.sector_hook || top.cro_hook || `${company}의 관련 포트폴리오와 지표에 영향을 줄 수 있습니다.`;
  return `오늘 ${sectorLabel(id)} 업권의 가장 큰 리스크는 ${top.entity || top.title} 관련 사안이며, ${path} ${company} 리스크관리부는 관련 익스포저와 한도 사용률이 기준치 안에 있는지를 오늘의 확인 사항으로 둡니다.`;
}
function assembleFallbackBriefing() {
  const top = [...selected].sort((a, b) => b.score - a.score);
  const bullet = (c) => `${c.one_line_fact || c.title} ${c.cro_hook || `${channelOf(c)} 관점에서 우리금융 관련 지표에 영향을 줄 수 있습니다.`}`;
  const briefing = {
    executive_judgment: `오늘 가장 큰 리스크는 ${top[0]?.entity || top[0]?.title || '주요 사안'} 관련 사안입니다. ${top[0]?.cro_hook || '그룹 포트폴리오와 자본 지표에 영향을 줄 수 있습니다.'} 오늘 주시할 것은 관련 익스포저와 한도 사용률이 그룹 기준치 안에 있는지입니다.`,
    executive_judgment_bullets: top.slice(0, 4).map(bullet),
    forward_looking_points: top.slice(0, 2).map((c) => ({ title: c.event_key.replace(/\|/g, ' '), horizon: '1~2주', likelihood: '중간', cro_angle: `${c.cro_hook || '관련 지표의 변화를 지켜볼 사안입니다.'} 후속 발표가 나오면 영향 범위를 재평가합니다.`, trigger: `${c.entity || '관련 기관'}의 후속 발표 또는 수치 변화입니다.` })),
    insights: {
      headline: `${top[0]?.entity || '주요 리스크'} 관련 사안을 중심으로 그룹 리스크 지표를 함께 봅니다.`,
      bullets: top.slice(0, 3).map(bullet),
      action_items: ['리스크관리부는 금일 중 관련 익스포저와 한도 사용률을 집계합니다.', '계열사 리스크 담당은 이번 주 안에 관련 지표 변화를 보고합니다.', '그룹 리스크관리협의회에서 다음 회의 때 대응 방향을 결정합니다.'],
      stance: '확인된 사실 범위 안에서 보수적으로 대응합니다.'
    },
    monitoring_points: top.slice(0, 5).map((c) => `${c.entity || channelOf(c)} 관련 후속 발표와 수치 변화`)
  };
  while (briefing.executive_judgment_bullets.length < 3) briefing.executive_judgment_bullets.push('추가로 확인된 변화는 없습니다. 기존 모니터링 체계를 유지합니다.');
  while (briefing.monitoring_points.length < 4) briefing.monitoring_points.push('그룹 연체율·충당금·자본비율 월간 추이');
  while (briefing.insights.bullets.length < 3) briefing.insights.bullets.push('추가 전이 경로는 확인되지 않았습니다. 기존 모니터링 체계를 유지합니다.');
  for (const key of NEWS_KEYS) briefing[key] = buckets[key].map(assembleItem);
  return briefing;
}

// ---------------------------------------------------------------------------------
// 9. 후처리: 입력값 강제 덮어쓰기, 금지어·마크다운 제거, 누락 보정, 플래그 정리
// ---------------------------------------------------------------------------------
// 초안 기사 → 최종 newsItem (공통·업권 공용). critical 은 호출자가 정한다.
function finalizeItem(c, draftItems, critical) {
  const found = draftItems.find((it) => safeCanonical(it.url) === c.key);
  const item = found ? { ...found } : assembleItem(c);
  if (!found) console.log(`Assembled missing article from scoring output: ${c.title}`);
  // 입력값 강제: url/title/published/source_type/window/critical
  item.title = c.title; item.url = c.url; item.published = c.published; item.source_type = c.source_type;
  item.window = windowOf(c); item.critical = critical;
  item.source_name = String(item.source_name || '').trim() || guessSourceName(c.url);
  item.entity = String(item.entity || '').trim() || c.entity || competitorOf(c.title) || '';
  item.channel = String(item.channel || '').trim() || channelOf(c);
  item.risk_type = String(item.risk_type || '').trim() || riskTypeOf(c);
  if (!['높음', '중간', '낮음'].includes(item.urgency)) item.urgency = urgencyOf(c);
  if (!['높음', '중간', '낮음'].includes(item.confidence)) item.confidence = confidenceOf(c);
  item.summary = dropQuestionSentences(dropBannedSentences(cleanText(item.summary)));
  item.why_woori_cro = dropQuestionSentences(dropBannedSentences(cleanText(item.why_woori_cro)));
  item.watchpoints = (Array.isArray(item.watchpoints) ? item.watchpoints : []).map(cleanText).filter((w) => w && findBannedPhrases(w).length === 0 && !isQuestionSentence(w)).slice(0, 3);
  while (item.watchpoints.length < 2) item.watchpoints.push(`${item.entity || item.channel} 관련 지표의 다음 발표·공시 일정`);
  if (sentenceCount(item.summary) < 2) item.summary = assembleItem(c).summary;
  if (sentenceCount(item.why_woori_cro) < 1) item.why_woori_cro = assembleItem(c).why_woori_cro;
  // 새 필드 (기존 웹·메일은 무시한다)
  item.score = c.score; item.axis = c.axis; item.event_key = c.event_key; item.one_line_fact = c.one_line_fact; item.cro_hook = c.cro_hook;
  item.sector = c.sector || 'group'; item.sector_hook = c.sector_hook || '';
  if (c.promoted_from_sector) item.promoted_from_sector = c.promoted_from_sector;
  return item;
}

let briefing = writing.draft ? writing.draft : assembleFallbackBriefing();
for (const key of NEWS_KEYS) briefing[key] = buckets[key].map((c) => finalizeItem(c, briefing[key] || [], key === 'critical'));
briefing.executive_judgment = dropQuestionSentences(dropBannedSentences(cleanText(briefing.executive_judgment)));
briefing.executive_judgment_bullets = (briefing.executive_judgment_bullets || []).map((b) => dropBannedSentences(cleanText(b))).filter(Boolean);
briefing.insights ||= {};
briefing.insights.headline = dropBannedSentences(cleanText(briefing.insights.headline || ''));
briefing.insights.bullets = (briefing.insights.bullets || []).map((b) => dropBannedSentences(cleanText(b))).filter(Boolean);
briefing.insights.action_items = (briefing.insights.action_items || []).map((b) => dropBannedSentences(cleanText(b))).filter(Boolean);
briefing.insights.stance = dropBannedSentences(cleanText(briefing.insights.stance || ''));
briefing.insights.as_of = `${date} KST`;
briefing.monitoring_points = (briefing.monitoring_points || []).map((b) => dropBannedSentences(cleanText(b))).filter(Boolean);
briefing.forward_looking_points = (briefing.forward_looking_points || []).map((p) => ({ ...p, title: cleanText(p.title), cro_angle: dropBannedSentences(cleanText(p.cro_angle)), trigger: cleanText(p.trigger) }));
{
  const fallback = assembleFallbackBriefing();
  if (briefing.executive_judgment_bullets.length < 3) briefing.executive_judgment_bullets = fallback.executive_judgment_bullets;
  if (briefing.insights.bullets.length < 3) briefing.insights.bullets = fallback.insights.bullets;
  if (briefing.insights.action_items.length < 3) briefing.insights.action_items = fallback.insights.action_items;
  if (briefing.monitoring_points.length < 4) briefing.monitoring_points = fallback.monitoring_points;
  if (!briefing.executive_judgment) briefing.executive_judgment = fallback.executive_judgment;
  if (!briefing.insights.headline) briefing.insights.headline = fallback.insights.headline;
  if (!briefing.insights.stance) briefing.insights.stance = fallback.insights.stance;
}
// 업권 섹션 조립 (공통 작성 결과와 독립적으로 각 업권을 확정한다)
briefing.sectors = {};
briefing.sector_judgment = {};
for (const id of SECTOR_IDS) {
  const draft = sectorWriting[id];
  const news = sectorSelected[id].map((c) => finalizeItem(c, draft?.news || [], Boolean(c.sector_critical)));
  let judgment = dropQuestionSentences(dropBannedSentences(cleanText(draft?.judgment || '')));
  if (sentenceCount(judgment) < 2) judgment = assembleSectorJudgment(id);
  briefing.sectors[id] = { ...emptySectorSection(id, sectorShortfall[id] || ''), judgment, news };
  briefing.sector_judgment[id] = judgment;
}
briefing.editions = EDITIONS;

const allNews = NEWS_KEYS.flatMap((key) => briefing[key] || []);
const allSectorNews = SECTOR_IDS.flatMap((id) => briefing.sectors[id].news);
const residualNonFormal = [...allNews, ...allSectorNews].filter((it) => [it.summary, it.why_woori_cro].some(usesNonFormalKorean)).length;
if (residualNonFormal) console.warn(`Quality note: ${residualNonFormal} article(s) still contain 해라체 sentences.`);

// ---------------------------------------------------------------------------------
// 10. 메타 · 이력 · 저장
// ---------------------------------------------------------------------------------
async function saveHistory(finalBriefing) {
  if (DRY_RUN) { console.log(`[DRY_RUN] Skipping history save (would write docs/briefing_history/${date}.json).`); return; }
  await mkdir(historyDir, { recursive: true });
  await writeFile(new URL(`${date}.json`, historyDir), `${JSON.stringify(finalBriefing, null, 2)}\n`, 'utf8');
  const cutoff = shiftDate(date, -HISTORY_RETENTION_DAYS);
  for (const name of await readdir(historyDir)) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (m && m[1] < cutoff) { await unlink(new URL(name, historyDir)); console.log(`Pruned old history file: ${name}`); }
  }
}
async function writeOutput(finalBriefing) {
  await writeFile(outputPath, `${JSON.stringify(finalBriefing, null, 2)}\n`, 'utf8');
  await saveHistory(finalBriefing);
}

const previousEventKeys = new Set(previousItems.map((it) => it.event_key_norm).filter(Boolean));
const continued = allSelected.filter((c) => isFollowUpEventKey(c.event_key) || previousEventKeys.has(c.event_key_norm)).map((c) => c.event_key);
const usage = usageSummary();
const sectorCounts = { group: allNews.length, ...Object.fromEntries(SECTOR_IDS.map((id) => [id, briefing.sectors[id].news.length])) };
briefing.meta = {
  fallback_notice: false,
  product: 'CRO Staff News & Critical Monitor',
  perspective: '우리금융그룹 CRO',
  mode: 'daily',
  briefing_date: date,
  generated_at: new Date().toISOString(),
  primary_window: '어제·오늘(KST) 우선, 최근 3일 이내 기사 중심 (부족 시 4일까지 related)',
  research_method: `${stageDefinitions.length} research stages (domestic/woori/peer/global/official + ${sectorConfig.research_stages.length} sector) + LLM scoring (axis+sector) + deterministic selection (common ${COMMON_TARGET} + ${SECTOR_IDS.length} sectors × ${SECTOR_TARGET}) + CRO writing (1 common + ${SECTOR_WRITING_BATCHES.length} sector batches)`,
  pipeline_version: PIPELINE_VERSION,
  dry_run: DRY_RUN,
  candidates_total: candidates.length,
  selected_total: allNews.length + allSectorNews.length,
  common_total: allNews.length,
  slots: selection.slots,
  selection_window_days: selection.step.windowDays,
  selection_min_score: selection.step.minScore,
  shortfall_reason: shortfallReason,
  sector_counts: sectorCounts,
  sector_shortfall: sectorShortfall,
  sector_selection_steps: Object.fromEntries(SECTOR_IDS.map((id) => [id, sectorSelections[id].step.label])),
  editions: EDITIONS.length,
  scoring_fallback: scoringFallbackUsed,
  writing_fallback: writing.fallback,
  sector_writing_fallback: sectorWritingFallback,
  models: { research: MODELS.research, scoring: MODELS.scoring, writing: writingModel },
  usage,
  changes: { new: allSelected.filter((c) => !continued.includes(c.event_key)).map((c) => c.event_key), continued },
  compared_briefings: previousBriefings.map((b) => b.date),
  source_mix: {
    media: [...allNews, ...allSectorNews].filter((item) => item.source_type === 'media').length,
    official: [...allNews, ...allSectorNews].filter((item) => item.source_type === 'official').length
  }
};

await writeOutput(briefing);
console.log(`Generated ${allNews.length} common + ${allSectorNews.length} sector briefing articles for ${date} → ${outputPath.pathname.split('/').slice(-2).join('/')}${shortfallReason ? ` (shortfall: ${shortfallReason})` : ''}${Object.keys(sectorShortfall).length ? ` (sector shortfall: ${Object.keys(sectorShortfall).join(', ')})` : ''}`);
