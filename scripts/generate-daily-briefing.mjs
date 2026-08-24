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

async function requestBriefing(requestBody, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240_000);
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

    if (response.status !== 429 || attempt === maxAttempts) {
      throw new Error(`OpenAI briefing generation failed (${response.status}): ${body?.error?.message || 'unknown error'}`);
    }

    const delay = Math.max(90_000, retryDelayMs(response, body, attempt));
    console.warn(`OpenAI rate limit reached. Retrying in ${delay}ms (${attempt}/${maxAttempts}).`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new Error('OpenAI briefing generation exhausted all retry attempts.');
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
const prompt = `
당신은 우리금융그룹 전체 CRO를 지원하는 전략 비서 CRO STAFF다. 실행일은 ${date} KST다.

공개 웹을 충분히 검색하여 실행 시점 기준 최근 24시간의 금융 리스크 브리핑을 작성하라. 금융위원회, 금융감독원, 한국은행, 기획재정부, 거래소, DART, 기업 공식 발표 등 1차 자료를 우선하고 주요 통신사·경제지의 신뢰도 높은 보도를 교차 확인하라.

우선순위:
1. 한국 금융시장 리스크
2. 한국 금융 규제·정책 변화
3. 국내 금융 경쟁사 동향
4. 글로벌 금융시장 및 해외 규제·정책
5. 우리금융그룹과 계열사 직접 영향은 범주와 관계없이 상향

선정 규칙:
- 웹 검색 호출은 최대 2회다. 첫 검색은 한국 금융시장·규제·경쟁사·우리금융을 함께 조사하고, 두 번째 검색은 글로벌 금융시장·해외 규제와 첫 검색의 핵심 근거 보강을 함께 수행한다.
- 크리티컬 최대 3건, 데일리 금융·리스크 최대 3건, 우리금융그룹·계열사 최대 3건으로 구성한다.
- 신뢰할 만한 기사가 부족하면 숫자를 억지로 채우지 않는다.
- 동일 사건의 중복 보도는 대표 원문 하나로 통합한다.
- 다음 전일 제목은 중대한 신규 사실이 있을 때만 다시 포함한다: ${JSON.stringify(previousTitles)}
- 각 URL은 실제 검색으로 확인한 기사 또는 공식 발표의 직접 링크여야 한다. 검색결과 페이지나 임의 URL을 만들지 않는다.
- 게시 일시는 KST 기준으로 명확히 적고, 확인할 수 없으면 '게시 시각 미확인'이라고 적는다.
- 확인된 사실과 분석·추론을 구분하고, 투자 권고나 확정적 시장 예측을 하지 않는다.

CRO 품질 게이트:
- 같은 사건과 동일 URL 중복 제거
- 수치, 날짜, 게시 시각, 기관명, 기업명 검증
- 자본·유동성·신용·시장·운영·사이버·법무/준법·평판·전략 리스크 영향 평가
- 영향 전파 속도, 영향 범위, 대응 가능 시간, 규제기관 관심으로 긴급도 판단
- 기사 간 연결고리, 리스크 전이 경로, 오늘 확인할 지표·질문, 단기 모니터링 포인트 도출

반드시 제공된 JSON 스키마에 맞춰 한국어로 답하라.
`;

const body = await requestBriefing({
  model,
  input: prompt,
  tools: [{ type: 'web_search', search_context_size: 'low' }],
  max_tool_calls: 2,
  include: ['web_search_call.action.sources'],
  store: false,
  reasoning: { effort: 'low' },
  text: {
    verbosity: 'medium',
    format: {
      type: 'json_schema',
      name: 'cro_staff_daily_briefing',
      strict: true,
      schema
    }
  },
  max_output_tokens: 6000
});

const text = extractOutputText(body);
if (!text) throw new Error('OpenAI response did not contain briefing JSON.');
const briefing = JSON.parse(text);

const allNews = ['critical', 'daily_news', 'subsidiary_news'].flatMap((key) => briefing[key] || []);
const urls = new Set();
for (const item of allNews) {
  const url = new URL(item.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Invalid article URL: ${item.url}`);
  if (urls.has(item.url)) throw new Error(`Duplicate article URL: ${item.url}`);
  urls.add(item.url);
}
briefing.critical.forEach((item) => { item.critical = true; });
briefing.daily_news.forEach((item) => { item.critical = false; });
briefing.subsidiary_news.forEach((item) => { item.critical = false; });

briefing.meta = {
  product: 'CRO Staff News & Critical Monitor',
  perspective: '우리금융그룹 CRO',
  mode: 'daily',
  briefing_date: date,
  generated_at: new Date().toISOString(),
  primary_window: '실행 시점 기준 최근 24시간 (KST)'
};
briefing.insights.as_of = `${date} KST`;

await writeFile(outputPath, `${JSON.stringify(briefing, null, 2)}\n`, 'utf8');
console.log(`Generated ${allNews.length} unique briefing articles for ${date}.`);
