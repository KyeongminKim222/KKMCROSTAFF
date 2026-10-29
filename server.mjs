import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// CRO Staff — AI 질문(Q&A) API 전용 서버 (Render).
// 브리핑 웹 페이지와 briefing.json 은 GitHub Pages(docs/)에서 서빙한다. 이 서버는 OpenAI 키를 가진 /api/ask 중계만 담당하고,
// 예전 링크(/, /report/TOKEN)로 들어온 요청은 Pages 로 302 리다이렉트한다.

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const briefingPath = path.join(rootDir, 'docs', 'briefing.json');
const port = Number(process.env.PORT || 8080);
const openAiKey = process.env.OPENAI_API_KEY || '';
const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const dailyLimit = Math.max(1, Number(process.env.DAILY_REQUEST_LIMIT_PER_IP || 30));
const minuteLimit = Math.max(1, Number(process.env.MINUTE_REQUEST_LIMIT_PER_IP || 10));
const pagesBaseUrl = String(process.env.PAGES_BASE_URL || 'https://kyeongminkim222.github.io/KKMCROSTAFF/').replace(/\/+$/, '') + '/';
// 허용 Origin: Pages 도메인(기본) + ALLOWED_ORIGINS(콤마 구분)로 추가. 로컬 미리보기는 NODE_ENV!=production 일 때만.
const allowedOrigins = new Set([
  new URL(pagesBaseUrl).origin,
  ...String(process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
]);
const isProduction = process.env.NODE_ENV === 'production';
const rateBuckets = new Map();
const minuteBuckets = new Map();

if (!openAiKey.startsWith('sk-')) {
  throw new Error('OPENAI_API_KEY is missing or invalid.');
}

function originAllowed(origin) {
  if (!origin) return false;
  if (allowedOrigins.has(origin)) return true;
  if (!isProduction && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!originAllowed(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  };
}

function secureHeaders(req, contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    ...corsHeaders(req)
  };
}

function json(req, res, status, body) {
  res.writeHead(status, secureHeaders(req, 'application/json; charset=utf-8'));
  res.end(JSON.stringify(body));
}

function redirect(req, res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...corsHeaders(req) });
  res.end();
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
}

function kstDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function consumeRateLimit(req) {
  const ip = clientIp(req);
  // 분당 한도 (메모리)
  const minuteKey = `${Math.floor(Date.now() / 60_000)}:${ip}`;
  const usedMinute = minuteBuckets.get(minuteKey) || 0;
  if (usedMinute >= minuteLimit) return { ok: false, reason: `분당 질문 한도(${minuteLimit}회)를 넘었습니다. 잠시 후 다시 시도해 주세요.` };
  minuteBuckets.set(minuteKey, usedMinute + 1);
  if (minuteBuckets.size > 5000) {
    const current = `${Math.floor(Date.now() / 60_000)}:`;
    for (const existing of minuteBuckets.keys()) if (!existing.startsWith(current)) minuteBuckets.delete(existing);
  }
  // 일일 한도 (KST 기준)
  const key = `${kstDay()}:${ip}`;
  const used = rateBuckets.get(key) || 0;
  if (used >= dailyLimit) return { ok: false, reason: `일일 질문 한도(${dailyLimit}회)에 도달했습니다.` };
  rateBuckets.set(key, used + 1);
  if (rateBuckets.size > 5000) {
    for (const existing of rateBuckets.keys()) {
      if (!existing.startsWith(`${kstDay()}:`)) rateBuckets.delete(existing);
    }
  }
  return { ok: true };
}

async function readJsonBody(req, maxBytes = 256_000) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-8).map((item) => ({
    role: item && item.role === 'assistant' ? 'assistant' : 'user',
    content: String((item && item.content) || '').slice(0, 2000)
  }));
}

function extractOutputText(response) {
  const parts = [];
  for (const item of response.output || []) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) parts.push(content.text);
    }
  }
  return parts.join('\n\n').trim();
}

async function currentBriefingDate() {
  try {
    const briefing = JSON.parse(await readFile(briefingPath, 'utf8'));
    return String((briefing.meta || {}).briefing_date || '');
  } catch {
    return '';
  }
}

async function handleAsk(req, res) {
  if (!originAllowed(req.headers.origin)) return json(req, res, 403, { error: '허용되지 않은 출처입니다.' });
  const limit = consumeRateLimit(req);
  if (!limit.ok) return json(req, res, 429, { error: limit.reason });

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = error.message === 'request_too_large' ? 413 : 400;
    return json(req, res, status, { error: status === 413 ? '요청 데이터가 너무 큽니다.' : '요청 형식이 올바르지 않습니다.' });
  }

  const question = String(body.question || '').trim().slice(0, 2000);
  const briefing = body.briefing && typeof body.briefing === 'object' ? body.briefing : {};
  const history = cleanHistory(body.history);
  if (!question) return json(req, res, 400, { error: '질문을 입력해 주세요.' });

  const input = [
    '당신은 우리금융그룹 리스크관리 실무를 돕는 AI 어시스턴트입니다. 한국어로 자연스럽게 대화하듯 답하세요.',
    '아래 JSON은 오늘의 CRO STAFF 브리핑으로, 참고 자료입니다. 질문과 관련 있으면 활용하고, 브리핑에 없는 주제는 일반 지식과 분석으로 자유롭게 답해도 됩니다.',
    '브리핑 기사를 인용할 때는 JSON 내용에 맞게 쓰고, 필요하면 기사 링크를 함께 알려주세요.',
    '',
    '브리핑 JSON:',
    JSON.stringify(briefing).slice(0, 80_000),
    '',
    '최근 대화:',
    history.map((item) => `${item.role}: ${item.content}`).join('\n\n'),
    '',
    '현재 질문:',
    question
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openAiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        input,
        store: false,
        reasoning: { effort: 'low' },
        text: { verbosity: 'medium' },
        max_output_tokens: 3000
      }),
      signal: controller.signal
    });
    const response = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('OpenAI request failed with status', upstream.status);
      const message = upstream.status === 429
        ? 'OpenAI 사용량 또는 결제 한도를 확인해 주세요.'
        : 'AI 답변 서버가 요청을 처리하지 못했습니다.';
      return json(req, res, 502, { error: message });
    }
    const answer = extractOutputText(response);
    if (!answer) return json(req, res, 502, { error: 'AI 응답에서 답변 텍스트를 찾지 못했습니다.' });
    return json(req, res, 200, { answer });
  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'AI 답변 시간이 초과되었습니다. 다시 시도해 주세요.'
      : 'AI 서버에 연결하지 못했습니다.';
    return json(req, res, 504, { error: message });
  } finally {
    clearTimeout(timer);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // CORS preflight (Pages → Render 크로스오리진)
  if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
    if (!originAllowed(req.headers.origin)) return json(req, res, 403, { error: '허용되지 않은 출처입니다.' });
    res.writeHead(204, { ...corsHeaders(req), 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(req, res, 200, { ok: true, briefing_date: await currentBriefingDate() });
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    if (!originAllowed(req.headers.origin)) return json(req, res, 403, { ok: false, error: '허용되지 않은 출처입니다.' });
    return json(req, res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/ask') {
    return handleAsk(req, res);
  }

  // 예전 링크 호환: 브리핑 페이지는 GitHub Pages 로 이동 (판 파라미터 유지)
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/report/'))) {
    return redirect(req, res, pagesBaseUrl + (url.search || ''));
  }
  if (req.method === 'GET' && url.pathname === '/briefing.json') {
    return redirect(req, res, pagesBaseUrl + 'briefing.json');
  }

  return json(req, res, 404, { error: 'Not found' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`CRO Staff Q&A API server listening on port ${port} (pages: ${pagesBaseUrl}, origins: ${[...allowedOrigins].join(', ')})`);
});
