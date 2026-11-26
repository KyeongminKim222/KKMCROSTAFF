// 기사 품질 가드 (결정적, LLM 비사용). 2026-11-26 점검에서 나온 다섯 가지 문제를 코드로 막는다.
//  1) 스포츠·인사(연임·유임)·전망형 물음 제목 → 제외 (offTopicReason)
//  2) 같은 사건 판정 보강: 제목 핵심어·수치 겹침 (sameEventLoose)
//  3) 최근 브리핑 재등장: 같은 판정 + '|후속'이라도 새 수치가 없으면 재등장 (isLooseRepeat)
//  4) 업권 관련성: 업권 칸 기사에 그 업권 낱말이 하나도 없으면 제외 (sectorMismatch)
//  5) 깨진 제목 복원: 원문 페이지 og:title/<title> (repairTitles)

// ── 1) 주제 밖 기사 ──
const SPORTS = /KOVO|V-?리그|배구|농구|야구|축구|골프|e스포츠|\d+\s?연패|\d+\s?연승|셧아웃|세터|감독\s?대행|시즌\s?첫\s?승|원정\s?경기|홈\s?경기|[가-힣A-Z]+-[가-힣A-Z]+전[,.\s]|\[AI프리뷰\]|\[프리뷰\]/;
const PERSONNEL = /연임|유임|3연임|재연임|임기\s?만료|후임|차기\s?(회장|행장|사장|대표|CEO)|수장|교체냐|선임|내정|취임\s?\d|인사\s?(단행|발표)|임원\s?인사|숏리스트|롱리스트|회추위|임추위|대표이사\s?후보|행장\s?후보/;
// 전망·추측형 물음 제목: '~할까?', '~일까', '~나?', '~되나', '~누구?' (단, 따옴표 속 인용은 제외하지 않음 — 제목 끝 기준)
const SPECULATIVE = /\?\s*$|(할까|일까|될까|을까|를까|인가|는가|되나|있나|없나|누구)\s*$/;
// 제외 사유 (스포츠·인사·연임). 사고·제재 자체는 별도 기사로 잡히므로 인사 기사는 모두 뺀다.
export function offTopicReason(title) {
  const t = String(title || '');
  if (SPORTS.test(t)) return 'sports';
  if (PERSONNEL.test(t)) return 'personnel';
  return '';
}
// 전망·추측형 물음 제목은 빼지 않고 점수를 깎는다 (수치가 있으면 덜 깎음).
export function speculativePenalty(title) {
  const t = String(title || '');
  if (!SPECULATIVE.test(t.replace(/\(종합\)|\[[^\]]*\]/g, '').trim())) return 0;
  return numbersOf(t).size ? 8 : 15;
}

// ── 2) 같은 사건 (느슨한 판정) ──
const STOP = new Set(('금융 금융사 금융권 금융당국 당국 정부 기준 강화 확대 추진 발표 개선 관련 이후 이어 따라 위해 대한 통해 우려 전망 가능 본격 논란 '
  + '은행 은행권 증권 증권사 보험 보험사 카드 카드사 업계 시장 국내 올해 내년 이번 지난 최대 역대 사상 첫 또 다시 이달 연내 '
  + '종합 속보 단독 기자 뉴스 오늘 내달 하반기 상반기 분기 대비 증가 감소 상승 하락 급증 급락 촉각 비상 주목 무게 부담 여전 변수 '
  // 사고 유형 낱말: 회사가 다르면 다른 사건이라 겹침 계산에서 뺀다 (해킹 몰림은 topic-caps 가 따로 막는다)
  + '해킹 유출 개인정보 고객 피해 사고 정보 보안').split(' '));
function normTitle(s) {
  return String(s || '').replace(/\[[^\]]*\]/g, ' ').replace(/&quot;|&#39;|["'“”‘’`]/g, ' ').replace(/\.{2,}|…/g, ' ');
}
export function numbersOf(s) {
  // 단위가 붙은 수치만 (0.62%, 10억, 7809억원, 1345.9원, 8천여명)
  const out = new Set();
  for (const m of normTitle(s).matchAll(/(\d[\d,.]*)\s*(%|％|%p|bp|조|억|만|천|원|배|명|건|개월|년)/g)) {
    const n = m[1].replace(/,/g, '').replace(/\.$/, '');
    if (n === '1' || n === '2' || n === '3') continue; // 1위·2곳 같은 흔한 수는 제외
    out.add(n + m[2].replace('％', '%'));
  }
  return out;
}
export function tokensOf(s) {
  const out = new Set();
  for (let w of normTitle(s).split(/[^가-힣A-Za-z0-9.%]+/)) {
    w = w.replace(/(은|는|이|가|의|을|를|에|에서|으로|로|과|와|도|만|까지|부터|보다|에게|께|서|엔)$/, '');
    if (w.length < 2 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(w);
  }
  return out;
}
function overlap(a, b) { let n = 0; for (const x of a) if (b.has(x)) n += 1; return n; }
// a,b: {title, entity?}. 반환: 같은 사건이면 이유 문자열, 아니면 ''.
export function sameEventLoose(a, b) {
  const ta = tokensOf(a.title), tb = tokensOf(b.title);
  const na = numbersOf(a.title), nb = numbersOf(b.title);
  const tok = overlap(ta, tb), num = overlap(na, nb);
  const small = Math.min(ta.size, tb.size) || 1;
  if (num >= 1 && tok >= 1) return `수치 ${[...na].filter((x) => nb.has(x)).join(',')} + 핵심어 ${tok}개 겹침`;
  if (tok >= 3) return `핵심어 ${tok}개 겹침`;
  if (tok >= 2 && tok / small >= 0.5) return `핵심어 ${tok}/${small} 겹침`;
  return '';
}

// ── 3) 최근 브리핑 재등장 ──
// prevItems: [{date,title}]. '|후속' 키라도 제목에 이전 기사에 없던 수치가 없으면 재등장으로 본다.
export function isLooseRepeat(c, prevItems) {
  for (const p of prevItems) {
    const why = sameEventLoose(c, p);
    if (!why) continue;
    // 제목에 이전 기사에 없던 수치가 있으면 후속(새 수치)으로 보고 통과시킨다
    const newNums = [...numbersOf(c.title)].filter((n) => !numbersOf(p.title).has(n));
    if (newNums.length) continue;
    return `${p.date} "${p.title}" (${why})`;
  }
  return '';
}

// ── 4) 업권 관련성 ──
const SECTOR_WORDS = {
  bank: /은행|銀|여신|예금|대출|금리|NIM|예대|주담대|LTV|DSR|부실채권|연체|고정이하|바젤|BIS|LCR|코픽스|가계부채|기업대출|PF|계좌|자금세탁|AML|송금|외환/,
  card_capital: /카드|캐피탈|여전|여신전문|저축은행|저축銀|카드론|리볼빙|현금서비스|할부|리스|중금리|대부|햇살론|예보료|가맹점|PG/,
  insurance: /보험|생명|화재|라이프|손보|손해보험|생보|K-?ICS|킥스|지급여력|CSM|IFRS17|해약|GA|설계사|보험금|보험료|예실차|재보험|후순위채|신종자본/,
  securities_am: /증권|운용|자산운용|투자증권|IB|ELS|DLS|랩어카운트|신탁|펀드|공매도|사이드카|서킷|코스피|코스닥|증시|IMA|발행어음|종투사|모험자본|PF|채권|ETF|STO|토큰증권|불공정거래|시세조종|부정거래/
};
export function sectorMismatch(sectorId, c) {
  const re = SECTOR_WORDS[sectorId];
  if (!re) return false;
  return !re.test(`${c.title} ${c.entity || ''}`);
}

// ── 5) 깨진 제목 복원 ──
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export function looksBrokenTitle(t, url = '') {
  const s = String(t || '').trim();
  if (s.length < 14) return true;
  if (/(습니다|하였다|했습니다|됩니다)[.\s]/.test(s) || /습니다\.?$/.test(s)) return true;          // 보도자료 본문 첫 문장
  if (/\s-\s/.test(s) && /fsc\.go\.kr|fss\.or\.kr|bok\.or\.kr/.test(url)) return true;
  if (/(\.{3}|…)\s*$/.test(s)) return true;                                                     // 잘린 제목
  if (/(두고|내고|하고|되고|면서|이며|및|·|,)\s*$/.test(s)) return true;                         // 연결어미로 끊김
  return false;
}
function decode(s) {
  return String(s || '').replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;|&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
function stripSite(t) {
  t = t.replace(/\s+[-|]\s+[^-|]{2,24}\([^)]{1,16}\)\s*$/, '').trim();   // ' - 시사오늘(시사ON)'
  return t.replace(/\s*[-|:·]\s*(금융위원회|금융감독원|한국은행|[가-힣A-Za-z0-9 .]{2,20}(신문|일보|경제|뉴스|타임즈|타임스|저널|미디어|방송|투데이|데일리|news|News|NEWS))\s*$/, '').trim();
}
async function fetchTitle(url, ms = 7000) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    let html = buf.toString('utf8');
    const cs = (r.headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1] || html.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || '';
    if (/euc-kr|ks_c_5601|cp949/i.test(cs)) { try { html = new TextDecoder('euc-kr').decode(buf); } catch {} }
    // 금융위 보도자료: 본문 제목 영역
    const fsc = html.match(/<div class="subject">\s*([\s\S]*?)<\/div>/i) || html.match(/<strong class="tit">\s*([\s\S]*?)<\/strong>/i);
    const cand = [
      fsc && fsc[1],
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1],
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title/i)?.[1],
      html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ].map((x) => stripSite(decode(String(x || '').replace(/<[^>]+>/g, ' ')))).filter((x) => x.length >= 8);
    return cand.find((x) => !looksBrokenTitle(x, url) && !/^(금융위원회|금융감독원|보도자료|알림마당)$/.test(x)) || '';
  } catch { return ''; } finally { clearTimeout(tm); }
}
// items: 확정 기사 배열(제자리 수정). 반환: 고친 목록.
export async function repairTitles(items, { dryRun = false } = {}) {
  const fixed = [];
  await Promise.all(items.map(async (c) => {
    if (!looksBrokenTitle(c.title, c.url)) return;
    const t = dryRun ? '' : await fetchTitle(c.url);
    if (t && t !== c.title) { fixed.push({ from: c.title, to: t }); c.original_title = c.title; c.title = t; }
    else if (/(\.{3}|…)\s*$/.test(c.title) === false && /\s-\s/.test(c.title)) {
      // 보도자료 '본문 첫 문장 - 부제' 꼴은 부제를 제목으로
      const parts = c.title.split(/\s-\s/); const alt = parts[1] && parts[1].replace(/(\.{3}|…)$/, '').trim();
      if (alt && alt.length >= 10) { fixed.push({ from: c.title, to: alt }); c.original_title = c.title; c.title = alt; }
    }
  }));
  return fixed;
}
