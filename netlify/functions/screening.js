// =====================================================================
//  Beconic · 1차 서면 모의심사 (D) 서버리스 프록시
//  - 기존 A진단 diagnose.js 와 동일 규격 (SSE 스트리밍, 키는 환경변수)
//  - 프런트(screening.html)가 { model, max_tokens, messages } 를 보내면 검사 후 Anthropic에 중계
//  - ANTHROPIC_API_KEY 는 Netlify 환경변수에서만 읽음 (브라우저 노출 금지)
//  - 스트리밍(SSE)으로 흘려보내 Netlify 10초 타임아웃 회피
//  - 잠금: 같은 사이트 출처만 허용, 모델 고정, 응답 길이 상한,
//          메시지 1개·모의심사 프롬프트 형식·길이 검사, IP당 60초에 5회
//  - 선택 환경변수 ALLOWED_ORIGINS: 쉼표로 구분한 추가 허용 출처
// =====================================================================

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8000;
const MAX_PROMPT_CHARS = 200000;
const PROMPT_PREFIX = '당신은 정부지원사업 서면평가를 수백 건 심사한 평가위원입니다.';

export default async (request) => {
  if (!allowedOrigin(request)) {
    return json({ error: '이 사이트에서만 사용할 수 있습니다.' }, 403);
  }
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 204 });
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method Not Allowed' }, 405);
  }

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) {
    return json(
      { error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. Netlify 사이트 설정에서 등록 후 재배포하세요.' },
      500
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: '요청 본문(JSON) 파싱 실패' }, 400);
  }
  const invalid = checkPayload(body);
  if (invalid) {
    return json({ error: invalid }, invalid.startsWith('문서가 너무') ? 413 : 400);
  }

  // Anthropic 규격으로 정규화 (+ 스트리밍 강제), 모델·길이는 서버 기준으로 고정
  const requested = Number(body.max_tokens);
  const payload = {
    model: MODEL,
    max_tokens: Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_TOKENS) : MAX_TOKENS,
    stream: true,
    messages: [{ role: 'user', content: body.messages[0].content }],
  };

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return json({ error: 'Anthropic 서버 연결 실패: ' + String(e.message || e) }, 502);
  }

  // 업스트림 에러는 그대로 상태코드와 본문을 전달 (프런트가 안내 문구 매핑)
  if (!upstream.ok) {
    const raw = await upstream.text();
    return new Response(raw, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // SSE 스트림을 그대로 프런트로 흘려보냄
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
};

// Netlify: 경로 지정 + IP당 호출 빈도 제한
export const config = {
  path: '/.netlify/functions/screening',
  rateLimit: { windowLimit: 5, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};

// 같은 사이트 화면(또는 ALLOWED_ORIGINS)에서 온 요청인지 확인
function allowedOrigin(request) {
  const source = request.headers.get('origin') || request.headers.get('referer');
  if (!source) return false;
  let origin;
  try { origin = new URL(source); } catch (_) { return false; }
  if (origin.host === new URL(request.url).host) return true;
  const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return extra.includes(origin.origin);
}

// 화면(screening.html)이 보내는 모의심사 요청 형식인지 확인
function checkPayload(body) {
  if (!body || typeof body !== 'object') return '요청 형식이 올바르지 않습니다.';
  if (body.model !== undefined && body.model !== MODEL) return '허용되지 않은 모델입니다.';
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length !== 1) return '메시지는 1개만 보낼 수 있습니다.';
  const m = msgs[0];
  if (!m || m.role !== 'user' || typeof m.content !== 'string') return '메시지 형식이 올바르지 않습니다.';
  if (!m.content.startsWith(PROMPT_PREFIX)) return '모의심사 요청 형식이 아닙니다.';
  if (m.content.length > MAX_PROMPT_CHARS) return '문서가 너무 깁니다. 분량을 줄여 다시 시도하세요.';
  return null;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
