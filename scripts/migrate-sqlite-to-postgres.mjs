import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'

const sqlitePath = process.env.SQLITE_PATH || './data/quiz.sqlite'
const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

const sqlite = new DatabaseSync(sqlitePath)
const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
})

const readAll = (sql) => sqlite.prepare(sql).all()

const quizzes = readAll('SELECT id, title, description, created_at FROM quizzes')
const questions = readAll(
  'SELECT id, quiz_id, prompt, options_json, correct_option_index, sort_order FROM questions',
)
const attempts = readAll(
  'SELECT id, quiz_id, player_name, score, total_questions, completed_at FROM attempts',
)
const liveSessions = readAll(
  'SELECT quiz_id, current_question_index, question_started_at, status, answer_seconds FROM live_sessions',
)
const liveAnswers = readAll(
  'SELECT quiz_id, question_id, player_id, player_name, selected_option_index, answered_at FROM live_answers',
)

const client = await pool.connect()

try {
  await client.query('BEGIN')

  await client.query(`
    CREATE TABLE IF NOT EXISTS quizzes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      options_json TEXT NOT NULL,
      correct_option_index INTEGER NOT NULL,
      sort_order INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      player_name TEXT NOT NULL,
      score INTEGER NOT NULL,
      total_questions INTEGER NOT NULL,
      completed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS live_sessions (
      quiz_id TEXT PRIMARY KEY REFERENCES quizzes(id) ON DELETE CASCADE,
      current_question_index INTEGER NOT NULL,
      question_started_at TEXT,
      status TEXT NOT NULL,
      answer_seconds INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS live_answers (
      quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL,
      player_name TEXT NOT NULL,
      selected_option_index INTEGER NOT NULL,
      answered_at TEXT NOT NULL,
      PRIMARY KEY (quiz_id, question_id, player_id)
    );

    CREATE INDEX IF NOT EXISTS idx_live_answers_quiz_id ON live_answers (quiz_id);
    CREATE INDEX IF NOT EXISTS idx_live_answers_quiz_question ON live_answers (quiz_id, question_id);
  `)

  for (const row of quizzes) {
    await client.query(
      `INSERT INTO quizzes (id, title, description, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         created_at = EXCLUDED.created_at`,
      [row.id, row.title, row.description, row.created_at],
    )
  }

  for (const row of questions) {
    await client.query(
      `INSERT INTO questions (id, quiz_id, prompt, options_json, correct_option_index, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         quiz_id = EXCLUDED.quiz_id,
         prompt = EXCLUDED.prompt,
         options_json = EXCLUDED.options_json,
         correct_option_index = EXCLUDED.correct_option_index,
         sort_order = EXCLUDED.sort_order`,
      [
        row.id,
        row.quiz_id,
        row.prompt,
        row.options_json,
        row.correct_option_index,
        row.sort_order,
      ],
    )
  }

  for (const row of attempts) {
    await client.query(
      `INSERT INTO attempts (id, quiz_id, player_name, score, total_questions, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         quiz_id = EXCLUDED.quiz_id,
         player_name = EXCLUDED.player_name,
         score = EXCLUDED.score,
         total_questions = EXCLUDED.total_questions,
         completed_at = EXCLUDED.completed_at`,
      [
        row.id,
        row.quiz_id,
        row.player_name,
        row.score,
        row.total_questions,
        row.completed_at,
      ],
    )
  }

  for (const row of liveSessions) {
    await client.query(
      `INSERT INTO live_sessions (quiz_id, current_question_index, question_started_at, status, answer_seconds)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (quiz_id) DO UPDATE SET
         current_question_index = EXCLUDED.current_question_index,
         question_started_at = EXCLUDED.question_started_at,
         status = EXCLUDED.status,
         answer_seconds = EXCLUDED.answer_seconds`,
      [
        row.quiz_id,
        row.current_question_index,
        row.question_started_at,
        row.status,
        row.answer_seconds,
      ],
    )
  }

  for (const row of liveAnswers) {
    await client.query(
      `INSERT INTO live_answers
       (quiz_id, question_id, player_id, player_name, selected_option_index, answered_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (quiz_id, question_id, player_id) DO UPDATE SET
         player_name = EXCLUDED.player_name,
         selected_option_index = EXCLUDED.selected_option_index,
         answered_at = EXCLUDED.answered_at`,
      [
        row.quiz_id,
        row.question_id,
        row.player_id,
        row.player_name,
        row.selected_option_index,
        row.answered_at,
      ],
    )
  }

  await client.query('COMMIT')

  const targetCounts = {
    quizzes: Number((await client.query('SELECT COUNT(*)::int AS count FROM quizzes')).rows[0].count),
    questions: Number((await client.query('SELECT COUNT(*)::int AS count FROM questions')).rows[0].count),
    attempts: Number((await client.query('SELECT COUNT(*)::int AS count FROM attempts')).rows[0].count),
    live_sessions: Number(
      (await client.query('SELECT COUNT(*)::int AS count FROM live_sessions')).rows[0].count,
    ),
    live_answers: Number(
      (await client.query('SELECT COUNT(*)::int AS count FROM live_answers')).rows[0].count,
    ),
  }

  const sourceCounts = {
    quizzes: quizzes.length,
    questions: questions.length,
    attempts: attempts.length,
    live_sessions: liveSessions.length,
    live_answers: liveAnswers.length,
  }

  console.log('Migration complete.')
  console.log('Source counts:', sourceCounts)
  console.log('Target counts:', targetCounts)
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  client.release()
  await pool.end()
}