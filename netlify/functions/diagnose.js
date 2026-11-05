// netlify/functions/diagnose.js
// ─────────────────────────────────────────────────────────────
// 사업계획서 AI 진단 — Anthropic API 스트리밍 프록시
//
// 역할: 브라우저(index.html)의 요청을 받아 Anthropic API로 중계한다.
//   - API 키는 이 서버에서만 붙인다 (브라우저에 절대 노출 안 함)
//   - Anthropic의 SSE 스트림을 그대로 브라우저로 흘려보낸다
//     → 진단이 40~70초 걸려도 Netlify 함수 타임아웃을 회피
//
// 잠금: 이 사이트 화면이 보내는 진단 요청만 중계한다.
//   - 출처 확인: 같은 사이트(또는 ALLOWED_ORIGINS)에서 온 요청만 허용
//   - 모델 고정, 응답 길이 상한, 메시지 1개·진단 프롬프트 형식·길이 검사
//   - 호출 빈도 제한: IP당 60초에 5회 (아래 config.rateLimit)
//
// 필수: Netlify 환경변수에 ANTHROPIC_API_KEY 등록 후 재배포
// 선택: ALLOWED_ORIGINS (쉼표로 구분한 추가 허용 출처, 예: https://example.com)
// ─────────────────────────────────────────────────────────────

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 12000;
const MAX_PROMPT_CHARS = 120000;
const PROMPT_PREFIX = '당신은 정부·공공 지원사업 사업계획서를 20년간 평가해 온 전문 심사위원이자 컨설턴트입니다.';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const fail = (status, error) => new Response(JSON.stringify({ error }), { status, headers: JSON_HEADERS });

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

// 화면(index.html)이 보내는 진단 요청 형식인지 확인
function checkPayload(payload) {
  if (!payload || typeof payload !== 'object') return '요청 형식이 올바르지 않습니다.';
  if (payload.model !== undefined && payload.model !== MODEL) return '허용되지 않은 모델입니다.';
  const msgs = payload.messages;
  if (!Array.isArray(msgs) || msgs.length !== 1) return '메시지는 1개만 보낼 수 있습니다.';
  const m = msgs[0];
  if (!m || m.role !== 'user' || typeof m.content !== 'string') return '메시지 형식이 올바르지 않습니다.';
  if (!m.content.startsWith(PROMPT_PREFIX)) return '진단 요청 형식이 아닙니다.';
  if (m.content.length > MAX_PROMPT_CHARS) return '문서가 너무 깁니다. 분량을 줄여 다시 시도하세요.';
  return null;
}

export default async (request) => {
  if (!allowedOrigin(request)) {
    return fail(403, '이 사이트에서만 사용할 수 있습니다.');
  }
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 204 });
  }

  if (request.method !== 'POST') {
    return fail(405, 'POST만 허용됩니다.');
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // 키 미설정 — 가장 흔한 배포 실수
    return fail(500, 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. Netlify → Site configuration → Environment variables에서 등록 후 재배포하세요.');
  }

  // 브라우저가 보낸 body: { model, max_tokens, messages }
  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return fail(400, '요청 본문(JSON) 파싱 실패');
  }
  const invalid = checkPayload(payload);
  if (invalid) {
    return fail(invalid.startsWith('문서가 너무') ? 413 : 400, invalid);
  }

  // 스트리밍 강제 (프런트가 SSE를 기대함), 모델·길이는 서버 기준으로 고정
  const requested = Number(payload.max_tokens);
  const body = {
    model: MODEL,
    max_tokens: Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_TOKENS) : MAX_TOKENS,
    messages: [{ role: 'user', content: payload.messages[0].content }],
    stream: true,
  };

  // Anthropic API 호출
  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return fail(502, 'Anthropic API 연결 실패: ' + String(e).slice(0, 200));
  }

  // Anthropic이 에러를 주면(스트림 아님) 그대로 상태·본문 전달
  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(errText, { status: anthropicRes.status, headers: JSON_HEADERS });
  }

  // 성공: SSE 스트림을 그대로 브라우저로 파이프
  return new Response(anthropicRes.body, {
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
  path: '/.netlify/functions/diagnose',
  rateLimit: { windowLimit: 5, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
