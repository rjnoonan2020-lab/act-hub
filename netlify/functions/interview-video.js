// netlify/functions/interview-video.js
// Handles:
//   action: 'feedback' → transcribes audio via OpenAI Whisper, then gets Claude coaching feedback

export default async (request) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!anthropicKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500, headers });
  }
  if (!openaiKey) {
    return new Response(JSON.stringify({ error: 'OPENAI_API_KEY not set' }), { status: 500, headers });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
  }

  const { action, audioBase64, mimeType, question, jobDescription } = body;

  if (action !== 'feedback') {
    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers });
  }

  if (!audioBase64 || !question) {
    return new Response(JSON.stringify({ error: 'Missing audioBase64 or question' }), { status: 400, headers });
  }

  try {
    // ── STEP 1: Transcribe via OpenAI Whisper ────────────────────────────────
    const transcript = await transcribeAudio(openaiKey, audioBase64, mimeType || 'video/webm');

    // ── STEP 2: Get coaching feedback via Claude ─────────────────────────────
    const feedback = await getCoachingFeedback(anthropicKey, question, transcript, jobDescription || '');

    return new Response(JSON.stringify({ transcript, feedback }), { status: 200, headers });

  } catch (err) {
    console.error('interview-video error:', err);
    return new Response(
      JSON.stringify({ error: err.message || 'Internal server error' }),
      { status: 500, headers }
    );
  }
};

// ── TRANSCRIBE AUDIO ──────────────────────────────────────────────────────────

async function transcribeAudio(apiKey, base64Audio, mimeType) {
  // Convert base64 to binary
  const binaryStr = atob(base64Audio);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  // Determine file extension from mime type
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const filename = `recording.${ext}`;

  // Build multipart form data for Whisper
  const formData = new FormData();
  const blob = new Blob([bytes], { type: mimeType });
  formData.append('file', blob, filename);
  formData.append('model', 'whisper-1');
  formData.append('language', 'en');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Whisper API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.text || '';
}

// ── COACHING FEEDBACK ─────────────────────────────────────────────────────────

async function getCoachingFeedback(apiKey, question, transcript, jobDescription) {
  if (!transcript || transcript.trim().length < 10) {
    return 'No speech was detected in your recording. Please try again and make sure your microphone is working.';
  }

  const prompt = `You are a skilled career coach reviewing a recorded interview answer.

INTERVIEW QUESTION:
${question}

CANDIDATE'S SPOKEN ANSWER (transcribed):
${transcript}

${jobDescription ? `JOB CONTEXT:\n${jobDescription.slice(0, 600)}` : ''}

Provide focused video interview coaching feedback in 5–7 sentences covering:

1. Content — did they actually answer the question? Was there a clear situation, action, and result?
2. Delivery signals visible in the transcript — did they ramble, use filler phrases ("um", "like", "you know"), or trail off?
3. The single strongest thing about this answer
4. The single most important thing to fix for next time
5. One specific suggested phrase or reframe they could use

Write in plain paragraph form — no bullet points, no headers. Be direct, warm, and specific. Do not use generic praise.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const block = data.content?.find(b => b.type === 'text');
  return block?.text?.trim() || 'Could not generate feedback.';
}

export const config = {
  path: '/.netlify/functions/interview-video'
};
