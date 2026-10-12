// netlify/functions/cleanup-videos.js
// Daily cleanup: deletes practice videos older than 45 days from Supabase
// Storage. Transcripts, AI coaching, framing, answer length and coach notes
// are kept — only the video file is removed, and the session is marked
// "videoRemoved" so pages can say so.
//
// Schedule is set in netlify.toml. Requires the Netlify environment variable
// SUPABASE_SERVICE_ROLE_KEY (Supabase → Project Settings → API keys →
// service_role). Without it the job logs a message and does nothing.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fdymihjzdvqbrxnymsaj.supabase.co';
const BUCKET = 'interview-recordings';
const RETENTION_DAYS = 45;

exports.handler = async () => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.log('cleanup-videos: SUPABASE_SERVICE_ROLE_KEY is not set — skipping.');
    return { statusCode: 200, body: 'skipped: no service key' };
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/interview_sessions?select=id,recordings&created_at=lt.${encodeURIComponent(cutoff)}`,
    { headers }
  );
  if (!res.ok) {
    console.error('cleanup-videos: could not read sessions', res.status, await res.text());
    return { statusCode: 500, body: 'read failed' };
  }
  const rows = await res.json();

  let deleted = 0, sessions = 0;
  for (const row of rows) {
    const recs = Array.isArray(row.recordings) ? row.recordings : [];
    const paths = [];
    const next = recs.map(r => {
      if (!r || r.videoRemoved) return r;
      let p = r.videoPath;
      if (!p && r.videoUrl && r.videoUrl.includes(`/${BUCKET}/`)) p = decodeURIComponent(r.videoUrl.split(`/${BUCKET}/`)[1]);
      if (!p) return r;
      paths.push(p);
      return { ...r, videoUrl: null, videoPath: null, videoRemoved: true };
    });
    if (!paths.length) continue;

    const del = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
      method: 'DELETE', headers, body: JSON.stringify({ prefixes: paths }),
    });
    if (!del.ok) {
      console.error('cleanup-videos: delete failed for session', row.id, del.status, await del.text());
      continue;
    }
    const up = await fetch(`${SUPABASE_URL}/rest/v1/interview_sessions?id=eq.${row.id}`, {
      method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify({ recordings: next }),
    });
    if (!up.ok) console.error('cleanup-videos: could not mark session', row.id, up.status, await up.text());
    deleted += paths.length;
    sessions++;
  }

  console.log(`cleanup-videos: removed ${deleted} video(s) from ${sessions} session(s) older than ${RETENTION_DAYS} days.`);
  return { statusCode: 200, body: JSON.stringify({ deleted, sessions }) };
};
