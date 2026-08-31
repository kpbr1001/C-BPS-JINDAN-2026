// =====================================================================
//  Beconic · 1차 서면 모의심사 (D) 서버리스 프록시
//  - 기존 A진단 diagnose.js 와 동일 규격 (SSE 스트리밍, 키는 환경변수)
//  - 프런트가 { model, max_tokens, messages } 를 보내면 그대로 Anthropic에 중계
//  - ANTHROPIC_API_KEY 는 Netlify 환경변수에서만 읽음 (브라우저 노출 금지)
//  - 스트리밍(SSE)으로 흘려보내 Netlify 10초 타임아웃 회피
// =====================================================================

export default async (request) => {
  // CORS 프리플라이트
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

  // 프런트에서 온 요청을 Anthropic 규격으로 정규화 (+ 스트리밍 강제)
  const payload = {
    model: body.model || 'claude-sonnet-4-6',
    max_tokens: body.max_tokens || 8000,
    stream: true,
    messages: body.messages || [],
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
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // SSE 스트림을 그대로 프런트로 흘려보냄
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
