// 뉴스 검색 피드 수집기 (결정적, LLM 비사용).
// 사람이 네이버 뉴스에서 검색하듯 config/sectors.json 의 키워드·계열사명으로 최신순 검색해 후보 기사를 대량 확보한다.
// 소스: (1) 네이버 뉴스 검색 최신순 HTML (2) Bing News RSS (원문 URL 복원). 실패해도 예외를 던지지 않고 빈 배열을 돌려준다.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BLOCK_HOST = /(^|\.)(blog\.naver\.com|cafe\.naver\.com|post\.naver\.com|tistory\.com|brunch\.co\.kr|youtube\.com|namu\.wiki|facebook\.com|instagram\.com|dcinside\.com|ppomppu\.co\.kr|clien\.net|fmkorea\.com)$/i;
const PROMO = /출시|후원|봉사|CSR|시상|수상|채용|박람회|체육대회|기념식|캠페인|이벤트|프로모션|할인|오픈|협약|MOU|업무제휴|사회공헌|기부|장학|인사\]|\[인사|부고|\[포토\]|\[화보\]|운세|분양|오피스텔|청약/;
const NOISE = /\[사진\]|\[포토\]|\[영상\]|WKBL|KBL|프로농구|여자농구|프로배구|V리그|농구단|배구단|야구단|프로야구|K리그|프로축구|골프|올림픽|선수단|우승 후보|챔피언|드라마|예능|아이돌|연예|날씨|오늘의 운세|부고|결혼|열애/;
const OPINION = /^\s*\[(칼럼|사설|기자수첩|데스크|기고|독자|오피니언|논단|시론|포럼)|인터뷰\]|\[인터뷰/;
const RISK = /연체|부실|NPL|충당금|PF|건전성|자본비율|BIS|CET1|NCR|K-ICS|킥스|지급여력|유동성|LCR|예대율|금리|환율|채권|국채|제재|과태료|과징금|기관경고|영업정지|횡령|금융사고|내부통제|해킹|정보유출|전산|사이버|감독|검사|규제|스트레스|대손|손실|리스크|위험|부도|디폴트|신용등급|가계부채|가계대출|기업대출|HUG|대출|환매|ELS|펀드|IFRS|해약|순익|순이익|영업이익|실적/;

function cleanTitle(s) {
  return String(s || '').replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function bigrams(s) { const t = String(s).replace(/[^가-힣A-Za-z0-9]/g, ''); const set = new Set(); for (let i = 0; i < t.length - 1; i += 1) set.add(t.slice(i, i + 2)); return set; }
function jaccard(a, b) { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n += 1; return n / (a.size + b.size - n); }

// '19시간 전' '2일 전' '2026.10.24.' → ISO(KST 표기 문자열, 시각 모를 땐 12:00)
function parseNaverTime(text, now) {
  const t = String(text || '').trim();
  let m = t.match(/^(\d+)\s*분 전$/); if (m) return new Date(now.getTime() - Number(m[1]) * 60_000);
  m = t.match(/^(\d+)\s*시간 전$/); if (m) return new Date(now.getTime() - Number(m[1]) * 3_600_000);
  m = t.match(/^(\d+)\s*일 전$/); if (m) return new Date(now.getTime() - Number(m[1]) * 86_400_000);
  m = t.match(/^(\d{4})\.(\d{2})\.(\d{2})\.?$/); if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00+09:00`);
  return null;
}
function kstString(d) {
  const k = new Date(d.getTime() + 9 * 3_600_000);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, '0')}-${String(k.getUTCDate()).padStart(2, '0')} ${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
}

async function fetchText(url, headers = {}, timeoutMs = 20000) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.5', ...headers }, signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, status: res.status, text: '' };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (e) { return { ok: false, status: 0, text: '', error: String(e && e.message || e) }; } finally { clearTimeout(timer); }
}

function parseNaver(html, now) {
  const out = [];
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>\s*<span[^>]*sds-comps-text-type-headline1[^>]*>([\s\S]*?)<\/span>/g;
  const heads = []; let m;
  while ((m = re.exec(html))) heads.push({ url: m[1].replace(/&amp;/g, '&'), title: cleanTitle(m[2]), start: m.index });
  for (let i = 0; i < heads.length; i += 1) {
    const h = heads[i];
    const seg = html.slice(h.start, i + 1 < heads.length ? heads[i + 1].start : h.start + 6000);
    // 발행시각: 블록 안의 첫 '○분/시간/일 전' 또는 날짜
    const tm = seg.match(/>(\d+\s*(?:분|시간|일) 전|\d{4}\.\d{2}\.\d{2}\.)</);
    const when = tm ? parseNaverTime(tm[1], now) : null;
    // 요약문: 본문 snippet (body 스타일 span 중 가장 긴 텍스트)
    const bodies = [...seg.matchAll(/<span[^>]*sds-comps-text-type-body1[^>]*>([\s\S]*?)<\/span>/g)].map((x) => cleanTitle(x[1])).filter((t) => t.length >= 25);
    const press = (seg.match(/profile-info-title[\s\S]*?<span[^>]*>([^<]{1,30})<\/span>/) || [])[1] || '';
    out.push({ url: h.url, title: h.title, published: when, snippet: bodies.sort((a, b) => b.length - a.length)[0] || '', press: cleanTitle(press) });
  }
  return out;
}

function parseBing(xml) {
  const out = [];
  for (const it of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = it[1];
    const title = cleanTitle((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const link = cleanTitle((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1]).replace(/&amp;/g, '&');
    const pub = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const desc = cleanTitle((b.match(/<description>([\s\S]*?)<\/description>/) || [])[1]);
    let real = '';
    try { real = new URL(link).searchParams.get('url') || ''; } catch { /* ignore */ }
    if (!real || !/^https?:/.test(real)) continue;
    out.push({ url: real, title, published: pub ? new Date(pub) : null, snippet: desc, press: '' });
  }
  return out;
}

// 언론사 RSS (원문 URL 직접 제공, 최신 기사 전체). 접속 확인된 곳만 둔다. 실패한 피드는 건너뛴다.
const RSS_FEEDS = [
  ['연합뉴스', 'https://www.yna.co.kr/rss/economy.xml'], ['연합뉴스', 'https://www.yna.co.kr/rss/news.xml'],
  ['매일경제', 'https://www.mk.co.kr/rss/30100041/'], ['매일경제', 'https://www.mk.co.kr/rss/50200011/'],
  ['서울경제', 'https://www.sedaily.com/rss/finance'], ['서울경제', 'https://www.sedaily.com/rss/economy'],
  ['뉴시스', 'https://www.newsis.com/RSS/economy.xml'], ['뉴시스', 'https://www.newsis.com/RSS/bank.xml'],
  ['아시아경제', 'https://www.asiae.co.kr/rss/economy.htm'], ['헤럴드경제', 'https://biz.heraldcorp.com/rss/google/economy'],
  ['연합인포맥스', 'https://news.einfomax.co.kr/rss/allArticle.xml'], ['전자신문', 'https://rss.etnews.com/Section901.xml'],
  ['EBN', 'https://www.ebn.co.kr/rss/allArticle.xml'], ['시사저널e', 'https://www.sisajournal-e.com/rss/allArticle.xml'],
  ['서울파이낸스', 'https://www.seoulfn.com/rss/allArticle.xml'], ['이코노믹리뷰', 'https://www.econovill.com/rss/allArticle.xml'],
  ['FETV', 'https://www.fetv.co.kr/rss/allArticle.xml'], ['디지털투데이', 'https://www.digitaltoday.co.kr/rss/allArticle.xml'],
  ['인포스탁데일리', 'https://www.infostockdaily.co.kr/rss/allArticle.xml'], ['finomy', 'https://www.finomy.com/rss/allArticle.xml'],
  ['보험신문', 'https://www.insnews.co.kr/rss/allArticle.xml'], ['금융소비자뉴스', 'https://www.fsnews.co.kr/rss/allArticle.xml'],
  ['CNB뉴스', 'https://www.cnbnews.com/rss/allArticle.xml'], ['코리아IT타임스', 'https://www.koreaittimes.com/rss/allArticle.xml'],
  ['핀포인트뉴스', 'https://www.pinpointnews.co.kr/rss/allArticle.xml'], ['더투데이', 'https://www.the-today.com/rss/allArticle.xml'],
  ['뉴스클레임', 'https://www.newsclaim.co.kr/rss/allArticle.xml'], ['M이코노미', 'https://www.m-i.kr/rss/allArticle.xml'],
  ['스트레이트뉴스', 'https://www.straightnews.co.kr/rss/allArticle.xml'], ['잡포스트', 'https://www.job-post.co.kr/rss/allArticle.xml']
];
const FIN = /금융|은행|증권|보험|카드|캐피탈|저축|자산운용|운용사|대출|금리|환율|채권|증시|코스피|코스닥|펀드|연금|핀테크|가상자산|코인|예금|여신|수신|자본|지주|ELS|PF|해킹|정보유출|전산|연체|부실|충당금/;

function parseRssDate(s) {
  const t = String(s || '').trim(); if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t)) return new Date(`${t.replace(' ', 'T')}${t.length === 16 ? ':00' : ''}+09:00`);
  const d = new Date(t); return Number.isNaN(d.getTime()) ? null : d;
}
function parseRss(xml, press) {
  const out = [];
  for (const it of xml.matchAll(/<item[ >]([\s\S]*?)<\/item>/g)) {
    const b = it[1];
    const pick = (tag) => { const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1') : ''; };
    const title = cleanTitle(pick('title'));
    const link = cleanTitle(pick('link')) || cleanTitle((b.match(/<link[^>]*href="([^"]+)"/) || [])[1]);
    const published = parseRssDate(pick('pubDate') || pick('dc:date') || pick('published'));
    const snippet = cleanTitle(pick('description') || pick('content:encoded')).slice(0, 400);
    if (title && /^https?:/.test(link)) out.push({ url: link.replace(/&amp;/g, '&'), title, published, snippet, press });
  }
  return out;
}

// MSN(msn.com) 재배포 링크 → 원문 언론사 URL 복원 (assets.msn.com Detail API)
async function restoreMsn(items, stats, concurrency = 6) {
  const targets = items.filter((it) => /(^|\.)msn\.com$/.test(hostOf(it.url)));
  stats.msn = { found: targets.length, restored: 0, failed: 0 };
  let i = 0;
  async function worker() {
    while (i < targets.length) {
      const it = targets[i]; i += 1;
      const m = it.url.match(/\/ar-([A-Za-z0-9]+)/) || it.url.match(/\/(AA[A-Za-z0-9]+)/);
      if (!m) { stats.msn.failed += 1; continue; }
      const id = m[1];
      const r = await fetchText(`https://assets.msn.com/content/view/v2/Detail/ko-kr/${id}`, { Accept: 'application/json' }, 15000);
      if (!r.ok) { stats.msn.failed += 1; continue; }
      try {
        const j = JSON.parse(r.text);
        if (j.sourceHref && /^https?:/.test(j.sourceHref) && !/msn\.com/.test(hostOf(j.sourceHref))) {
          it.url = j.sourceHref; it.press = (j.provider && j.provider.name) || it.press; stats.msn.restored += 1;
        } else stats.msn.failed += 1;
      } catch { stats.msn.failed += 1; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

export function buildQueries(sectorConfig) {
  const q = []; // {text, hint[], pages}
  const group = sectorConfig.group || {};
  const add = (text, hint, pages = 1) => { const t = String(text || '').trim(); if (t && !q.some((x) => x.text === t)) q.push({ text: t, hint, pages }); };
  for (const [i, k] of (group.keywords_ko || []).entries()) add(k, ['group'], i < 8 ? 2 : 1);
  for (const s of sectorConfig.sectors || []) {
    for (const c of s.companies || []) add(c, [s.id], 2);
    for (const k of s.keywords_ko || []) add(k, [s.id], 1);
  }
  add('금융 연체율', ['group'], 2); add('금융권 해킹 정보유출', ['group']); add('금융사 제재 금감원', ['group'], 2); add('금융당국 가계부채 대책', ['group']);
  add('코스피 환율 금융시장', ['group']); add('미국 국채금리 연준', ['group']); add('부동산 PF 부실', ['group'], 2);
  return q;
}

export async function collectFeedCandidates({ sectorConfig, now = new Date(), maxAgeDays = 4, maxKeep = 170, log = console.log, concurrency = 3 } = {}) {
  const queries = buildQueries(sectorConfig);
  const stats = { queries: queries.length, naverOk: 0, naverFail: 0, bingOk: 0, bingFail: 0, raw: 0 };
  const raw = [];
  // 네이버: 동시 요청 시 차단되므로 순차 + 간격. 실패하면 3초 후 1회 재시도.
  async function naverLoop() {
    for (const q of queries) {
      for (let p = 0; p < q.pages; p += 1) {
        const nUrl = `https://search.naver.com/search.naver?where=news&query=${encodeURIComponent(q.text)}&sort=1&start=${p * 10 + 1}`;
        let r = await fetchText(nUrl);
        if (!r.ok) { await sleep(3000); r = await fetchText(nUrl); }
        if (r.ok) {
          const items = parseNaver(r.text, now); stats.naverOk += 1;
          items.forEach((x) => raw.push({ ...x, hint: q.hint, query: q.text, via: 'naver' }));
          if (items.length < 5) break;
        } else { stats.naverFail += 1; break; }
        await sleep(1100);
      }
    }
  }
  // Bing News RSS: 원문 URL 복원, 병렬 3
  async function bingLoop() {
    let cursor = 0;
    async function worker() {
      while (cursor < queries.length) {
        const q = queries[cursor]; cursor += 1;
        const bUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(q.text)}&format=rss&setmkt=ko-KR&qft=${encodeURIComponent('interval="7"')}`;
        const b = await fetchText(bUrl);
        if (b.ok) { stats.bingOk += 1; parseBing(b.text).forEach((x) => raw.push({ ...x, hint: q.hint, query: q.text, via: 'bing' })); } else stats.bingFail += 1;
        await sleep(250);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }
  // 언론사 RSS: 병렬. 금융 관련성(FIN)+리스크 키워드(RISK)가 있는 기사만 남기고, 업권 힌트는 키워드 적중으로 정한다.
  const termSets = [['group', (sectorConfig.group?.keywords_ko || [])], ...(sectorConfig.sectors || []).map((s) => [s.id, [...(s.companies || []), ...(s.keywords_ko || [])]])]
    .map(([id, terms]) => [id, terms.filter((t) => String(t).length >= 2)]);
  async function rssLoop() {
    stats.rssOk = 0; stats.rssFail = 0; stats.rssItems = 0; stats.rssRelevant = 0;
    let k = 0;
    async function worker() {
      while (k < RSS_FEEDS.length) {
        const [press, url] = RSS_FEEDS[k]; k += 1;
        const r = await fetchText(url, { Accept: 'application/rss+xml,text/xml,*/*' }, 20000);
        if (!r.ok) { stats.rssFail += 1; continue; }
        stats.rssOk += 1;
        for (const x of parseRss(r.text, press)) {
          stats.rssItems += 1;
          const text = `${x.title} ${x.snippet}`;
          if (!(FIN.test(x.title) || FIN.test(text)) || !(RISK.test(x.title) || RISK.test(text))) continue;
          const hint = termSets.filter(([, terms]) => terms.some((t) => text.includes(t))).map(([id]) => id);
          stats.rssRelevant += 1;
          raw.push({ ...x, hint: hint.length ? hint : ['group'], query: 'rss', via: 'rss' });
        }
      }
    }
    await Promise.all(Array.from({ length: 6 }, () => worker()));
  }
  await Promise.all([naverLoop(), bingLoop(), rssLoop()]);
  await restoreMsn(raw, stats);
  stats.raw = raw.length;

  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  const seenUrl = new Map(); const kept = [];
  const stripUrl = (u) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname}${x.search}`.replace(/\/$/, '').toLowerCase(); } catch { return u; } };
  for (const it of raw) {
    if (!it.title || it.title.length < 8) continue;
    const host = hostOf(it.url);
    if (!host || BLOCK_HOST.test(host)) continue;
    if (!it.published || Number.isNaN(it.published.getTime()) || it.published.getTime() < cutoff || it.published.getTime() > now.getTime() + 3_600_000) continue;
    if (PROMO.test(it.title) || OPINION.test(it.title) || NOISE.test(it.title)) continue;
    const key = stripUrl(it.url);
    const prev = seenUrl.get(key);
    if (prev) { prev.hits += 1; prev.hint = [...new Set([...prev.hint, ...it.hint])]; if (!prev.snippet && it.snippet) prev.snippet = it.snippet; continue; }
    const rec = { ...it, hits: 1, bg: bigrams(it.title) };
    seenUrl.set(key, rec); kept.push(rec);
  }
  // 제목 유사 중복 제거 (같은 보도자료 재전송 기사)
  kept.sort((a, b) => b.published - a.published);
  const uniq = [];
  for (const it of kept) { if (uniq.some((u) => jaccard(u.bg, it.bg) >= 0.62)) continue; uniq.push(it); }
  // 리스크 관련도 사전 점수 → 상위 maxKeep 건만 LLM 채점으로 보낸다
  const scoreOf = (it) => {
    const t = `${it.title} ${it.snippet}`;
    let s = 0;
    if (RISK.test(it.title)) s += 3; else if (RISK.test(t)) s += 1;
    s += Math.min(3, it.hits - 1);
    if (/우리금융|우리은행|우리카드|우리금융캐피탈|우리투자증권|우리자산운용|우리금융저축|동양생명|ABL생명/.test(t)) s += 2;
    const ageH = (now.getTime() - it.published.getTime()) / 3_600_000; if (ageH <= 36) s += 1;
    if (it.via === 'rss' && /(^|\.)(yna|mk|sedaily|newsis|einfomax|asiae)\./.test(hostOf(it.url))) s += 1;
    return s;
  };
  uniq.forEach((it) => { it.pre = scoreOf(it); });
  uniq.sort((a, b) => (b.pre - a.pre) || (b.published - a.published));
  // 업권 균형: 각 힌트 업권별 최소 보장 후 나머지는 점수순
  const out = []; const take = new Set();
  const perHint = Math.floor(maxKeep / 6);
  for (const h of ['bank', 'card_capital', 'insurance', 'securities_am', 'group']) {
    let n = 0; for (const it of uniq) { if (n >= perHint) break; if (it.hint.includes(h) && !take.has(it) && it.pre >= 1) { take.add(it); out.push(it); n += 1; } }
  }
  for (const it of uniq) { if (out.length >= maxKeep) break; if (!take.has(it) && it.pre >= 1) { take.add(it); out.push(it); } }
  stats.afterFilter = uniq.length; stats.sent = out.length;
  log(`Feed collector: ${stats.queries} queries (naver ok ${stats.naverOk}/fail ${stats.naverFail}, bing ok ${stats.bingOk}/fail ${stats.bingFail}), rss ${stats.rssOk}/${RSS_FEEDS.length} feeds (${stats.rssItems} items, ${stats.rssRelevant} relevant), msn restored ${stats.msn.restored}/${stats.msn.found} → raw ${stats.raw} → filtered ${stats.afterFilter} → candidates ${stats.sent}.`);
  return {
    stats,
    sources: out.map((it) => ({
      url: it.url, title: it.title, published: kstString(it.published), excerpt: it.snippet ? `${it.press ? `[${it.press}] ` : ''}${it.snippet}`.slice(0, 500) : '',
      hint: it.hint, via: it.via
    }))
  };
}
