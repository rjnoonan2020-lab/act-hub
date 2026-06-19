// netlify/functions/interview-prep.js
// Handles two actions:
//   action: 'generate' → returns 8-10 tailored interview questions
//   action: 'feedback' → returns coaching feedback on a specific answer

const https = require('https');

// ── HELPERS ──────────────────────────────────────────────────────────────────

function callClaude(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON from Claude API'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(25000, () => {
      req.destroy();
      reject(new Error('Claude API timeout'));
    });

    req.write(payload);
    req.end();
  });
}

function getTextContent(response) {
  if (!response?.content?.length) return '';
  const block = response.content.find(b => b.type === 'text');
  return block?.text || '';
}

// ── GENERATE QUESTIONS ────────────────────────────────────────────────────────

async function generateQuestions(jd, stage, focus) {
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

  const response = await callClaude({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = getTextContent(response);

  // Strip any accidental markdown fences
  const cleaned = raw.replace(/```json\n?/gi, '').replace(/```\n?/gi, '').trim();

  let questions;
  try {
    questions = JSON.parse(cleaned);
  } catch (e) {
    // Try to extract JSON array if there's extra text
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

async function getFeedback(question, answer, jd) {
  const prompt = `You are a skilled career coach providing targeted, honest interview coaching.

INTERVIEW QUESTION: ${question}

CANDIDATE'S ANSWER:
${answer}

${jd ? `JOB CONTEXT (brief excerpt):\n${jd.slice(0, 500)}` : ''}

Provide concise coaching feedback (4–6 sentences). Structure your response as:

1. What's working — what's strong about this answer (be specific, not generic praise)
2. What to improve — the single most important thing to strengthen (specificity of examples, structure, length, relevance to role, missing impact/result)
3. A concrete suggestion — one specific thing they can do or say differently

Be direct and constructive. Use plain language. Do not use bullet points or headers — write in natural paragraph form. Keep it under 120 words.`;

  const response = await callClaude({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  return getTextContent(response).trim();
}

// ── HANDLER ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY environment variable not set' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { action } = body;

  try {
    if (action === 'generate') {
      const { jd, stage, focus } = body;

      if (!jd || jd.trim().length < 50) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Job description is too short. Please paste the full posting.' }),
        };
      }

      const questions = await generateQuestions(jd.trim(), stage || 'new grad', focus || []);
      return { statusCode: 200, headers, body: JSON.stringify({ questions }) };
    }

    if (action === 'feedback') {
      const { question, answer, jd } = body;

      if (!question || !answer || answer.trim().length < 20) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Please provide both a question and a substantive answer.' }),
        };
      }

      const feedback = await getFeedback(question, answer.trim(), jd || '');
      return { statusCode: 200, headers, body: JSON.stringify({ feedback }) };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: `Unknown action: ${action}. Use 'generate' or 'feedback'.` }),
    };

  } catch (err) {
    console.error('interview-prep function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Internal server error' }),
    };
  }
};
