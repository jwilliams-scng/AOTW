const ALLOWED_ORIGIN = "https://jwilliams-scng.github.io";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // SETUP DATABASE
    if (request.method === "GET" && url.pathname === "/setup") {
      try {
        await env.DB.batch([
          env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS polls (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              subtitle TEXT,
              opens_at TEXT,
              closes_at TEXT,
              active INTEGER NOT NULL DEFAULT 1
            )
          `),

          env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS candidates (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              poll_id TEXT NOT NULL,
              name TEXT NOT NULL,
              school TEXT NOT NULL,
              class_year TEXT,
              performance TEXT,
              sort_order INTEGER NOT NULL DEFAULT 0
            )
          `),

          env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS votes (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              poll_id TEXT NOT NULL,
              candidate_id INTEGER NOT NULL,
              voter_hash TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              UNIQUE (poll_id, voter_hash)
            )
          `)
        ]);

        await env.DB.prepare(`
          INSERT OR IGNORE INTO polls
          (id, title, subtitle, opens_at, closes_at, active)
          VALUES (?, ?, ?, ?, ?, 1)
        `).bind(
          "test-2026",
          "SCNG High School Athlete of the Week",
          "Vote for the top performance of the week.",
          "2026-08-01T07:00:00Z",
          "2026-12-31T20:00:00Z"
        ).run();

        const existing = await env.DB.prepare(
          "SELECT COUNT(*) AS total FROM candidates WHERE poll_id = ?"
        ).bind("test-2026").first();

        if (existing.total === 0) {
          await env.DB.batch([
            env.DB.prepare(`
              INSERT INTO candidates
              (poll_id, name, school, class_year, performance, sort_order)
              VALUES (?, ?, ?, ?, ?, ?)
            `).bind(
              "test-2026",
              "Jane Smith",
              "Mater Dei",
              "Sr.",
              "225 total yards and three touchdowns.",
              1
            ),

            env.DB.prepare(`
              INSERT INTO candidates
              (poll_id, name, school, class_year, performance, sort_order)
              VALUES (?, ?, ?, ?, ?, ?)
            `).bind(
              "test-2026",
              "John Jones",
              "Centennial",
              "Jr.",
              "12 tackles, three sacks and a forced fumble.",
              2
            )
          ]);
        }

        return json({
          ok: true,
          message: "AOTW database is ready."
        });

      } catch (error) {
        return json({
          ok: false,
          error: error.message
        }, 500);
      }
    }

    // GET POLL
    if (request.method === "GET" && url.pathname === "/api/poll") {
      const pollId = url.searchParams.get("id");

      const poll = await env.DB.prepare(
        "SELECT * FROM polls WHERE id = ?"
      ).bind(pollId).first();

      if (!poll) {
        return json({ error: "Poll not found" }, 404);
      }

      const result = await env.DB.prepare(`
        SELECT
          c.*,
          COUNT(v.id) AS votes
        FROM candidates c
        LEFT JOIN votes v
          ON v.candidate_id = c.id
        WHERE c.poll_id = ?
        GROUP BY c.id
        ORDER BY c.sort_order
      `).bind(pollId).run();

      const candidates = result.results || [];

      const totalVotes = candidates.reduce(
        (sum, candidate) => sum + Number(candidate.votes || 0),
        0
      );

      return json({
        id: poll.id,
        title: poll.title,
        subtitle: poll.subtitle,
        opensAt: poll.opens_at,
        closesAt: poll.closes_at,
        open: true,
        totalVotes,
        candidates: candidates.map(c => ({
          id: c.id,
          name: c.name,
          school: c.school,
          classYear: c.class_year,
          performance: c.performance,
          votes: Number(c.votes || 0)
        }))
      });
    }

    // RECORD VOTE
    if (request.method === "POST" && url.pathname === "/api/vote") {
      try {
        const body = await request.json();

        const voterHash = await hash(body.voterId);

        const result = await env.DB.prepare(`
          INSERT OR IGNORE INTO votes
          (poll_id, candidate_id, voter_hash)
          VALUES (?, ?, ?)
        `).bind(
          body.pollId,
          body.candidateId,
          voterHash
        ).run();

        if (result.meta.changes === 0) {
          return json({
            error: "You have already voted."
          }, 409);
        }

        return json({
          ok: true
        });

      } catch (error) {
        return json({
          error: error.message
        }, 500);
      }
    }

    return json({
      message: "SCNG AOTW API is running",
      setup: "/setup",
      poll: "/api/poll?id=test-2026"
    });
  }
};

async function hash(value) {
  const data = new TextEncoder().encode(
    "scng-aotw:" + value
  );

  const digest = await crypto.subtle.digest(
    "SHA-256",
    data
  );

  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
      }
    }
  );
}
