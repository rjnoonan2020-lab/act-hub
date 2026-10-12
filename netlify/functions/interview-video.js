// netlify/functions/interview-video.js
// Handles: action: 'feedback' → transcribes audio via Whisper, then gets Claude coaching feedback

const https = require('https');

function callClaude(apiKey, messages, maxTokens) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens || 500,
      messages,
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(`Claude API error: ${parsed.error.message}`));
          else {
            const block = parsed.content?.find(b => b.type === 'text');
            resolve(block?.text?.trim() || '');
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('Claude API timeout')); });
    req.write(payload);
    req.end();
  });
}

async function transcribeAudio(apiKey, base64Audio, mimeType) {
  const binaryStr = Buffer.from(base64Audio, 'base64');
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';

  // Use node-fetch style multipart
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const filename = `recording.${ext}`;

  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n` +
    // Priming prompt so Whisper keeps filler words (um, uh, like) instead of cleaning them up
    `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nUmm, so, uh, let me think. Like, I mean, you know, it was, um, kind of a big project. Uh, basically...\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const ending = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([preamble, binaryStr, ending]);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(`Whisper error: ${parsed.error.message}`));
          else resolve(parsed.text || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Whisper timeout')); });
    req.write(body);
    req.end();
  });
}

async function getCoachingFeedback(apiKey, opts) {
  if (!opts.answer || opts.answer.trim().length < 10) {
    return 'No speech detected. Please try again and make sure your microphone is working.';
  }
  const prompt = buildCoachingPrompt({ ...opts, video: true });
  return await callClaude(apiKey, [{ role: 'user', content: prompt }], 600);
}

// ── SHARED COACHING PROMPT ────────────────────────────────────────────────────
// The SAME builder lives in interview-prep.js and interview-video.js so typed,
// spoken and on-camera answers get identical coaching. If you change it, change
// it in both files.
//
// opts: { question, answer, questionType, jd, voice, stage, resume,
//         spoken: { durationSeconds } | null,   // answered out loud (mic or camera)
//         video: bool, framing: {pctInFrame, exits, longestOutSeconds} | null,
//         previous: [{ answer, feedback }] }    // earlier attempts ("Try again")
function buildCoachingPrompt(opts) {
  const question = String(opts.question || '');
  const answer = String(opts.answer || '');
  const questionType = opts.questionType || '';
  const jd = opts.jd || '';
  const resume = opts.resume || '';
  const spoken = opts.spoken || (opts.video ? {} : null);
  const framing = opts.framing || null;
  const previous = Array.isArray(opts.previous) ? opts.previous.filter(p => p && p.answer).slice(-2) : [];
  const q = question.toLowerCase();
  const stage = String(opts.stage || '').toLowerCase();

  const isExclusion = questionType === 'Exclusion Question' ||
    ['salary', 'weakness', 'why did you leave', 'interviewing elsewhere', 'when can you start',
     'where do you see yourself', 'sets you apart', 'best person for this role', 'of all the candidates',
     'why should i hire', "didn't turn out", 'superhero', 'animal'].some(k => q.includes(k));
  const isTellMe = questionType === 'Tell Me About Yourself' || q.includes('tell me about yourself');
  const isBehavioral = questionType === 'Behavioral' || q.startsWith('tell me about a time') ||
    q.startsWith('describe a') || q.startsWith('give me an example');
  const isSenior = stage.includes('11+') || stage.includes('senior');

  // ── Context blocks ──
  const roundMap = {
    screening: 'a SCREENING CALL with a recruiter or HR — they are checking basic fit, interest, and communication',
    'hiring-manager': 'a SECOND INTERVIEW, usually with the hiring manager — they expect real depth on qualifications and how the candidate works',
    supervisor: 'a FINAL INTERVIEW, often with their future boss or a panel — they expect specifics, results, and proof the candidate can do the job',
  };
  const ctx = [];
  if (roundMap[opts.voice]) ctx.push(`INTERVIEW ROUND: The candidate was answering in ${roundMap[opts.voice]}. Calibrate how much depth and specificity you expect to this round.`);
  if (opts.stage) ctx.push(`CANDIDATE CAREER STAGE: ${opts.stage}`);
  if (jd) ctx.push(`JOB CONTEXT:\n${jd.slice(0, 800)}`);
  if (resume && !isExclusion) ctx.push(`CANDIDATE RESUME (for context — if they left out relevant experience from it, point that out):\n${resume.slice(0, 2500)}`);

  // ── How the answer was given ──
  let how = '';
  if (spoken) {
    const len = spoken.durationSeconds ? ` It ran about ${Math.floor(spoken.durationSeconds / 60)}:${String(spoken.durationSeconds % 60).padStart(2, '0')} (target: under 2:00).` : '';
    how = `HOW IT WAS GIVEN: The candidate SPOKE this answer out loud${opts.video ? ' on camera' : ''} and it was transcribed.${len} Ignore small transcription errors.${spoken.fillers ? ` Filler words counted in this answer: ${spoken.fillers}.` : ''}`;
  }
  if (framing && typeof framing.pctInFrame === 'number') {
    const problem = framing.pctInFrame < 85 || framing.exits >= 2;
    how += `\nCAMERA FRAMING (measured by face tracking while they answered): face inside the target frame ${framing.pctInFrame}% of the time, moved out of frame ${framing.exits} time(s), longest stretch out of frame about ${framing.longestOutSeconds} second(s). ` +
      (problem ? 'This IS a problem — in DELIVERY, say plainly that they moved out of the camera frame, roughly how much, and that interviewers notice it; stay centered with the face inside the oval.'
               : 'Framing was fine — do not mention it.');
  }

  // ── Earlier attempts (Try again) ──
  let attempts = '';
  if (previous.length) {
    attempts = `EARLIER ATTEMPTS AT THIS SAME QUESTION (oldest first):\n` +
      previous.map((p, i) => `Attempt ${i + 1} answer: ${String(p.answer).slice(0, 1500)}\nCoaching they received: ${String(p.feedback || '(none)').slice(0, 900)}`).join('\n\n') +
      `\n\nThis is attempt ${previous.length + 1}. Open your FIRST section by comparing directly with their last attempt — name specifically what improved, or say plainly if it did not. In the improvement section, focus on what still needs work instead of repeating issues they already fixed. If they copied the earlier suggested wording nearly word for word, remind them it should sound like them, not a script.`;
  }

  // ── Framework per question type ──
  let role, framework, labels;
  if (isExclusion) {
    role = `You are a skilled career coach reviewing a candidate's answer to an EXCLUSION QUESTION — a trap where answering directly can hurt their chances.`;
    framework = `COACHING FRAMEWORK:
- The goal is to deflect, reframe, or redirect gracefully — NOT answer directly
- Salary: avoid naming a number; redirect to learning more about the role and total package
- Weakness: acknowledge briefly, pivot immediately to growth and mitigation
- Why did you leave: stay positive, focus on moving toward, not away from
- When can you start / interviewing elsewhere: vague, non-committal, preserves leverage
- Where do you see yourself: align with the role without over-committing
- Why should I hire you / what sets you apart: reframe around value delivered, not comparison to unknown candidates
- Personality questions (animal, superhero): pick something, tie it to a professional strength, keep it brief

HOW YOU HANDLED IT: did they deflect or answer directly? THE RISK: what leverage or risk their answer created. TRY ANSWERING IT THIS WAY: a specific reframe or deflection they could say.`;
    labels = ['HOW YOU HANDLED IT', 'THE RISK'];
  } else if (isTellMe) {
    role = `You are a skilled career coach reviewing a candidate's "Tell Me About Yourself" answer — their 60–90 second professional pitch.`;
    framework = `COACHING FRAMEWORK:
- Structure: Present (current role) → Past (relevant background) → Future (why this role)
- 60–90 seconds when spoken, tailored to the role, NOT a biography
- Should NOT start with childhood or walk chronologically through everything
- Should end with a bridge: "...which is why I'm excited about this opportunity"

STRUCTURE: did they follow Present → Past → Future, and was it concise and tailored? WHAT TO STRENGTHEN: the single most important improvement.`;
    labels = ['STRUCTURE', 'WHAT TO STRENGTHEN'];
  } else if (isSenior && isBehavioral) {
    role = `You are a skilled career coach providing interview coaching to a senior professional (11+ years of experience). Use a peer-to-peer tone, not an instructional one.`;
    framework = `COACHING FRAMEWORK:
- Do NOT reference the STAR method or its components by name
- Coach on executive storytelling: clear challenge, decisive action, measurable outcome
- Look for strategic context — organizational scope, leadership influence, business impact
- Flag it if the answer was too operational rather than strategic

WHAT'S WORKING: the single strongest, most specific thing about the answer. WHAT TO STRENGTHEN: the single most important fix.`;
    labels = ["WHAT'S WORKING", 'WHAT TO STRENGTHEN'];
  } else {
    role = `You are a skilled career coach providing targeted interview coaching.`;
    framework = `COACHING FRAMEWORK:
- Did they actually answer the question that was asked?
- ${isBehavioral ? 'Behavioral question: is there a clear situation, the action THEY took, and a specific result (ideally a number)?' : 'Is the answer specific and concrete, with an example or result rather than general claims?'}
- Is it relevant to this job and this interview round?

WHAT'S WORKING: the single strongest thing — specific, not generic. WHAT TO STRENGTHEN: the single most important fix to the content.`;
    labels = ["WHAT'S WORKING", 'WHAT TO STRENGTHEN'];
  }
  if (spoken) labels.push('DELIVERY');
  labels.push('TRY ANSWERING IT THIS WAY');

  const deliveryRule = spoken
    ? `\nDELIVERY: how it sounded — rambling, filler words (um, like, you know), trailing off, pace, and length versus the 2-minute target${framing ? ', plus camera framing' : ''}. If delivery was strong, say so in one sentence.`
    : '';
  const words = (spoken ? 150 : 130) + (previous.length ? 30 : 0);
  const sections = labels.map(l => l === 'TRY ANSWERING IT THIS WAY'
    ? `${l}\n<an example of what to say, in quotation marks: 1–2 sentences in the candidate's own voice, built from what they actually said>`
    : `${l}\n<1–2 sentences>`).join('\n\n');

  return `${role}

INTERVIEW QUESTION: ${question}

CANDIDATE'S ANSWER: ${answer}

${how ? how + '\n\n' : ''}${ctx.length ? ctx.join('\n\n') + '\n\n' : ''}${attempts ? attempts + '\n\n' : ''}${framework}${deliveryRule}
TRY ANSWERING IT THIS WAY is always a short example of what they could actually say, in quotation marks — not general advice. Be direct, warm, and specific.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS — ${labels.length} short sections, each label in capitals on its own line, followed by 1–2 sentences, with a blank line between sections. No bullet points, no markdown, no bold, no intro or sign-off. Keep the whole response under ${words} words.

${sections}`;
}

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

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!anthropicKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };
  if (!openaiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'OPENAI_API_KEY not set' }) };

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { action, audioBase64, mimeType, question, jobDescription, questionType, framing, voice, stage, resume, durationSeconds, previous } = body;

  // Mic-only answers on the typed practice page: transcribe and return the text
  if (action === 'transcribe') {
    if (!audioBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing audio' }) };
    try {
      const transcript = await transcribeAudio(openaiKey, audioBase64, mimeType || 'audio/webm');
      return { statusCode: 200, headers, body: JSON.stringify({ transcript }) };
    } catch (err) {
      console.error('transcribe error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Transcription failed' }) };
    }
  }

  if (action !== 'feedback') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
  }

  if (!audioBase64 || !question) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing audioBase64 or question' }) };
  }

  try {
    const transcript = await transcribeAudio(openaiKey, audioBase64, mimeType || 'audio/webm');
    const feedback = await getCoachingFeedback(anthropicKey, { question, answer: transcript, jd: jobDescription || '', questionType: questionType || '', voice: voice || '', stage: stage || '', resume: (resume || '').trim(), spoken: { durationSeconds: Number(durationSeconds) || 0 }, framing: framing || null, previous: Array.isArray(previous) ? previous : [] });
    return { statusCode: 200, headers, body: JSON.stringify({ transcript, feedback }) };
  } catch (err) {
    console.error('interview-video error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
