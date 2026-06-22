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

async function getCoachingFeedback(apiKey, question, transcript, jobDescription, questionType) {
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

CANDIDATE'S SPOKEN ANSWER (transcribed): ${transcript}

COACHING FRAMEWORK:
- Goal is to deflect, reframe, or redirect gracefully — NOT answer directly
- Salary: avoid naming a number; redirect to learning more about role and total package
- Weakness: acknowledge briefly, pivot to growth and mitigation
- Why did you leave: stay positive, focus on moving toward not away from
- When can you start / interviewing elsewhere: vague, non-committal, preserves leverage
- Where do you see yourself: align with role without over-committing
- Why should I hire you / what sets you apart: reframe around value delivered, not comparison
- Personality questions (animal, superhero): pick something, tie to professional strength, keep brief

Provide feedback in 4-5 sentences: did they deflect or answer directly? What leverage/risk did their answer create? Give one specific reframe or deflection phrase. Be direct, warm, and concise.`;

  } else if (isTellMe) {
    prompt = `You are a skilled career coach reviewing a candidate's "Tell Me About Yourself" answer.

CANDIDATE'S SPOKEN ANSWER (transcribed): ${transcript}

${jobDescription ? `JOB CONTEXT:\n${jobDescription.slice(0, 500)}` : ''}

COACHING FRAMEWORK:
- Structure: Present (current role) → Past (relevant background) → Future (why this role)
- Should be 60-90 seconds when spoken, tailored to role, NOT a biography
- Should NOT go chronologically through entire career
- Should end with a bridge: "...which is why I'm excited about this opportunity"

Provide feedback in 4-5 sentences: did they follow the structure? Was it concise and tailored? Give one specific improvement. Be direct, warm, and concise.`;

  } else if (isSeniorBehavioral) {
    prompt = `You are a skilled career coach providing video interview coaching to a senior executive (11+ years experience).

INTERVIEW QUESTION: ${question}

CANDIDATE'S SPOKEN ANSWER (transcribed): ${transcript}

${jobDescription ? `JOB CONTEXT:\n${jobDescription.slice(0, 500)}` : ''}

COACHING FRAMEWORK:
- Do NOT reference STAR method by name
- Coach on executive storytelling: clear challenge, decisive action, measurable outcome
- Look for strategic context — organizational scope, leadership influence, business impact
- Flag if answer was too operational rather than strategic
- Tone should be peer-to-peer, not instructional

Provide feedback in 5-6 sentences. Plain paragraph form, no bullet points. Direct and concise.`;

  } else {
    prompt = `You are a skilled career coach reviewing a recorded interview answer.

INTERVIEW QUESTION: ${question}

CANDIDATE'S SPOKEN ANSWER (transcribed): ${transcript}

${jobDescription ? `JOB CONTEXT:\n${jobDescription.slice(0, 500)}` : ''}

Provide focused coaching feedback in 5-6 sentences covering:
1. Content — did they answer the question? Was there a clear situation, action, and result?
2. Delivery — did they ramble, use filler phrases, or trail off?
3. The single strongest thing about this answer
4. The single most important thing to fix
5. One specific suggested phrase or reframe

Plain paragraph form, no bullet points. Be direct, warm, and specific.`;
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

  const { action, audioBase64, mimeType, question, jobDescription, questionType } = body;

  if (action !== 'feedback') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
  }

  if (!audioBase64 || !question) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing audioBase64 or question' }) };
  }

  try {
    const transcript = await transcribeAudio(openaiKey, audioBase64, mimeType || 'audio/webm');
    const feedback = await getCoachingFeedback(anthropicKey, question, transcript, jobDescription || '', questionType || '');
    return { statusCode: 200, headers, body: JSON.stringify({ transcript, feedback }) };
  } catch (err) {
    console.error('interview-video error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
