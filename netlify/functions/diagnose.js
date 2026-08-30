// netlify/functions/diagnose.js
// ─────────────────────────────────────────────────────────────
// 사업계획서 AI 진단 — Anthropic API 스트리밍 프록시
//
// 역할: 브라우저(index.html)의 요청을 받아 Anthropic API로 중계한다.
//   - API 키는 이 서버에서만 붙인다 (브라우저에 절대 노출 안 함)
//   - Anthropic의 SSE 스트림을 그대로 브라우저로 흘려보낸다
//     → 진단이 40~70초 걸려도 Netlify 함수 타임아웃을 회피
//
// 필수: Netlify 환경변수에 ANTHROPIC_API_KEY 등록 후 재배포
// ─────────────────────────────────────────────────────────────

export default async (request) => {
  // CORS/프리플라이트 (같은 도메인이면 사실상 불필요하지만 안전하게)
  if (request.method === 'OPTIONS') {
    return new Response('', {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST만 허용됩니다.' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // 키 미설정 — 가장 흔한 배포 실수
    return new Response(
      JSON.stringify({
        error:
          'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다. Netlify → Site configuration → Environment variables에서 등록 후 재배포하세요.',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 브라우저가 보낸 body: { model, max_tokens, messages }
  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return new Response(JSON.stringify({ error: '요청 본문(JSON) 파싱 실패' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 스트리밍 강제 (프런트가 SSE를 기대함)
  const body = {
    model: payload.model || 'claude-sonnet-4-6',
    max_tokens: payload.max_tokens || 12000,
    messages: payload.messages || [],
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
    return new Response(
      JSON.stringify({ error: 'Anthropic API 연결 실패: ' + String(e).slice(0, 200) }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Anthropic이 에러를 주면(스트림 아님) 그대로 상태·본문 전달
  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(errText, {
      status: anthropicRes.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 성공: SSE 스트림을 그대로 브라우저로 파이프
  return new Response(anthropicRes.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
};

// Netlify: 이 함수를 스트리밍 모드로 실행 (긴 응답 타임아웃 회피)
export const config = {
  path: '/.netlify/functions/diagnose',
};
