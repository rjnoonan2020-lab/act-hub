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
    const feedback = await getCoachingFeedback(anthropicKey, question, transcript, jobDescription || '', body.questionType || '');

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

async function getCoachingFeedback(apiKey, question, transcript, jobDescription, questionType) {
  if (!transcript || transcript.trim().length < 10) {
    return 'No speech was detected in your recording. Please try again and make sure your microphone is working.';
  }

  // ── EXCLUSION QUESTIONS — coach on deflection, not content ────────────────
  const isExclusion = questionType === 'Exclusion Question' ||
    question.toLowerCase().includes('salary') ||
    question.toLowerCase().includes('weakness') ||
    question.toLowerCase().includes('why did you leave') ||
    question.toLowerCase().includes('interviewing elsewhere') ||
    question.toLowerCase().includes('when can you start') ||
    question.toLowerCase().includes('where do you see yourself') ||
    question.toLowerCase().includes('sets you apart') ||
    question.toLowerCase().includes('why should i hire') ||
    question.toLowerCase().includes('didn't turn out') ||
    question.toLowerCase().includes('superhero') ||
    question.toLowerCase().includes('animal');

  const isTellMe = questionType === 'Tell Me About Yourself' ||
    question.toLowerCase().includes('tell me about yourself');

  let promptBody;

  if (isExclusion) {
    promptBody = `You are a skilled career coach reviewing a candidate's answer to an EXCLUSION QUESTION — a trap question where answering directly can hurt their chances.

EXCLUSION QUESTION:
${question}

CANDIDATE'S SPOKEN ANSWER (transcribed):
${transcript}

COACHING FRAMEWORK FOR EXCLUSION QUESTIONS:
- The goal is NOT to answer directly — it is to deflect, reframe, or redirect gracefully
- For salary questions: the candidate should avoid naming a number, instead redirecting to learning more about the role and total package
- For weakness questions: acknowledge briefly, pivot immediately to growth and mitigation
- For "why did you leave": stay positive, focus on what they're moving toward not away from
- For "when can you start" / "interviewing elsewhere": give vague, non-committal answers that preserve leverage
- For "where do you see yourself": align with the role without over-committing or under-selling
- For "why should I hire you / what sets you apart": reframe around value delivered, not comparison to unknown competitors
- For hypothetical/personality questions (animal, superhero): pick something, tie it to a professional strength, keep it brief

Provide coaching feedback in 5–7 sentences covering:
1. Did they deflect effectively or did they answer directly (which is the mistake)?
2. What leverage or risk was created by their answer?
3. A specific suggested reframe or deflection phrase they could use instead
4. One delivery note (were they confident, hesitant, rambling?)

Write in plain paragraph form — no bullet points, no headers. Be direct, warm, and specific.`;

  } else if (isTellMe) {
    promptBody = `You are a skilled career coach reviewing a candidate's "Tell Me About Yourself" answer — their 60-second professional pitch.

CANDIDATE'S SPOKEN ANSWER (transcribed):
${transcript}

${jobDescription ? `JOB CONTEXT:
${jobDescription.slice(0, 600)}` : ''}

COACHING FRAMEWORK FOR "TELL ME ABOUT YOURSELF":
- This is a pitch, not a biography. It should take 60–90 seconds when spoken aloud.
- Structure: Present (current role/what they do) → Past (relevant background) → Future (why this role/company)
- Should be tailored to the job — generic answers miss the opportunity
- Should NOT start with "I was born in..." or go chronologically through their whole career
- Should end with a bridge to the role: "...which is why I'm excited about this opportunity"

Provide coaching feedback in 5–7 sentences covering:
1. Did they follow Present → Past → Future structure?
2. Was it appropriately concise (60–90 seconds) or did they ramble/cut short?
3. Was it tailored to the role or generic?
4. The strongest part of their pitch
5. One specific suggested improvement or phrase

Write in plain paragraph form — no bullet points, no headers. Be direct, warm, and specific.`;

  } else {
    const isSeniorBehavioral = (
      (questionType || '').toLowerCase().includes('11+') ||
      (questionType || '').toLowerCase().includes('senior')
    ) && (
      questionType === 'Behavioral' ||
      question.toLowerCase().startsWith('tell me about') ||
      question.toLowerCase().startsWith('describe a') ||
      question.toLowerCase().startsWith('give me an example')
    );

    if (isSeniorBehavioral) {
      promptBody = `You are a skilled career coach providing video interview coaching to a senior executive (11+ years experience).

INTERVIEW QUESTION: ${question}

CANDIDATE'S SPOKEN ANSWER (transcribed):
${transcript}

${jobDescription ? `JOB CONTEXT:\n${jobDescription.slice(0, 600)}` : ''}

COACHING FRAMEWORK:
- Do NOT reference STAR method or its components by name
- Coach on executive storytelling: clear challenge, decisive action, measurable outcome
- Look for strategic context — organizational scope, leadership influence, business impact
- Flag if answer was too operational rather than appropriately strategic
- Note delivery: were they concise, confident, and outcome-focused?
- Tone should be peer-to-peer, not instructional

Provide feedback in 5-6 sentences. Plain paragraph form, no bullet points. Direct and concise.`;
    } else {
      promptBody = `You are a skilled career coach reviewing a recorded interview answer.

INTERVIEW QUESTION:
${question}

CANDIDATE'S SPOKEN ANSWER (transcribed):
${transcript}

${jobDescription ? `JOB CONTEXT:\n${jobDescription.slice(0, 600)}` : ''}

Provide focused video interview coaching feedback in 5-7 sentences covering:

1. Content — did they actually answer the question? Was there a clear situation, action, and result?
2. Delivery signals visible in the transcript — did they ramble, use filler phrases ("um", "like", "you know"), or trail off?
3. The single strongest thing about this answer
4. The single most important thing to fix for next time
5. One specific suggested phrase or reframe they could use

Write in plain paragraph form — no bullet points, no headers. Be direct, warm, and specific. Do not use generic praise.`;
    }
  }

  const prompt = promptBody;

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
