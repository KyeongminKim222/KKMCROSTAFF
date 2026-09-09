import { readFile, writeFile } from 'node:fs/promises';

const apiKey = process.env.OPENAI_API_KEY || '';
const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const cooldownMilliseconds = Number(process.env.OPENAI_COOLDOWN_MS || 30_000);
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

function extractSourceData(response) {
  const sourceMap = new Map();
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
          const key = canonicalUrlKey(value.url);
          if (!sourceMap.has(key)) {
            sourceMap.set(key, {
              url: value.url,
              title: String(value.title || '').trim(),
              published: String(value.published_date || value.publish_date || value.date || value.published || '').trim()
            });
          }
        }
      } catch {}
    }
    Object.values(value).forEach(visit);
  };
  visit(response.output || []);
  return [...sourceMap.values()];
}

function parseSourceMappingFromNarrative(narrative) {
  const mappings = [];
  const text = String(narrative || '');
  const blockMatch = text.match(/\[\[SOURCE_METADATA\]\]([\s\S]*?)\[\[\/SOURCE_METADATA\]\]/);
  if (blockMatch) {
    try {
      const parsed = JSON.parse(blockMatch[1].trim());
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.url && item.title) {
            mappings.push({
              url: String(item.url).trim(),
              title: String(item.title).trim(),
              published: String(item.published || item.publish_date || item.date || '').trim()
            });
          }
        }
      }
    } catch {}
  }
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.url && item.title) {
            try {
              const key = canonicalUrlKey(item.url);
              if (!mappings.find((m) => { try { return canonicalUrlKey(m.url) === key; } catch { return false; } })) {
                mappings.push({
                  url: String(item.url).trim(),
                  title: String(item.title).trim(),
                  published: String(item.published || item.publish_date || item.date || '').trim()
                });
              }
            } catch {}
          }
        }
      }
    } catch {}
  }
  return mappings;
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

function normalizeJsonText(text) {
  return String(text || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function structuredOutputError(message, retryFeedback) {
  const error = new Error(message);
  error.retryFeedback = retryFeedback || message;
  return error;
}

function parseStructuredOutput(body, label) {
  const status = String(body?.status || 'unknown');
  const incompleteReason = String(
    body?.incomplete_details?.reason ||
    body?.error?.message ||
    ''
  );

  // 구조화 출력은 completed 상태일 때만 JSON 스키마 준수를 기대할 수 있습니다.
  if (status === 'incomplete') {
    console.error(`${label} response was incomplete.`);
    console.error(`reason: ${incompleteReason || 'not provided'}`);
    console.error(`usage: ${JSON.stringify(body?.usage || {})}`);

    throw structuredOutputError(
      `${label} response was incomplete: ${incompleteReason || 'unknown reason'}.`,
      '이전 응답이 출력 도중 중단되었습니다. 기사 수와 서술 분량을 줄이고, 유효한 JSON 객체 하나만 처음부터 끝까지 완성하여 반환하십시오.'
    );
  }

  if (status === 'failed') {
    throw structuredOutputError(
      `${label} response failed before completion.`,
      '이전 응답 생성에 실패했습니다. 조사 근거만 사용하여 유효한 JSON 객체 하나를 다시 생성하십시오.'
    );
  }

  const rawText = extractOutputText(body);

  if (!rawText) {
    const outputTypes = (body.output || [])
      .map((item) => item.type)
      .join(', ') || 'none';

    throw structuredOutputError(
      `${label} did not contain structured output (status=${status}, output_types=${outputTypes}, reason=${incompleteReason || 'not provided'}).`,
      '이전 응답에 JSON 본문이 없었습니다. 설명이나 Markdown 없이 스키마에 맞는 JSON 객체 하나만 반환하십시오.'
    );
  }

  const text = normalizeJsonText(rawText);

  try {
    return JSON.parse(text);
  } catch (error) {
    const preview = rawText.length > 1200
      ? `${rawText.slice(0, 600)}\n... (생략) ...\n${rawText.slice(-600)}`
      : rawText;

    // 로그에는 남기되, 이 원문을 다음 모델 프롬프트에 다시 넣지는 않습니다.
    console.error(`${label} JSON parse failed: ${error.message}`);
    console.error(`${label} status: ${status}`);
    console.error(`${label} output length: ${rawText.length}`);
    console.error(`${label} raw output preview:\n${preview}`);

    throw structuredOutputError(
      `${label} returned invalid JSON.`,
      '이전 응답의 JSON 문법이 올바르지 않았습니다. 설명, Markdown 코드블록, 주석을 포함하지 말고 스키마에 맞는 JSON 객체 하나만 반환하십시오.'
    );
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
    watchpoints: {
      type: 'array',
      minItems: 2,
      maxItems: 3,
      items: { type: 'string' }
    }
  }
};

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['executive_judgment', 'executive_judgment_bullets', 'critical', 'daily_news', 'subsidiary_news', 'additional_news', 'forward_looking_points', 'insights', 'monitoring_points'],
  properties: {
    executive_judgment: { type: 'string' },
    executive_judgment_bullets: {
      type: 'array',
      minItems: 3,
      maxItems: 4,
      items: { type: 'string' }
    },
    critical: { type: 'array', minItems: 1, maxItems: 2, items: newsItem },
    daily_news: { type: 'array', minItems: 5, maxItems: 6, items: newsItem },
    subsidiary_news: { type: 'array', minItems: 0, maxItems: 4, items: newsItem },
    additional_news: { type: 'array', minItems: 0, maxItems: 2, items: newsItem },
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
        bullets: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string' } },
        action_items: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string' } },
        stance: { type: 'string' }
      }
    },
    monitoring_points: { type: 'array', minItems: 4, maxItems: 7, items: { type: 'string' } }
  }
};

let previousTitles = [];
let previousTopics = [];
const previousCanonicalUrls = new Set();

try {
  const previous = JSON.parse(await readFile(outputPath, 'utf8'));
  const previousDate = String(previous?.meta?.briefing_date || '');
  const isPastBriefing = previousDate && previousDate < kstDate();

  if (isPastBriefing) {
    const previousNews = ['critical', 'daily_news', 'subsidiary_news', 'additional_news']
      .flatMap((key) => previous[key] || []);

    previousTitles = previousNews
      .map((item) => item.title)
      .filter(Boolean)
      .slice(0, 20);

    previousTopics = previousNews
      .map((item) => ({
        title: item.title || '',
        entity: item.entity || '',
        risk_type: item.risk_type || '',
        summary: item.summary || ''
      }))
      .filter((item) => item.title || item.summary)
      .slice(0, 20);

    for (const item of previousNews) {
      try {
        if (item?.url) previousCanonicalUrls.add(canonicalUrlKey(item.url));
      } catch {}
    }
  }
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
이전 브리핑에 이미 사용된 URL은 후보에서 절대 제외하라: ${JSON.stringify([...previousCanonicalUrls])}
이전 브리핑 제목은 중대한 신규 사실이 있을 때만 다시 후보에 포함하라: ${JSON.stringify(previousTitles)}
이전 브리핑의 사건·주제와 사실상 같은 경우에는 URL과 언론사가 달라도 후보에서 제외하라. 예를 들어 같은 기업의 같은 제재·사고·실적·자본조달·정책발표·통계발표를 다른 매체가 보도한 기사는 새로운 기사로 보지 마라. 이전 브리핑 주제 참고 자료: ${JSON.stringify(previousTopics)}
각 후보에 제목, 매체·기관, 게시 일시, 직접 URL, 확인된 사실, 우리금융 CRO 중요성, 리스크 유형, 긴급도, 근거 신뢰도와 확인할 질문을 포함하라. 제목은 반드시 원문 기사의 실제 헤드라인을 그대로 가져와라. "이데일리 금융권 기사입니다", "금융권 동향관련보도", "증권금융시장 관련보도", "우리은행 해외현지법인 관련보도", "계열사 관련보도" 같이 매체명·카테고리·그룹명만 조합한 문장을 제목으로 만들지 마라. "관련보도"나 "관련 보도"로 끝나는 제목을 절대 만들지 마라. 반드시 원문에 있는 구체적인 기사 제목을 그대로 사용하라. 각 후보 옆에 반드시 해당 기사의 실제 URL과 게시 일시를 정확히 적어라.
모든 한국어 서술은 임원 보고서에 맞는 정중한 합니다체로 작성하라. 문장을 '한다·이다·있다·된다·필요하다'로 끝내지 말고 '합니다·입니다·있습니다·됩니다·필요합니다'로 끝내라.
반드시 웹 검색을 수행하고, 모든 후보 옆에 실제 검색 출처를 인라인 인용으로 붙여라. 이 조사 단계에서는 읽기 쉽고 한국어 조사 메모로 답하되, 마지막에 반드시 메타데이터 블록을 추가하라. 다음 기사는 CRO 리스크 브리핑 후보에서 절대 제외하라: 내부 교육·세미나·행사, 후원·CSR·봉사활동, 인사 발령·조직 개편(리스크 사고와 무관한 것), 홍보성 기사, 체육대회·채용박람회·시상식, 단순 통계 발표(리스크 영향 분석이 없는 것), 일반 행정 공지, 통화안정증권 경쟁입찰·정례모집, 금융위·한국은행·금감원 정기 보도자료, 기관 공식 보도자료(기자가 작성한 언론기사가 아닌 것). 이 기사들은 숫자를 채우기 위해 끼워 넣지 마라. 오직 자본·유동성·신용·시장·운영·사이버·법무·평판·전략 리스크에 직접적 영향이 있는 기사만 후보로 삼아라.
조사 메모를 모두 작성한 후, 마지막에 반드시 다음 블록을 추가하라. 각 후보 기사의 정확한 메타데이터를 포함해야 한다:
[[SOURCE_METADATA]]
[{"url":"실제URL","title":"원문 기사의 실제 헤드라인","published":"게시일시(YYYY-MM-DD 또는 YYYY-MM-DD HH:MM)"}]
[[/SOURCE_METADATA]]
title은 반드시 원문 기사의 실제 헤드라인을 그대로 적어라. "금융권 동향관련보도" 같은 요약형 제목을 만들지 마라. published는 반드시 정확한 게시일시를 적어라. 이 메타데이터는 후보 선정에 직접 사용되므로 정확성이 매우 중요하다.
`;

const koreanMediaDomains = [
  'n.news.naver.com',
  'news.naver.com',
  'finance.naver.com',
  'yna.co.kr',
  'news1.kr',
  'hankyung.com',
  'mk.co.kr',
  'sedaily.com',
  'edaily.co.kr',
  'mt.co.kr',
  'news.bizwatch.co.kr',
  'biz.chosun.com',
  'fnnews.com',
  'asiae.co.kr',
  'etoday.co.kr',
  'ytn.co.kr',
  'infomax.co.kr',
  'heraldcorp.com',
  'donga.com',
  'joongang.co.kr'
];
const globalMediaDomains = [
  'reuters.com', 'bloomberg.com', 'ft.com', 'wsj.com', 'cnbc.com',
  'apnews.com', 'nikkei.com', 'economist.com', 'marketwatch.com',
  'finance.yahoo.com'
];
const officialDomains = [
  'fsc.go.kr', 'fss.or.kr', 'bok.or.kr', 'moef.go.kr', 'kofia.or.kr',
  'krx.co.kr', 'dart.fss.or.kr', 'kdic.or.kr', 'woorifg.com',
  'wooribank.com', 'bis.org', 'fsb.org', 'imf.org',
  'federalreserve.gov', 'ecb.europa.eu'
];
const wooriSubsidiaryKeywords = [
  '우리금융', '우리금융지주', '우리은행', '우리카드', '우리금융캐피탈',
  '우리종합금융', '우리자산운용', '우리금융저축은행', '우리투자증권',
  '우리에프아이에스', '우리글로벌자산운용', '동양생명', 'ABL생명',
  '우리아메리카', 'Woori America', '우리소다라', 'Woori Saudara', 'Bank Woori Saudara',
  '우리은행 캄보디아', '우리은행 브라질', '우리은행 중국', '베트남우리은행'
];

function mentionsWooriSubsidiary(item) {
  // subsidiary_news 판정은 모델이 만든 entity·summary가 아니라
  // 실제 기사 제목만 기준으로 합니다.
  const title = String(item.title || '').trim();

  if (!title) return false;

  const competitorKeywords = [
    'KB금융', 'KB국민', 'KB국민은행',
    '신한금융', '신한은행', '신한카드', '신한투자증권',
    '하나금융', '하나은행', '하나카드', '하나증권',
    'NH농협', '농협금융', '농협은행',
    'IBK기업은행', '기업은행',
    '한국금융지주', '한국투자증권'
  ];

  // 경쟁사가 제목에 등장하면, 우리금융 관련 표현이 함께 있어도
  // 계열사 뉴스가 아닌 daily_news 후보로만 처리합니다.
  if (competitorKeywords.some((keyword) => title.includes(keyword))) {
    return false;
  }

  // 실제 기사 제목에 우리금융 또는 계열사명이 직접 등장해야 합니다.
  return wooriSubsidiaryKeywords.some((keyword) => title.includes(keyword));
}
if (competitorKeywords.some((keyword) => title.includes(keyword))) {
  return false;
}

function isCompetitorFinancialArticle(item) {
  const title = String(item?.title || '').trim();

  return competitorKeywords.some((keyword) => title.includes(keyword));
}

function moveMisplacedSubsidiaryNews(candidate) {
  candidate.critical ||= [];
  candidate.daily_news ||= [];
  candidate.subsidiary_news ||= [];
  candidate.additional_news ||= [];

  const existingDailyUrls = new Set(
    candidate.daily_news
      .map((item) => {
        try {
          return canonicalUrlKey(item.url);
        } catch {
          return '';
        }
      })
      .filter(Boolean)
  );

  const validSubsidiaryNews = [];

  for (const item of candidate.subsidiary_news) {
    const isDirectWooriArticle =
      isFromResearchStage(item.url, 'woori_media') &&
      mentionsWooriSubsidiary(item);

    if (isDirectWooriArticle) {
      validSubsidiaryNews.push(item);
      continue;
    }

    // 신한·KB·하나 등 경쟁사 기사는 버리지 않고 daily_news로 이동합니다.
    if (isCompetitorFinancialArticle(item)) {
      try {
        const key = canonicalUrlKey(item.url);

        if (!existingDailyUrls.has(key)) {
          item.critical = false;
          candidate.daily_news.push(item);
          existingDailyUrls.add(key);

          console.log(
            `Moved competitor article from subsidiary_news to daily_news: ${item.title}`
          );
        }
      } catch {}
      continue;
    }

    // 우리금융 직접 관련이 아닌 해외 일반기업·일반 사이버·일반 시장 기사는 제외합니다.
    console.log(
      `Removed unrelated article from subsidiary_news: ${item.title || '제목 미확인'}`
    );
  }

  candidate.subsidiary_news = validSubsidiaryNews;
}
function extractDateFromPublished(publishedText) {
  const match = String(publishedText || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[0] : '';
}

function parsePublishedKst(publishedText) {
  const text = String(publishedText || '');
  const dateMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!dateMatch) return { date: null, hasTime: false };
  const datePart = dateMatch[0];
  const timeMatch = text.match(/(\d{2}):(\d{2})/);
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
    const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
    return hostname.endsWith('.go.kr') || hostname.endsWith('.gov') ||
      officialDomains.some((domain) => hostMatchesDomain(hostname, domain));
  } catch {
    return false;
  }
}

function isLikelyListingUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/\/+$/, '');
    const hasArticleId = /\d{4,}/.test(path) || [...url.searchParams.keys()].some((key) =>
      /^(idx|id|no|seq|article|article_id|nttId|bbsId)$/i.test(key) && url.searchParams.get(key)
    );
    const looksLikeSearch = !hasArticleId && [...url.searchParams.keys()].some((key) =>
      /^(query|keyword|search|searchword|srchtext|srchkey)$/i.test(key) && url.searchParams.get(key)
    );
    const knownBoardRoot = /\/(no\d{6}|po\d{6})$/i.test(path);
    return looksLikeSearch || knownBoardRoot || (!hasArticleId && /\/(news|search|list|bbs)$/i.test(path));
  } catch {
    return true;
  }
}

function sourceUrlQuality(rawUrl) {
  try {
    const url = new URL(rawUrl);
    let score = 0;
    if (!isLikelyListingUrl(rawUrl)) score += 100;
    if (/\d{4,}/.test(url.pathname)) score += 20;
    score -= [...url.searchParams.keys()].filter((key) => key.toLowerCase().startsWith('utm_')).length * 5;
    score -= url.search.length / 100;
    return score;
  } catch {
    return -1000;
  }
}

async function researchStage(label, scope, allowedDomains, minimumSources = 4) {
  let best = { narrative: '', source_urls: [], source_data: [] };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const body = await requestOpenAi(label, {
      model,
      input: `당신은 CRO STAFF의 조사 담당자다.\n\n조사 범위:\n${scope}\n\n공통 조사 규칙:\n${commonResearchRules}`,
      tools: [{
        type: 'web_search',
        search_context_size: 'high',
        ...(allowedDomains && allowedDomains.length > 0 ? { filters: { allowed_domains: allowedDomains } } : {}),
        user_location: { type: 'approximate', country: 'KR', timezone: 'Asia/Seoul' }
      }],
      max_tool_calls: 3,
      include: ['web_search_call.action.sources'],
      store: false,
      reasoning: { effort: 'low' },
      text: { verbosity: 'medium' },
      max_output_tokens: 12000
    });
    const narrative = extractOutputText(body);
    const sourceData = extractSourceData(body);
    const narrativeMappings = parseSourceMappingFromNarrative(narrative);
    if (narrativeMappings.length > 0) {
      console.log(`${label} extracted ${narrativeMappings.length} title/date mappings from narrative.`);
    }
    const combinedData = [...sourceData];
    for (const mapping of narrativeMappings) {
      try {
        const mKey = canonicalUrlKey(mapping.url);
        const existing = combinedData.find((d) => {
          try { return canonicalUrlKey(d.url) === mKey; } catch { return false; }
        });
        if (existing) {
          if ((!existing.title || existing.title.length < 5) && mapping.title) existing.title = mapping.title;
          if (!existing.published && mapping.published) existing.published = mapping.published;
        } else {
          try {
            const mUrl = new URL(mapping.url);
            if (['http:', 'https:'].includes(mUrl.protocol) && !isLikelyListingUrl(mapping.url)) {
              combinedData.push(mapping);
            }
          } catch {}
        }
      } catch {}
    }
    const sourceUrls = combinedData.map((s) => s.url);
    if (narrative && sourceUrls.length > best.source_urls.length) best = { narrative, source_urls: sourceUrls, source_data: combinedData };
    if (narrative && sourceUrls.length >= minimumSources) {
      console.log(`${label} collected ${sourceUrls.length} verified source URLs.`);
      return { narrative, source_urls: sourceUrls, source_data: combinedData };
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
  `한국 금융시장·금융회사 리스크 관련 일반 언론기사를 조사하라.
후보는 네이버 메인뉴스 및 네이버 경제뉴스 기사 링크(n.news.naver.com, news.naver.com, finance.naver.com)를 최우선으로 사용하라.
네이버 기사 링크가 충분하면 후보 6~8건 중 최소 4건 이상은 네이버 뉴스 직접 링크로 제시하라.
네이버에 적합한 기사가 부족할 때만 연합뉴스·주요 경제지·금융전문매체의 원문 링크를 보완적으로 사용하라.
금리·환율·유동성·부동산 PF·가계·기업 신용·자본규제·소비자보호·사이버·운영리스크와 금융회사 사건을 점검하라.
정부기관 보도자료가 아니라 기자가 작성한 기사 원문만 후보로 제시하라. 같은 정책이라도 시장·금융회사 파급효과를 분석한 언론기사를 우선하라.`,
  koreanMediaDomains,
  5
);
await coolDown('Korean financial media research');

const wooriMedia = await researchStage(
  'Woori Financial Group media research',
  `한국 주요 통신사·경제지·금융 전문매체 및 네이버뉴스에서 우리금융그룹 및 계열사에 관한 일반 언론기사를 전용으로 조사하라. 네이버뉴스(news.naver.com, finance.naver.com)의 검색 결과를 적극적으로 활용하라.
우리금융지주, 우리은행, 우리카드, 우리금융캐피탈, 우리종합금융, 우리자산운용, 우리금융저축은행, 우리투자증권, 우리에프아이에스, 동양생명, ABL생명 관련 보도를 빠짐없이 점검하라.
우리은행 해외지점 및 해외 현지법인인 우리아메리카은행, 우리소다라 등의 직접 관련 보도도 조사하라.
기업 홈페이지·공시 링크가 아니라 기자가 작성한 기사 원문을 후보로 최소 6건 최대 8건 제시하라.`,
  koreanMediaDomains,
  5
);
await coolDown('Woori Financial Group media research');

const peerMedia = await researchStage(
  'Peer competitor media research',
  `한국 주요 통신사·경제지·금융 전문매체 및 네이버뉴스에서 국내 주요 금융 경쟁사의 일반 언론기사를 전용으로 조사하라. 네이버뉴스(news.naver.com, finance.naver.com)의 검색 결과를 적극적으로 활용하라.
KB금융, 신한금융, 하나금융, NH농협금융, IBK기업은행, 한국금융지주 및 주요 은행·증권·보험·카드사의 자본, 건전성, 유동성, 인수합병, 제재, 금융사고, 소비자보호, 실적과 리스크 변화를 점검하라.
우리금융그룹 관련 기사는 이 조사 단계의 후보로 넣지 말고, 경쟁사 변화가 우리금융그룹의 자본·유동성·신용·시장·운영·준법·평판 리스크에 주는 시사점을 함께 적어라.
기업 홈페이지·공시 링크가 아니라 기자가 작성한 기사 원문을 후보로 최소 6건 최대 8건 제시하라.`,
  koreanMediaDomains,
  5
);
await coolDown('Peer competitor media research');

const globalMedia = await researchStage(
  'Global financial media research',
  `Reuters, Bloomberg, FT, WSJ, CNBC, AP, Nikkei 등 신뢰도 높은 글로벌 언론에서 우리금융그룹으로 전이될 수 있는 일반 금융기사를 조사하라.
금리·달러·채권·주식·원자재·지정학·해외 상업용 부동산·은행 건전성·사이버·제재·AML 변화를 점검하라.
기관 발표문 자체보다 기자가 취재·작성한 기사 원문을 후보로 최대 8건 제시하라.`,
  globalMediaDomains,
  4
);
await coolDown('Global financial media research');

const researchEvidence = {
  korean_media: domesticMedia,
  woori_media: wooriMedia,
  peer_media: peerMedia,
  global_media: globalMedia
};
const sourceStagesByCanonical = new Map();

for (const [stage, evidence] of Object.entries(researchEvidence)) {
  for (const sourceUrl of evidence.source_urls || []) {
    try {
      const key = canonicalUrlKey(sourceUrl);

      if (!sourceStagesByCanonical.has(key)) {
        sourceStagesByCanonical.set(key, new Set());
      }

      sourceStagesByCanonical.get(key).add(stage);
    } catch {}
  }
}

function isFromResearchStage(rawUrl, stage) {
  try {
    return sourceStagesByCanonical
      .get(canonicalUrlKey(rawUrl))
      ?.has(stage) === true;
  } catch {
    return false;
  }
}

function isNaverNewsUrl(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/^www\./, '');

    return [
      'n.news.naver.com',
      'news.naver.com',
      'finance.naver.com'
    ].some((domain) => hostMatchesDomain(hostname, domain));
  } catch {
    return false;
  }
}
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
if (researchedUrlByCanonical.size < 10) {
  throw new Error(`Research produced only ${researchedUrlByCanonical.size} unique source URLs; at least 10 are required.`);
}
const researchedTitleByUrl = new Map();
const researchedDateByUrl = new Map();
for (const sourceData of Object.values(researchEvidence).flatMap((evidence) => evidence.source_data || [])) {
  const canonicalKey = canonicalUrlKey(sourceData.url);
  if (sourceData.title && !researchedTitleByUrl.has(canonicalKey)) {
    researchedTitleByUrl.set(canonicalKey, sourceData.title);
  }
  if (sourceData.published && !researchedDateByUrl.has(canonicalKey)) {
    researchedDateByUrl.set(canonicalKey, sourceData.published);
  }
}
function getResearchedMeta(itemUrl) {
  try {
    const canonicalKey = canonicalUrlKey(itemUrl);
    let researchedUrl = researchedUrlByCanonical.get(canonicalKey);
    if (!researchedUrl) {
      const pathMatches = researchedUrlsByPath.get(urlPathKey(itemUrl)) || [];
      if (pathMatches.length === 1) researchedUrl = pathMatches[0];
    }
    if (!researchedUrl) return null;
    const verifiedKey = canonicalUrlKey(researchedUrl);
    return {
      title: researchedTitleByUrl.get(verifiedKey) || '',
      published: researchedDateByUrl.get(verifiedKey) || '',
      researchedUrl
    };
  } catch {
    return null;
  }
}

console.log(`Extracted ${researchedTitleByUrl.size} article titles and ${researchedDateByUrl.size} article dates from research sources.`);
function buildSynthesisPrompt() {
  return `
당신은 우리금융그룹 전체 CRO를 지원하는 전략 비서 CRO STAFF다. 실행일은 ${date} KST다.
아래 네 조사팀의 웹 조사 메모와 검증 출처 URL만 사용하여 최종 데일리 브리핑을 작성하라. 조사 메모에 없는 사실과 수치를 새로 만들지 마라.

우선순위: 1. 한국 금융시장 리스크 2. 한국 금융 규제·정책 변화 3. 국내 금융 경쟁사 동향 4. 글로벌 금융시장 및 해외 규제·정책 5. 우리금융그룹과 계열사 직접 영향은 범주와 관계없이 상향
언어 규칙 (반드시 준수): - summary, why_woori_cro, watchpoints, entity, channel, risk_type 등 분석 텍스트 필드는 반드시 자연스러운 한국어로 작성한다. - title은 URL별 실제 기사 제목 매핑에 있는 제목을 그대로 사용한다. 외국어 원문 제목은 임의로 번역하거나 바꾸지 마라. - 고유명사(인명, 기관명, 기업명, 상품명)는 널리 쓰이는 한국어 표기(예: 로이터, 블룸버그, 연준)를 사용하고, 필요하면 괄호 안에 원어를 병기할 수 있다.
카테고리별 리서치 출처 우선순위 (daily_news 구성 시 반드시 준수): - daily_news는 korean_media와 peer_media 조사 결과를 우선적으로 사용한다. 우리금융그룹 및 계열사 직접 영향 기사는 woori_media 조사 결과를 우선 사용하되 subsidiary_news 배치를 먼저 검토한다. global_media(Reuters, Bloomberg, FT, CNBC 등) 기사는 daily_news 전체의 약 30% 이내로 제한한다. - global_media 기사는 한국 금융시장이나 우리금융그룹에 직접적인 영향이 있는 경우에만 선택하고, 단순 해외 시황 소개성 기사는 선택하지 않는다.

- daily_news는 한국 기사 중심으로 구성하라. 네이버 메인뉴스·네이버 경제뉴스에서 주요하게 다뤄진 사안을 우선 선정하되, 출처 URL은 네이버 링크 또는 해당 언론사의 원문 링크를 모두 허용한다.
- global_media 단독 출처 기사는 전체 기사 중 최대 20%까지만 허용한다. 글로벌 기사는 한국 금융시장, 원화·채권·유동성 또는 우리금융그룹에 직접 전이될 가능성이 높은 경우만 선택하라.
- subsidiary_news에는 woori_media 조사 단계에서 수집된 URL 중 실제 기사 제목에 우리금융지주·우리은행·우리카드·우리금융캐피탈·우리투자증권·동양생명·ABL생명 등 우리금융 계열사명이 직접 등장하는 기사만 넣어라. - 신한금융·신한은행·KB금융·KB국민은행·하나금융·하나은행·NH농협·IBK기업은행·한국금융지주 등 경쟁사명이 기사 제목에 등장하면, 우리금융이 본문에서 언급되거나 비교 대상이어도 subsidiary_news에 넣지 마라. 해당 기사는 daily_news 후보로만 검토하라.
- 해외 일반 기업, 해외 일반 사이버 공격, 해외 시장 동향, 경쟁사 단독 기사, 우리금융과 무관한 기업 기사는 subsidiary_news에 절대 넣지 마라.
- 우리금융 직접 관련 기사가 없으면 subsidiary_news는 빈 배열([])로 제출하라. 기사의 수를 채우기 위해 무관한 뉴스를 넣는 것을 절대 금지한다.

최종 선정 규칙:
- 전체 기사는 최소 10건을 목표로 선정한다. critical(크리티컬)은 최소 1건은 반드시 포함하고, 나머지는 daily_news, subsidiary_news, additional_news 사이에서 그날 확보된 조사 근거의 양과 질에 맞게 자유롭게 배분한다.
- 특정 카테고리에 오늘 조건을 만족하는 기사가 부족하면 억지로 채우지 말고, 다른 카테고리에서 조건을 만족하는 기사를 더 선정해서 전체 합계 10건을 채운다.
- subsidiary_news를 채울 때는 다음 우선순위를 따른다: (1) 국내 우리금융그룹 계열사 관련 기사(오늘자 primary 우선, 부족하면 최근 7일 이내 related도 허용), (2) 우리은행 해외지점·해외 현지법인(캄보디아, 인도네시아, 우리아메리카은행 등) 관련 기사. (1)에서 오늘자 기사가 부족하면 최근 7일 이내 related 기사로 채워라. subsidiary_news에는 일반 시장 뉴스(금리, 환율, 증시, 투자심리, 은행 건전성 등)를 절대 배치하지 마라. subsidiary_news에는 우리금융그룹 또는 계열사에 직접 관련된 기사만 넣어라.조건에 맞는 실제 기사가 없으면 빈 배열([])로 제출하라.일반 시장 뉴스, 해외 일반 기업 뉴스, 단순 사이버 뉴스로 빈자리를 채우는 것은 절대 금지한다.
- 전체 기사는 10건을 목표로 선정하되, 검증 가능한 서로 다른 사건이 부족하면 억지로 채우지 마라. 이 경우 최소 8건 이상을 선정하고, 존재하지 않는 기사나 중복 사건을 만들지 마라.
- 우리금융그룹·계열사(subsidiary_news)에는 우리금융지주, 우리은행, 우리카드, 우리금융캐피탈, 우리종합금융, 우리자산운용, 우리금융저축은행, 우리투자증권, 우리에프아이에스, 우리글로벌자산운용, 동양생명, ABL생명 등 국내 계열사 기사, 또는 우리은행 해외지점·현지법인(우리은행 캄보디아, 우리소다라, 우리아메리카은행) 기사만 선택한다. 캄보디아·인도네시아·미국 지역의 일반 금융권 기사(금리, 환율, 증시, 투자심리, 은행 건전성 등)는 subsidiary_news에 절대 포함하지 마라. 그런 기사는 daily_news에만 배치할 수 있다. KB금융, 신한금융, 하나금융, NH농협금융, 한국금융지주 등 다른 금융지주·경쟁사 기사도 subsidiary_news에는 절대 포함하지 마라.
- subsidiary_news에는 우리금융그룹 계열사 또는 우리은행 해외지점·해외 현지법인에 직접 관련된 기사만 선정한다. 다음 우선순위를 따른다: (1) 국내 우리금융그룹 계열사(우리은행, 우리카드, 우리금융캐피탈, 우리종합금융, 우리자산운용, 우리금융저축은행, 우리투자증권, 우리에프아이에스, 우리글로벌자산운용, 동양생명, ABL생명 등) 관련 기사(오늘자 primary 우선, 부족하면 최근 7일 이내 related도 허용), (2) 우리은행 해외지점·해외 현지법인(우리은행 캄보디아, 우리소다라, 우리아메리카은행 등) 관련 기사. subsidiary_news에는 절대로 일반 시장 뉴스(엔화, 환율, 증시, 투자심리, 금리, 은행 건전성 등)를 배치하지 마라. 해당 지역의 일반 금융권 기사는 daily_news에만 배치할 수 있다. subsidiary_news를 빈 배열로 제출하지 마라. 반드시 최소 2건 이상을 채워라.
- 전체 기사 중 기자가 작성한 일반 언론기사(source_type=media)를 최소 60% 이상 선정하고, 감독당국·정부·중앙은행·공시·기업 공식자료(source_type=official)는 나머지 비중으로 선정한다.
- 공식자료는 사실과 수치 검증에 적극 활용하되, 같은 사건의 언론기사가 있으면 독자가 맥락과 파급효과를 이해할 수 있는 언론기사를 대표 원문으로 우선 선정한다.
- Gumloop 예시처럼 연합뉴스, 주요 경제지·금융 전문매체 및 Reuters·Bloomberg·FT·CNBC 등 신뢰도 높은 일반기사가 브리핑의 중심이 되어야 한다.
- critical 기사는 반드시 window를 primary로 표시하며, 실행 시점 기준 최근 36시간 이내에 게시된 기사만 사용한다. published 필드에는 반드시 정확한 게시 시각(시:분 단위)을 KST 기준으로 적는다.
- daily_news와 subsidiary_news를 채우기 위해 related로 표시하는 기사는 최근 7일 이내여야 하며, 전체 기사 중 related는 최대 8건까지 허용한다.
- "오늘자 검증 가능한 기사 없음" 같은 placeholder 문구를 title이나 다른 필드에 넣지 마라. 절대로 가짜 기사를 만들지 마라. 조사 근거 URL 목록에 없는 URL을 사용하지 마라. 10건을 채우기 위해 존재하지 않는 기사를 지어내지 마라. 그런 항목을 만들 수 없으면 조사 근거 안에서 실제로 존재하는 다른 기사로 대체하거나, additional_news에 한해서만 해당 카테고리를 빈 배열로 남긴다.
- 동일 사건과 동일 URL을 제거하고 대표 원문 하나만 남긴다. 서로 다른 매체가 같은 사건(예: 같은 날 발표된 같은 통계, 같은 기관의 같은 공지, 같은 기업의 같은 이슈)을 각자 보도한 경우, URL이 다르더라도 반드시 동일 사건으로 간주하여 가장 상세하고 신뢰도 높은 원문 하나만 남기고 나머지는 절대 선택하지 마라. 예를 들어 "카드론 금리 상승"처럼 같은 주제를 다룬 여러 매체의 기사를 daily_news에 중복 포함시키지 마라. - 통화안정증권 경쟁입찰·정례모집, 금융위·한국은행·금감원 정기 보도자료, 기관 공식 보도자료는 절대 선정하지 마라. 오직 기자가 작성한 언론기사만 선정하라.
- critical, daily_news, subsidiary_news, additional_news 네 카테고리를 통틀어 같은 URL이나 같은 게시물 번호(seq, id 등)를 가진 기사를 두 번 이상 선택하지 마라. 카테고리를 넘나드는 중복도 동일 사건 중복으로 간주하고 반드시 제거하라.
- 만약 특정 사건이 여러 카테고리에 모두 적합해 보이면, 그 사건은 가장 관련성이 높은 카테고리 하나에만 배치하고 다른 카테고리에는 조사 근거 안에서 완전히 다른 사건을 새로 찾아 채워라. url 필드를 빈 문자열이나 추정값으로 채우지 말고, 반드시 조사 근거에 있는 실제 URL만 사용하라.
- URL은 각 조사팀의 source_urls에 있는 값을 글자 하나도 바꾸지 않고 그대로 복사한다.
- 검색결과, 언론사·기관의 뉴스 섹션 첫 화면, 게시판 목록 주소는 기사로 선정하지 않는다. URL 경로 또는 쿼리에 개별 기사·발표 식별자가 있는 직접 링크만 사용한다.
- 이전 브리핑에 사용된 URL은 절대 다시 선택하지 마라. 금지 URL의 정규화 목록은 다음과 같다: ${JSON.stringify([...previousCanonicalUrls])} - 이전 브리핑 제목은 중대한 신규 사실이 있을 때만 다시 포함한다: ${JSON.stringify(previousTitles)} - 이전 브리핑의 제목·요약·대상·리스크 유형을 아래 참고 자료와 비교하라. 같은 사건 또는 사실상 같은 주제라면 다른 언론사·다른 URL·표현 변경 기사라도 다시 선택하지 마라. 단, 새로운 처분·수치·피해 확산·당국 조치·자본 영향 등 독립적인 신규 사실이 확인된 경우에만 예외로 한다: ${JSON.stringify(previousTopics)}
- 확인된 사실과 분석·추론을 구분하고 투자 권고나 확정적 시장 예측을 하지 않는다.

CRO 품질 게이트:
- title 필드에는 반드시 원문 기사의 실제 헤드라인을 그대로 사용하라. "이데일리 금융권 기사입니다", "한국경제 금융권 기사입니다", "금융권 동향관련보도", "증권금융시장 관련보도", "우리은행 해외현지법인 관련보도", "계열사 관련보도" 같이 매체명·카테고리·그룹명만 조합한 문장을 title로 만들지 마라. "관련보도"나 "관련 보도"로 끝나는 제목을 절대 만들지 마라. 원문에 있는 구체적인 기사 제목을 URL별 실제 기사 제목 매핑에 있는 형태 그대로 작성하라. "제목 없음"을 title로 사용하지 마라. title이 없는 기사는 제출하지 마라. URL이 없는 기사도 제출하지 마라.
- 다음 기사는 리스크 영향이 없으므로 절대 선정하지 마라: 내부 교육·행사, 후원·CSR, 인사 발령, 홍보성 기사, 체육대회·시상식·채용박람회, 단순 통계 발표, 일반 행정 공지, 통화안정증권 경쟁입찰·정례모집, 금융위·한국은행·금감원 정기 보도자료, 기관 공식 보도자료. 이런 기사가 조사 근거에 있어도 반드시 제외하라. - 수치, 날짜, 게시 시각, 기관명, 기업명과 근거 신뢰도를 후보 간 비교한다.
- 자본·유동성·신용·시장·운영·사이버·법무/준법·평판·전략 리스크 영향을 평가한다.
- 영향 전파 속도, 영향 범위, 대응 가능 시간, 규제기관 관심으로 긴급도를 판단한다.
- 기사 간 연결고리, 리스크 전이 경로, 오늘 확인할 지표·질문, 단기 모니터링 포인트를 도출한다.
- 모든 문장은 예외 없이 정중한 합니다체를 사용한다. '한다·이다·있다·된다·필요하다·전망된다' 같은 해라체 종결은 금지하고 '합니다·입니다·있습니다·됩니다·필요합니다·전망됩니다'로 쓴다.
- executive_judgment_bullets는 Gumloop 예시처럼 3~4개로 작성한다. 각 항목은 (1) 무슨 변화가 확인되었는지 (2) 그 핵심 수치·맥락은 무엇인지 (3) 그룹 리스크 관점에서 어떤 의미인지를 자연스럽게 이어지는 2문장의 완결된 문장으로 서술한다. "확인된 변화는", "핵심 수치는" 같은 정형화된 라벨 단어를 문장 맨 앞에 그대로 반복해서 쓰지 말고, 자연스러운 문장으로 풀어서 작성한다. executive_judgment에는 이 판단을 충분한 문단으로 종합한다.
- 각 기사 summary는 3~5문장으로 작성한다. 첫 문장에서 매체명과 게시일을 밝히고, 이후 핵심 수치·당사자·발생 경위·현재 상태를 원문 범위 안에서 구체적으로 설명한다. 단순 헤드라인 재진술이나 2문장 요약은 금지한다.
- why_woori_cro는 2~3문장으로 작성한다. 우리은행 또는 관련 계열사에 미치는 자본·유동성·신용·시장·운영·준법·평판·전략 영향과 30~90일 의사결정 포인트를 구체적으로 연결한다.
- watchpoints는 기사마다 2~3개를 제시한다. 기관 발표 일정, 비율·스프레드·연체율·충당금·한도 등 실제로 확인할 지표나 질문으로 작성한다.
- 오늘의 CRO STAFF 인사이트는 기사들을 나열하지 말고 공통 동인, 1차·2차 전이경로, 현재 판단을 뒤집을 조건, 1주·2주·90일 모니터링 행동을 연결한다.

URL별 실제 기사 제목 매핑 (반드시 준수):
각 기사의 title 필드에는 반드시 아래 매핑에 있는 제목을 그대로 복사하라. 임의로 제목을 수정하거나 새로 만들지 마라. 제목이 매핑에 없는 URL은 조사 메모에서 해당 URL에 대응하는 실제 기사 제목을 찾아 사용하라. 매핑에 있는 제목에 언론사명이나 카테고리명이 포함된 경우, 그 부분만 제거하고 실제 기사 제목 부분을 사용하라.
${JSON.stringify([...researchedTitleByUrl.entries()].map(([url, title]) => ({ url, title })))}

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

function titleSimilarity(a, b) {
  const normalize = (s) => String(s || '').replace(/\s+/g, '').replace(/[-_|\u00b7,\[\](){}'"]/g, '').toLowerCase();
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length < 4 || nb.length < 4) return 0;
  const bigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const sa = bigrams(na);
  const sb = bigrams(nb);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const bg of sa) if (sb.has(bg)) intersection += 1;
  return intersection / Math.max(sa.size, sb.size);
}

function narrativeQualityError(candidate, candidateNews) {
  const genericTitlePatterns = ['금융권 기사입니다', '금융권 동향관련보도', '금융권 동향 관련 보도', '증권금융시장 관련보도', '증권금융시장 관련 보도', '금융 기사입니다', '경제 기사입니다', '시장 기사입니다', '관련보도', '관련 보도', '해외현지법인 관련', '해외지점 관련', '계열사 관련보도', '금융권 동향', '증권금융시장', '해당없음', '해당 없음', '해당사항없음', '해당 사항 없음', 'placeholder', 'Placeholder', 'N/A', 'n/a', '제목 없음'];
  const genericTitleItem = candidateNews.find((item) => {
    const title = String(item.title || '');
    return genericTitlePatterns.some((pattern) => title.includes(pattern));
  });
  if (genericTitleItem) {
    return `Article title appeared to be a generic/placeholder instead of the actual headline: "${genericTitleItem.title}"`;
  }
  const irrelevantPatterns = ['교육', '세미나', '후원', 'CSR', '봉사', '체육대회', '시상식', '채용박람회', '환영 행사', '초청 강연'];
  const irrelevantItem = candidateNews.find((item) => {
    const text = `${item.title || ''} ${item.summary || ''}`;
    return irrelevantPatterns.some((pattern) => text.includes(pattern)) &&
           !text.includes('리스크') && !text.includes('제재') && !text.includes('사고') &&
           !text.includes('손실') && !text.includes('규제') && !text.includes('벌금');
  });
  if (irrelevantItem) {
    return `Article appeared to be a non-risk event (education/sponsorship/CSR) incorrectly included: ${irrelevantItem.title}`;
  }
  const narrativeFields = [
    candidate.executive_judgment,
    ...(candidate.executive_judgment_bullets || []),
    ...candidateNews.flatMap((item) => [item.summary, item.why_woori_cro]),
    (candidate.insights || {}).headline,
    ...((candidate.insights || {}).bullets || []),
    ...((candidate.insights || {}).action_items || []),
    (candidate.insights || {}).stance
  ];
  const placeholderPatterns = ['해당없음', '해당 없음', '해당사항없음', '해당 사항 없음', 'placeholder', 'Placeholder', 'N/A', 'n/a'];
  const placeholderItem = candidateNews.find((item) => {
    const text = `${item.title || ''} ${item.summary || ''} ${item.why_woori_cro || ''}`;
    return placeholderPatterns.some((pattern) => text.includes(pattern));
  });
  if (placeholderItem) {
    return `Article contained placeholder text instead of real content: ${placeholderItem.title}`;
  }
  if (narrativeFields.some(usesNonFormalKorean)) {
    return 'Korean narrative used plain 한다체 instead of formal 합니다체.';
  }
  const shortSummary = candidateNews.find((item) => String(item.summary || '').length < 180);
  if (shortSummary) return `Article summary was too short for Gumloop-quality depth: ${shortSummary.title}`;
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

function extractUrlsFromText(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s)]+/g) || [];
  return matches.map((url) => url.replace(/[).,]+$/, ''));
}

function dedupeCandidateNews(candidate) {
  const seen = new Set();
  const cleaned = { ...candidate };
  const now = new Date();
  for (const key of ['critical', 'daily_news', 'subsidiary_news', 'additional_news']) {
    const items = candidate[key] || [];
    const keptItems = [];
    for (const item of items) {
      let normalizedKey;
      try {
        normalizedKey = canonicalUrlKey(item.url);
      } catch {
        continue;
      }
      if (seen.has(normalizedKey)) continue;
      if (previousCanonicalUrls.has(normalizedKey)) continue;
      if (isLikelyListingUrl(item.url)) continue;
      const parsedPublished = parsePublishedKst(item.published);
      if (!parsedPublished.date) continue; // 날짜를 확인할 수 없는 기사는 fallback에서도 제외
      const daysDiff = (now - parsedPublished.date) / (1000 * 60 * 60 * 24);
      if (daysDiff < -0.2 || daysDiff > 7) continue; // 7일보다 오래된 기사는 fallback에서도 제외
      seen.add(normalizedKey);
      item.source_type = isOfficialUrl(item.url) ? 'official' : 'media';
      keptItems.push(item);
    }
    cleaned[key] = keptItems;
  }
  return cleaned;
}

function countNews(candidate) {
  return ['critical', 'daily_news', 'subsidiary_news', 'additional_news']
    .reduce((sum, key) => sum + (candidate[key] || []).length, 0);
}

const MAX_SYNTHESIS_ATTEMPTS = 5;
const badUrls = new Set();

for (let attempt = 1; attempt <= MAX_SYNTHESIS_ATTEMPTS; attempt += 1) {
  const bannedUrlsText = rejectedUrls.size > 0
    ? `\n\n다음 URL은 이전 시도에서 이미 실패했으므로 이번 시도에서 절대 다시 선택하지 마라. 대신 조사 근거 안에 있는 완전히 다른 URL을 선택하라:\n${[...rejectedUrls].join('\n')}`
    : '';
  const dynamicBannedUrlsText = badUrls.size > 0
    ? `\n\n다음 URL은 사용이 금지되었습니다. 절대 사용하지 마십시오:\n${[...badUrls].map((u) => `- ${u}`).join('\n')}`
    : '';
  const synthesisBody = await requestOpenAi('CRO quality-gate synthesis', {     model,     input: `${buildSynthesisPrompt()}${synthesisFeedback ? `\n\n이전 시도 품질 오류:\n${synthesisFeedback}\n이 오류를 모두 고쳐 완전히 새로 선정하라.` : ''}${bannedUrlsText}${dynamicBannedUrlsText}`,     store: false,     reasoning: { effort: 'low' },     text: {       verbosity: 'medium',       format: {         type: 'json_schema',         name: 'cro_staff_daily_briefing',         strict: true,         schema       }     },     max_output_tokens: 32000   });
  let candidate;
  try {
    candidate = parseStructuredOutput(synthesisBody, 'CRO quality-gate synthesis');
  } catch (parseError) {
    synthesisError = parseError;

    // parseStructuredOutput()이 제공한 짧고 안전한 재시도 지시만 사용합니다.
    synthesisFeedback = parseError.retryFeedback ||
      '이전 응답의 형식 검증에 실패했습니다. 유효한 JSON 객체 하나만 반환하십시오.';

    console.warn(
      `${parseError.message} (attempt ${attempt}/${MAX_SYNTHESIS_ATTEMPTS}).`
    );

    if (attempt < MAX_SYNTHESIS_ATTEMPTS) {
      await coolDown('CRO quality-gate synthesis retry');
    }

    continue;
  }

  // Override fabricated titles and dates with actual values from research metadata
  for (const item of ['critical', 'daily_news', 'subsidiary_news', 'additional_news'].flatMap((k) => candidate[k] || [])) {
    const meta = getResearchedMeta(item.url);
    if (meta) {
      if (meta.title && meta.title.length > 5) {
        if (item.title && titleSimilarity(item.title, meta.title) < 0.3) {
          console.log(`Overriding model title with actual headline: "${item.title}" -> "${meta.title}" (URL: ${item.url})`);
        }
        item.title = meta.title;
      }
      if (meta.published) {
        item.published = meta.published;
      }
      if (meta.researchedUrl && item.url !== meta.researchedUrl) {
        item.url = meta.researchedUrl;
      }
    }
  }
  moveMisplacedSubsidiaryNews(candidate);
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
   const minimumRequired = attempt <= 2 ? 8 : 7;

if (candidateNews.length < minimumRequired) {
  throw new Error(
    `Final briefing contained only ${candidateNews.length} articles; ` +
    `at least ${minimumRequired} are required. ` +
    `조사 근거 URL 안에서 서로 다른 실제 기사로 보완하십시오.`
  );
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
        badUrls.add(canonicalUrlKey(item.url));
        if (attempt < MAX_SYNTHESIS_ATTEMPTS) {
          throw new Error(`Article URL was not found in the research source list (possibly fabricated): ${item.title} URL: ${item.url}`);
        }
        console.warn(`Last attempt — skipping article with unverified URL: ${item.title} URL: ${item.url}`);
        continue;
      } else if (item.url !== researchedUrl) {
        console.log(`Normalized researched URL: ${item.url} -> ${researchedUrl}`);
        item.url = researchedUrl;
      }
      const verifiedKey = canonicalUrlKey(item.url);
      // Titles and dates were already overridden with actual values before dedup
      if (previousCanonicalUrls.has(verifiedKey)) {
        throw new Error(`Article URL was already used in the previous briefing: ${item.url}`);
      }
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
// 우리금융 직접 관련 기사가 없는 날에는 subsidiary_news를 빈 배열로 둡니다.
// 무관한 기사를 채우기 위해 넣지 않습니다.
    for (const item of candidate.subsidiary_news || []) {
  if (!isFromResearchStage(item.url, 'woori_media')) {
    throw new Error(
      `Subsidiary news must use a URL found by Woori Financial Group media research: ` +
      `${item.title} URL: ${item.url}`
    );
  }

  if (!mentionsWooriSubsidiary(item)) {
    throw new Error(
      `Subsidiary news must directly name a Woori Financial Group subsidiary in its article title and must not be a competitor article: ` +
      `${item.title} URL: ${item.url}`
    );
  }
}
    candidateNews.forEach((item) => { item.source_type = isOfficialUrl(item.url) ? 'official' : 'media'; });
    const mediaCount = candidateNews.filter((item) => item.source_type === 'media').length;
    const minimumMediaCount = Math.max(3, Math.ceil(candidateNews.length * 0.5));

if (mediaCount < minimumMediaCount) {
  throw new Error(
    `CRO quality-gate synthesis selected only ${mediaCount} media articles; ` +
    `at least ${minimumMediaCount} are required.`
  );
}

// 전체 브리핑에서 global_media 단독 출처 기사는 최대 20%만 허용합니다.
const globalOnlyItems = candidateNews.filter((item) => {
  const isGlobal = isFromResearchStage(item.url, 'global_media');

  const isKoreanOrWooriOrPeer =
    isFromResearchStage(item.url, 'korean_media') ||
    isFromResearchStage(item.url, 'woori_media') ||
    isFromResearchStage(item.url, 'peer_media');

  return isGlobal && !isKoreanOrWooriOrPeer;
});

const maximumGlobalItems = Math.max(1, Math.floor(candidateNews.length * 0.2));

if (globalOnlyItems.length > maximumGlobalItems) {
  throw new Error(
    `Too many global-media articles: ${globalOnlyItems.length}. ` +
    `At most ${maximumGlobalItems} global-only articles are allowed. ` +
    `Replace them with Korean or Naver financial-news articles.`
  );
}

const qualityError = narrativeQualityError(candidate, candidateNews);
    if (qualityError) throw new Error(qualityError);
    briefing = candidate;
    break;
  } catch (error) {
    synthesisError = error;
    synthesisFeedback = error.message;
 const badUrlsFromError = extractUrlsFromText(error.message);

    for (const url of badUrlsFromError) {
      // 이번 합성 시도에서는 재선정하지 않게 금지 목록에만 넣습니다.
      // 실제 조사 근거와 메타데이터에서는 삭제하지 않습니다.
      rejectedUrls.add(url);

      // 조사 근거에 없는 URL만 별도 금지 목록에 추가합니다.
      try {
        const canonicalKey = canonicalUrlKey(url);
        const researchedUrl = researchedUrlByCanonical.get(canonicalKey);

        if (!researchedUrl) {
          badUrls.add(canonicalKey);
        }
      } catch {
        badUrls.add(url);
      }
    }
    if (attempt < MAX_SYNTHESIS_ATTEMPTS) {
      console.warn(
  `${error.message} ` +
  `Blocked ${badUrlsFromError.length} URL(s) for the next synthesis attempt ` +
  `without deleting verified research evidence. ` +
  `Retrying synthesis after TPM cooldown (${attempt}/${MAX_SYNTHESIS_ATTEMPTS}).`
);
      await coolDown('CRO quality-gate synthesis retry');
    }
  }
}
function createFailureBriefing(date, reason) {
  return {
    executive_judgment:
      '오늘의 CRO 브리핑은 조사 출처를 수집했으나 최종 구조화 출력 검증에 실패하여 자동 생성하지 않았습니다. 검증되지 않은 기사나 수치를 임의로 포함하지 않았습니다.',
    executive_judgment_bullets: [
      '조사 단계는 수행되었으나 최종 합성 응답이 유효한 JSON 형식으로 완성되지 않았습니다. 따라서 기사 내용을 추정하거나 임의로 작성하지 않았습니다.',
      '이번 결과는 기사 부재가 아니라 출력 형식 검증 실패에 따른 안전 조치입니다. 다음 자동 실행에서 재생성이 필요합니다.',
      '운영 측면에서는 응답 상태, incomplete 사유, 출력 길이와 원본 출력 미리보기를 확인해야 합니다. 구조화 출력이 정상 완료되기 전에는 본 결과를 의사결정 자료로 사용하지 않아야 합니다.'
    ],
    critical: [],
    daily_news: [],
    subsidiary_news: [],
    additional_news: [],
    forward_looking_points: [],
    insights: {
      headline: '최종 구조화 출력 검증이 필요합니다.',
      bullets: [
        '최종 합성 응답이 유효한 JSON으로 완성되지 않았습니다.',
        '검증되지 않은 기사 정보를 브리핑에 포함하지 않았습니다.',
        '다음 실행에서 로그를 확인한 뒤 자동 생성을 다시 수행해야 합니다.'
      ],
      action_items: [
        'GitHub Actions 로그에서 응답 상태와 incomplete 사유를 확인합니다.',
        'raw output preview를 확인해 출력 중단 또는 문법 오류를 점검합니다.',
        '기사 수와 기사별 서술 분량을 필요 시 추가로 줄입니다.'
      ],
      stance: '검증 가능한 구조화 출력이 생성될 때까지 자동 브리핑 내용을 의사결정에 사용하지 않아야 합니다.'
    },
    monitoring_points: [
      `${date} KST 최종 합성 응답의 상태를 확인합니다.`,
      '구조화 출력의 중단 사유를 확인합니다.',
      '다음 자동 실행에서 정상 기사 배열 생성 여부를 확인합니다.',
      `직전 실패 사유: ${String(reason || '확인되지 않았습니다.')}`
    ],
    meta: {
      fallback_notice: true
    }
  };
}
if (!briefing) {
  // 엄격한 검증은 실패했더라도 실제 후보 기사가 3건 이상이면
  // 빈 실패 안내문 대신 가장 나은 후보를 결과에 남깁니다.
  if (bestFallbackCandidate && bestFallbackCount >= 3) {
    console.warn(
      `Strict validation failed, but preserving the best verified candidate ` +
      `with ${bestFallbackCount} articles.`
    );

    bestFallbackCandidate.critical ||= [];
    bestFallbackCandidate.daily_news ||= [];
    bestFallbackCandidate.subsidiary_news ||= [];
    bestFallbackCandidate.additional_news ||= [];

    briefing = bestFallbackCandidate;
  } else {
    console.warn(
      'No usable candidate with at least 3 articles was produced. ' +
      'Writing a failure notice instead of fabricated news.'
    );

    briefing = createFailureBriefing(date, synthesisError?.message);
  }
}
const allNews = ['critical', 'daily_news', 'subsidiary_news', 'additional_news']
  .flatMap((key) => briefing[key] || []);

const isFailureFallback = briefing?.meta?.fallback_notice === true;

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
    console.warn(`Final briefing contained unverified URL, keeping: ${item.title} URL: ${item.url}`);
  } else if (item.url !== researchedUrl) {
    console.log(`Normalized researched URL: ${item.url} -> ${researchedUrl}`);
    item.url = researchedUrl;
  }
  const verifiedKey = canonicalUrlKey(item.url);
  // Override title and date with actual values in fallback too
  const meta = getResearchedMeta(item.url);
  if (meta) {
    if (meta.title && meta.title.length > 5) {
      item.title = meta.title;
    }
    if (meta.published) {
      item.published = meta.published;
    }
    if (meta.researchedUrl && item.url !== meta.researchedUrl) {
      item.url = meta.researchedUrl;
    }
  }
  if (previousCanonicalUrls.has(verifiedKey)) {
    throw new Error(`Final briefing reused an article URL from the previous briefing: ${item.url}`);
  }
  if (urls.has(verifiedKey)) { console.warn(`Duplicate article URL after normalization, removing: ${item.url}`); continue; }
  urls.add(verifiedKey);
}
if (allNews.length < 3 && !isFailureFallback) {
  throw new Error(
    `Fallback briefing contained only ${allNews.length} articles; at least 3 are required.`
  );
}
// Check fallback quality (warn only, don't reject)
const fallbackQualityError = narrativeQualityError(briefing, allNews);
if (fallbackQualityError) {
  console.warn(`Fallback briefing had quality issues (continuing anyway): ${fallbackQualityError}`);
}
briefing.critical.forEach((item) => { item.critical = true; });
briefing.daily_news.forEach((item) => { item.critical = false; });
briefing.subsidiary_news.forEach((item) => { item.critical = false; });
briefing.additional_news.forEach((item) => { item.critical = false; });

briefing.meta = {
  fallback_notice: briefing?.meta?.fallback_notice === true,
  product: 'CRO Staff News & Critical Monitor',
  perspective: '우리금융그룹 CRO',
  mode: 'daily',
  briefing_date: date,
  generated_at: new Date().toISOString(),
  primary_window: '실행 시점 기준 최근 24시간 (KST), 부족분은 날짜가 표시된 최근 7일 유관·배경 자료',
  research_method: '4 media research stages + independent CRO quality-gate synthesis',
  source_mix: {
    media: allNews.filter((item) => item.source_type === 'media').length,
    official: allNews.filter((item) => item.source_type === 'official').length
  }
};
briefing.insights.as_of = `${date} KST`;

await writeFile(outputPath, `${JSON.stringify(briefing, null, 2)}\n`, 'utf8');
console.log(`Generated ${allNews.length} unique briefing articles for ${date}.`); 
