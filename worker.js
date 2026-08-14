const ALLOWED_ORIGIN = "https://jwilliams-scng.github.io";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    try {
      // ======================================================
      // SETUP DATABASE
      // Visit /setup once after deployment
      // ======================================================
      if (request.method === "GET" && url.pathname === "/setup") {
        await setupDatabase(env.DB);

        const poll = await getPoll(env.DB, "test-2026");

        return json({
          ok: true,
          message: "AOTW database is ready.",
          poll
        });
      }

      // ======================================================
      // GET POLL
      // Example: /api/poll?id=test-2026
      // ======================================================
      if (request.method === "GET" && url.pathname === "/api/poll") {
        const pollId = url.searchParams.get("id");

        if (!pollId) {
          return json(
            { error: "Missing poll id." },
            400
          );
        }

        const poll = await getPoll(env.DB, pollId);

        if (!poll) {
          return json(
            { error: "Poll not found." },
            404
          );
        }

        return json(poll);
      }

      // ======================================================
      // RECORD VOTE
      // ======================================================
      if (request.method === "POST" && url.pathname === "/api/vote") {
        const body = await request.json().catch(() => null);

        if (
          !body ||
          !body.pollId ||
          !body.candidateId ||
          !body.voterId
        ) {
          return json(
            { error: "Missing vote data." },
            400
          );
        }

        if (
          typeof body.voterId !== "string" ||
          body.voterId.length > 128
        ) {
          return json(
            { error: "Invalid voter id." },
            400
          );
        }

        // Make sure poll exists
        const pollRow = await env.DB.prepare(`
          SELECT
            id,
            opens_at,
            closes_at,
            active
          FROM polls
          WHERE id = ?
          LIMIT 1
        `)
          .bind(body.pollId)
          .first();

        if (!pollRow) {
          return json(
            { error: "Poll not found." },
            404
          );
        }

        // Make sure poll is open
        if (!isPollOpen(pollRow)) {
          const poll = await getPoll(
            env.DB,
            body.pollId
          );

          return json(
            {
              error: "Voting is closed.",
              poll
            },
            403
          );
        }

        // Make sure candidate belongs to poll
        const candidate = await env.DB.prepare(`
          SELECT id
          FROM candidates
          WHERE id = ?
            AND poll_id = ?
          LIMIT 1
        `)
          .bind(
            Number(body.candidateId),
            body.pollId
          )
          .first();

        if (!candidate) {
          return json(
            { error: "Candidate not found." },
            400
          );
        }

        // Hash anonymous browser voter ID
        const voterHash = await hashVoter(
          body.voterId
        );

        // Database unique constraint prevents same
        // voterHash from voting twice in same poll
        const result = await env.DB.prepare(`
          INSERT OR IGNORE INTO votes
            (
              poll_id,
              candidate_id,
              voter_hash
            )
          VALUES (?, ?, ?)
        `)
          .bind(
            body.pollId,
            Number(body.candidateId),
            voterHash
          )
          .run();

        const updatedPoll = await getPoll(
          env.DB,
          body.pollId
        );

        if (result.meta.changes === 0) {
          return json(
            {
              error: "You have already voted.",
              duplicate: true,
              poll: updatedPoll
            },
            409
          );
        }

        return json({
          ok: true,
          poll: updatedPoll
        });
      }

      // ======================================================
      // ROOT TEST
      // ======================================================
      if (request.method === "GET" && url.pathname === "/") {
        return json({
          message: "SCNG AOTW API is running.",
          setup: "/setup",
          poll: "/api/poll?id=test-2026"
        });
      }

      return json(
        { error: "Not found." },
        404
      );

    } catch (error) {
      console.error(error);

      return json(
        {
          error:
            error?.message ||
            "Server error."
        },
        500
      );
    }
  }
};


// ==========================================================
// DATABASE SETUP
// ==========================================================

async function setupDatabase(db) {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS polls (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        subtitle TEXT,
        opens_at TEXT,
        closes_at TEXT,
        active INTEGER NOT NULL DEFAULT 1
      )
    `),

    db.prepare(`
      CREATE TABLE IF NOT EXISTS candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id TEXT NOT NULL,
        name TEXT NOT NULL,
        school TEXT NOT NULL,
        class_year TEXT,
        performance TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (poll_id)
          REFERENCES polls(id)
          ON DELETE CASCADE
      )
    `),

    db.prepare(`
      CREATE TABLE IF NOT EXISTS votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id TEXT NOT NULL,
        candidate_id INTEGER NOT NULL,
        voter_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
          DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (poll_id)
          REFERENCES polls(id)
          ON DELETE CASCADE,

        FOREIGN KEY (candidate_id)
          REFERENCES candidates(id)
          ON DELETE CASCADE,

        UNIQUE (poll_id, voter_hash)
      )
    `),

    db.prepare(`
      CREATE INDEX IF NOT EXISTS
        idx_candidates_poll
      ON candidates(
        poll_id,
        sort_order
      )
    `),

    db.prepare(`
      CREATE INDEX IF NOT EXISTS
        idx_votes_poll
      ON votes(poll_id)
    `),

    db.prepare(`
      CREATE INDEX IF NOT EXISTS
        idx_votes_candidate
      ON votes(candidate_id)
    `)
  ]);

  // --------------------------------------------------------
  // CREATE TEST POLL
  // --------------------------------------------------------

  await db.prepare(`
    INSERT OR IGNORE INTO polls
      (
        id,
        title,
        subtitle,
        opens_at,
        closes_at,
        active
      )
    VALUES (?, ?, ?, ?, ?, 1)
  `)
    .bind(
      "test-2026",
      "SCNG High School Athlete of the Week",
      "Vote for the top performance of the week.",
      "2026-08-01T07:00:00Z",
      "2026-12-31T20:00:00Z"
    )
    .run();

  // --------------------------------------------------------
  // ADD TEST CANDIDATES ONLY IF NONE EXIST
  // --------------------------------------------------------

  const existing = await db.prepare(`
    SELECT COUNT(*) AS total
    FROM candidates
    WHERE poll_id = ?
  `)
    .bind("test-2026")
    .first();

  if (Number(existing?.total || 0) === 0) {
    await db.batch([
      db.prepare(`
        INSERT INTO candidates
          (
            poll_id,
            name,
            school,
            class_year,
            performance,
            sort_order
          )
        VALUES (?, ?, ?, ?, ?, ?)
      `)
        .bind(
          "test-2026",
          "Jane Smith",
          "Mater Dei",
          "Sr.",
          "225 total yards and three touchdowns.",
          1
        ),

      db.prepare(`
        INSERT INTO candidates
          (
            poll_id,
            name,
            school,
            class_year,
            performance,
            sort_order
          )
        VALUES (?, ?, ?, ?, ?, ?)
      `)
        .bind(
          "test-2026",
          "John Jones",
          "Centennial",
          "Jr.",
          "12 tackles, three sacks and a forced fumble.",
          2
        )
    ]);
  }
}


// ==========================================================
// GET COMPLETE POLL + RESULTS
// ==========================================================

async function getPoll(db, pollId) {
  const poll = await db.prepare(`
    SELECT
      id,
      title,
      subtitle,
      opens_at,
      closes_at,
      active
    FROM polls
    WHERE id = ?
    LIMIT 1
  `)
    .bind(pollId)
    .first();

  if (!poll) {
    return null;
  }

  const candidateResult = await db.prepare(`
    SELECT
      c.id,
      c.name,
      c.school,
      c.class_year,
      c.performance,
      c.sort_order,
      COUNT(v.id) AS votes

    FROM candidates c

    LEFT JOIN votes v
      ON v.candidate_id = c.id

    WHERE c.poll_id = ?

    GROUP BY
      c.id,
      c.name,
      c.school,
      c.class_year,
      c.performance,
      c.sort_order

    ORDER BY
      c.sort_order ASC,
      c.id ASC
  `)
    .bind(pollId)
    .run();

  const candidates =
    candidateResult.results || [];

  const mappedCandidates =
    candidates.map(candidate => ({
      id: candidate.id,
      name: candidate.name,
      school: candidate.school,
      classYear:
        candidate.class_year,
      performance:
        candidate.performance,
      votes:
        Number(candidate.votes || 0)
    }));

  const totalVotes =
    mappedCandidates.reduce(
      (total, candidate) =>
        total + candidate.votes,
      0
    );

  return {
    id: poll.id,
    title: poll.title,
    subtitle: poll.subtitle,
    opensAt: poll.opens_at,
    closesAt: poll.closes_at,
    open: isPollOpen(poll),
    totalVotes,
    candidates: mappedCandidates
  };
}


// ==========================================================
// OPEN/CLOSED STATUS
// ==========================================================

function isPollOpen(poll) {
  if (
    !poll ||
    Number(poll.active) !== 1
  ) {
    return false;
  }

  const now = Date.now();

  const opensAt = poll.opens_at
    ? new Date(
        poll.opens_at
      ).getTime()
    : -Infinity;

  const closesAt = poll.closes_at
    ? new Date(
        poll.closes_at
      ).getTime()
    : Infinity;

  return (
    now >= opensAt &&
    now < closesAt
  );
}


// ==========================================================
// ANONYMOUS VOTER HASH
// ==========================================================

async function hashVoter(voterId) {
  const data =
    new TextEncoder().encode(
      "scng-aotw-v1:" +
      voterId
    );

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      data
    );

  return Array
    .from(
      new Uint8Array(digest)
    )
    .map(byte =>
      byte
        .toString(16)
        .padStart(2, "0")
    )
    .join("");
}


// ==========================================================
// CORS
// ==========================================================

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":
      ALLOWED_ORIGIN,

    "Access-Control-Allow-Headers":
      "Content-Type, Accept",

    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",

    "Access-Control-Max-Age":
      "86400",

    "Cache-Control":
      "no-store"
  };
}


// ==========================================================
// JSON RESPONSE
// ==========================================================

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        ...corsHeaders()
      }
    }
  );
}
