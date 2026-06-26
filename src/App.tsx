import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type Question = {
  id: string
  prompt: string
  options: string[]
}

type Quiz = {
  id: string
  title: string
  description: string
  questions: Question[]
  createdAt: string
}

type Attempt = {
  id: string
  quizId: string
  quizTitle: string
  playerName: string
  score: number
  totalQuestions: number
  completedAt: string
}

type DraftQuestion = {
  prompt: string
  options: string[]
  correctOptionIndex: number
}

type ActiveQuiz = {
  quiz: Quiz
  playerId: string
  playerName: string
}

type LiveSession = {
  quizId: string
  status: 'idle' | 'running' | 'finished'
  currentQuestionIndex: number
  questionStartedAt: string | null
  answerSeconds: number
  totalQuestions: number
  currentQuestion: Question | null
  playerAnswer: number | null
  playerCount: number
  submittedAnswerCount: number
}

const playerIdStorageKey = 'quiz-app.player-id'

const emptyQuestion = (): DraftQuestion => ({
  prompt: '',
  options: ['', '', '', ''],
  correctOptionIndex: 0,
})

const getPlayerId = () => {
  const existingPlayerId = localStorage.getItem(playerIdStorageKey)

  if (existingPlayerId) {
    return existingPlayerId
  }

  const playerId = crypto.randomUUID()
  localStorage.setItem(playerIdStorageKey, playerId)
  return playerId
}

const requestJson = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed with status ${response.status}.`)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

function App() {
  const [activeSection, setActiveSection] = useState<'home' | 'admin'>(() =>
    window.location.pathname === '/admin' ? 'admin' : 'home',
  )
  const [quizzes, setQuizzes] = useState<Quiz[]>([])
  const [attempts, setAttempts] = useState<Attempt[]>([])
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [draftQuestions, setDraftQuestions] = useState<DraftQuestion[]>([emptyQuestion()])
  const [formMessage, setFormMessage] = useState('')
  const [selectedQuizId, setSelectedQuizId] = useState('')
  const [playerName, setPlayerName] = useState('')
  const [activeQuiz, setActiveQuiz] = useState<ActiveQuiz | null>(null)
  const [liveSession, setLiveSession] = useState<LiveSession | null>(null)
  const [playMessage, setPlayMessage] = useState('')
  const [adminPasswordInput, setAdminPasswordInput] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [isAdminUnlocked, setIsAdminUnlocked] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [now, setNow] = useState(Date.now())

  const selectedQuiz = useMemo(
    () => quizzes.find((quiz) => quiz.id === selectedQuizId) ?? quizzes[0],
    [quizzes, selectedQuizId],
  )
  const liveQuizId = activeQuiz?.quiz.id ?? selectedQuiz?.id

  const leaderboard = useMemo(
    () =>
      attempts
        .toSorted((left, right) => {
          const scoreDelta = right.score / right.totalQuestions - left.score / left.totalQuestions

          if (scoreDelta !== 0) {
            return scoreDelta
          }

          return Date.parse(right.completedAt) - Date.parse(left.completedAt)
        })
        .slice(0, 10),
    [attempts],
  )

  const remainingSeconds = useMemo(() => {
    if (
      !liveSession ||
      liveSession.status !== 'running' ||
      !liveSession.questionStartedAt ||
      !liveSession.currentQuestion
    ) {
      return 0
    }

    const elapsedSeconds = (now - Date.parse(liveSession.questionStartedAt)) / 1000
    return Math.max(0, Math.ceil(liveSession.answerSeconds - elapsedSeconds))
  }, [liveSession, now])
  const questionIsLocked = remainingSeconds === 0

  const refreshAttempts = async () => {
    setAttempts(await requestJson<Attempt[]>('/api/attempts'))
  }

  const getAdminHeaders = () => ({ 'x-admin-password': adminPassword })

  useEffect(() => {
    const loadSharedData = async () => {
      try {
        const [storedQuizzes, storedAttempts] = await Promise.all([
          requestJson<Quiz[]>('/api/quizzes'),
          requestJson<Attempt[]>('/api/attempts'),
        ])
        setQuizzes(storedQuizzes)
        setAttempts(storedAttempts)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not load quiz data.'
        setPlayMessage(message)
      } finally {
        setIsLoading(false)
      }
    }

    void loadSharedData()
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const handleLocationChange = () => {
      setActiveSection(window.location.pathname === '/admin' ? 'admin' : 'home')
    }

    window.addEventListener('popstate', handleLocationChange)
    return () => window.removeEventListener('popstate', handleLocationChange)
  }, [])

  const navigateToSection = (section: 'home' | 'admin') => {
    const nextPath = section === 'admin' ? '/admin' : '/'

    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, '', nextPath)
    }

    setActiveSection(section)
  }

  useEffect(() => {
    if (!liveQuizId) {
      setLiveSession(null)
      return undefined
    }

    let isCancelled = false

    const loadLiveSession = async () => {
      const playerQuery = activeQuiz ? `?playerId=${encodeURIComponent(activeQuiz.playerId)}` : ''
      const session = await requestJson<LiveSession>(`/api/quizzes/${liveQuizId}/live${playerQuery}`)

      if (isCancelled) {
        return
      }

      setLiveSession(session)

      if (session.status === 'finished') {
        await refreshAttempts()
      }
    }

    void loadLiveSession().catch((error: unknown) => {
      setPlayMessage(error instanceof Error ? error.message : 'Could not load live quiz state.')
    })

    const poller = window.setInterval(() => {
      void loadLiveSession().catch((error: unknown) => {
        setPlayMessage(error instanceof Error ? error.message : 'Could not load live quiz state.')
      })
    }, 1000)

    return () => {
      isCancelled = true
      window.clearInterval(poller)
    }
  }, [activeQuiz, liveQuizId])

  const updateQuestion = (questionIndex: number, changes: Partial<DraftQuestion>) => {
    setDraftQuestions((currentQuestions) =>
      currentQuestions.map((question, index) =>
        index === questionIndex ? { ...question, ...changes } : question,
      ),
    )
  }

  const updateOption = (questionIndex: number, optionIndex: number, value: string) => {
    setDraftQuestions((currentQuestions) =>
      currentQuestions.map((question, index) => {
        if (index !== questionIndex) {
          return question
        }

        const nextOptions = [...question.options]
        nextOptions[optionIndex] = value

        return { ...question, options: nextOptions }
      }),
    )
  }

  const saveQuiz = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const trimmedTitle = title.trim()
    const normalizedQuestions = draftQuestions.map((question) => ({
      ...question,
      prompt: question.prompt.trim(),
      options: question.options.map((option) => option.trim()),
    }))

    if (!trimmedTitle) {
      setFormMessage('Add a quiz title before publishing.')
      return
    }

    if (
      normalizedQuestions.some(
        (question) =>
          !question.prompt ||
          question.options.some((option) => !option) ||
          !question.options[question.correctOptionIndex],
      )
    ) {
      setFormMessage('Every question needs text, four answers, and a correct answer.')
      return
    }

    if (!isAdminUnlocked) {
      setFormMessage('Enter the admin password to publish quizzes.')
      return
    }

    try {
      const quiz = await requestJson<Quiz>('/api/quizzes', {
        method: 'POST',
        headers: getAdminHeaders(),
        body: JSON.stringify({
          title: trimmedTitle,
          description: description.trim(),
          questions: normalizedQuestions,
        }),
      })

      setQuizzes((currentQuizzes) => [quiz, ...currentQuizzes])
      setSelectedQuizId(quiz.id)
      setTitle('')
      setDescription('')
      setDraftQuestions([emptyQuestion()])
      setFormMessage(`Published "${quiz.title}" with ${quiz.questions.length} questions.`)
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not publish quiz.')
    }
  }

  const startLiveQuiz = async () => {
    if (!selectedQuiz) {
      setFormMessage('Create a quiz before starting a live session.')
      return
    }

    if (!isAdminUnlocked) {
      setFormMessage('Enter the admin password to control live quizzes.')
      return
    }

    try {
      setLiveSession(
        await requestJson<LiveSession>(`/api/quizzes/${selectedQuiz.id}/live/start`, {
          method: 'POST',
          headers: getAdminHeaders(),
        }),
      )
      setFormMessage(`Live session started for "${selectedQuiz.title}".`)
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not start live quiz.')
    }
  }

  const advanceLiveQuiz = async () => {
    if (!selectedQuiz) {
      return
    }

    if (!isAdminUnlocked) {
      setFormMessage('Enter the admin password to control live quizzes.')
      return
    }

    try {
      const session = await requestJson<LiveSession>(`/api/quizzes/${selectedQuiz.id}/live/next`, {
        method: 'POST',
        headers: getAdminHeaders(),
      })
      setLiveSession(session)

      if (session.status === 'finished') {
        await refreshAttempts()
        setFormMessage(`"${selectedQuiz.title}" is finished and scores are posted.`)
      } else {
        setFormMessage(`Advanced to question ${session.currentQuestionIndex + 1}.`)
      }
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not advance live quiz.')
    }
  }

  const deleteQuiz = async (quizId: string) => {
    if (!isAdminUnlocked) {
      setFormMessage('Enter the admin password to delete quizzes.')
      return
    }

    try {
      await requestJson<void>(`/api/quizzes/${quizId}`, {
        method: 'DELETE',
        headers: getAdminHeaders(),
      })
      setQuizzes((currentQuizzes) => currentQuizzes.filter((quiz) => quiz.id !== quizId))
      setAttempts((currentAttempts) =>
        currentAttempts.filter((attempt) => attempt.quizId !== quizId),
      )

      if (selectedQuizId === quizId) {
        setSelectedQuizId('')
      }
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not delete quiz.')
    }
  }

  const unlockAdmin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const trimmedPassword = adminPasswordInput.trim()

    if (!trimmedPassword) {
      setFormMessage('Enter an admin password to unlock admin controls.')
      return
    }

    try {
      await requestJson<{ ok: true }>('/api/admin/auth', {
        method: 'POST',
        headers: { 'x-admin-password': trimmedPassword },
      })
      setAdminPassword(trimmedPassword)
      setIsAdminUnlocked(true)
      setFormMessage('Admin controls unlocked.')
    } catch (error) {
      setIsAdminUnlocked(false)
      setAdminPassword('')
      setFormMessage(error instanceof Error ? error.message : 'Admin password check failed.')
    }
  }

  const lockAdmin = () => {
    setIsAdminUnlocked(false)
    setAdminPassword('')
    setAdminPasswordInput('')
    setFormMessage('Admin controls locked.')
  }

  const joinQuiz = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!selectedQuiz) {
      setPlayMessage('Create a quiz before players can join.')
      return
    }

    const trimmedPlayerName = playerName.trim()

    if (!trimmedPlayerName) {
      setPlayMessage('Enter a player name to begin.')
      return
    }

    setActiveQuiz({
      quiz: selectedQuiz,
      playerId: getPlayerId(),
      playerName: trimmedPlayerName,
    })
    setPlayMessage('')
  }

  const submitLiveAnswer = async (selectedOptionIndex: number) => {
    if (!activeQuiz || !liveSession?.currentQuestion || questionIsLocked) {
      return
    }

    try {
      setLiveSession(
        await requestJson<LiveSession>(`/api/quizzes/${activeQuiz.quiz.id}/live/answer`, {
          method: 'POST',
          body: JSON.stringify({
            playerId: activeQuiz.playerId,
            playerName: activeQuiz.playerName,
            questionId: liveSession.currentQuestion.id,
            selectedOptionIndex,
          }),
        }),
      )
      setPlayMessage('Answer saved. You can change it until time is up.')
    } catch (error) {
      setPlayMessage(error instanceof Error ? error.message : 'Could not save answer.')
    }
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Live quiz builder</p>
          <h1>Create quizzes and let everyone play</h1>
          <p className="hero-copy">
            Admins publish quizzes, start a live session, and control when players move to the next
            question. Each question accepts answers for 60 seconds.
          </p>
          <div className="button-row hero-actions">
            <button
              type="button"
              className={activeSection === 'admin' ? 'secondary-button' : undefined}
              onClick={() => navigateToSection('home')}
            >
              Home
            </button>
            <button
              type="button"
              className={activeSection === 'admin' ? undefined : 'secondary-button'}
              onClick={() => navigateToSection('admin')}
            >
              Admin
            </button>
          </div>
        </div>
        <div className="stat-card" aria-label="Quiz app stats">
          <strong>{quizzes.length}</strong>
          <span>published quizzes</span>
          <strong>{attempts.length}</strong>
          <span>completed plays</span>
        </div>
      </section>

      {isLoading ? (
        <section className="panel full-width">
          <p>Loading shared quiz data...</p>
        </section>
      ) : (
        <>
          <div className="workspace workspace-single">
            {activeSection === 'admin' ? (
              <section className="panel">
              <div className="panel-heading">
                <p className="eyebrow">Admin</p>
                <h2>Build a quiz</h2>
              </div>

              <form onSubmit={unlockAdmin} className="stack admin-gate">
                <label>
                  Admin password
                  <input
                    type="password"
                    value={adminPasswordInput}
                    onChange={(event) => setAdminPasswordInput(event.target.value)}
                    autoComplete="current-password"
                  />
                </label>

                <div className="button-row">
                  <button type="submit">Unlock admin controls</button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!isAdminUnlocked}
                    onClick={lockAdmin}
                  >
                    Lock
                  </button>
                </div>
              </form>

              {!isAdminUnlocked ? (
                <p className="status-message">Admin controls are locked.</p>
              ) : (
                <p className="status-message">Admin controls are unlocked.</p>
              )}

              <form onSubmit={saveQuiz} className="stack" aria-disabled={!isAdminUnlocked}>
                <label>
                  Quiz title
                  <input
                    value={title}
                    disabled={!isAdminUnlocked}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>

                <label>
                  Description
                  <textarea
                    value={description}
                    disabled={!isAdminUnlocked}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={3}
                  />
                </label>

                {draftQuestions.map((question, questionIndex) => (
                  <fieldset key={questionIndex} className="question-card">
                    <legend>Question {questionIndex + 1}</legend>
                    <label>
                      Prompt
                      <input
                        value={question.prompt}
                        disabled={!isAdminUnlocked}
                        onChange={(event) =>
                          updateQuestion(questionIndex, { prompt: event.target.value })
                        }
                      />
                    </label>

                    <div className="answers-grid">
                      {question.options.map((option, optionIndex) => (
                        <label key={optionIndex}>
                          Answer {optionIndex + 1}
                          <div className="answer-row">
                            <input
                              value={option}
                              disabled={!isAdminUnlocked}
                              onChange={(event) =>
                                updateOption(questionIndex, optionIndex, event.target.value)
                              }
                            />
                            <input
                              type="radio"
                              name={`correct-${questionIndex}`}
                              disabled={!isAdminUnlocked}
                              checked={question.correctOptionIndex === optionIndex}
                              onChange={() =>
                                updateQuestion(questionIndex, { correctOptionIndex: optionIndex })
                              }
                              aria-label={`Mark answer ${optionIndex + 1} as correct`}
                            />
                          </div>
                        </label>
                      ))}
                    </div>

                    {draftQuestions.length > 1 && (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={!isAdminUnlocked}
                        onClick={() =>
                          setDraftQuestions((currentQuestions) =>
                            currentQuestions.filter((_, index) => index !== questionIndex),
                          )
                        }
                      >
                        Remove question
                      </button>
                    )}
                  </fieldset>
                ))}

                <div className="button-row">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!isAdminUnlocked}
                    onClick={() =>
                      setDraftQuestions((questions) => [...questions, emptyQuestion()])
                    }
                  >
                    Add question
                  </button>
                  <button type="submit" disabled={!isAdminUnlocked}>
                    Publish quiz
                  </button>
                </div>
              </form>

              <section className="live-controls">
                <p className="eyebrow">Live controls</p>
                <h3>{selectedQuiz ? selectedQuiz.title : 'No quiz selected'}</h3>
                {liveSession && selectedQuiz && (
                  <div className="live-status-grid">
                    <span>Status: {liveSession.status}</span>
                    <span>
                      Question {Math.min(liveSession.currentQuestionIndex + 1, liveSession.totalQuestions)} of{' '}
                      {liveSession.totalQuestions}
                    </span>
                    <span>{liveSession.playerCount} joined players</span>
                    <span>
                      {liveSession.submittedAnswerCount}/{liveSession.playerCount} answered
                    </span>
                    <span>{remainingSeconds}s accepting answers</span>
                  </div>
                )}
                <div className="button-row">
                  <button
                    type="button"
                    disabled={!isAdminUnlocked || !selectedQuiz}
                    onClick={() => void startLiveQuiz()}
                  >
                    Start / restart live quiz
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!isAdminUnlocked || !selectedQuiz || liveSession?.status !== 'running'}
                    onClick={() => void advanceLiveQuiz()}
                  >
                    {liveSession &&
                    liveSession.currentQuestionIndex + 1 >= liveSession.totalQuestions
                      ? 'Finish quiz'
                      : 'Next question'}
                  </button>
                </div>
              </section>

              {formMessage && <p className="status-message">{formMessage}</p>}
              </section>
            ) : (
              <section className="panel">
              <div className="panel-heading">
                <p className="eyebrow">Players</p>
                <h2>Join the live quiz</h2>
              </div>

              {!activeQuiz ? (
                <form onSubmit={joinQuiz} className="stack">
                  <label>
                    Choose quiz
                    <select
                      value={selectedQuiz?.id ?? ''}
                      onChange={(event) => setSelectedQuizId(event.target.value)}
                      disabled={quizzes.length === 0}
                    >
                      {quizzes.length === 0 ? (
                        <option value="">No quizzes yet</option>
                      ) : (
                        quizzes.map((quiz) => (
                          <option key={quiz.id} value={quiz.id}>
                            {quiz.title}
                          </option>
                        ))
                      )}
                    </select>
                  </label>

                  <label>
                    Player name
                    <input
                      value={playerName}
                      onChange={(event) => setPlayerName(event.target.value)}
                    />
                  </label>

                  {selectedQuiz && (
                    <article className="quiz-summary">
                      <h3>{selectedQuiz.title}</h3>
                      <p>{selectedQuiz.description || 'No description provided.'}</p>
                      <span>{selectedQuiz.questions.length} questions</span>
                    </article>
                  )}

                  <button type="submit" disabled={!selectedQuiz}>
                    Join quiz
                  </button>
                </form>
              ) : (
                <div className="stack">
                  <div>
                    <p className="eyebrow">Playing as {activeQuiz.playerName}</p>
                    <h3>{activeQuiz.quiz.title}</h3>
                  </div>

                  {liveSession?.status === 'running' && liveSession.currentQuestion ? (
                    <fieldset className="question-card active-question">
                      <legend>
                        Question {liveSession.currentQuestionIndex + 1} of{' '}
                        {liveSession.totalQuestions}
                      </legend>
                      <div className="timer-pill">
                        {remainingSeconds > 0
                          ? `${remainingSeconds}s left`
                          : 'Time is up. Wait for the admin.'}
                      </div>
                      <h3>{liveSession.currentQuestion.prompt}</h3>
                      <div className="option-list">
                        {liveSession.currentQuestion.options.map((option, optionIndex) => (
                          <label key={`${liveSession.currentQuestion?.id}-${optionIndex}`}>
                            <input
                              type="radio"
                              name={liveSession.currentQuestion?.id}
                              disabled={questionIsLocked}
                              checked={liveSession.playerAnswer === optionIndex}
                              onChange={() => void submitLiveAnswer(optionIndex)}
                            />
                            {option}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ) : liveSession?.status === 'finished' ? (
                    <article className="quiz-summary">
                      <h3>Quiz complete</h3>
                      <p>Your score will appear on the leaderboard after the admin finishes.</p>
                    </article>
                  ) : (
                    <article className="quiz-summary">
                      <h3>Waiting for the admin</h3>
                      <p>The next question will appear here when the admin starts or advances.</p>
                    </article>
                  )}

                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setActiveQuiz(null)}
                  >
                    Leave quiz
                  </button>
                </div>
              )}

              {playMessage && <p className="status-message">{playMessage}</p>}
              </section>
            )}
          </div>

          {activeSection === 'home' && (
            <section className="panel full-width">
              <div className="panel-heading">
                <p className="eyebrow">Results</p>
                <h2>Recent leaderboard</h2>
              </div>

              {leaderboard.length === 0 ? (
                <p>No one has completed a quiz yet.</p>
              ) : (
                <div className="results-list">
                  {leaderboard.map((attempt) => (
                    <article key={attempt.id} className="result-card">
                      <div>
                        <strong>{attempt.playerName}</strong>
                        <span>{attempt.quizTitle}</span>
                      </div>
                      <strong>
                        {attempt.score}/{attempt.totalQuestions}
                      </strong>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}

          {activeSection === 'admin' && quizzes.length > 0 && (
            <section className="panel full-width">
              <div className="panel-heading">
                <p className="eyebrow">Admin library</p>
                <h2>Published quizzes</h2>
              </div>

              <div className="quiz-library">
                {quizzes.map((quiz) => (
                  <article key={quiz.id} className="quiz-summary">
                    <div>
                      <h3>{quiz.title}</h3>
                      <p>{quiz.description || 'No description provided.'}</p>
                    </div>
                    <div className="button-row">
                      <span>{quiz.questions.length} questions</span>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={!isAdminUnlocked}
                        onClick={() => setSelectedQuizId(quiz.id)}
                      >
                        Select
                      </button>
                      <button
                        type="button"
                        className="danger-button"
                        disabled={!isAdminUnlocked}
                        onClick={() => void deleteQuiz(quiz.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  )
}

export default App
