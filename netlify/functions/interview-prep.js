// netlify/functions/interview-prep.js
// Handles two actions:
//   action: 'generate' → returns 8-10 tailored interview questions
//   action: 'feedback' → returns coaching feedback on a specific answer

export default async (request, context) => {
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500, headers });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
  }

  const { action } = body;

  try {
    if (action === 'generate') {
      const { jd, stage, focus } = body;

      if (!jd || jd.trim().length < 50) {
        return new Response(
          JSON.stringify({ error: 'Job description is too short. Please paste the full posting.' }),
          { status: 400, headers }
        );
      }

      const questions = await generateQuestions(apiKey, jd.trim(), stage || 'new grad', focus || []);
      return new Response(JSON.stringify({ questions }), { status: 200, headers });
    }

    if (action === 'feedback') {
      const { question, answer, jd } = body;

      if (!question || !answer || answer.trim().length < 20) {
        return new Response(
          JSON.stringify({ error: 'Please provide both a question and a substantive answer.' }),
          { status: 400, headers }
        );
      }

      const feedback = await getFeedback(apiKey, question, answer.trim(), jd || '');
      return new Response(JSON.stringify({ feedback }), { status: 200, headers });
    }

    return new Response(
      JSON.stringify({ error: `Unknown action: ${action}` }),
      { status: 400, headers }
    );

  } catch (err) {
    console.error('interview-prep error:', err);
    return new Response(
      JSON.stringify({ error: err.message || 'Internal server error' }),
      { status: 500, headers }
    );
  }
};

// ── CLAUDE API CALL ───────────────────────────────────────────────────────────

async function callClaude(apiKey, messages, maxTokens = 1500) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const block = data.content?.find(b => b.type === 'text');
  return block?.text || '';
}

// ── GENERATE QUESTIONS ────────────────────────────────────────────────────────

async function generateQuestions(apiKey, jd, stage, focus) {
  const focusStr = focus?.length
    ? focus.join(', ')
    : 'behavioral, role-specific, motivation';

  const prompt = `You are an expert career coach helping a job candidate prepare for an interview.

JOB DESCRIPTION:
${jd.slice(0, 3000)}

CANDIDATE STAGE: ${stage}
FOCUS AREAS REQUESTED: ${focusStr}

Generate exactly 9 interview questions tailored to this specific role and candidate stage.

Return ONLY a valid JSON array. No preamble, no explanation, no markdown fences. Each object must have:
- "type": one of "Behavioral", "Technical", "Motivation", "Culture Fit", "Career Story", "Situational", or "Ask Them"
- "question": the full interview question text

Distribute question types based on the focus areas requested. Make the questions specific to the role — use real language from the job description. Do not use generic filler questions.

For "Ask Them" type questions, phrase them as questions the candidate should ask the interviewer.`;

  const raw = await callClaude(apiKey, [{ role: 'user', content: prompt }], 1500);
  const cleaned = raw.replace(/```json\n?/gi, '').replace(/```\n?/gi, '').trim();

  let questions;
  try {
    questions = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      questions = JSON.parse(match[0]);
    } else {
      throw new Error('Could not parse questions from Claude response');
    }
  }

  if (!Array.isArray(questions) || !questions.length) {
    throw new Error('No questions returned');
  }

  return questions;
}

// ── FEEDBACK ──────────────────────────────────────────────────────────────────

async function getFeedback(apiKey, question, answer, jd) {
  const prompt = `You are a skilled career coach providing targeted, honest interview coaching.

INTERVIEW QUESTION: ${question}

CANDIDATE'S ANSWER:
${answer}

${jd ? `JOB CONTEXT (brief excerpt):\n${jd.slice(0, 500)}` : ''}

Provide concise coaching feedback (4–6 sentences). Structure your response as:

1. What's working — what's strong about this answer (be specific, not generic praise)
2. What to improve — the single most important thing to strengthen
3. A concrete suggestion — one specific thing they can do or say differently

Be direct and constructive. Use plain language. Do not use bullet points or headers — write in natural paragraph form. Keep it under 120 words.`;

  return await callClaude(apiKey, [{ role: 'user', content: prompt }], 400);
}

export const config = {
  path: '/.netlify/functions/interview-prep'
};
