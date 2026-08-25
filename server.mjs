import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const reportPath = path.join(rootDir, 'public', 'index.html');
const briefingPath = path.join(rootDir, 'public', 'briefing.json');
const port = Number(process.env.PORT || 8080);
const openAiKey = process.env.OPENAI_API_KEY || '';
const accessToken = process.env.REPORT_ACCESS_TOKEN || '';
const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const dailyLimit = Math.max(1, Number(process.env.DAILY_REQUEST_LIMIT_PER_IP || 30));
const isProduction = process.env.NODE_ENV === 'production';
const rateBuckets = new Map();

if (!openAiKey.startsWith('sk-')) {
  throw new Error('OPENAI_API_KEY is missing or invalid.');
}
if (accessToken.length < 32) {
  throw new Error('REPORT_ACCESS_TOKEN must contain at least 32 characters.');
}

function secureHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  };
}

function json(res, status, body) {
  res.writeHead(status, secureHeaders('application/json; charset=utf-8'));
  res.end(JSON.stringify(body));
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function sameSecret(actual, expected) {
  const a = createHash('sha256').update(String(actual || '')).digest();
  const b = createHash('sha256').update(String(expected || '')).digest();
  return timingSafeEqual(a, b);
}

function isAuthorized(req) {
  return sameSecret(parseCookies(req).cro_report_access, accessToken);
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
  const key = `${kstDay()}:${clientIp(req)}`;
  const used = rateBuckets.get(key) || 0;
  if (used >= dailyLimit) return false;
  rateBuckets.set(key, used + 1);
  if (rateBuckets.size > 5000) {
    for (const existing of rateBuckets.keys()) {
      if (!existing.startsWith(`${kstDay()}:`)) rateBuckets.delete(existing);
    }
  }
  return true;
}

function hasSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  return origin === `${protocol}://${req.headers.host}`;
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
  if (!isAuthorized(req)) return json(res, 401, { error: '보고서 링크 인증이 필요합니다.' });
  if (!hasSameOrigin(req)) return json(res, 403, { error: '허용되지 않은 출처입니다.' });
  if (!consumeRateLimit(req)) return json(res, 429, { error: `일일 질문 한도(${dailyLimit}회)에 도달했습니다.` });

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = error.message === 'request_too_large' ? 413 : 400;
    return json(res, status, { error: status === 413 ? '요청 데이터가 너무 큽니다.' : '요청 형식이 올바르지 않습니다.' });
  }

  const question = String(body.question || '').trim().slice(0, 2000);
  const briefing = body.briefing && typeof body.briefing === 'object' ? body.briefing : {};
  const history = cleanHistory(body.history);
  if (!question) return json(res, 400, { error: '질문을 입력해 주세요.' });

  const input = [
    '아래 JSON은 오늘의 CRO STAFF 브리핑입니다.',
    '질문에 한국어로 간결하고 의사결정 중심으로 답하세요.',
    '확인된 사실과 분석·추론을 구분하고, JSON에 없는 숫자나 사실을 추정하지 마세요.',
    '관련 기사 URL을 답변 마지막에 원문 링크로 명시하세요.',
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
        max_output_tokens: 1200
      }),
      signal: controller.signal
    });
    const response = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('OpenAI request failed with status', upstream.status);
      const message = upstream.status === 429
        ? 'OpenAI 사용량 또는 결제 한도를 확인해 주세요.'
        : 'AI 답변 서버가 요청을 처리하지 못했습니다.';
      return json(res, 502, { error: message });
    }
    const answer = extractOutputText(response);
    if (!answer) return json(res, 502, { error: 'AI 응답에서 답변 텍스트를 찾지 못했습니다.' });
    return json(res, 200, { answer, model });
  } catch (error) {
    const message = error.name === 'AbortError'
      ? 'AI 답변 시간이 초과되었습니다. 다시 시도해 주세요.'
      : 'AI 서버에 연결하지 못했습니다.';
    return json(res, 504, { error: message });
  } finally {
    clearTimeout(timer);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(res, 200, { ok: true, briefing_date: await currentBriefingDate() });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/report/')) {
    const supplied = decodeURIComponent(url.pathname.slice('/report/'.length));
    if (!sameSecret(supplied, accessToken)) return json(res, 404, { error: '유효하지 않은 보고서 링크입니다.' });
    const cookie = [
      `cro_report_access=${encodeURIComponent(accessToken)}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      'Max-Age=2592000',
      isProduction ? 'Secure' : ''
    ].filter(Boolean).join('; ');
    const html = await readFile(reportPath);
    res.writeHead(200, { ...secureHeaders('text/html; charset=utf-8'), 'Set-Cookie': cookie });
    return res.end(html);
  }

  if (req.method === 'GET' && url.pathname === '/') {
    if (!isAuthorized(req)) return json(res, 401, { error: '이메일로 받은 전체 보고서 링크를 사용해 주세요.' });
    const html = await readFile(reportPath);
    res.writeHead(200, secureHeaders('text/html; charset=utf-8'));
    return res.end(html);
  }

  if (req.method === 'GET' && url.pathname === '/briefing.json') {
    if (!isAuthorized(req)) return json(res, 401, { error: '보고서 링크 인증이 필요합니다.' });
    try {
      const briefing = await readFile(briefingPath);
      res.writeHead(200, secureHeaders('application/json; charset=utf-8'));
      return res.end(briefing);
    } catch {
      return json(res, 404, { error: '브리핑 데이터가 아직 생성되지 않았습니다.' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    if (!isAuthorized(req)) return json(res, 401, { ok: false });
    return json(res, 200, { ok: true, model });
  }

  if (req.method === 'POST' && url.pathname === '/api/ask') {
    return handleAsk(req, res);
  }

  return json(res, 404, { error: 'Not found' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`CRO Staff secure briefing server listening on port ${port}`);
});
