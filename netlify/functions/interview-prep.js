// netlify/functions/interview-prep.js
// Handles two actions:
//   action: 'generate' → returns 8-10 tailored interview questions
//   action: 'feedback' → returns coaching feedback on a specific answer

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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };
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
      const { jd, stage, focus, voice } = body;
      const resume = (body.resume || '').trim();

      if (!jd || jd.trim().length < 50) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Job description is too short. Please paste the full posting.' }) };
      }

      const questions = await generateQuestions(apiKey, jd.trim(), stage || 'new grad', focus || [], voice || 'screening', resume);
      return { statusCode: 200, headers, body: JSON.stringify({ questions }) };
    }

    if (action === 'feedback') {
      const { question, answer, jd, voice } = body;

      if (!question || !answer || answer.trim().length < 20) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please provide both a question and a substantive answer.' }) };
      }

      const questionType = body.questionType || '';
      const feedback = await getFeedback(apiKey, question, answer.trim(), jd || '', questionType, voice || '', (body.resume || '').trim());
      return { statusCode: 200, headers, body: JSON.stringify({ feedback }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('interview-prep error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
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

async function generateQuestions(apiKey, jd, stage, focus, voice, resume = '') {

  // ── INTERVIEW ROUND MAP ───────────────────────────────────────────────────
  // The interview round (Screening Call → Second Interview → Final Interview)
  // shapes emphasis/tone and how many questions are asked. Keys are kept from
  // the original voice selector so saved sessions keep working:
  //   screening = Screening Call, hiring-manager = Second Interview,
  //   supervisor = Final Interview.
  const voiceMap = {
    screening: {
      label: 'Screening Call',
      instruction: 'This round is a SCREENING CALL with an HR recruiter or talent acquisition coordinator — not the hiring manager or supervisor. They are checking basic qualifications, verifying resume claims, gauging communication and interest, and covering logistics (availability, work authorization). They rarely probe deep technical or functional skill. Keep JD-Based and Technical questions at a surface level ("Have you worked with X?" rather than a deep scenario), and favor broad qualification, motivation, and logistics questions.',
    },
    'hiring-manager': {
      label: 'Second Interview',
      instruction: 'This round is the SECOND INTERVIEW — usually with the hiring manager who owns the role, sometimes with HR or a team member. The candidate has passed screening, so this round goes beyond basic fit. They probe culture fit, motivation, values alignment, and how the candidate works with others and handles ambiguity, alongside a real but not exhaustive review of core qualifications.',
    },
    supervisor: {
      label: 'Final Interview',
      instruction: 'This round is the FINAL INTERVIEW — often with the person the candidate would report to day-to-day, sometimes a panel or senior leader. This round cares most about whether the candidate can actually do the job. Favor JD-Based and Technical questions that dig into specific tools, responsibilities, and day-to-day scenarios named in the job description, and behavioral questions about how the candidate has handled real work situations, over generic culture or motivation questions.',
    },
  };
  const activeVoice = voiceMap[voice] || voiceMap.screening;

  // ── EXCLUSION QUESTIONS BANK ──────────────────────────────────────────────
  const exclusionBank = [
    "Why did you leave your last role?",
    "Are you interviewing elsewhere?",
    "When can you start?",
    "Where do you see yourself in three, five, or seven years?",
    "Tell me about something in your career that didn't turn out as you expected.",
    "Why should I hire you? What sets you apart from all the other candidates?",
    "Why do you think you're the best person for this role?",
    "Of all the candidates we're interviewing, why should we hire you?",
    "If you were a car, animal, or superhero — what would you be and why?",
  ];

  // Pick 2 different random exclusion questions
  const shuffled = [...exclusionBank].sort(() => Math.random() - 0.5);
  const exclusionSample = shuffled.slice(0, 2);

  // ── FOCUS AREA MAP ────────────────────────────────────────────────────────
  const focusMap = {
    'jd-based questions': {
      type: 'JD-Based',
      count: 3,
      instruction: 'Generate questions pulled DIRECTLY from the specific skills, tools, responsibilities, and requirements listed in the job description — but ask the question plainly, without first restating or explaining the JD requirement. Examples: "Walk me through how you have used [specific tool]." or "Tell me about your experience with [specific responsibility]." Do NOT use a lead-in clause like "The role requires X — " or "This position involves X — " before the question. Every question must still be clearly grounded in something explicitly mentioned in the JD, it just shouldn\'t announce that fact before asking.',
    },
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
    'resume-based questions': {
      type: 'Resume',
      count: 3,
      instruction: 'Generate questions drawn DIRECTLY from the candidate\'s resume below — the way a real interviewer reads a resume and asks about it. Mix these angles: walk me through a specific role ("Walk me through your role at [Company]."), expand on a specific accomplishment or number they list ("Your resume mentions [accomplishment] — how did you make that happen?"), explain a transition or gap between roles, or show depth on a skill they list that also matters for this job. Name the actual company, title, project, or result from the resume. Never invent details that are not on the resume.',
    },
    'salary and offer negotiation': {
      type: 'Exclusion Question',
      count: 2,
      instruction: `Generate exactly 2 exclusion/trap questions chosen from this list (pick 2 different ones): "${exclusionSample.join('" or "')}" — These are trap questions where a direct answer can hurt the candidate. They must practice deflecting or reframing. Use each question EXACTLY as written, do not modify them.`,
    },

  };

  // Build from selected focus areas
  const selectedFocus = (focus || []).filter(f => focusMap[f] && (f !== 'resume-based questions' || resume.length >= 100));
  const defaultFocus = ['jd-based questions', 'behavioral (STAR-format) questions'];
  const activeFocus = selectedFocus.length ? selectedFocus : defaultFocus;

  // ── QUESTION COUNT PER ROUND ──────────────────────────────────────────────
  // Later rounds are longer. Totals include "Tell me about yourself" (#1).
  //   Screening Call 9 · Second Interview 12 · Final Interview 15
  // Resume and JD get fixed blocks; the rest is shared across the other
  // selected focus areas. Exclusion questions are capped at 2.
  const roundPlan = {
    screening:        { total: 9,  resume: 3, jd: 2 },
    'hiring-manager': { total: 12, resume: 4, jd: 4 },
    supervisor:       { total: 15, resume: 4, jd: 5 },
  };
  const plan = roundPlan[voice] || roundPlan.screening;
  const T = plan.total - 1; // slots after "Tell me about yourself"

  const alloc = {};
  const hasResume = activeFocus.includes('resume-based questions');
  const hasJd = activeFocus.includes('jd-based questions');
  if (hasResume) alloc['resume-based questions'] = plan.resume;
  // No resume: half of the resume block goes to JD questions, the rest to the other areas
  if (hasJd) alloc['jd-based questions'] = plan.jd + (hasResume ? 0 : Math.ceil(plan.resume / 2));
  // Extra slots go to Behavioral first, then Motivation, Career Story, Exclusion
  const otherOrder = ['behavioral (STAR-format) questions', 'motivation and culture fit', 'career story and transitions', 'salary and offer negotiation', 'role-specific technical questions'];
  const others = activeFocus.filter(f => f !== 'resume-based questions' && f !== 'jd-based questions')
    .sort((a, b) => otherOrder.indexOf(a) - otherOrder.indexOf(b));
  let remaining = T - Object.values(alloc).reduce((a, b) => a + b, 0);
  const cap = f => (focusMap[f].type === 'Exclusion Question' ? 2 : Infinity);
  const fillPool = others.length ? others : Object.keys(alloc);
  let guard = 0;
  while (remaining > 0 && guard++ < 100) {
    let placed = false;
    for (const f of fillPool) {
      if (remaining <= 0) break;
      if ((alloc[f] || 0) >= cap(f)) continue;
      alloc[f] = (alloc[f] || 0) + 1;
      remaining--;
      placed = true;
    }
    if (!placed) {
      // Everything capped (e.g. only Exclusion selected) — fill with Behavioral
      const b = 'behavioral (STAR-format) questions';
      alloc[b] = (alloc[b] || 0) + remaining;
      remaining = 0;
    }
  }

  const typeBreakdown = Object.entries(alloc)
    .filter(([, n]) => n > 0)
    .map(([f, n]) => `- ${n} x "${focusMap[f].type}": ${focusMap[f].instruction}`)
    .join('\n');
  const exclusionOnlyNote = '';

  const prompt = `You are an expert career coach generating interview practice questions for a job candidate.

JOB DESCRIPTION:
${jd.slice(0, 3000)}

CANDIDATE STAGE: ${stage}
${resume ? `
CANDIDATE RESUME (use it so every question fits this person's real background; only "Resume" questions should name specific resume items):
${resume.slice(0, 5000)}
` : ''}
INTERVIEW ROUND: ${activeVoice.instruction}

Generate exactly ${T} questions distributed as follows:
${typeBreakdown}

RULES:
- Return ONLY a valid JSON array of exactly ${T} objects. No preamble, no explanation, no markdown fences.
- Each object must have exactly two keys:
  - "type": the question type label exactly as specified above
  - "question": the full question text
- Do NOT include "Tell me about yourself" — it is added separately.
- CALIBRATE TO BOTH THE CANDIDATE STAGE AND THE INTERVIEW ROUND ABOVE. This is a hard requirement, not a suggestion. The same focus-area categories should be asked differently depending on who's asking. For JD-Based and Technical questions especially: do not simply lift a senior-level JD requirement into a question — translate it to what THIS candidate could plausibly speak to.
  - New grad (0-1 yrs): ask about coursework, class/personal projects, internships, or how they'd approach learning the skill — not production ownership or scaled systems.
  - Early career (1-5 yrs): ask about direct hands-on work and early individual contributions, not org-wide strategy or managing others.
  - Mid-career (5-11 yrs): ask about leadership of a project/team and measurable impact, appropriate to an individual contributor or first-line manager.
  - Senior (11+ yrs): ask about strategic decisions, cross-functional influence, and organizational-level impact.
  - Career changer: ask about transferable experience and how it maps to the requirement, not direct prior use of the specific tool.
- Behavioral questions MUST start with "Tell me about a time when...", "Describe a situation where...", or "Give me an example of your [skill]..." — NEVER "How would you..."
- Technical questions must reference actual skills or requirements from the job description
- Exclusion Question must use the exact question text specified above — do not change it
- Do not repeat similar questions${exclusionOnlyNote}`;

  const raw = await callClaude(apiKey, [{ role: 'user', content: prompt }], 3000);
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

  // Keep only well-formed questions, drop any stray "Tell me about yourself"
  questions = questions.filter(q => q && typeof q.question === 'string' && q.question.trim() &&
    !/tell me about yourself/i.test(q.question));

  // Guarantee the full count: if the model came back short, ask for the rest once
  if (questions.length < T) {
    const missing = T - questions.length;
    const topUpPrompt = `${prompt}

You already wrote these questions — do NOT repeat or closely paraphrase any of them:
${questions.map(q => `- ${q.question}`).join('\n')}

Now return ONLY a JSON array of exactly ${missing} additional question object(s) with the same "type"/"question" keys, choosing types from the distribution above that are under-represented.`;
    try {
      const raw2 = await callClaude(apiKey, [{ role: 'user', content: topUpPrompt }], 1200);
      const c2 = raw2.replace(/```json\n?/gi, '').replace(/```\n?/gi, '').trim();
      const m2 = c2.match(/\[[\s\S]*\]/);
      const extra = JSON.parse(m2 ? m2[0] : c2);
      if (Array.isArray(extra)) {
        questions = questions.concat(extra.filter(q => q && typeof q.question === 'string' && q.question.trim()));
      }
    } catch (e) {
      console.error('Top-up failed:', e.message);
    }
  }
  questions = questions.slice(0, T);

  // Always guarantee "Tell Me About Yourself" as question #1 — it's no longer
  // something the model can generate (removed from focusMap above), so this
  // check will always be true and this always fires.
  const hasTellMe = questions.some(q => q.type === 'Tell Me About Yourself');
  if (!hasTellMe) {
    questions.unshift({
      type: 'Tell Me About Yourself',
      question: 'Tell me about yourself.',
    });
  }

  return questions;
}
// ── FEEDBACK ──────────────────────────────────────────────────────────────────

async function getFeedback(apiKey, question, answer, jd, questionType, voice, resume = '') {

  const resumeNote = resume ? `\n\nCANDIDATE RESUME (for context — if they left out relevant experience from it, point that out in one of your sections):\n${resume.slice(0, 2500)}` : '';

  const voiceLabelMap = {
    screening: 'an HR recruiter on a screening call',
    'hiring-manager': 'the hiring manager in a second interview',
    supervisor: 'their direct supervisor',
  };
  const voiceNote = voiceLabelMap[voice] ? `\n\nCONTEXT: The candidate was answering as if speaking with ${voiceLabelMap[voice]}.` : '';

  const isExclusion = questionType === 'Exclusion Question' ||
    question.toLowerCase().includes('why did you leave') ||
    question.toLowerCase().includes('interviewing elsewhere') ||
    question.toLowerCase().includes('when can you start') ||
    question.toLowerCase().includes('where do you see yourself') ||
    question.toLowerCase().includes('sets you apart') ||
    question.toLowerCase().includes('best person for this role') ||
    question.toLowerCase().includes('of all the candidates') ||
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

Cover: did they deflect or answer directly, what leverage or risk their answer created, and one specific reframe or deflection phrase they could use. Be direct, warm, and concise.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS — 3 short sections, each label in capitals on its own line, followed by 1–2 sentences, with a blank line between sections. No bullet points, no markdown, no bold, no intro or sign-off. Keep the whole response under 120 words.

HOW YOU HANDLED IT
<1–2 sentences>

THE RISK
<1–2 sentences>

TRY THIS
<1–2 sentences>`;

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

${resumeNote}

Cover: did they follow the Present → Past → Future structure, was it concise and tailored, and one specific improvement. Be direct, warm, and concise.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS — 3 short sections, each label in capitals on its own line, followed by 1–2 sentences, with a blank line between sections. No bullet points, no markdown, no bold, no intro or sign-off. Keep the whole response under 120 words.

STRUCTURE
<1–2 sentences>

WHAT TO STRENGTHEN
<1–2 sentences>

TRY THIS
<1–2 sentences>`;

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

${resumeNote}

Peer-to-peer tone, direct and concise.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS — 3 short sections, each label in capitals on its own line, followed by 1–2 sentences, with a blank line between sections. No bullet points, no markdown, no bold, no intro or sign-off. Keep the whole response under 120 words.

WHAT'S WORKING
<1–2 sentences>

WHAT TO STRENGTHEN
<1–2 sentences>

TRY THIS
<1–2 sentences>`;
    } else {
      prompt = `You are a skilled career coach providing targeted interview coaching.

INTERVIEW QUESTION: ${question}

CANDIDATE'S ANSWER: ${answer}
${voiceNote}

${jd ? `JOB CONTEXT:\n${jd.slice(0, 500)}` : ''}

${resumeNote}

WHAT'S WORKING should be specific, not generic. WHAT TO STRENGTHEN is the single most important fix. TRY THIS is one concrete suggestion or phrase they could use instead. Be direct and constructive.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS — 3 short sections, each label in capitals on its own line, followed by 1–2 sentences, with a blank line between sections. No bullet points, no markdown, no bold, no intro or sign-off. Keep the whole response under 130 words.

WHAT'S WORKING
<1–2 sentences>

WHAT TO STRENGTHEN
<1–2 sentences>

TRY THIS
<1–2 sentences>`;
    }
  }

  const response = await callClaude(apiKey, [{ role: 'user', content: prompt }], 400);
  return response.trim();
}
