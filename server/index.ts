import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import pg from 'pg'
import { fileURLToPath } from 'node:url'

type QuestionInput = {
  prompt: string
  options: string[]
  correctOptionIndex: number
}

type QuizInput = {
  title: string
  description?: string
  questions: QuestionInput[]
}

type AttemptInput = {
  playerName: string
  answers: Record<string, number>
}

type LiveAnswerInput = {
  playerId: string
  playerName: string
  questionId: string
  selectedOptionIndex: number
}

type QuizRow = {
  id: string
  title: string
  description: string
  created_at: string
}

type QuestionRow = {
  id: string
  quiz_id: string
  prompt: string
  options_json: string
  correct_option_index: number
  sort_order: number
}

type AttemptRow = {
  id: string
  quiz_id: string
  quiz_title: string
  player_name: string
  score: number
  total_questions: number
  completed_at: string
}

type LiveSessionRow = {
  quiz_id: string
  current_question_index: number
  question_started_at: string | null
  status: 'idle' | 'running' | 'finished'
  answer_seconds: number
}

type LiveAnswerRow = {
  quiz_id: string
  question_id: string
  player_id: string
  player_name: string
  selected_option_index: number
  answered_at: string
}

type DbResult = {
  changes: number
}

type DbClient = {
  all<T>(sql: string, params?: SQLInputValue[]): Promise<T[]>
  get<T>(sql: string, params?: SQLInputValue[]): Promise<T | undefined>
  run(sql: string, params?: SQLInputValue[]): Promise<DbResult>
  exec(sql: string): Promise<void>
}

type Db = DbClient & {
  transaction<T>(operation: (tx: DbClient) => Promise<T>): Promise<T>
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const databasePath = process.env.DATABASE_PATH ?? path.join(projectRoot, 'data', 'quiz.sqlite')
const databaseUrl = process.env.DATABASE_URL?.trim() ?? ''
const distPath = path.join(projectRoot, 'dist')
const port = Number(process.env.PORT ?? 3001)
const adminPassword = (process.env.ADMIN_PASSWORD ?? 'change-me').trim()

if (adminPassword === 'change-me') {
  console.warn('Using default ADMIN_PASSWORD. Set ADMIN_PASSWORD in your environment for security.')
}

mkdirSync(path.dirname(databasePath), { recursive: true })

const toPostgresSql = (sql: string) => {
  let parameterIndex = 0
  return sql.replace(/\?/g, () => {
    parameterIndex += 1
    return `$${parameterIndex}`
  })
}

const initializeSchema = async (db: DbClient, includePragmas: boolean) => {
  if (includePragmas) {
    await db.exec('PRAGMA foreign_keys = ON;')
    await db.exec('PRAGMA journal_mode = WAL;')
  }

  await db.exec(`
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
}

const createSqliteDatabase = async (): Promise<Db> => {
  const sqlite = new DatabaseSync(databasePath)

  const client: DbClient = {
    all: async <T,>(sql: string, params: SQLInputValue[] = []) =>
      sqlite.prepare(sql).all(...params) as T[],
    get: async <T,>(sql: string, params: SQLInputValue[] = []) =>
      sqlite.prepare(sql).get(...params) as T | undefined,
    run: async (sql: string, params: SQLInputValue[] = []) => {
      const result = sqlite.prepare(sql).run(...params)
      return { changes: Number(result.changes ?? 0) }
    },
    exec: async (sql: string) => {
      sqlite.exec(sql)
    },
  }

  const db: Db = {
    ...client,
    transaction: async <T,>(operation: (tx: DbClient) => Promise<T>) => {
      sqlite.exec('BEGIN')
      try {
        const result = await operation(client)
        sqlite.exec('COMMIT')
        return result
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }

  await initializeSchema(db, true)
  return db
}

const createPostgresDatabase = async (): Promise<Db> => {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  })

  const client: DbClient = {
    all: async <T,>(sql: string, params: SQLInputValue[] = []) => {
      const result = await pool.query(toPostgresSql(sql), params)
      return result.rows as T[]
    },
    get: async <T,>(sql: string, params: SQLInputValue[] = []) => {
      const result = await pool.query(toPostgresSql(sql), params)
      return result.rows[0] as T | undefined
    },
    run: async (sql: string, params: SQLInputValue[] = []) => {
      const result = await pool.query(toPostgresSql(sql), params)
      return { changes: result.rowCount ?? 0 }
    },
    exec: async (sql: string) => {
      await pool.query(sql)
    },
  }

  const db: Db = {
    ...client,
    transaction: async <T,>(operation: (tx: DbClient) => Promise<T>) => {
      const transactionClient = await pool.connect()
      const tx: DbClient = {
        all: async <T2,>(sql: string, params: SQLInputValue[] = []) => {
          const result = await transactionClient.query(toPostgresSql(sql), params)
          return result.rows as T2[]
        },
        get: async <T2,>(sql: string, params: SQLInputValue[] = []) => {
          const result = await transactionClient.query(toPostgresSql(sql), params)
          return result.rows[0] as T2 | undefined
        },
        run: async (sql: string, params: SQLInputValue[] = []) => {
          const result = await transactionClient.query(toPostgresSql(sql), params)
          return { changes: result.rowCount ?? 0 }
        },
        exec: async (sql: string) => {
          await transactionClient.query(sql)
        },
      }

      try {
        await transactionClient.query('BEGIN')
        const result = await operation(tx)
        await transactionClient.query('COMMIT')
        return result
      } catch (error) {
        await transactionClient.query('ROLLBACK')
        throw error
      } finally {
        transactionClient.release()
      }
    },
  }

  await initializeSchema(db, false)
  return db
}

const createDatabase = async (): Promise<Db> =>
  databaseUrl ? createPostgresDatabase() : createSqliteDatabase()

const createId = () => crypto.randomUUID()

const sendJson = (res: ServerResponse, statusCode: number, body: unknown) => {
  res.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-password',
    'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, POST',
    'Content-Type': 'application/json',
  })
  res.end(JSON.stringify(body))
}

const sendError = (res: ServerResponse, statusCode: number, message: string) => {
  sendJson(res, statusCode, { error: message })
}

const isAdminAuthorized = (req: IncomingMessage) => {
  const header = req.headers['x-admin-password']
  const providedPassword = Array.isArray(header) ? header[0] : header
  return typeof providedPassword === 'string' && providedPassword.trim() === adminPassword
}

const requireAdmin = (req: IncomingMessage, res: ServerResponse) => {
  if (!isAdminAuthorized(req)) {
    sendError(res, 401, 'Admin password required for this action.')
    return false
  }

  return true
}

const readJsonBody = async <T,>(req: IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length

    if (size > 1_000_000) {
      throw new Error('Request body is too large.')
    }

    chunks.push(buffer)
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

const normalizeQuizInput = (input: QuizInput): QuizInput => {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const questions = Array.isArray(input.questions) ? input.questions : []

  if (!title) {
    throw new Error('Quiz title is required.')
  }

  if (questions.length === 0) {
    throw new Error('At least one question is required.')
  }

  return {
    title,
    description,
    questions: questions.map((question) => {
      const prompt = typeof question.prompt === 'string' ? question.prompt.trim() : ''
      const options = Array.isArray(question.options)
        ? question.options.map((option) => String(option).trim())
        : []
      const correctOptionIndex = Number(question.correctOptionIndex)

      if (
        !prompt ||
        options.length !== 4 ||
        options.some((option) => !option) ||
        !Number.isInteger(correctOptionIndex) ||
        correctOptionIndex < 0 ||
        correctOptionIndex >= options.length
      ) {
        throw new Error('Each question needs text, four answers, and a correct answer.')
      }

      return { prompt, options, correctOptionIndex }
    }),
  }
}

const listQuizzes = async (db: DbClient) => {
  const quizRows = await db.all<QuizRow>(
    'SELECT id, title, description, created_at FROM quizzes ORDER BY created_at DESC',
  )
  const questionRows = await db.all<QuestionRow>(
    `SELECT id, quiz_id, prompt, options_json, correct_option_index, sort_order
     FROM questions
     ORDER BY sort_order ASC`,
  )

  return quizRows.map((quiz) => ({
    id: quiz.id,
    title: quiz.title,
    description: quiz.description,
    createdAt: quiz.created_at,
    questions: questionRows
      .filter((question) => question.quiz_id === quiz.id)
      .map((question) => ({
        id: question.id,
        prompt: question.prompt,
        options: JSON.parse(question.options_json) as string[],
      })),
  }))
}

const listAttempts = async (db: DbClient) =>
  (
    await db.all<AttemptRow>(
      `SELECT attempts.id, attempts.quiz_id, quizzes.title AS quiz_title, attempts.player_name,
              attempts.score, attempts.total_questions, attempts.completed_at
       FROM attempts
       JOIN quizzes ON quizzes.id = attempts.quiz_id
       ORDER BY
         CAST(attempts.score AS REAL) / attempts.total_questions DESC,
         attempts.completed_at DESC
       LIMIT 50`,
    )
  ).map((attempt) => ({
    id: attempt.id,
    quizId: attempt.quiz_id,
    quizTitle: attempt.quiz_title,
    playerName: attempt.player_name,
    score: attempt.score,
    totalQuestions: attempt.total_questions,
    completedAt: attempt.completed_at,
  }))

const createQuiz = async (db: Db, input: QuizInput) => {
  const quiz = normalizeQuizInput(input)
  const quizId = createId()
  const createdAt = new Date().toISOString()

  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO quizzes (id, title, description, created_at) VALUES (?, ?, ?, ?)', [
      quizId,
      quiz.title,
      quiz.description ?? '',
      createdAt,
    ])

    for (const [index, question] of quiz.questions.entries()) {
      await tx.run(
        `INSERT INTO questions
         (id, quiz_id, prompt, options_json, correct_option_index, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          createId(),
          quizId,
          question.prompt,
          JSON.stringify(question.options),
          question.correctOptionIndex,
          index,
        ],
      )
    }
  })

  return (await listQuizzes(db)).find((storedQuiz) => storedQuiz.id === quizId)
}

const deleteQuiz = async (db: DbClient, quizId: string) => {
  const result = await db.run('DELETE FROM quizzes WHERE id = ?', [quizId])
  return result.changes > 0
}

const createAttempt = async (db: DbClient, quizId: string, input: AttemptInput) => {
  const playerName = typeof input.playerName === 'string' ? input.playerName.trim() : ''
  const answers =
    input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers)
      ? input.answers
      : {}

  if (!playerName) {
    throw new Error('Player name is required.')
  }

  const quiz = await db.get<Pick<QuizRow, 'id' | 'title'>>('SELECT id, title FROM quizzes WHERE id = ?', [
    quizId,
  ])

  if (!quiz) {
    return undefined
  }

  const questions = await db.all<QuestionRow>(
    `SELECT id, quiz_id, prompt, options_json, correct_option_index, sort_order
     FROM questions
     WHERE quiz_id = ?
     ORDER BY sort_order ASC`,
    [quizId],
  )

  if (questions.some((question) => answers[question.id] === undefined)) {
    throw new Error('Every question must be answered.')
  }

  const score = questions.filter(
    (question) => answers[question.id] === question.correct_option_index,
  ).length
  const attemptId = createId()
  const completedAt = new Date().toISOString()

  await db.run(
    `INSERT INTO attempts
     (id, quiz_id, player_name, score, total_questions, completed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [attemptId, quizId, playerName, score, questions.length, completedAt],
  )

  return {
    id: attemptId,
    quizId,
    quizTitle: quiz.title,
    playerName,
    score,
    totalQuestions: questions.length,
    completedAt,
  }
}

const getQuestionRows = (db: DbClient, quizId: string) =>
  db.all<QuestionRow>(
    `SELECT id, quiz_id, prompt, options_json, correct_option_index, sort_order
     FROM questions
     WHERE quiz_id = ?
     ORDER BY sort_order ASC`,
    [quizId],
  )

const getQuizTitle = (db: DbClient, quizId: string) =>
  db.get<Pick<QuizRow, 'title'>>('SELECT title FROM quizzes WHERE id = ?', [quizId])

const getLiveSessionRow = (db: DbClient, quizId: string) =>
  db.get<LiveSessionRow>(
    `SELECT quiz_id, current_question_index, question_started_at, status, answer_seconds
     FROM live_sessions
     WHERE quiz_id = ?`,
    [quizId],
  )

const toPublicQuestion = (question: QuestionRow) => ({
  id: question.id,
  prompt: question.prompt,
  options: JSON.parse(question.options_json) as string[],
})

const getLiveSession = async (db: DbClient, quizId: string, playerId?: string) => {
  const quiz = await getQuizTitle(db, quizId)

  if (!quiz) {
    return undefined
  }

  const questions = await getQuestionRows(db, quizId)
  const session = await getLiveSessionRow(db, quizId)

  if (!session) {
    return {
      quizId,
      status: 'idle',
      currentQuestionIndex: 0,
      questionStartedAt: null,
      answerSeconds: 60,
      totalQuestions: questions.length,
      currentQuestion: null,
      playerAnswer: null,
      playerCount: 0,
      submittedAnswerCount: 0,
    }
  }

  const currentQuestion = questions[session.current_question_index]
  const playerAnswer =
    playerId && currentQuestion
      ? await db.get<LiveAnswerRow>(
          `SELECT quiz_id, question_id, player_id, player_name, selected_option_index, answered_at
           FROM live_answers
           WHERE quiz_id = ? AND question_id = ? AND player_id = ?`,
          [quizId, currentQuestion.id, playerId],
        )
      : undefined
  const playerCount =
    (await db.get<{ count: number }>(
      'SELECT COUNT(DISTINCT player_id) AS count FROM live_answers WHERE quiz_id = ?',
      [quizId],
    ))?.count ?? 0
  const submittedAnswerCount = currentQuestion
    ? ((
        await db.get<{ count: number }>(
          'SELECT COUNT(*) AS count FROM live_answers WHERE quiz_id = ? AND question_id = ?',
          [quizId, currentQuestion.id],
        )
      )?.count ?? 0)
    : 0

  return {
    quizId,
    status: session.status,
    currentQuestionIndex: session.current_question_index,
    questionStartedAt: session.question_started_at,
    answerSeconds: session.answer_seconds,
    totalQuestions: questions.length,
    currentQuestion: currentQuestion ? toPublicQuestion(currentQuestion) : null,
    playerAnswer: playerAnswer?.selected_option_index ?? null,
    playerCount,
    submittedAnswerCount,
  }
}

const startLiveQuiz = async (db: Db, quizId: string) => {
  const questions = await getQuestionRows(db, quizId)

  if (questions.length === 0) {
    return undefined
  }

  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM live_answers WHERE quiz_id = ?', [quizId])
    await tx.run(
      `INSERT INTO live_sessions
       (quiz_id, current_question_index, question_started_at, status, answer_seconds)
       VALUES (?, 0, ?, 'running', 60)
       ON CONFLICT(quiz_id) DO UPDATE SET
         current_question_index = excluded.current_question_index,
         question_started_at = excluded.question_started_at,
         status = excluded.status,
         answer_seconds = excluded.answer_seconds`,
      [quizId, new Date().toISOString()],
    )
  })

  return getLiveSession(db, quizId)
}

const finishLiveQuiz = async (db: Db, quizId: string) => {
  const quiz = await getQuizTitle(db, quizId)
  const questions = await getQuestionRows(db, quizId)

  if (!quiz || questions.length === 0) {
    return undefined
  }

  const players = await db.all<Pick<LiveAnswerRow, 'player_id' | 'player_name'>>(
    `SELECT player_id, player_name
     FROM live_answers
     WHERE quiz_id = ?
     GROUP BY player_id, player_name`,
    [quizId],
  )
  const answers = await db.all<LiveAnswerRow>(
    `SELECT quiz_id, question_id, player_id, player_name, selected_option_index, answered_at
     FROM live_answers
     WHERE quiz_id = ?`,
    [quizId],
  )
  const completedAt = new Date().toISOString()

  await db.transaction(async (tx) => {
    for (const player of players) {
      const score = questions.filter((question) =>
        answers.some(
          (answer) =>
            answer.player_id === player.player_id &&
            answer.question_id === question.id &&
            answer.selected_option_index === question.correct_option_index,
        ),
      ).length

      await tx.run(
        `INSERT INTO attempts
         (id, quiz_id, player_name, score, total_questions, completed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [createId(), quizId, player.player_name, score, questions.length, completedAt],
      )
    }

    await tx.run(
      `UPDATE live_sessions
       SET status = 'finished', question_started_at = NULL
       WHERE quiz_id = ?`,
      [quizId],
    )
  })

  return getLiveSession(db, quizId)
}

const advanceLiveQuiz = async (db: Db, quizId: string) => {
  const session = await getLiveSessionRow(db, quizId)
  const questions = await getQuestionRows(db, quizId)

  if (!session || session.status !== 'running' || questions.length === 0) {
    return undefined
  }

  if (session.current_question_index + 1 >= questions.length) {
    return finishLiveQuiz(db, quizId)
  }

  await db.run(
    `UPDATE live_sessions
     SET current_question_index = ?, question_started_at = ?, status = 'running'
     WHERE quiz_id = ?`,
    [session.current_question_index + 1, new Date().toISOString(), quizId],
  )

  return getLiveSession(db, quizId)
}

const submitLiveAnswer = async (db: DbClient, quizId: string, input: LiveAnswerInput) => {
  const session = await getLiveSessionRow(db, quizId)
  const questions = await getQuestionRows(db, quizId)
  const currentQuestion = questions[session?.current_question_index ?? -1]

  if (!session || session.status !== 'running' || !currentQuestion || !session.question_started_at) {
    throw new Error('This quiz is not accepting answers right now.')
  }

  if (currentQuestion.id !== input.questionId) {
    throw new Error('That question is not currently active.')
  }

  const elapsedSeconds = (Date.now() - Date.parse(session.question_started_at)) / 1000

  if (elapsedSeconds > session.answer_seconds) {
    throw new Error('Time is up for this question.')
  }

  const playerId = typeof input.playerId === 'string' ? input.playerId.trim() : ''
  const playerName = typeof input.playerName === 'string' ? input.playerName.trim() : ''
  const selectedOptionIndex = Number(input.selectedOptionIndex)

  if (
    !playerId ||
    !playerName ||
    !Number.isInteger(selectedOptionIndex) ||
    selectedOptionIndex < 0 ||
    selectedOptionIndex >= JSON.parse(currentQuestion.options_json).length
  ) {
    throw new Error('Answer payload is invalid.')
  }

  await db.run(
    `INSERT INTO live_answers
     (quiz_id, question_id, player_id, player_name, selected_option_index, answered_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(quiz_id, question_id, player_id) DO UPDATE SET
       player_name = excluded.player_name,
       selected_option_index = excluded.selected_option_index,
       answered_at = excluded.answered_at`,
    [quizId, input.questionId, playerId, playerName, selectedOptionIndex, new Date().toISOString()],
  )

  return getLiveSession(db, quizId, playerId)
}

const contentTypes: Record<string, string> = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const serveStatic = (res: ServerResponse, pathname: string) => {
  if (!existsSync(distPath)) {
    sendError(res, 404, 'Build the client with npm run build before using the production server.')
    return
  }

  const requestedPath = pathname === '/' ? '/index.html' : pathname
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, '')
  const filePath = path.join(distPath, safePath)
  const finalPath =
    existsSync(filePath) && statSync(filePath).isFile() ? filePath : path.join(distPath, 'index.html')
  const extension = path.extname(finalPath)

  res.writeHead(200, { 'Content-Type': contentTypes[extension] ?? 'application/octet-stream' })
  createReadStream(finalPath).pipe(res)
}

const handleApiRequest = async (db: Db, req: IncomingMessage, res: ServerResponse, pathname: string) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, null)
    return
  }

  if (req.method === 'GET' && (pathname === '/api/health' || pathname === '/health')) {
    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method === 'POST' && pathname === '/api/admin/auth') {
    if (!requireAdmin(req, res)) {
      return
    }

    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method === 'GET' && pathname === '/api/quizzes') {
    sendJson(res, 200, await listQuizzes(db))
    return
  }

  if (req.method === 'POST' && pathname === '/api/quizzes') {
    if (!requireAdmin(req, res)) {
      return
    }

    try {
      const quiz = await createQuiz(db, await readJsonBody<QuizInput>(req))
      sendJson(res, 201, quiz)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Could not create quiz.')
    }
    return
  }

  const quizMatch = pathname.match(/^\/api\/quizzes\/([^/]+)$/)

  if (req.method === 'DELETE' && quizMatch) {
    if (!requireAdmin(req, res)) {
      return
    }

    sendJson(res, (await deleteQuiz(db, quizMatch[1])) ? 204 : 404, null)
    return
  }

  const attemptMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/attempts$/)

  if (req.method === 'POST' && attemptMatch) {
    try {
      const attempt = await createAttempt(db, attemptMatch[1], await readJsonBody<AttemptInput>(req))

      if (!attempt) {
        sendError(res, 404, 'Quiz was not found.')
        return
      }

      sendJson(res, 201, attempt)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Could not save attempt.')
    }
    return
  }

  if (req.method === 'GET' && pathname === '/api/attempts') {
    sendJson(res, 200, await listAttempts(db))
    return
  }

  const liveMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/live$/)

  if (req.method === 'GET' && liveMatch) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const session = await getLiveSession(db, liveMatch[1], url.searchParams.get('playerId') ?? undefined)

    if (!session) {
      sendError(res, 404, 'Quiz was not found.')
      return
    }

    sendJson(res, 200, session)
    return
  }

  const liveStartMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/live\/start$/)

  if (req.method === 'POST' && liveStartMatch) {
    if (!requireAdmin(req, res)) {
      return
    }

    const session = await startLiveQuiz(db, liveStartMatch[1])

    if (!session) {
      sendError(res, 404, 'Quiz was not found.')
      return
    }

    sendJson(res, 200, session)
    return
  }

  const liveNextMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/live\/next$/)

  if (req.method === 'POST' && liveNextMatch) {
    if (!requireAdmin(req, res)) {
      return
    }

    const session = await advanceLiveQuiz(db, liveNextMatch[1])

    if (!session) {
      sendError(res, 400, 'Start this live quiz before advancing.')
      return
    }

    sendJson(res, 200, session)
    return
  }

  const liveAnswerMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/live\/answer$/)

  if (req.method === 'POST' && liveAnswerMatch) {
    try {
      sendJson(
        res,
        200,
        await submitLiveAnswer(db, liveAnswerMatch[1], await readJsonBody<LiveAnswerInput>(req)),
      )
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Could not save answer.')
    }
    return
  }

  sendError(res, 404, 'Not found.')
}

const bootstrap = async () => {
  const db = await createDatabase()

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (url.pathname.startsWith('/api/')) {
      void handleApiRequest(db, req, res, url.pathname)
      return
    }

    serveStatic(res, url.pathname)
  })

  server.listen(port, () => {
    console.log(`Quiz API running on http://localhost:${port}`)
    if (databaseUrl) {
      console.log('Connected to shared PostgreSQL database.')
    } else {
      console.log(`Using local SQLite database at ${databasePath}.`)
    }
  })
}

void bootstrap().catch((error: unknown) => {
  console.error('Failed to start server.', error)
  process.exit(1)
})
