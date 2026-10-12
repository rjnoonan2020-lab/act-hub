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

async function getCoachingFeedback(apiKey, question, transcript, jobDescription, questionType, framing = null) {

  // Camera framing measured by face tracking during the recording
  let framingNote = '';
  if (framing && typeof framing.pctInFrame === 'number') {
    const problem = framing.pctInFrame < 85 || framing.exits >= 2;
    framingNote = `\n\nCAMERA FRAMING (measured by face tracking while they answered): their face was inside the target frame ${framing.pctInFrame}% of the time, they moved out of frame ${framing.exits} time(s), and the longest stretch out of frame was about ${framing.longestOutSeconds} second(s). ` +
      (problem
        ? 'This IS a problem: in the delivery-related part of your feedback (DELIVERY if that section exists, otherwise WHAT TO STRENGTHEN), say plainly that they moved out of the camera frame, roughly how much, and that interviewers notice it — stay centered with the face inside the oval.'
        : 'Framing was fine — do not mention it.');
  }
  if (!transcript || transcript.trim().length < 10) {
    return 'No speech detected. Please try again and make sure your microphone is working.';
  }

  const isExclusion = questionType === 'Exclusion Question' ||
    question.toLowerCase().includes('salary') ||
    question.toLowerCase().includes('weakness') ||
    question.toLowerCase().includes('why did you leave') ||
    question.toLowerCase().includes('interviewing elsewhere') ||
    question.toLowerCase().includes('when can you start') ||
    question.toLowerCase().includes('where do you see yourself') ||
    question.toLowerCase().includes('sets you apart') ||
    question.toLowerCase().includes('why should i hire') ||
    question.toLowerCase().includes("didn't turn out") ||
    question.toLowerCase().includes('superhero') ||
    question.toLowerCase().includes('animal');

  const isTellMe = questionType === 'Tell Me About Yourself' ||
    question.toLowerCase().includes('tell me about yourself');

  const isSeniorBehavioral = (
    (questionType || '').toLowerCase().includes('11+') ||
    (questionType || '').toLowerCase().includes('senior')
  ) && (
    questionType === 'Behavioral' ||
    question.toLowerCase().startsWith('tell me about') ||
    question.toLowerCase().startsWith('describe a') ||
    question.toLowerCase().startsWith('give me an example')
  );

  let prompt;

  if (isExclusion) {
    prompt = `You are a skilled career coach reviewing a candidate's answer to an EXCLUSION QUESTION — a trap where answering directly can hurt their chances.

EXCLUSION QUESTION: ${question}

CANDIDATE'S SPOKEN ANSWER (transcribed): ${transcript}${framingNote}

COACHING FRAMEWORK:
- Goal is to deflect, reframe, or redirect gracefully — NOT answer directly
- Salary: avoid naming a number; redirect to learning more about role and total package
- Weakness: acknowledge briefly, pivot to growth and mitigation
- Why did you leave: stay positive, focus on moving toward not away from
- When can you start / interviewing elsewhere: vague, non-committal, preserves leverage
- Where do you see yourself: align with role without over-committing
- Why should I hire you / what sets you apart: reframe around value delivered, not comparison
- Personality questions (animal, superhero): pick something, tie to professional strength, keep brief

Cover: did they deflect or answer directly, what leverage or risk their answer created, and one specific reframe or deflection phrase. Be direct, warm, and concise.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS — 3 short sections, each label in capitals on its own line, followed by 1–2 sentences, with a blank line between sections. No bullet points, no markdown, no bold, no intro or sign-off. Keep the whole response under 120 words.

HOW YOU HANDLED IT
<1–2 sentences>

THE RISK
<1–2 sentences>

TRY ANSWERING IT THIS WAY
<an example of what to say, in quotation marks: 1–2 sentences in the candidate's own voice, built from what they actually said>`;

  } else if (isTellMe) {
    prompt = `You are a skilled career coach reviewing a candidate's "Tell Me About Yourself" answer.

CANDIDATE'S SPOKEN ANSWER (transcribed): ${transcript}${framingNote}

${jobDescription ? `JOB CONTEXT:\n${jobDescription.slice(0, 500)}` : ''}

COACHING FRAMEWORK:
- Structure: Present (current role) → Past (relevant background) → Future (why this role)
- Should be 60-90 seconds when spoken, tailored to role, NOT a biography
- Should NOT go chronologically through entire career
- Should end with a bridge: "...which is why I'm excited about this opportunity"

Cover: did they follow the structure, was it concise and tailored, and one specific improvement. Be direct, warm, and concise.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS — 3 short sections, each label in capitals on its own line, followed by 1–2 sentences, with a blank line between sections. No bullet points, no markdown, no bold, no intro or sign-off. Keep the whole response under 120 words.

STRUCTURE
<1–2 sentences>

WHAT TO STRENGTHEN
<1–2 sentences>

TRY ANSWERING IT THIS WAY
<an example of what to say, in quotation marks: 1–2 sentences in the candidate's own voice, built from what they actually said>`;

  } else if (isSeniorBehavioral) {
    prompt = `You are a skilled career coach providing video interview coaching to a senior executive (11+ years experience).

INTERVIEW QUESTION: ${question}

CANDIDATE'S SPOKEN ANSWER (transcribed): ${transcript}${framingNote}

${jobDescription ? `JOB CONTEXT:\n${jobDescription.slice(0, 500)}` : ''}

COACHING FRAMEWORK:
- Do NOT reference STAR method by name
- Coach on executive storytelling: clear challenge, decisive action, measurable outcome
- Look for strategic context — organizational scope, leadership influence, business impact
- Flag if answer was too operational rather than strategic
- Tone should be peer-to-peer, not instructional

Peer-to-peer tone, direct and concise. Use DELIVERY to note rambling, filler, or trailing off.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS — 4 short sections, each label in capitals on its own line, followed by 1–2 sentences, with a blank line between sections. No bullet points, no markdown, no bold, no intro or sign-off. Keep the whole response under 150 words.

WHAT'S WORKING
<1–2 sentences>

WHAT TO STRENGTHEN
<1–2 sentences>

DELIVERY
<1–2 sentences>

TRY ANSWERING IT THIS WAY
<an example of what to say, in quotation marks: 1–2 sentences in the candidate's own voice, built from what they actually said>`;

  } else {
    prompt = `You are a skilled career coach reviewing a recorded interview answer.

INTERVIEW QUESTION: ${question}

CANDIDATE'S SPOKEN ANSWER (transcribed): ${transcript}${framingNote}

${jobDescription ? `JOB CONTEXT:\n${jobDescription.slice(0, 500)}` : ''}

WHAT'S WORKING is the single strongest thing about the answer. WHAT TO STRENGTHEN covers content — did they answer the question with a clear situation, action, and result — and the most important fix. DELIVERY covers rambling, filler phrases, or trailing off. TRY ANSWERING IT THIS WAY is always a short example of what they could actually say, in quotation marks — not general advice. Be direct, warm, and specific.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS — 4 short sections, each label in capitals on its own line, followed by 1–2 sentences, with a blank line between sections. No bullet points, no markdown, no bold, no intro or sign-off. Keep the whole response under 150 words.

WHAT'S WORKING
<1–2 sentences>

WHAT TO STRENGTHEN
<1–2 sentences>

DELIVERY
<1–2 sentences>

TRY ANSWERING IT THIS WAY
<an example of what to say, in quotation marks: 1–2 sentences in the candidate's own voice, built from what they actually said>`;
  }

  return await callClaude(apiKey, [{ role: 'user', content: prompt }], 500);
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

  const { action, audioBase64, mimeType, question, jobDescription, questionType, framing } = body;

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
    const feedback = await getCoachingFeedback(anthropicKey, question, transcript, jobDescription || '', questionType || '', framing || null);
    return { statusCode: 200, headers, body: JSON.stringify({ transcript, feedback }) };
  } catch (err) {
    console.error('interview-video error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
