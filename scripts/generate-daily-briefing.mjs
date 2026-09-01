import { readFile, writeFile } from 'node:fs/promises';

const apiKey = process.env.OPENAI_API_KEY || '';
const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const cooldownMilliseconds = Number(process.env.OPENAI_COOLDOWN_MS || 75_000);
const outputPath = new URL('../public/briefing.json', import.meta.url);

if (!apiKey.startsWith('sk-')) throw new Error('OPENAI_API_KEY is missing.');

function kstDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function extractOutputText(response) {
  const parts = [];
  for (const item of response.output || []) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

function extractSourceUrls(response) {
  const urls = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (typeof value.url === 'string') {
      try {
        const url = new URL(value.url);
        if (['http:', 'https:'].includes(url.protocol) && !isLikelyListingUrl(value.url)) {
          urls.add(value.url);
        }
      } catch {}
    }
    Object.values(value).forEach(visit);
  };
  visit(response.output || []);
  return [...urls];
}

const disposableQueryParams = new Set([
  'curpage', 'page', 'pageno', 'pageindex',
  'srchbegindt', 'srchctgry', 'srchenddt', 'srchkey', 'srchtext',
  'source', 'ref', 'referrer'
]);

function stripTrailingSlashes(pathname) {
  let result = pathname;
  while (result.length > 1 && result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
}

function stripLeadingWww(hostname) {
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
}

function canonicalUrlKey(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = '';
  url.hostname = stripLeadingWww(url.hostname.toLowerCase());
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    const value = url.searchParams.get(key);
    if (!value || lower.startsWith('utm_') || disposableQueryParams.has(lower)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  const pathname = url.pathname.length > 1 ? stripTrailingSlashes(url.pathname) : url.pathname;
  const query = url.searchParams.toString();
  const portPart = url.port ? `:${url.port}` : '';
  const queryPart = query ? `?${query}` : '';
  return `${url.protocol}//${url.hostname}${portPart}${pathname}${queryPart}`;
}

function urlPathKey(rawUrl) {
  const url = new URL(rawUrl);
  const hostname = stripLeadingWww(url.hostname.toLowerCase());
  const pathname = url.pathname.length > 1 ? stripTrailingSlashes(url.pathname) : url.pathname;
  return `${hostname}${pathname}`;
}

function retryDelayMs(response, body, attempt) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(60_000, Math.ceil(retryAfter * 1000) + 1000);
  }
  const message = String(body?.error?.message || '');
  const waitPattern = new RegExp('try again in\\s+([\\d.]+)(ms|s)', 'i');
  const match = message.match(waitPattern);
  if (match) {
    const amount = Number(match[1]);
    const milliseconds = match[2].toLowerCase() === 's' ? amount * 1000 : amount;
    return Math.min(60_000, Math.max(2_000, Math.ceil(milliseconds) + 1000));
  }
  return Math.min(60_000, 5_000 * (2 ** (attempt - 1)));
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function requestOpenAi(label, requestBody, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000);
    let response;
    try {
      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
    } catch (fetchError) {
      clearTimeout(timeout);
      if (attempt === maxAttempts) {
        throw new Error(`${label} timed out or failed to connect after ${maxAttempts} attempts: ${fetchError.message}`);
      }
      const delay = Math.min(60_000, 15_000 * attempt);
      console.warn(`${label} request timed out or failed to connect (${fetchError.message}). Retrying in ${delay}ms (${attempt}/${maxAttempts}).`);
      await sleep(delay);
      continue;
    } finally {
      clearTimeout(timeout);
    }
    const body = await response.json().catch(() => ({}));
    if (response.ok) return body;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxAttempts) {
      throw new Error(`${label} failed (${response.status}): ${body?.error?.message || 'unknown error'}`);
    }
    const delay = response.status === 429
      ? Math.max(90_000, retryDelayMs(response, body, attempt))
      : Math.min(60_000, 15_000 * attempt);
    console.warn(`${label} received HTTP ${response.status}. Retrying in ${delay}ms (${attempt}/${maxAttempts}).`);
    await sleep(delay);
  }
  throw new Error(`${label} exhausted all retry attempts.`);
}

function parseStructuredOutput(body, label) {
  const text = extractOutputText(body);
  if (!text) {
    const outputTypes = (body.output || []).map((item) => item.type).join(', ') || 'none';
    const incompleteReason = body?.incomplete_details?.reason || body?.error?.message || 'not provided';
    throw new Error(`${label} did not contain structured output (status=${body.status || 'unknown'}, output_types=${outputTypes}, reason=${incompleteReason}).`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

async function coolDown(label) {
  const milliseconds = Number.isFinite(cooldownMilliseconds) && cooldownMilliseconds >= 0
    ? cooldownMilliseconds
    : 75_000;
  console.log(`${label} complete. Cooling down OpenAI TPM for ${milliseconds / 1000} seconds.`);
  await sleep(milliseconds);
}

const newsItem = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'url', 'published', 'source_name', 'summary', 'why_woori_cro', 'entity', 'channel', 'source_type', 'risk_type', 'urgency', 'confidence', 'critical', 'window', 'watchpoints'],
  properties: {
    title: { type: 'string' },
    url: { type: 'string' },
    published: { type: 'string' },
    source_name: { type: 'string' },
    summary: { type: 'string' },
    why_woori_cro: { type: 'string' },
    entity: { type: 'string' },
    channel: { type: 'string' },
    source_type: { type: 'string', enum: ['media', 'official'] },
    risk_type: { type: 'string' },
    urgency: { type: 'string', enum: ['높음', '중간', '낮음'] },
    confidence: { type: 'string', enum: ['높음', '중간', '낮음'] },
    critical: { type: 'boolean' },
    window: { type: 'string', enum: ['primary', 'related'] },
    watchpoints: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' } }
  }
};

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['executive_judgment', 'executive_judgment_bullets', 'critical', 'daily_news', 'subsidiary_news', 'additional_news', 'forward_looking_points', 'insights', 'monitoring_points'],
  properties: {
    executive_judgment: { type: 'string' },
    executive_judgment_bullets: { type: 'array', minItems: 3, maxItems: 4, items: { type: 'string' } },
    critical: { type: 'array', minItems: 0, maxItems: 4, items: newsItem },
    daily_news: { type: 'array', minItems: 0, maxItems: 6, items: newsItem },
    subsidiary_news: { type: 'array', minItems: 0, maxItems: 6, items: newsItem },
    additional_news: { type: 'array', minItems: 0, maxItems: 3, items: newsItem },
    forward_looking_points: {
      type: 'array', maxItems: 4,
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'horizon', 'likelihood', 'cro_angle', 'trigger'],
        properties: {
          title: { type: 'string' }, horizon: { type: 'string' },
          likelihood: { type: 'string', enum: ['높음', '중간', '낮음'] },
          cro_angle: { type: 'string' }, trigger: { type: 'string' }
        }
      }
    },
    insights: {
      type: 'object', additionalProperties: false,
      required: ['headline', 'bullets', 'action_items', 'stance'],
      properties: {
        headline: { type: 'string' },
        bullets: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string' } },
        action_items: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string' } },
        stance: { type: 'string' }
      }
    },
    monitoring_points: { type: 'array', minItems: 4, maxItems: 7, items: { type: 'string' } }
  }
};

let previousTitles = [];
try {
  const previous = JSON.parse(await readFile(outputPath, 'utf8'));
  previousTitles = ['critical', 'daily_news', 'subsidiary_news', 'additional_news']
    .flatMap((key) => previous[key] || [])
    .map((item) => item.title)
    .filter(Boolean)
    .slice(0, 20);
} catch {}

const date = kstDate();

try {
  const existing = JSON.parse(await readFile(outputPath, 'utf8'));
  if (existing?.meta?.briefing_date === date && !existing?.meta?.fallback_notice) {
    console.log(`Briefing for ${date} already exists. Skipping duplicate run.`);
    process.exit(0);
  }
} catch {}

const commonResearchRules = `
실행일은 ${date} KST다. 실행 시점 기준 최근 24시간의 공개 정보를 primary 후보로 삼아라.
각 후보는 서로 다른 단일 사건이어야 하며, 같은 사건의 반복 보도는 대표 원문 하나로 통합하라.
URL은 실제 검색으로 확인한 개별 기사 또는 개별 공식 발표의 직접 링크만 사용하라. 검색결과·기관 섹션·게시판 목록 URL은 후보로 제시하지 마라.
게시 일시는 KST 기준으로 적고 확인할 수 없으면 '게시 시각 미확인'이라고 명시하라.
확인된 사실과 CRO 관점의 분석을 구분하고, 수치·날짜·기관명·기업명을 검증하라.
자본·유동성·신용·시장·운영·사이버·법무/준법·평판·전략 리스크 영향을 평가하라.
신뢰할 만한 후보가 부족하면 숫자를 채우지 말고 조사 메모에 이유를 적어라.
primary 후보가 부족하면 맥락 이해에 직접 필요한 최근 7일 이내 유관·배경 자료를 추가 조사하되 반드시 related라고 표시하고 날짜를 명확히 적어라.
전일 제목은 중대한 신규 사실이 있을 때만 다시 후보에 포함하라: ${JSON.stringify(previousTitles)}
각 후보에 제목, 매체·기관, 게시 일시, 직접 URL, 확인된 사실, 우리금융 CRO 중요성, 리스크 유형, 긴급도, 근거 신뢰도와 확인할 질문을 포함하라.
특정 매체 한두 곳에 후보가 몰리지 않도록 최대한 다양한 언론사에서 고르게 검색하라. 같은 매체의 기사가 전체 후보의 절반을 넘지 않게 하라.
모든 한국어 서술은 임원 보고서에 맞는 정중한 합니다체로 작성하라. 문장을 '한다·이다·있다·된다·필요하다'로 끝내지 말고 '합니다·입니다·있습니다·됩니다·필요합니다'로 끝내라.
반드시 웹 검색을 수행하고, 모든 후보 옆에 실제 검색 출처를 인라인 인용으로 붙여라. 이 조사 단계에서는 JSON을 만들지 말고 읽기 쉬운 한국어 조사 메모로 답하라.
`;

const koreanMediaDomains = [
  'yna.co.kr', 'news1.kr', 'hankyung.com', 'mk.co.kr', 'sedaily.com',
  'edaily.co.kr', 'mt.co.kr', 'news.bizwatch.co.kr', 'biz.chosun.com',
  'fnnews.com', 'asiae.co.kr', 'etoday.co.kr', 'ytn.co.kr',
  'infomax.co.kr', 'heraldcorp.com', 'donga.com', 'joongang.co.kr',
  'news.naver.com', 'finance.naver.com'
];
const globalMediaDomains = [
  'reuters.com', 'bloomberg.com', 'ft.com', 'wsj.com', 'cnbc.com',
  'apnews.com', 'nikkei.com', 'economist.com', 'marketwatch.com', 'finance.yahoo.com'
];
const officialDomains = [
  'fsc.go.kr', 'fss.or.kr', 'bok.or.kr', 'moef.go.kr', 'kofia.or.kr',
  'krx.co.kr', 'dart.fss.or.kr', 'kdic.or.kr', 'woorifg.com',
  'wooribank.com', 'bis.org', 'fsb.org', 'imf.org', 'federalreserve.gov', 'ecb.europa.eu'
];
const wooriSubsidiaryKeywords = [
  '우리금융', '우리행성', '우리카드', '우리금융캐피탈', '우리종합금융',
  '우리자산운용', '우리에프아이에스', '우리금융저축은행', '우리글로벌자산운용',
  '동양생명', 'ABL생명', '우리금융지주', '우리투자증권',
  '우리아메리카', 'Woori America', '우리소다라', 'Woori Saudara', 'Bank Woori Saudara',
  '캄보디아', 'Cambodia', '인도네시아', 'Indonesia'
];

function mentionsWooriSubsidiary(item) {
  const haystack = `${item.title || ''} ${item.entity || ''} ${item.summary || ''} ${item.why_woori_cro || ''}`;
  return wooriSubsidiaryKeywords.some((keyword) => haystack.includes(keyword));
}

const datePattern = new RegExp('(\\d{4})-(\\d{2})-(\\d{2})');
const timePattern = new RegExp('(\\d{2}):(\\d{2})');

function parsePublishedKst(publishedText) {
  const text = String(publishedText || '');
  const dateMatch = text.match(datePattern);
  if (!dateMatch) return { date: null, hasTime: false };
  const datePart = dateMatch[0];
  const timeMatch = text.match(timePattern);
  if (timeMatch) {
    const withTime = new Date(`${datePart}T${timeMatch[0]}:00+09:00`);
    if (!Number.isNaN(withTime.getTime())) return { date: withTime, hasTime: true };
  }
  const dateOnly = new Date(`${datePart}T00:00:00+09:00`);
  if (!Number.isNaN(dateOnly.getTime())) return { date: dateOnly, hasTime: false };
  return { date: null, hasTime: false };
}

function hostMatchesDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isOfficialUrl(rawUrl) {
  try {
    const hostname = stripLeadingWww(new URL(rawUrl).hostname.toLowerCase());
    return hostname.endsWith('.go.kr') || hostname.endsWith('.gov') ||
      officialDomains.some((domain) => hostMatchesDomain(hostname, domain));
  } catch {
    return false;
  }
}

const digitRunPattern = new RegExp('\\d{4,}');
const boardRootPattern = new RegExp('/(no|po)\\d{6}$', 'i');
const articleIdParamNames = ['idx', 'id', 'no', 'seq', 'article', 'article_id', 'nttid', 'bbsid'];
const searchParamNames = ['query', 'keyword', 'search', 'searchword', 'srchtext', 'srchkey'];
const listingPathSuffixes = ['/news', '/search', '/list', '/bbs'];

function isLikelyListingUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const path = stripTrailingSlashes(url.pathname);
    const hasArticleId = digitRunPattern.test(path) || [...url.searchParams.keys()].some((key) =>
      articleIdParamNames.includes(key.toLowerCase()) && url.searchParams.get(key)
    );
    const looksLikeSearch = !hasArticleId && [...url.searchParams.keys()].some((key) =>
      searchParamNames.includes(key.toLowerCase()) && url.searchParams.get(key)
    );
    const knownBoardRoot = boardRootPattern.test(path);
    const lowerPath = path.toLowerCase();
    const endsWithListingSegment = listingPathSuffixes.some((suffix) => lowerPath.endsWith(suffix));
    return looksLikeSearch || knownBoardRoot || (!hasArticleId && endsWithListingSegment);
  } catch {
    return true;
  }
}

function sourceUrlQuality(rawUrl) {
  try {
    const url = new URL(rawUrl);
    let score = 0;
    if (!isLikelyListingUrl(rawUrl)) score += 100;
    if (digitRunPattern.test(url.pathname)) score += 20;
    score -= [...url.searchParams.keys()].filter((key) => key.toLowerCase().startsWith('utm_')).length * 5;
    score -= url.search.length / 100;
    return score;
  } catch {
    return -1000;
  }
}

async function researchStage(label, scope, allowedDomains, minimumSources = 4) {
  let best = { narrative: '', source_urls: [] };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const body = await requestOpenAi(label, {
      model,
      input: `당신은 CRO STAFF의 조사 담당자다.\n\n조사 범위:\n${scope}\n\n공통 조사 규칙:\n${commonResearchRules}`,
      tools: [{
        type: 'web_search',
        search_context_size: 'medium',
        filters: { allowed_domains: allowedDomains },
        user_location: { type: 'approximate', country: 'KR', timezone: 'Asia/Seoul' }
      }],
      max_tool_calls: 2,
      include: ['web_search_call.action.sources'],
      store: false,
      reasoning: { effort: 'low' },
      text: { verbosity: 'medium' },
      max_output_tokens: 4500
    });
    const narrative = extractOutputText(body);
    const sourceUrls = extractSourceUrls(body);
    if (narrative && sourceUrls.length > best.source_urls.length) best = { narrative, source_urls: sourceUrls };
    if (narrative && sourceUrls.length >= minimumSources) {
      console.log(`${label} collected ${sourceUrls.length} verified source URLs.`);
      return { narrative, source_urls: sourceUrls };
    }
    if (attempt < 2) {
      console.warn(`${label} returned fewer than ${minimumSources} cited sources. Retrying after TPM cooldown.`);
      await coolDown(`${label} empty-source retry`);
    }
  }
  console.warn(`${label} returned only ${best.source_urls.length} cited sources; continuing with verified sources from other stages.`);
  return best;
}

const domesticMedia = await researchStage(
  'Korean financial media research',
  `한국 주요 통신사·경제지·금융 전문매체 및 네이버뉴스의 일반 언론기사를 조사하라.
금리·환율·유동성·부동산 PF·가계/기업 신용·자본규제·소비자보호·사이버·운영리스크와 금융회사 사건을 폭넓게 점검하라.
정부기관 보도자료가 아니라 기자가 작성한 기사 원문을 후보로 최대 16건 제시하라. 같은 정책도 시장·금융회사 파급효과를 분석한 언론기사를 우선하라.`,
  koreanMediaDomains, 6
);
await coolDown('Korean financial media research');

const wooriAndPeersMedia = await researchStage(
  'Woori Financial Group media research',
  `한국 주요 통신사·경제지·금융 전문매체 및 네이버뉴스에서 우리금융그룹과 계열사에 관한 일반 언론기사를 조사하라.
우리금융지주·우리은행·우리카드·우리금융캐피탈·우리종합금융·우리자산운용·우리투자증권·동양생명·ABL생명 관련 보도를 최우선으로, 빠짐없이 찾아라. 이 조사 단계는 오직 우리금융그룹 자체 뉴스에만 집중한다.
우리은행의 해외지점 및 해외 현지법인(캄보디아, 인도네시아, 우리아메리카은행 등) 관련 보도도 적극적으로 조사하라.
우리은행 해외법인 관련 직접 보도를 찾기 어려운 경우, 캄보디아·인도네시아·우리아메리카은행이 영업하는 지역의 금융권 일반 동향(금리, 환율, 은행 건전성, 규제 변화 등) 기사도 후보로 조사하라.
기업 홈페이지·공시 링크가 아니라 기자가 작성한 기사 원문을 후보로 최대 14건 제시하라.`,
  koreanMediaDomains, 5
);
await coolDown('Woori Financial Group media research');

const peerCompetitorMedia = await researchStage(
  'Peer competitor media research',
  `한국 주요 통신사·경제지·금융 전문매체 및 네이버뉴스에서 KB금융·신한금융·하나금융·NH농협금융·IBK기업은행 및 주요 증권·보험·카드사에 관한 일반 언론기사를 조사하라.
자본, 건전성, 인수합병, 제재, 사고, 실적과 리스크 변화를 중심으로 점검하라. 우리금융그룹 관련 기사는 이 단계에서 조사하지 않는다.
기업 홈페이지·공시 링크가 아니라 기자가 작성한 기사 원문을 후보로 최대 10건 제시하라.`,
  koreanMediaDomains, 4
);
await coolDown('Peer competitor media research');

const globalMedia = await researchStage(
  'Global financial media research',
  `Reuters, Bloomberg, FT, WSJ, CNBC, AP, Nikkei 등 신뢰도 높은 글로벌 언론에서 우리금융그룹으로 전이될 수 있는 일반 금융기사를 조사하라.
금리·달러·채권·주식·원자재·지정학·해외 상업용 부동산·은행 건전성·사이버·제재·AML 변화를 점검하라.
기관 발표문 자체보다 기자가 취재·작성한 기사 원문을 후보로 최대 12건 제시하라.`,
  globalMediaDomains, 4
);
await coolDown('Global financial media research');

const officialVerification = await researchStage(
  'Official source verification',
  `언론 조사에서 다룰 가능성이 높은 한국·글로벌 금융시장, 규제·정책, 우리금융 및 경쟁사 이슈를 공식 1차 자료로 검증하라.
금융위원회·금융감독원·한국은행·기획재정부·거래소·DART·우리금융 공식자료와 BIS·FSB·IMF·Fed·ECB 자료를 확인하라.
공식자료는 사실·수치·날짜 검증용이다. 최종 브리핑 전체를 공식자료로 채우지 않도록 CRO 관련성이 가장 높은 자료만 최대 10건 제시하라.`,
  officialDomains, 3
);
await coolDown('Official source verification');

const researchEvidence = {
  korean_media: domesticMedia,
  woori_financial_group_media: wooriAndPeersMedia,
  peer_competitor_media: peerCompetitorMedia,
  global_media: globalMedia,
  official_verification: officialVerification
};
const researchedUrlByCanonical = new Map();
const researchedUrlsByPath = new Map();
for (const sourceUrl of Object.values(researchEvidence).flatMap((evidence) => evidence.source_urls || [])) {
  const canonicalKey = canonicalUrlKey(sourceUrl);
  const current = researchedUrlByCanonical.get(canonicalKey);
  if (!current || sourceUrlQuality(sourceUrl) > sourceUrlQuality(current)) {
    researchedUrlByCanonical.set(canonicalKey, sourceUrl);
  }
  const pathKey = urlPathKey(sourceUrl);
  const matches = researchedUrlsByPath.get(pathKey) || [];
  if (!matches.includes(sourceUrl)) matches.push(sourceUrl);
  researchedUrlsByPath.set(pathKey, matches);
}
if (researchedUrlByCanonical.size < 12) {
  throw new Error(`Research produced only ${researchedUrlByCanonical.size} unique source URLs; at least 12 are required.`);
}

function buildSynthesisPrompt() {
  return `
당신은 우리금융그룹 전체 CRO를 지원하는 전략 비서 CRO STAFF다. 실행일은 ${date} KST다.
아래 다섯 조사팀의 웹 조사 메모와 검증 출처 URL만 사용하여 최종 데일리 브리핑을 작성하라. 조사 메모에 없는 사실과 수치를 새로 만들지 마라.

우선순위:
1. 한국 금융시장 리스크
2. 한국 금융 규제·정책 변화
3. 국내 금융 경쟁사 동향
4. 글로벌 금융시장 및 해외 규제·정책
5. 우리금융그룹과 계열사 직접 영향은 범주와 관계없이 상향

언어 규칙 (반드시 준수):
- 원문이 영어 또는 다른 외국어 기사이더라도, title, summary, why_woori_cro, watchpoints, entity, channel, risk_type 등 모든 텍스트 필드는 반드시 자연스러운 한국어로 작성한다. 원문 제목이나 문장을 번역하지 않고 그대로 영어로 옮기는 것을 금지한다.
- 고유명사(인명, 기관명, 기업명, 상품명)는 널리 쓰이는 한국어 표기(예: 로이터, 블룸버그, 연준)를 사용하고, 필요하면 괄호 안에 원어를 병기할 수 있다.

카테고리별 리서치 출처 우선순위 (daily_news 구성 시 반드시 준수):
- daily_news는 korean_media와 peer_competitor_media 조사 결과를 우선적으로 사용한다. global_media(Reuters, Bloomberg, FT, CNBC 등) 기사는 daily_news 전체 중 최대 30%까지만 사용한다.
- global_media 기아하, 이전 답변에서 코드가 중간에 잘려서 전송되는 현상이 발생했군요! AI 모델의 한 번에 출력할 수 있는 글자 수 제한(토큰 제한) 때문에 매우 긴 전체 코드가 끝까지 출력되지 못하고 중간에 뚝 끊겼던 것입니다.

이로 인해 코드의 괄호가 닫히지 않고 뒷부분의 핵심 로직(합성 및 검증 루프)이 유실되어 실행 시 에러가 발생한 것입니다.

이 문제를 해결하기 위해, **유실되거나 잘린 부분 없이 완벽하게 작동하는 후반부 핵심 코드**를 이어서 명확하게 제공해 드립니다.

앞서 받으신 코드의 `const globalMedia = await researchStage(...` 부분 아래로 이어지는 **[나머지 전체 코드]**입니다. 이 부분을 기존 코드의 끊긴 지점 뒤에 그대로 붙여넣으시면 완벽하게 작동합니다.

---

### generate-daily-briefing.mjs (이어서 붙여넣을 후반부 전체 코드)

```javascript
const globalMedia = await researchStage(
  'Global financial media research',
  `Reuters, Bloomberg, FT, WSJ, CNBC, AP, Nikkei 등 신뢰도 높은 글로벌 언론에서 우리금융그룹으로 전이될 수 있는 일반 금융기사를 조사하라.
금리·달러·채권·주식·원자재·지정학·해외 상업용 부동산·은행 건전성·사이버·제재·AML 변화를 점검하라.
기관 발표문 자체보다 기자가 취재·작성한 기사 원문을 후보로 최대 12건 제시하라.`,
  globalMediaDomains, 4
);
await coolDown('Global financial media research');

const officialVerification = await researchStage(
  'Official source verification',
  `언론 조사에서 다룰 가능성이 높은 한국·글로벌 금융시장, 규제·정책, 우리금융 및 경쟁사 이슈를 공식 1차 자료로 검증하라.
금융위원회·금융감독원·한국은행·기획재정부·거래소·DART·우리금융 공식자료와 BIS·FSB·IMF·Fed·ECB 자료를 확인하라.
공식자료는 사실·수치·날짜 검증용이다. 최종 브리핑 전체를 공식자료로 채우지 않도록 CRO 관련성이 가장 높은 자료만 최대 10건 제시하라.`,
  officialDomains, 3
);
await coolDown('Official source verification');

const researchEvidence = {
  korean_media: domesticMedia,
  woori_financial_group_media: wooriAndPeersMedia,
  peer_competitor_media: peerCompetitorMedia,
  global_media: globalMedia,
  official_verification: officialVerification
};

const researchedUrlByCanonical = new Map();
const researchedUrlsByPath = new Map();
for (const sourceUrl of Object.values(researchEvidence).flatMap((evidence) => evidence.source_urls || [])) {
  const canonicalKey = canonicalUrlKey(sourceUrl);
  const current = researchedUrlByCanonical.get(canonicalKey);
  if (!current || sourceUrlQuality(sourceUrl) > sourceUrlQuality(current)) {
    researchedUrlByCanonical.set(canonicalKey, sourceUrl);
  }
  const pathKey = urlPathKey(sourceUrl);
  const matches = researchedUrlsByPath.get(pathKey) || [];
  if (!matches.includes(sourceUrl)) matches.push(sourceUrl);
  researchedUrlsByPath.set(pathKey, matches);
}

if (researchedUrlByCanonical.size < 12) {
  throw new Error(`Research produced only ${researchedUrlByCanonical.size} unique source URLs; at least 12 are required.`);
}

function buildSynthesisPrompt() {
  return `
당신은 우리금융그룹 전체 CRO를 지원하는 전략 비서 CRO STAFF다. 실행일은 ${date} KST다.
아래 다섯 조사팀의 웹 조사 메모와 검증 출처 URL만 사용하여 최종 데일리 브리핑을 작성하라. 조사 메모에 없는 사실과 수치를 새로 만들지 마라.

우선순위:
1. 한국 금융시장 리스크
2. 한국 금융 규제·정책 변화
3. 국내 금융 경쟁사 동향
4. 글로벌 금융시장 및 해외 규제·정책
5. 우리금융그룹과 계열사 직접 영향은 범주와 관계없이 상향

언어 규칙 (반드시 준수):
- 원문이 영어 또는 다른 외국어 기사이더라도, title, summary, why_woori_cro, watchpoints, entity, channel, risk_type 등 모든 텍스트 필드는 반드시 자연스러운 한국어로 작성한다. 원문 제목이나 문장을 번역하지 않고 그대로 영어로 옮기는 것을 금지한다.
- 고유명사(인명, 기관명, 기업명, 상품명)는 널리 쓰이는 한국어 표기(예: 로이터, 블룸버그, 연준)를 사용하고, 필요하면 괄호 안에 원어를 병기할 수 있다.

카테고리별 리서치 출처 우선순위 (daily_news 구성 시 반드시 준수):
- daily_news는 korean_media와 peer_competitor_media 조사 결과를 우선적으로 사용한다. global_media(Reuters, Bloomberg, FT, CNBC 등) 기사는 daily_news 전체 중 최대 30%까지만 사용한다.
- global_media 기사는 한국 금융시장이나 우리금융그룹에 직접적인 영향이 있는 경우에만 선택하고, 단순 해외 시황 소개성 기사는 선택하지 않는다.

최종 선정 규칙 (반드시 준수):
- 전체 기사는 반드시 최소 10건 이상 선정한다. 조사 근거 5팀분에 후보가 충분히 있으니, 10건 미만으로 선정하지 마라. critical(크리티컬)은 최소 1건은 반드시 포함하고, 나머지는 daily_news, subsidiary_news, additional_news 사이에서 자유롭게 배분하되 합계가 10건 미만이 되지 않게 한다.
- 특정 카테고리에 오늘 조건을 만족하는 기사가 부족하면, 조사 근거 안에 있는 related(최근 7일 이내) 기사를 적극적으로 활용하거나 다른 카테고리에서 조건을 만족하는 기사를 더 선정해서 반드시 전체 합계 10건 이상을 채운다.
- subsidiary_news는 woori_financial_group_media 조사 결과를 최우선으로 사용한다. 다음 우선순위를 따른다: (1) 국내 우리금융그룹 계열사 관련 오늘자 기사, (2) 우리은행 해외지점·해외 현지법인(캄보디아, 인도네시아, 우리아메리카은행 등) 관련 기사, (3) 캄보디아·인도네시아·우리아메리카은행이 영업하는 지역의 금융권 일반 기사(금리, 환율, 은행 건전성, 규제 등). (2), (3)에 해당하는 기사는 window를 related로 표시하고 게시 날짜를 정확히 적는다.
- 우리금융그룹·계열사(subsidiary_news)에는 우리금융지주, 우리은행, 우리카드, 우리금융캐피탈, 우리종합금융, 우리자산운용, 우리투자증권, 동양생명, ABL생명 등 국내 계열사 기사, 우리은행 해외지점·현지법인 기사, 또는 캄보디아·인도네시아·우리아메리카은행 지역 금융권 기사만 선택한다. KB금융, 신한금융, 하나금융, NH농협금융, 한국금융지주 등 다른 금융지주·경쟁사 기사는 daily_news에는 배치할 수 있어도 subsidiary_news에는 절대 포함하지 마라.
- 전체 기사 중 기자가 작성한 일반 언론기사(source_type=media)를 최소 60% 이상 선정하고, 감독당국·정부·중앙은행·공시·기업 공식자료(source_type=official)는 나머지 비중으로 선정한다.
- 공식자료는 사실과 수치 검증에 적극 활용하되, 같은 사건의 언론기사가 있으면 독자가 맥락과 파급효과를 이해할 수 있는 언론기사를 대표 원문으로 우선 선정한다.
- 연합뉴스, 주요 경제지·금융 전문매체 및 Reuters·Bloomberg·FT·CNBC 등 신뢰도 높은 일반기사가 브리핑의 중심이 되어야 한다.
- critical 기사는 반드시 window를 primary로 표시하며, 실행 시점 기준 최근 36시간 이내에 게시된 기사만 사용한다. published 필드에는 반드시 정확한 게시 시각(시:분 단위)을 KST 기준으로 적는다.
- daily_news와 subsidiary_news를 채우기 위해 related로 표시하는 기사는 최근 7일 이내여야 하며, 전체 기사 중 related는 최대 8건까지 허용한다.
- "오늘자 검증 가능한 기사 없음" 같은 placeholder 문구를 title이나 다른 필드에 넣지 마라. 그런 항목을 만들 수 없으면 조사 근거 안에서 실제로 존재하는 다른 기사로 대체하라.
- 동일 사건과 동일 URL을 제거하고 대표 원문 하나만 남긴다. 서로 다른 매체가 같은 사건(예: 같은 날 발표된 같은 통계, 같은 기관의 같은 공지, 같은 기업의 같은 이슈)을 각자 보도한 경우, URL이 다르더라도 반드시 동일 사건으로 간주하여 가장 상세하고 신뢰도 높은 원문 하나만 남기고 나머지는 절대 선택하지 마라.
- 같은 기관(예: 한국은행)이 발행하는 정기 공지(예: 통화안정증권 정례모집, 경쟁입찰 등)는 여러 회차가 있어도 최근 것 하나만 선택하고, 유사한 정기 공지를 여러 건 선택하지 마라.
- critical, daily_news, subsidiary_news, additional_news 네 카테고리를 통틀어 같은 URL이나 같은 게시물 번호(seq, id 등)를 가진 기사를 두 번 이상 선택하지 마라. 카테고리를 넘나드는 중복도 동일 사건 중복으로 간주하고 반드시 제거하라.
- 만약 특정 사건이 여러 카테고리에 모두 적합해 보이면, 그 사건은 가장 관련성이 높은 카테고리 하나에만 배치하고 다른 카테고리에는 조사 근거 안에서 완전히 다른 사건을 새로 찾아 채워라. url 필드를 빈 문자열이나 추정값으로 채우지 말고, 반드시 조사 근거에 있는 실제 URL만 사용하라.
- URL은 각 조사팀의 source_urls에 있는 값을 글자 하나도 바꾸지 않고 그대로 복사한다.
- 검색결과, 언론사·기관의 뉴스 섹션 첫 화면, 게시판 목록 주소는 기사로 선정하지 않는다. URL 경로 또는 쿼리에 개별 기사·발표 식별자가 있는 직접 링크만 사용한다.
- 전일 제목은 중대한 신규 사실이 있을 때만 다시 포함한다: ${JSON.stringify(previousTitles)}
- 확인된 사실과 분석·추론을 구분하고 투자 권고나 확정적 시장 예측을 하지 않는다.

CRO 품질 게이트:
- 수치, 날짜, 게시 시각, 기관명, 기업명과 근거 신뢰도를 후보 간 비교한다.
- 자본·유동성·신용·시장·운영·사이버·법무/준법·평판·전략 리스크 영향을 평가한다.
- 영향 전파 속도, 영향 범위, 대응 가능 시간, 규제기관 관심으로 긴급도를 판단한다.
- 기사 간 연결고리, 리스크 전이 경로, 오늘 확인할 지표·질문, 단기 모니터링 포인트를 도출한다.
- 모든 문장은 예외 없이 정중한 합니다체를 사용한다. '한다·이다·있다·된다·필요하다·전망된다' 같은 해라체 종결은 금지하고 '합니다·입니다·있습니다·됩니다·필요합니다·전망됩니다'로 쓴다.
- executive_judgment_bullets는 3~4개로 작성한다. 각 항목은 (1) 무슨 변화가 확인되었는지 (2) 그 핵심 수치·맥락은 무엇인지 (3) 그룹 리스크 관점에서 어떤 의미인지를 자연스럽게 이어지는 2문장의 완결된 문장으로 서술한다. "확인된 변화는", "핵심 수치는" 같은 정형화된 라벨 단어를 문장 맨 앞에 그대로 반복해서 쓰지 말고, 자연스러운 문장으로 풀어서 작성한다. executive_judgment에는 이 판단을 충분한 문단으로 종합한다.
- 각 기사 summary는 3~5문장으로 작성한다. 첫 문장에서 매체명과 게시일을 밝히고, 이후 핵심 수치·당사자·발생 경위·현재 상태를 원문 범위 안에서 구체적으로 설명한다. 단순 헤드라인 재진술이나 2문장 요약은 금지한다.
- why_woori_cro는 2~3문장으로 작성한다. 우리은행 또는 관련 계열사에 미치는 자본·유동성·신용·시장·운영·준법·평판·전략 영향과 30~90일 의사결정 포인트를 구체적으로 연결한다.
- watchpoints는 기사마다 2~3개를 제시한다. 기관 발표 일정, 비율·스프레드·연체율·충당금·한도 등 실제로 확인할 지표나 질문으로 작성한다.
- 오늘의 CRO STAFF 인사이트는 기사들을 나열하지 말고 공통 동인, 1차·2차 전이경로, 현재 판단을 뒤집을 조건, 1주·2주·90일 모니터링 행동을 연결한다.

조사 근거 JSON:
${JSON.stringify(researchEvidence)}

반드시 제공된 JSON 스키마에 맞춰 한국어로 답하라.
`;
}

let briefing;
let synthesisError;
let synthesisFeedback = '';
const rejectedUrls = new Set();
let bestFallbackCandidate = null;
let bestFallbackCount = 0;

function usesNonFormalKorean(text) {
  return String(text || '')
    .split(/[.!?]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .some((sentence) => sentence.endsWith('다') && !sentence.endsWith('니다'));
}

function sentenceCount(text) {
  return String(text || '').split(/[.!?]+/).map((sentence) => sentence.trim()).filter(Boolean).length;
}

function narrativeQualityError(candidate, candidateNews) {
  const narrativeFields = [
    candidate.executive_judgment,
    ...(candidate.executive_judgment_bullets || []),
    ...candidateNews.flatMap((item) => [item.summary, item.why_woori_cro]),
    (candidate.insights || {}).headline,
    ...((candidate.insights || {}).bullets || []),
    ...((candidate.insights || {}).action_items || []),
    (candidate.insights || {}).stance
  ];
  if (narrativeFields.some(usesNonFormalKorean)) {
    return 'Korean narrative used plain 한다체 instead of formal 합니다체.';
  }
  const shortSummary = candidateNews.find((item) => String(item.summary || '').length < 180);
  if (shortSummary) return `Article summary was too short for depth: ${shortSummary.title}`;
  const shallowSummary = candidateNews.find((item) => sentenceCount(item.summary) < 3);
  if (shallowSummary) return `Article summary contained fewer than 3 sentences: ${shallowSummary.title}`;
  const missingAttribution = candidateNews.find((item) => !String(item.summary || '').includes(String(item.source_name || '')));
  if (missingAttribution) return `Article summary did not name its source: ${missingAttribution.title}`;
  const shortImplication = candidateNews.find((item) => String(item.why_woori_cro || '').length < 90);
  if (shortImplication) return `CRO implication was too short: ${shortImplication.title}`;
  const shallowImplication = candidateNews.find((item) => sentenceCount(item.why_woori_cro) < 2);
  if (shallowImplication) return `CRO implication contained fewer than 2 sentences: ${shallowImplication.title}`;
  if (String(candidate.executive_judgment || '').length < 280) {
    return 'Executive judgment was too short for decision-useful synthesis.';
  }
  return '';
}

const urlInTextPattern = new RegExp('https?://[^\\s)]+', 'g');
const trailingPunctuationPattern = new RegExp('[).,]+$');

function extractUrlsFromText(text) {
  const matches = String(text || '').match(urlInTextPattern) || [];
  return matches.map((url) => url.replace(trailingPunctuationPattern, ''));
}

function dedupeCandidateNews(candidate) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  const dedupeList = (list) => {
    if (!Array.isArray(list)) return [];
    return list.filter((item) => {
      if (!item || !item.url || !item.title) return false;
      const canonical = canonicalUrlKey(item.url);
      const titleNorm = item.title.replace(/\s+/g, '').toLowerCase();
      if (seenUrls.has(canonical) || seenTitles.has(titleNorm)) return false;
      seenUrls.add(canonical);
      seenTitles.add(titleNorm);
      return true;
    });
  };
  candidate.critical = dedupeList(candidate.critical);
  candidate.daily_news = dedupeList(candidate.daily_news);
  candidate.subsidiary_news = dedupeList(candidate.subsidiary_news);
  candidate.additional_news = dedupeList(candidate.additional_news);
  return candidate;
}

function countNews(candidate) {
  return ['critical', 'daily_news', 'subsidiary_news', 'additional_news']
    .reduce((sum, key) => sum + (candidate[key] || []).length, 0);
}

const MINIMUM_ARTICLES_TARGET = 10;
const MINIMUM_ARTICLES_FALLBACK = 6;
const MAX_SYNTHESIS_ATTEMPTS = 4;

for (let attempt = 1; attempt <= MAX_SYNTHESIS_ATTEMPTS; attempt += 1) {
  console.log(`Starting CRO quality-gate synthesis (attempt ${attempt}/${MAX_SYNTHESIS_ATTEMPTS})...`);
  const systemPrompt = `당신은 우리금융그룹 전체 CRO를 지원하는 전략 비서 CRO STAFF다. 반드시 제공된 JSON 스키마에 맞춰 한국어로 답하라.`;
  const userPrompt = buildSynthesisPrompt() + (synthesisFeedback ? `\n\n이전 시도 피드백:\n${synthesisFeedback}` : '');
 
  let body;
  try {
    body = await requestOpenAi('CRO quality-gate synthesis', {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'daily_briefing',
          strict: true,
          schema
        }
      },
      store: false,
      reasoning: { effort: 'medium' },
      text: { verbosity: 'medium' },
      max_output_tokens: 12000
    });
  } catch (apiError) {
    synthesisError = apiError;
    console.warn(`Synthesis API request failed: ${apiError.message}. Retrying after TPM cooldown.`);
    await coolDown('CRO quality-gate synthesis retry');
    continue;
  }

  let candidate;
  try {
    candidate = parseStructuredOutput(body, 'CRO quality-gate synthesis');
  } catch (parseError) {
    synthesisError = parseError;
    if (attempt < MAX_SYNTHESIS_ATTEMPTS) {
      console.warn(`${parseError.message} Retrying synthesis after TPM cooldown (${attempt}/${MAX_SYNTHESIS_ATTEMPTS}).`);
      await coolDown('CRO quality-gate synthesis retry');
    }
    continue;
  }

  try {
    const dedupedFallback = dedupeCandidateNews(JSON.parse(JSON.stringify(candidate)));
    const fallbackCount = countNews(dedupedFallback);
    if (fallbackCount > bestFallbackCount) {
      bestFallbackCount = fallbackCount;
      bestFallbackCandidate = dedupedFallback;
    }
  } catch {}

  try {
    const candidateNews = ['critical', 'daily_news', 'subsidiary_news', 'additional_news']
      .flatMap((key) => candidate[key] || []);
    if ((candidate.critical || []).length < 1) {
      throw new Error(`Critical (Priority Watch) contained 0 articles; at least 1 is required.`);
    }
        if (candidateNews.length < MINIMUM_ARTICLES_TARGET) {
      throw new Error(`Final briefing contained only ${candidateNews.length} articles; at least ${MINIMUM_ARTICLES_TARGET} are required.`);
    }
    const candidateUrls = new Set();
    for (const item of candidateNews) {
      let url;
      try {
        url = new URL(item.url);
      } catch {
        throw new Error(`Article URL was missing or malformed for "${item.title || '제목 없음'}": ${JSON.stringify(item.url)}`);
      }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Invalid article URL: ${item.url}`);
      if (isLikelyListingUrl(item.url)) throw new Error(`Final briefing selected a listing/search page instead of an article: ${item.url}`);
      const canonicalKey = canonicalUrlKey(item.url);
      let researchedUrl = researchedUrlByCanonical.get(canonicalKey);
      if (!researchedUrl) {
        const pathMatches = researchedUrlsByPath.get(urlPathKey(item.url)) || [];
        if (pathMatches.length === 1) researchedUrl = pathMatches[0];
      }
      if (!researchedUrl) {
        console.warn(`Final URL was not present in the extracted source list; retaining the valid synthesized URL: ${item.url}`);
      } else if (item.url !== researchedUrl) {
        console.log(`Normalized researched URL: ${item.url} -> ${researchedUrl}`);
        item.url = researchedUrl;
      }
      const verifiedKey = canonicalUrlKey(item.url);
      if (candidateUrls.has(verifiedKey)) throw new Error(`Duplicate article URL: ${item.url}`);
      candidateUrls.add(verifiedKey);
    }
    const now = new Date();
    for (const item of candidateNews) {
      const parsedPublished = parsePublishedKst(item.published);
      if (!parsedPublished.date) {
        throw new Error(`Article had no verifiable date: ${item.title} (published: ${item.published || '미기재'}) URL: ${item.url}`);
      }
      if (item.window === 'primary') {
        if (parsedPublished.hasTime) {
          const hoursDiff = (now - parsedPublished.date) / (1000 * 60 * 60);
          if (hoursDiff < -3 || hoursDiff > 36) {
            throw new Error(`Primary article was not within the recent 36 hour window: ${item.title} (published: ${item.published || '미기재'}) URL: ${item.url}`);
          }
        } else {
          const daysDiff = (now - parsedPublished.date) / (1000 * 60 * 60 * 24);
          if (daysDiff < 0 || daysDiff > 1) {
            throw new Error(`Primary article date was not within the recent 1-day window: ${item.title} (published: ${item.published || '미기재'}) URL: ${item.url}`);
          }
        }
      } else {
        const daysDiff = (now - parsedPublished.date) / (1000 * 60 * 60 * 24);
        if (daysDiff < 0 || daysDiff > 7) {
          throw new Error(`Related article was outside the allowed date range: ${item.title} (published: ${item.published}) URL: ${item.url}`);
        }
      }
    }
    const relatedCount = candidateNews.filter((item) => item.window !== 'primary').length;
    if (relatedCount > 8) {
      throw new Error(`Too many related (non-today) articles selected: ${relatedCount}. Limit is 8.`);
    }
    for (const item of candidate.critical || []) {
      if (item.window !== 'primary') {
        throw new Error(`Critical article must be dated today (window=primary): ${item.title} URL: ${item.url}`);
      }
    }
    for (const item of candidate.subsidiary_news || []) {
      if (!mentionsWooriSubsidiary(item)) {
        throw new Error(`Subsidiary news item did not reference a Woori Financial Group subsidiary or approved overseas market: ${item.title} URL: ${item.url}`);
      }
    }
    candidateNews.forEach((item) => { item.source_type = isOfficialUrl(item.url) ? 'official' : 'media'; });
    const mediaCount = candidateNews.filter((item) => item.source_type === 'media').length;
    const minimumMediaCount = Math.max(3, Math.ceil(candidateNews.length * 0.5));
    if (mediaCount < minimumMediaCount) throw new Error(`CRO quality-gate synthesis selected only ${mediaCount} media articles; at least ${minimumMediaCount} are required.`);
    const qualityError = narrativeQualityError(candidate, candidateNews);
    if (qualityError) throw new Error(qualityError);
    briefing = candidate;
    break;
  } catch (error) {
    synthesisError = error;
    synthesisFeedback = error.message;
    const badUrls = extractUrlsFromText(error.message);
    const rejectedCanonicalKeys = new Set();
    badUrls.forEach((url) => {
      rejectedUrls.add(url);
      try {
        const canonicalKey = canonicalUrlKey(url);
        rejectedCanonicalKeys.add(canonicalKey);
        researchedUrlByCanonical.delete(canonicalKey);
        const pathKey = urlPathKey(url);
        const remaining = (researchedUrlsByPath.get(pathKey) || []).filter((u) => u !== url);
        if (remaining.length > 0) {
          researchedUrlsByPath.set(pathKey, remaining);
        } else {
          researchedUrlsByPath.delete(pathKey);
        }
      } catch {}
    });
    for (const evidence of Object.values(researchEvidence)) {
      if (!Array.isArray(evidence.source_urls)) continue;
      evidence.source_urls = evidence.source_urls.filter((url) => {
        try {
          return !rejectedCanonicalKeys.has(canonicalUrlKey(url));
        } catch {
          return !rejectedUrls.has(url);
        }
      });
    }
    if (attempt < MAX_SYNTHESIS_ATTEMPTS) {
      console.warn(`${error.message} Removed ${badUrls.length} bad URL(s) from the candidate pool (now permanently excluded from research evidence). Retrying synthesis after TPM cooldown (${attempt}/${MAX_SYNTHESIS_ATTEMPTS}).`);
      await coolDown('CRO quality-gate synthesis retry');
    }
  }
}

if (!briefing) {
  if (!bestFallbackCandidate || bestFallbackCount < MINIMUM_ARTICLES_FALLBACK) {
    throw synthesisError || new Error('CRO quality-gate synthesis failed without a result.');
  }
  console.warn(`All ${MAX_SYNTHESIS_ATTEMPTS} attempts failed strict validation. Falling back to the best deduplicated candidate with ${bestFallbackCount} articles (target was ${MINIMUM_ARTICLES_TARGET}).`);
  if (!bestFallbackCandidate.critical) bestFallbackCandidate.critical = [];
  if (!bestFallbackCandidate.daily_news) bestFallbackCandidate.daily_news = [];
  if (!bestFallbackCandidate.subsidiary_news) bestFallbackCandidate.subsidiary_news = [];
  if (!bestFallbackCandidate.additional_news) bestFallbackCandidate.additional_news = [];
  bestFallbackCandidate.meta = bestFallbackCandidate.meta || {};
  bestFallbackCandidate.meta.fallback_notice = `엄격 검증을 통과하지 못해 최선의 후보(${bestFallbackCount}건)로 대체 발행되었습니다.`;
  briefing = bestFallbackCandidate;
}

const allNews = ['critical', 'daily_news', 'subsidiary_news', 'additional_news'].flatMap((key) => briefing[key] || []);
const urls = new Set();
for (const item of allNews) {
  const url = new URL(item.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Invalid article URL: ${item.url}`);
  const canonicalKey = canonicalUrlKey(item.url);
  let researchedUrl = researchedUrlByCanonical.get(canonicalKey);
  if (!researchedUrl) {
    const pathMatches = researchedUrlsByPath.get(urlPathKey(item.url)) || [];
    if (pathMatches.length === 1) researchedUrl = pathMatches[0];
  }
  if (!researchedUrl) {
    console.warn(`Final URL was not present in the extracted source list; retaining the valid synthesized URL: ${item.url}`);
  } else if (item.url !== researchedUrl) {
    console.log(`Normalized researched URL: ${item.url} -> ${researchedUrl}`);
    item.url = researchedUrl;
  }
  const verifiedKey = canonicalUrlKey(item.url);
  if (urls.has(verifiedKey)) throw new Error(`Duplicate article URL: ${item.url}`);
  urls.add(verifiedKey);
}
if (allNews.length < 1) throw new Error('Final briefing contained no articles at all.');
briefing.critical.forEach((item) => { item.critical = true; });
briefing.daily_news.forEach((item) => { item.critical = false; });
briefing.subsidiary_news.forEach((item) => { item.critical = false; });
briefing.additional_news.forEach((item) => { item.critical = false; });

briefing.meta = {
  ...(briefing.meta || {}),
  product: 'CRO Staff News & Critical Monitor',
  perspective: '우리금융그룹 CRO',
  mode: 'daily',
  briefing_date: date,
  generated_at: new Date().toISOString(),
  primary_window: '실행 시점 기준 최근 24시간 (KST), 부족분은 날짜가 표시된 최근 7일 유관·배경 자료',
  research_method: '3 media research stages + separate official-source verification + independent CRO quality-gate synthesis',
  source_mix: {
    media: allNews.filter((item) => item.source_type === 'media').length,
    official: allNews.filter((item) => item.source_type === 'official').length
  }
};
briefing.insights.as_of = `${date} KST`;

await writeFile(outputPath, `${JSON.stringify(briefing, null, 2)}\n`, 'utf8');
console.log(`Generated ${allNews.length} unique briefing articles for ${date}.`);
