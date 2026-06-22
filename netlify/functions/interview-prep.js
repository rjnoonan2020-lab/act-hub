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

      const questionType = body.questionType || '';
      const feedback = await getFeedback(apiKey, question, answer.trim(), jd || '', questionType);
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

  // ── EXCLUSION QUESTIONS BANK ──────────────────────────────────────────────
  const exclusionBank = [
    "What is your salary expectation for this role?",
    "Tell me about a weakness or fault you have.",
    "Why did you leave your last role?",
    "Are you interviewing elsewhere?",
    "When can you start?",
    "Where do you see yourself in three, five, or seven years?",
    "Tell me about something in your career that didn't turn out as you expected.",
    "Why should I hire you? What sets you apart from all the other candidates?",
    "If you were a car, animal, or superhero — what would you be and why?",
  ];

  const randomExclusion = exclusionBank[Math.floor(Math.random() * exclusionBank.length)];

  // ── FOCUS AREA MAP ────────────────────────────────────────────────────────
  const focusMap = {
    'behavioral (STAR-format) questions': {
      type: 'Behavioral',
      count: 3,
      instruction: 'MUST start with "Tell me about a time when...", "Describe a situation where...", or "Give me an example of your [leadership/planning/problem-solving]..." — designed for STAR-method answers. NEVER start with "How would you..."',
    },
    'role-specific technical questions': {
      type: 'Technical',
      count: 2,
      instruction: 'Reference specific skills, tools, or domain knowledge from the job description.',
    },
    'motivation and culture fit': {
      type: 'Motivation',
      count: 1,
      instruction: 'Ask why they want this role/company or what motivates them. Options: "Why do you want to work here?", "What motivates you professionally?", "What do you do best and how does it apply here?"',
    },
    'career story and transitions': {
      type: 'Career Story',
      count: 1,
      instruction: 'Ask about approach, professional identity, or learning style. Options: "What is your approach to problem solving?", "How do you like to receive feedback?", "What would a former manager say is your biggest strength?", "How do you continue learning professionally?"',
    },
    'salary and offer negotiation': {
      type: 'Exclusion Question',
      count: 1,
      instruction: `Use this EXACT question as written: "${randomExclusion}" — This is a trap/exclusion question where a direct answer can hurt the candidate. They must practice deflecting or reframing.`,
    },
    'questions to ask the interviewer': {
      type: 'Ask Them',
      count: 1,
      instruction: 'A smart question the CANDIDATE asks the interviewer — specific to this job description. About role expectations, team dynamics, success metrics, or growth.',
    },
  };

  // Build from selected focus areas
  const selectedFocus = (focus || []).filter(f => focusMap[f]);
  const defaultFocus = ['behavioral (STAR-format) questions', 'role-specific technical questions', 'motivation and culture fit'];
  const activeFocus = selectedFocus.length ? selectedFocus : defaultFocus;

  const typeInstructions = activeFocus.map(f => focusMap[f]);
  // Reserve 1 slot for "Tell Me About Yourself", distribute remaining 8
  const totalRequested = typeInstructions.reduce((sum, t) => sum + t.count, 0);
  const scale = 8 / totalRequested;

  const typeBreakdown = typeInstructions.map(t => {
    const count = Math.max(1, Math.round(t.count * scale));
    return `- ${count} x "${t.type}": ${t.instruction}`;
  }).join('\n');

  const prompt = `You are an expert career coach generating interview practice questions for a job candidate.

JOB DESCRIPTION:
${jd.slice(0, 3000)}

CANDIDATE STAGE: ${stage}

Generate exactly 8 questions distributed as follows:
${typeBreakdown}

RULES:
- Return ONLY a valid JSON array of exactly 8 objects. No preamble, no explanation, no markdown fences.
- Each object must have exactly two keys:
  - "type": the question type label exactly as specified above
  - "question": the full question text
- Behavioral questions MUST start with "Tell me about a time when...", "Describe a situation where...", or "Give me an example of your [skill]..." — NEVER "How would you..."
- Technical questions must reference actual skills or requirements from the job description
- Exclusion Question must use the exact question text specified above — do not change it
- Ask Them questions must be phrased as questions the CANDIDATE asks the interviewer
- Do not repeat similar questions`;

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

  // Always prepend "Tell Me About Yourself" as question 1
  questions.unshift({
    type: 'Tell Me About Yourself',
    question: 'Tell me about yourself.',
  });

  return questions;
}
// ── FEEDBACK ──────────────────────────────────────────────────────────────────

async function getFeedback(apiKey, question, answer, jd, questionType) {

  const isExclusion = questionType === 'Exclusion Question' ||
    question.toLowerCase().includes('salary') ||
    question.toLowerCase().includes('weakness') ||
    question.toLowerCase().includes('why did you leave') ||
    question.toLowerCase().includes('interviewing elsewhere') ||
    question.toLowerCase().includes('when can you start') ||
    question.toLowerCase().includes('where do you see yourself') ||
    question.toLowerCase().includes('sets you apart') ||
    question.toLowerCase().includes("why should i hire") ||
    question.toLowerCase().includes("didn't turn out") ||
    question.toLowerCase().includes('superhero') ||
    question.toLowerCase().includes('animal');

  const isTellMe = questionType === 'Tell Me About Yourself' ||
    question.toLowerCase().includes('tell me about yourself');

  let prompt;

  if (isExclusion) {
    prompt = `You are a skilled career coach reviewing a candidate's answer to an EXCLUSION QUESTION — a trap where answering directly can hurt their chances.

EXCLUSION QUESTION: ${question}

CANDIDATE'S ANSWER: ${answer}

COACHING FRAMEWORK:
- The goal is to deflect, reframe, or redirect gracefully — NOT answer directly
- Salary: avoid naming a number; redirect to learning more about role and total package
- Weakness: acknowledge briefly, pivot immediately to growth and mitigation
- Why did you leave: stay positive, focus on moving toward not away from
- When can you start / interviewing elsewhere: vague, non-committal, preserves leverage
- Where do you see yourself: align with role without over-committing
- Why should I hire you / what sets you apart: reframe around value delivered, not comparison to unknown competitors
- Personality questions (animal, superhero): pick something, tie to professional strength, keep brief

Provide feedback in 4–5 sentences: did they deflect or answer directly? What leverage/risk did their answer create? Give one specific reframe or deflection phrase they could use. Be direct, warm, and concise.`;

  } else if (isTellMe) {
    prompt = `You are a skilled career coach reviewing a candidate's "Tell Me About Yourself" answer — their 60-second professional pitch.

CANDIDATE'S ANSWER: ${answer}

${jd ? `JOB CONTEXT:
${jd.slice(0, 500)}` : ''}

COACHING FRAMEWORK:
- Structure: Present (current role) → Past (relevant background) → Future (why this role)
- Should be 60–90 seconds when spoken, tailored to the role, NOT a biography
- Should NOT start with birth/childhood or go chronologically through everything
- Should end with a bridge: "...which is why I'm excited about this opportunity"

Provide feedback in 4–5 sentences: did they follow the structure? Was it concise? Was it tailored? Give one specific improvement. Be direct, warm, and concise.`;

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
      prompt = `You are a skilled career coach providing interview coaching to a senior executive (11+ years experience).

INTERVIEW QUESTION: ${question}

CANDIDATE'S ANSWER: ${answer}

${jd ? `JOB CONTEXT:\n${jd.slice(0, 500)}` : ''}

COACHING FRAMEWORK:
- Do NOT reference STAR method or its components by name
- Coach on executive storytelling: clear challenge, decisive action, measurable outcome
- Look for strategic context — organizational scope, leadership influence, business impact
- Flag if answer was too operational rather than strategic
- Tone should be peer-to-peer, not instructional

Provide feedback in 4-5 sentences. Plain paragraph form, no bullet points. Direct and concise.`;
    } else {
      prompt = `You are a skilled career coach providing targeted interview coaching.

INTERVIEW QUESTION: ${question}

CANDIDATE'S ANSWER: ${answer}

${jd ? `JOB CONTEXT:\n${jd.slice(0, 500)}` : ''}

Provide concise coaching feedback in 4-5 sentences:
1. What's working — be specific, not generic
2. The single most important thing to strengthen
3. One concrete suggestion or phrase they could use differently

Be direct and constructive. Plain paragraph form, no bullet points or headers. Under 120 words.`;
    }
  }

  const response = await callClaude(apiKey, [{ role: 'user', content: prompt }], 400);
  return response.trim();
}

export const config = {
  path: '/.netlify/functions/interview-prep'
};
