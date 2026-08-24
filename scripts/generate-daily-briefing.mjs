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
  if (!text) throw new Error(`${label} did not contain structured output.`);
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
  required: ['title', 'url', 'published', 'summary', 'why_woori_cro', 'entity', 'channel', 'risk_type', 'urgency', 'confidence', 'critical', 'watchpoints'],
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
    watchpoints: { type: 'array', maxItems: 4, items: { type: 'string' } }
  }
};

const candidateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates', 'coverage_notes', 'insufficient_evidence'],
  properties: {
    candidates: { type: 'array', maxItems: 12, items: newsItem },
    coverage_notes: { type: 'array', maxItems: 5, items: { type: 'string' } },
    insufficient_evidence: { type: 'string' }
  }
};

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['executive_judgment', 'executive_judgment_bullets', 'critical', 'daily_news', 'subsidiary_news', 'forward_looking_points', 'insights', 'monitoring_points'],
  properties: {
    executive_judgment: { type: 'string' },
    executive_judgment_bullets: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string' } },
    critical: { type: 'array', maxItems: 3, items: newsItem },
    daily_news: { type: 'array', maxItems: 3, items: newsItem },
    subsidiary_news: { type: 'array', maxItems: 3, items: newsItem },
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
  previousTitles = ['critical', 'daily_news', 'subsidiary_news']
    .flatMap((key) => previous[key] || [])
    .map((item) => item.title)
    .filter(Boolean)
    .slice(0, 20);
} catch {}

const date = kstDate();
const commonResearchRules = `
실행일은 ${date} KST다. 실행 시점 기준 최근 24시간의 공개 정보만 기본 후보로 삼아라.
공식 발표, 공시, 금융·감독·규제기관, 중앙은행, 거래소, 기업 IR 등 1차 자료를 우선하고 주요 통신사·경제지 보도로 교차 확인하라.
각 후보는 서로 다른 단일 사건이어야 하며, 같은 사건의 반복 보도는 대표 원문 하나로 통합하라.
URL은 실제 검색으로 확인한 기사 또는 공식 발표의 직접 링크만 사용하고 검색결과 페이지나 임의 URL을 만들지 마라.
게시 일시는 KST 기준으로 적고 확인할 수 없으면 '게시 시각 미확인'이라고 명시하라.
확인된 사실과 CRO 관점의 분석을 구분하고, 수치·날짜·기관명·기업명을 검증하라.
자본·유동성·신용·시장·운영·사이버·법무/준법·평판·전략 리스크 영향을 평가하라.
신뢰할 만한 후보가 부족하면 숫자를 채우지 말고 insufficient_evidence에 이유를 적어라.
전일 제목은 중대한 신규 사실이 있을 때만 다시 후보에 포함하라: ${JSON.stringify(previousTitles)}
반드시 제공된 JSON 스키마에 맞춰 한국어로 답하라.
`;

function validateCandidateBatch(batch, label) {
  const urls = new Set();
  for (const item of batch.candidates || []) {
    const url = new URL(item.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label} returned an invalid URL: ${item.url}`);
    if (urls.has(item.url)) throw new Error(`${label} returned a duplicate URL: ${item.url}`);
    urls.add(item.url);
  }
  console.log(`${label} produced ${(batch.candidates || []).length} candidate articles.`);
  return batch;
}

async function researchStage(label, schemaName, scope) {
  const body = await requestOpenAi(label, {
    model,
    input: `당신은 CRO STAFF의 조사 담당자다.\n\n조사 범위:\n${scope}\n\n공통 조사 규칙:\n${commonResearchRules}`,
    tools: [{
      type: 'web_search',
      search_context_size: 'medium',
      user_location: { type: 'approximate', country: 'KR', timezone: 'Asia/Seoul' }
    }],
    tool_choice: 'required',
    max_tool_calls: 2,
    include: ['web_search_call.action.sources'],
    store: false,
    reasoning: { effort: 'low' },
    text: {
      verbosity: 'medium',
      format: {
        type: 'json_schema',
        name: schemaName,
        strict: true,
        schema: candidateSchema
      }
    },
    max_output_tokens: 5000
  });
  return validateCandidateBatch(parseStructuredOutput(body, label), label);
}

const domestic = await researchStage(
  'Korean market and regulation research',
  'cro_korean_market_candidates',
  `한국 금융시장 리스크와 한국 금융 규제·정책 변화를 조사하라.
금융위원회, 금융감독원, 한국은행, 기획재정부, 예금보험공사, 한국거래소, DART 발표를 우선 확인하라.
금리·환율·유동성·부동산 PF·가계/기업 신용·자본규제·소비자보호·사이버 및 운영리스크를 폭넓게 점검하고 CRO 관련성이 높은 후보를 최대 12건 제시하라.`
);
await coolDown('Korean market and regulation research');

const wooriAndPeers = await researchStage(
  'Woori and peer institutions research',
  'cro_woori_peer_candidates',
  `우리금융그룹과 계열사, 국내 주요 금융 경쟁사 동향을 조사하라.
우리금융지주·우리은행·우리카드·우리금융캐피탈·우리종합금융·우리자산운용 등 그룹 관련 공식 발표와 공시를 우선 확인하라.
KB·신한·하나·NH·IBK 및 주요 증권·보험·카드사의 자본, 건전성, 인수합병, 제재, 사고, 실적과 리스크 변화를 함께 점검하라.
우리금융에 직접 영향을 주는 사안은 중요도를 상향하고 후보를 최대 12건 제시하라.`
);
await coolDown('Woori and peer institutions research');

const global = await researchStage(
  'Global market and regulation research',
  'cro_global_candidates',
  `글로벌 금융시장과 해외 규제·정책 중 우리금융그룹으로 전이될 수 있는 리스크를 조사하라.
주요 중앙은행, 재무·감독기관, BIS·FSB·IMF 및 글로벌 금융회사 공식 발표를 우선 확인하라.
금리·달러·채권·주식·원자재·지정학·해외 상업용 부동산·은행 건전성·사이버·제재·AML 변화를 점검하고 후보를 최대 12건 제시하라.`
);
await coolDown('Global market and regulation research');

const candidateBatches = { domestic, woori_and_peers: wooriAndPeers, global };
const synthesisPrompt = `
당신은 우리금융그룹 전체 CRO를 지원하는 전략 비서 CRO STAFF다. 실행일은 ${date} KST다.
아래 세 조사팀의 검증 후보만 사용하여 최종 데일리 브리핑을 작성하라. 후보에 없는 사실, 수치, URL을 새로 만들지 마라.

우선순위:
1. 한국 금융시장 리스크
2. 한국 금융 규제·정책 변화
3. 국내 금융 경쟁사 동향
4. 글로벌 금융시장 및 해외 규제·정책
5. 우리금융그룹과 계열사 직접 영향은 범주와 관계없이 상향

최종 선정 규칙:
- 크리티컬 최대 3건, 데일리 금융·리스크 최대 3건, 우리금융그룹·계열사 최대 3건으로 구성한다.
- 신뢰할 만한 후보가 부족하면 숫자를 억지로 채우지 않는다.
- 동일 사건과 동일 URL을 제거하고 대표 원문 하나만 남긴다.
- URL은 후보에 있는 값을 글자 하나도 바꾸지 않고 그대로 복사한다.
- 전일 제목은 중대한 신규 사실이 있을 때만 다시 포함한다: ${JSON.stringify(previousTitles)}
- 확인된 사실과 분석·추론을 구분하고 투자 권고나 확정적 시장 예측을 하지 않는다.

CRO 품질 게이트:
- 수치, 날짜, 게시 시각, 기관명, 기업명과 근거 신뢰도를 후보 간 비교한다.
- 자본·유동성·신용·시장·운영·사이버·법무/준법·평판·전략 리스크 영향을 평가한다.
- 영향 전파 속도, 영향 범위, 대응 가능 시간, 규제기관 관심으로 긴급도를 판단한다.
- 기사 간 연결고리, 리스크 전이 경로, 오늘 확인할 지표·질문, 단기 모니터링 포인트를 도출한다.

조사 후보 JSON:
${JSON.stringify(candidateBatches)}

반드시 제공된 JSON 스키마에 맞춰 한국어로 답하라.
`;

const synthesisBody = await requestOpenAi('CRO quality-gate synthesis', {
  model,
  input: synthesisPrompt,
  store: false,
  reasoning: { effort: 'medium' },
  text: {
    verbosity: 'medium',
    format: {
      type: 'json_schema',
      name: 'cro_staff_daily_briefing',
      strict: true,
      schema
    }
  },
  max_output_tokens: 7000
});

const briefing = parseStructuredOutput(synthesisBody, 'CRO quality-gate synthesis');

const allNews = ['critical', 'daily_news', 'subsidiary_news'].flatMap((key) => briefing[key] || []);
const urls = new Set();
const candidateUrls = new Set(
  Object.values(candidateBatches)
    .flatMap((batch) => batch.candidates || [])
    .map((item) => item.url)
);
for (const item of allNews) {
  const url = new URL(item.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Invalid article URL: ${item.url}`);
  if (urls.has(item.url)) throw new Error(`Duplicate article URL: ${item.url}`);
  if (!candidateUrls.has(item.url)) throw new Error(`Final briefing used a URL that was not researched: ${item.url}`);
  urls.add(item.url);
}
if (!allNews.length) throw new Error('Final briefing did not contain any verified articles.');
briefing.critical.forEach((item) => { item.critical = true; });
briefing.daily_news.forEach((item) => { item.critical = false; });
briefing.subsidiary_news.forEach((item) => { item.critical = false; });

briefing.meta = {
  product: 'CRO Staff News & Critical Monitor',
  perspective: '우리금융그룹 CRO',
  mode: 'daily',
  briefing_date: date,
  generated_at: new Date().toISOString(),
  primary_window: '실행 시점 기준 최근 24시간 (KST)',
  research_method: '3-stage web research + independent CRO quality-gate synthesis'
};
briefing.insights.as_of = `${date} KST`;

await writeFile(outputPath, `${JSON.stringify(briefing, null, 2)}\n`, 'utf8');
console.log(`Generated ${allNews.length} unique briefing articles for ${date}.`);
