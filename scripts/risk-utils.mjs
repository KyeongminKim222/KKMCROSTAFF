// 리스크 유형 분류·핵심판단 카드(risk_brief) 보조 모듈.
// 생성기(generate-daily-briefing.mjs)와 enrich-risk.mjs 가 공유한다. 외부 의존성 없음.

export const RISK_ORDER = ['신용리스크', '시장리스크', '운영리스크', '금리리스크', '유동성리스크', '시스템리스크', '평판리스크'];
export const LEVELS = ['높음', '중간', '낮음'];

// 핵심판단 카드는 '우리금융그룹이 받는 영향'만 다룬다. 타 금융사의 실적·건전성 자체가 주어인 카드는 제외한다.
const OTHER_FIRMS = /JB금융|전북은행|광주은행|JB우리|BNK|부산은행|경남은행|iM금융|iM뱅크|DGB|대구은행|제주은행|농협|NH|기업은행|IBK|산업은행|수협|카카오뱅크|케이뱅크|토스뱅크|KB|국민은행|신한|하나(금융|은행|카드|증권)|한국금융지주|삼성(카드|생명|화재|증권)|미래에셋|대신증권|메리츠|한화|현대(카드|해상|캐피탈)|롯데카드|빗썸/;
const WOORI_RE = /우리/;
export function isNonWooriCard(r) {
  const t = `${r?.headline || ''} ${r?.check || ''}`;
  return OTHER_FIRMS.test(t) && !WOORI_RE.test(t);
}
// 카드의 근거 기사로 쓸 수 있는 기사: 타사 경쟁 기사(peer 축)인데 우리 언급이 없으면 제외
export function isWooriRelevantItem(it) {
  if (it?.axis !== 'peer') return true;
  return WOORI_RE.test(`${it.title || ''} ${it.entity || ''} ${it.why_woori_cro || ''}`.slice(0, 400)) && /우리(금융|은행|카드|캐피탈|저축|투자증권|자산|생명|라이프)/.test(`${it.title || ''} ${it.entity || ''}`);
}
const LEVEL_RANK = { 높음: 0, 중간: 1, 낮음: 2 };

// 모델이 태그를 못 붙였을 때만 쓰는 키워드 보정 규칙 (유형별 키워드 개수로 판정)
const KEYWORDS = {
  신용리스크: /연체|부실|NPL|대손|충당금|PF|채무불이행|부도|디폴트|신용등급|여신|대출|건전성|회수|상각|담보|익스포저|가계부채/gi,
  시장리스크: /주가|환율|원달러|증시|변동성|VaR|파생|평가손|평가이익|채권시장|코스피|국채시장|자산가격|헤지/gi,
  운영리스크: /내부통제|횡령|금융사고|제재|과태료|과징금|부당|민원|소비자보호|준법|배임|불완전판매|위반|검사|감독규정|사고/gi,
  금리리스크: /금리|국채|듀레이션|지표금리|NIM|순이자마진|COFIX|기준금리|스프레드|이자이익/gi,
  유동성리스크: /유동성|LCR|예대율|자금조달|조달|뱅크런|인출|환매|단기자금|콜시장|예금 ?이탈/gi,
  시스템리스크: /\bIT\b|전산|해킹|사이버|장애|보안|랜섬|정보유출|개인정보|취약점|클라우드|시스템|디지털/gi,
  평판리스크: /평판|논란|비판|불매|이미지|여론|고객 ?이탈|스캔들|사과|신뢰/gi
};
const AXIS_DEFAULT = { supervision: '운영리스크', group: '운영리스크', peer: '평판리스크', market: '시장리스크', overseas: '시장리스크' };

export function classifyRisks(text, axis) {
  const s = String(text || '');
  const scored = RISK_ORDER.map((r) => [r, (s.match(KEYWORDS[r]) || []).length]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const tags = scored.slice(0, 2).map(([r]) => r);
  if (!tags.length) tags.push(AXIS_DEFAULT[axis] || '시장리스크');
  return tags;
}

export function toRiskName(v) {
  const s = String(v || '').trim().replace(/\s+/g, '');
  const name = s.endsWith('리스크') ? s : `${s}리스크`;
  return RISK_ORDER.includes(name) ? name : '';
}

export function normalizeRiskTags(tags, text, axis) {
  const out = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    const n = toRiskName(t);
    if (n && !out.includes(n)) out.push(n);
  }
  return (out.length ? out : classifyRisks(text, axis)).slice(0, 3);
}

function cut(s, n) {
  const t = String(s || '').replace(/^(\s*\[[^\]]{1,14}\]\s*)+/, '').replace(/\s+/g, ' ').trim().replace(/[…]+$/, '');
  return t.length > n ? `${t.slice(0, n - 1).trim()}…` : t;
}
function levelOfScore(score) { return score >= 85 ? '높음' : score >= 60 ? '중간' : '낮음'; }

// 기사 목록에서 리스크 유형별 카드를 결정적으로 만든다 (모델 결과가 부족할 때의 보정·기존 JSON 보강용)
export function deriveRiskBrief(items, max = 7) {
  const groups = new Map();
  for (const it of items) {
    const tags = Array.isArray(it.risk_tags) && it.risk_tags.length ? it.risk_tags : classifyRisks(`${it.title} ${it.summary} ${it.why_woori_cro}`, it.axis);
    const primary = tags[0];
    if (!groups.has(primary)) groups.set(primary, []);
    groups.get(primary).push(it);
  }
  const rows = [...groups.entries()].map(([risk, list]) => {
    const sorted = [...list].sort((a, b) => (b.score || 0) - (a.score || 0));
    const top = sorted[0];
    const wp = (top.watchpoints || []).find((w) => String(w || '').trim()) || `${top.entity || top.channel || '관련'} 후속 발표·공시 일정`;
    return { risk, level: levelOfScore(top.score || 0), headline: cut(top.title, 38), check: cut(wp, 46), _s: top.score || 0, _n: list.length };
  });
  rows.sort((a, b) => (LEVEL_RANK[a.level] - LEVEL_RANK[b.level]) || (b._s - a._s) || (b._n - a._n));
  return rows.slice(0, max).map(({ _s, _n, ...r }) => r);
}

// 모델이 쓴 risk_brief 정리 → 유효한 유형·중복 제거·위험도 순 정렬, 3개 미만이면 결정적 보정으로 채운다
export function normalizeRiskBrief(raw, items, clean = (x) => String(x || '').trim()) {
  const out = [];
  const seen = new Set();
  const dropped = [];
  const pool = items.filter(isWooriRelevantItem);
  for (const r of Array.isArray(raw) ? raw : []) {
    const risk = toRiskName(r?.risk);
    if (!risk || seen.has(risk)) continue;
    const headline = clean(r.headline);
    const check = clean(r.check);
    if (!headline || !check) continue;
    if (isNonWooriCard({ headline, check })) { dropped.push(risk); continue; }
    seen.add(risk);
    out.push({ risk, level: LEVELS.includes(r.level) ? r.level : '중간', headline, check });
  }
  // 타사 중심이라 제외한 유형은 우리금융 관련 기사에서 같은 유형 카드를 다시 만든다
  const derived = deriveRiskBrief(pool).filter((d) => !isNonWooriCard(d));
  for (const d of derived) {
    if (dropped.includes(d.risk) && !seen.has(d.risk)) { seen.add(d.risk); out.push(d); }
  }
  if (out.length < 3) {
    for (const d of derived) {
      if (seen.has(d.risk)) continue;
      seen.add(d.risk);
      out.push(d);
      if (out.length >= 4) break;
    }
  }
  out.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
  return out.slice(0, 7);
}
