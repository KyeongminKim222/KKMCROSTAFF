import { readFile, writeFile } from 'node:fs/promises';

const apiKey = process.env.OPENAI_API_KEY || '';
const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
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
        if (['http:', 'https:'].includes(url.protocol)) urls.add(value.url);
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

function canonicalUrlKey(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    const value = url.searchParams.get(key);
    if (!value || lower.startsWith('utm_') || disposableQueryParams.has(lower)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const query = url.searchParams.toString();
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${pathname}${query ? `?${query}` : ''}`;
}

function urlPathKey(rawUrl) {
  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  return `${hostname}${pathname}`;
}

function retryDelayMs(response, body, attempt) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(60_000, Math.ceil(retryAfter * 1000) + 1000);
  }

  const message = String(body?.error?.message || '');
  const match = message.match(/try again in\s+([\d.]+)(ms|s)/i);
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
  const milliseconds = 75_000;
  console.log(`${label} complete. Cooling down OpenAI TPM for ${milliseconds / 1000} seconds.`);
  await sleep(milliseconds);
}

const newsItem = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'url', 'published', 'summary', 'why_woori_cro', 'entity', 'channel', 'risk_type', 'urgency', 'confidence', 'critical', 'window', 'watchpoints'],
  properties: {
    title: { type: 'string' },
    url: { type: 'string' },
    published: { type: 'string' },
    summary: { type: 'string' },
    why_woori_cro: { type: 'string' },
    entity: { type: 'string' },
    channel: { type: 'string' },
    risk_type: { type: 'string' },
    urgency: { type: 'string', enum: ['높음', '중간', '낮음'] },
    confidence: { type: 'string', enum: ['높음', '중간', '낮음'] },
    critical: { type: 'boolean' },
    window: { type: 'string', enum: ['primary', 'related'] },
    watchpoints: { type: 'array', maxItems: 4, items: { type: 'string' } }
  }
};

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['executive_judgment', 'executive_judgment_bullets', 'critical', 'daily_news', 'subsidiary_news', 'additional_news', 'forward_looking_points', 'insights', 'monitoring_points'],
  properties: {
    executive_judgment: { type: 'string' },
    executive_judgment_bullets: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string' } },
    critical: { type: 'array', minItems: 3, maxItems: 3, items: newsItem },
    daily_news: { type: 'array', minItems: 3, maxItems: 3, items: newsItem },
    subsidiary_news: { type: 'array', minItems: 3, maxItems: 3, items: newsItem },
    additional_news: { type: 'array', minItems: 1, maxItems: 1, items: newsItem },
    forward_looking_points: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'horizon', 'likelihood', 'cro_angle', 'trigger'],
        properties: {
          title: { type: 'string' },
          horizon: { type: 'string' },
          likelihood: { type: 'string', enum: ['높음', '중간', '낮음'] },
          cro_angle: { type: 'string' },
          trigger: { type: 'string' }
        }
      }
    },
    insights: {
      type: 'object',
      additionalProperties: false,
      required: ['headline', 'bullets', 'action_items', 'stance'],
      properties: {
        headline: { type: 'string' },
        bullets: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string' } },
        action_items: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string' } },
        stance: { type: 'string' }
      }
    },
    monitoring_points: { type: 'array', minItems: 3, maxItems: 7, items: { type: 'string' } }
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
const commonResearchRules = `
실행일은 ${date} KST다. 실행 시점 기준 최근 24시간의 공개 정보를 primary 후보로 삼아라.
공식 발표, 공시, 금융·감독·규제기관, 중앙은행, 거래소, 기업 IR 등 1차 자료를 우선하고 주요 통신사·경제지 보도로 교차 확인하라.
각 후보는 서로 다른 단일 사건이어야 하며, 같은 사건의 반복 보도는 대표 원문 하나로 통합하라.
URL은 실제 검색으로 확인한 기사 또는 공식 발표의 직접 링크만 사용하고 검색결과 페이지나 임의 URL을 만들지 마라.
게시 일시는 KST 기준으로 적고 확인할 수 없으면 '게시 시각 미확인'이라고 명시하라.
확인된 사실과 CRO 관점의 분석을 구분하고, 수치·날짜·기관명·기업명을 검증하라.
자본·유동성·신용·시장·운영·사이버·법무/준법·평판·전략 리스크 영향을 평가하라.
신뢰할 만한 후보가 부족하면 숫자를 채우지 말고 조사 메모에 이유를 적어라.
primary 후보가 부족하면 맥락 이해에 직접 필요한 최근 7일 이내 유관·배경 자료를 추가 조사하되 반드시 related라고 표시하고 날짜를 명확히 적어라.
전일 제목은 중대한 신규 사실이 있을 때만 다시 후보에 포함하라: ${JSON.stringify(previousTitles)}
각 후보에 제목, 매체·기관, 게시 일시, 직접 URL, 확인된 사실, 우리금융 CRO 중요성, 리스크 유형, 긴급도, 근거 신뢰도와 확인할 질문을 포함하라.
반드시 웹 검색을 수행하고, 모든 후보 옆에 실제 검색 출처를 인라인 인용으로 붙여라. 이 조사 단계에서는 JSON을 만들지 말고 읽기 쉬운 한국어 조사 메모로 답하라.
`;

async function researchStage(label, scope) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const body = await requestOpenAi(label, {
      model,
      input: `당신은 CRO STAFF의 조사 담당자다.\n\n조사 범위:\n${scope}\n\n공통 조사 규칙:\n${commonResearchRules}`,
      tools: [{
        type: 'web_search',
        search_context_size: 'medium',
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
    if (narrative && sourceUrls.length >= 5) {
      console.log(`${label} collected ${sourceUrls.length} verified source URLs.`);
      return { narrative, source_urls: sourceUrls };
    }
    if (attempt < 2) {
      console.warn(`${label} returned fewer than 5 cited sources. Retrying after TPM cooldown.`);
      await coolDown(`${label} empty-source retry`);
    }
  }
  throw new Error(`${label} did not return at least 5 cited web sources after two attempts.`);
}

const domestic = await researchStage(
  'Korean market and regulation research',
  `한국 금융시장 리스크와 한국 금융 규제·정책 변화를 조사하라.
금융위원회, 금융감독원, 한국은행, 기획재정부, 예금보험공사, 한국거래소, DART 발표를 우선 확인하라.
금리·환율·유동성·부동산 PF·가계/기업 신용·자본규제·소비자보호·사이버 및 운영리스크를 폭넓게 점검하고 CRO 관련성이 높은 후보를 최대 12건 제시하라.`
);
await coolDown('Korean market and regulation research');

const wooriAndPeers = await researchStage(
  'Woori and peer institutions research',
  `우리금융그룹과 계열사, 국내 주요 금융 경쟁사 동향을 조사하라.
우리금융지주·우리은행·우리카드·우리금융캐피탈·우리종합금융·우리자산운용 등 그룹 관련 공식 발표와 공시를 우선 확인하라.
KB·신한·하나·NH·IBK 및 주요 증권·보험·카드사의 자본, 건전성, 인수합병, 제재, 사고, 실적과 리스크 변화를 함께 점검하라.
우리금융에 직접 영향을 주는 사안은 중요도를 상향하고 후보를 최대 12건 제시하라.`
);
await coolDown('Woori and peer institutions research');

const global = await researchStage(
  'Global market and regulation research',
  `글로벌 금융시장과 해외 규제·정책 중 우리금융그룹으로 전이될 수 있는 리스크를 조사하라.
주요 중앙은행, 재무·감독기관, BIS·FSB·IMF 및 글로벌 금융회사 공식 발표를 우선 확인하라.
금리·달러·채권·주식·원자재·지정학·해외 상업용 부동산·은행 건전성·사이버·제재·AML 변화를 점검하고 후보를 최대 12건 제시하라.`
);
await coolDown('Global market and regulation research');

const researchEvidence = { domestic, woori_and_peers: wooriAndPeers, global };
const researchedUrlByCanonical = new Map();
const researchedUrlsByPath = new Map();
for (const sourceUrl of Object.values(researchEvidence).flatMap((evidence) => evidence.source_urls || [])) {
  researchedUrlByCanonical.set(canonicalUrlKey(sourceUrl), sourceUrl);
  const pathKey = urlPathKey(sourceUrl);
  const matches = researchedUrlsByPath.get(pathKey) || [];
  if (!matches.includes(sourceUrl)) matches.push(sourceUrl);
  researchedUrlsByPath.set(pathKey, matches);
}
if (researchedUrlByCanonical.size < 10) {
  throw new Error(`Research produced only ${researchedUrlByCanonical.size} unique source URLs; at least 10 are required.`);
}
const synthesisPrompt = `
당신은 우리금융그룹 전체 CRO를 지원하는 전략 비서 CRO STAFF다. 실행일은 ${date} KST다.
아래 세 조사팀의 웹 조사 메모와 검증 출처 URL만 사용하여 최종 데일리 브리핑을 작성하라. 조사 메모에 없는 사실과 수치를 새로 만들지 마라.

우선순위:
1. 한국 금융시장 리스크
2. 한국 금융 규제·정책 변화
3. 국내 금융 경쟁사 동향
4. 글로벌 금융시장 및 해외 규제·정책
5. 우리금융그룹과 계열사 직접 영향은 범주와 관계없이 상향

최종 선정 규칙:
- 정확히 10건을 선정한다: 크리티컬 3건, 데일리 금융·리스크 3건, 우리금융그룹·계열사 3건, CRO 관련성이 가장 높은 추가 이슈 1건.
- 최근 24시간 기사는 window를 primary로 표시한다. 10건 구성을 위해 사용한 최근 7일 이내 유관·배경 자료는 window를 related로 표시하고 게시 날짜를 명확히 유지한다.
- 검증된 조사 근거가 10건보다 적으면 임의로 채우지 않는다. 이 경우에는 완성된 10건을 만들 수 없으므로 오류가 나도록 빈 URL이나 가짜 항목을 만들지 않는다.
- 동일 사건과 동일 URL을 제거하고 대표 원문 하나만 남긴다.
- URL은 각 조사팀의 source_urls에 있는 값을 글자 하나도 바꾸지 않고 그대로 복사한다.
- 전일 제목은 중대한 신규 사실이 있을 때만 다시 포함한다: ${JSON.stringify(previousTitles)}
- 확인된 사실과 분석·추론을 구분하고 투자 권고나 확정적 시장 예측을 하지 않는다.

CRO 품질 게이트:
- 수치, 날짜, 게시 시각, 기관명, 기업명과 근거 신뢰도를 후보 간 비교한다.
- 자본·유동성·신용·시장·운영·사이버·법무/준법·평판·전략 리스크 영향을 평가한다.
- 영향 전파 속도, 영향 범위, 대응 가능 시간, 규제기관 관심으로 긴급도를 판단한다.
- 기사 간 연결고리, 리스크 전이 경로, 오늘 확인할 지표·질문, 단기 모니터링 포인트를 도출한다.
- 각 기사 summary와 why_woori_cro는 각각 최대 2문장으로 간결하게 작성하고 watchpoints는 1~2개만 제시한다.

조사 근거 JSON:
${JSON.stringify(researchEvidence)}

반드시 제공된 JSON 스키마에 맞춰 한국어로 답하라.
`;

let briefing;
let synthesisError;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const synthesisBody = await requestOpenAi('CRO quality-gate synthesis', {
    model,
    input: synthesisPrompt,
    store: false,
    reasoning: { effort: 'low' },
    text: {
      verbosity: 'low',
      format: {
        type: 'json_schema',
        name: 'cro_staff_daily_briefing',
        strict: true,
        schema
      }
    },
    max_output_tokens: 14000
  });
  try {
    briefing = parseStructuredOutput(synthesisBody, 'CRO quality-gate synthesis');
    break;
  } catch (error) {
    synthesisError = error;
    if (attempt < 3) {
      console.warn(`${error.message} Retrying synthesis after TPM cooldown (${attempt}/3).`);
      await coolDown('CRO quality-gate synthesis retry');
    }
  }
}
if (!briefing) throw synthesisError || new Error('CRO quality-gate synthesis failed without a result.');

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
  if (!researchedUrl) throw new Error(`Final briefing used a URL that was not researched: ${item.url}`);
  if (item.url !== researchedUrl) {
    console.log(`Normalized researched URL: ${item.url} -> ${researchedUrl}`);
    item.url = researchedUrl;
  }
  const verifiedKey = canonicalUrlKey(item.url);
  if (urls.has(verifiedKey)) throw new Error(`Duplicate article URL: ${item.url}`);
  urls.add(verifiedKey);
}
if (allNews.length !== 10) throw new Error(`Final briefing contained ${allNews.length} articles; exactly 10 are required.`);
briefing.critical.forEach((item) => { item.critical = true; });
briefing.daily_news.forEach((item) => { item.critical = false; });
briefing.subsidiary_news.forEach((item) => { item.critical = false; });
briefing.additional_news.forEach((item) => { item.critical = false; });

briefing.meta = {
  product: 'CRO Staff News & Critical Monitor',
  perspective: '우리금융그룹 CRO',
  mode: 'daily',
  briefing_date: date,
  generated_at: new Date().toISOString(),
  primary_window: '실행 시점 기준 최근 24시간 (KST), 부족분은 날짜가 표시된 최근 7일 유관·배경 자료',
  research_method: '3-stage cited web research + independent CRO quality-gate synthesis'
};
briefing.insights.as_of = `${date} KST`;

await writeFile(outputPath, `${JSON.stringify(briefing, null, 2)}\n`, 'utf8');
console.log(`Generated ${allNews.length} unique briefing articles for ${date}.`);
