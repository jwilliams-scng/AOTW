const DEFAULT_ORIGIN = "https://jwilliams-scng.github.io";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowedOrigin = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigin) });
    }

    if (origin && origin !== allowedOrigin) {
      return json({ error: "Origin not allowed." }, 403, origin, allowedOrigin);
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/poll") {
        const pollId = url.searchParams.get("id");
        if (!pollId) return json({ error: "Missing poll id." }, 400, origin, allowedOrigin);
        const poll = await getPoll(env.DB, pollId);
        if (!poll) return json({ error: "Poll not found." }, 404, origin, allowedOrigin);
        return json(poll, 200, origin, allowedOrigin);
      }

      if (request.method === "POST" && url.pathname === "/api/vote") {
        const body = await request.json().catch(() => null);
        if (!body || !body.pollId || !body.candidateId || !body.voterId) {
          return json({ error: "Missing vote data." }, 400, origin, allowedOrigin);
        }
        if (typeof body.voterId !== "string" || body.voterId.length > 128) {
          return json({ error: "Invalid voter id." }, 400, origin, allowedOrigin);
        }

        const pollRow = await env.DB.prepare(
          `SELECT id, opens_at, closes_at, active FROM polls WHERE id = ?1 LIMIT 1`
        ).bind(body.pollId).first();
        if (!pollRow) return json({ error: "Poll not found." }, 404, origin, allowedOrigin);
        if (!isOpen(pollRow)) {
          return json({ error: "Voting is closed.", poll: await getPoll(env.DB, body.pollId) }, 403, origin, allowedOrigin);
        }

        const candidate = await env.DB.prepare(
          `SELECT id FROM candidates WHERE id = ?1 AND poll_id = ?2 LIMIT 1`
        ).bind(Number(body.candidateId), body.pollId).first();
        if (!candidate) return json({ error: "Candidate not found." }, 400, origin, allowedOrigin);

        const voterHash = await hashVoter(body.voterId, env.VOTER_SALT || "change-me");
        const insert = await env.DB.prepare(
          `INSERT OR IGNORE INTO votes (poll_id, candidate_id, voter_hash) VALUES (?1, ?2, ?3)`
        ).bind(body.pollId, Number(body.candidateId), voterHash).run();

        const poll = await getPoll(env.DB, body.pollId);
        if (insert.meta.changes === 0) {
          return json({ error: "A vote from this browser has already been recorded.", duplicate: true, poll }, 409, origin, allowedOrigin);
        }
        return json({ ok: true, poll }, 200, origin, allowedOrigin);
      }

      return json({ error: "Not found." }, 404, origin, allowedOrigin);
    } catch (error) {
      console.error(error);
      return json({ error: "Server error." }, 500, origin, allowedOrigin);
    }
  }
};

function corsHeaders(origin, allowedOrigin) {
  return {
    "Access-Control-Allow-Origin": origin === allowedOrigin ? origin : allowedOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Cache-Control": "no-store"
  };
}

function json(data, status, origin, allowedOrigin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin, allowedOrigin) }
  });
}

function isOpen(row) {
  if (!row || Number(row.active) !== 1) return false;
  const now = Date.now();
  const opens = row.opens_at ? new Date(row.opens_at).getTime() : -Infinity;
  const closes = row.closes_at ? new Date(row.closes_at).getTime() : Infinity;
  return now >= opens && now < closes;
}

async function getPoll(db, pollId) {
  const poll = await db.prepare(
    `SELECT id, title, subtitle, opens_at, closes_at, active FROM polls WHERE id = ?1 LIMIT 1`
  ).bind(pollId).first();
  if (!poll) return null;

  const candidateResult = await db.prepare(
    `SELECT c.id, c.name, c.school, c.class_year, c.performance, c.sort_order, COUNT(v.id) AS votes
     FROM candidates c
     LEFT JOIN votes v ON v.candidate_id = c.id
     WHERE c.poll_id = ?1
     GROUP BY c.id
     ORDER BY c.sort_order ASC, c.id ASC`
  ).bind(pollId).run();

  const candidates = (candidateResult.results || []).map(row => ({
    id: row.id,
    name: row.name,
    school: row.school,
    classYear: row.class_year,
    performance: row.performance,
    votes: Number(row.votes || 0)
  }));
  const totalVotes = candidates.reduce((sum, candidate) => sum + candidate.votes, 0);
  return {
    id: poll.id,
    title: poll.title,
    subtitle: poll.subtitle,
    opensAt: poll.opens_at,
    closesAt: poll.closes_at,
    open: isOpen(poll),
    totalVotes,
    candidates
  };
}

async function hashVoter(voterId, salt) {
  const bytes = new TextEncoder().encode(`${salt}:${voterId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
