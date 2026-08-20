const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { parse } = require("csv-parse/sync");
const QRCode = require("qrcode");

const PORT = Number(process.env.PORT || 3000);
const BASE_PATH = normalizeBasePath(process.env.QUIZ_BASE_PATH || "");
const PUBLIC_APP_URL = normalizePublicAppUrl(process.env.QUIZ_PUBLIC_URL || "");
const DEFAULT_QUESTION_TIME_MS = 15000;
const MIN_QUESTION_TIME_MS = 5000;
const MAX_QUESTION_TIME_MS = 120000;
const REVEAL_TIME_MS = 5000;
const MIN_CORRECT_POINTS = 400;
const MAX_CORRECT_POINTS = 1000;
const SESSION_CODE_LENGTH = 6;
const SESSION_TTL_SECONDS = 6 * 60 * 60;
const LOCK_TTL_MS = 5000;
const LOCK_WAIT_MS = 2500;
const LOCK_RETRY_MS = 75;

function normalizeBasePath(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

function normalizePublicAppUrl(rawValue) {
  return String(rawValue || "").trim().replace(/\/+$/, "");
}

function stripBasePath(pathname) {
  if (!BASE_PATH) {
    return pathname;
  }

  if (pathname === BASE_PATH) {
    return "/";
  }

  if (pathname.startsWith(`${BASE_PATH}/`)) {
    return pathname.slice(BASE_PATH.length) || "/";
  }

  return null;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error("Request body exceeded 10MB."));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function normalizeHeader(header) {
  return String(header || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function findRowValue(row, aliases) {
  for (const alias of aliases) {
    const value = row[normalizeHeader(alias)];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function optionLetterFromValue(rawValue, optionMap) {
  const normalized = String(rawValue || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const letterCandidate = normalized.replace(/[^a-d]/g, "");
  if (letterCandidate.length === 1 && optionMap[letterCandidate.toUpperCase()]) {
    return letterCandidate.toUpperCase();
  }

  for (const [letter, optionText] of Object.entries(optionMap)) {
    if (optionText.trim().toLowerCase() === normalized) {
      return letter;
    }
  }

  return null;
}

function parseQuizCsv(csvText) {
  let rows;
  try {
    rows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: false,
      bom: true
    });
  } catch (error) {
    return {
      errors: [{ rowNumber: 0, issues: [`CSV parsing failed: ${error.message}`] }],
      validQuestions: [],
      previewQuestions: []
    };
  }

  const validQuestions = [];
  const previewQuestions = [];
  const errors = [];

  rows.forEach((rawRow, index) => {
    const rowNumber = index + 2;
    const row = {};
    for (const [key, value] of Object.entries(rawRow)) {
      row[normalizeHeader(key)] = typeof value === "string" ? value.trim() : value;
    }

    const question = findRowValue(row, ["Question"]);
    const optionMap = {
      A: findRowValue(row, ["A", "Option A"]),
      B: findRowValue(row, ["B", "Option B"]),
      C: findRowValue(row, ["C", "Option C"]),
      D: findRowValue(row, ["D", "Option D"])
    };
    const answerKey = findRowValue(row, [
      "Correct answer(s) - Choose at least one, answers separated by a comma",
      "Correct answer(s)",
      "Correct Answer(s)",
      "Correct answer",
      "Answer",
      "✅ Answer"
    ]);

    const isCompletelyBlank = !question && Object.values(optionMap).every((value) => !value) && !answerKey;
    if (isCompletelyBlank) {
      return;
    }

    const issues = [];
    if (!question) {
      issues.push("Missing question text.");
    }

    for (const [letter, value] of Object.entries(optionMap)) {
      if (!value) {
        issues.push(`Missing option ${letter}.`);
      }
    }

    const answerParts = String(answerKey)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    const parsedAnswers = [...new Set(answerParts.map((part) => optionLetterFromValue(part, optionMap)).filter(Boolean))];

    if (answerParts.length === 0) {
      issues.push("Missing correct answer.");
    } else if (parsedAnswers.length !== 1) {
      issues.push("Correct answer must resolve to exactly one option (A, B, C, or D).");
    }

    const previewQuestion = {
      rowNumber,
      question,
      options: optionMap,
      correctAnswer: parsedAnswers[0] || null,
      valid: issues.length === 0
    };

    previewQuestions.push(previewQuestion);

    if (issues.length > 0) {
      errors.push({ rowNumber, issues });
      return;
    }

    validQuestions.push(previewQuestion);
  });

  if (validQuestions.length !== 15) {
    errors.push({
      rowNumber: 0,
      issues: [`Expected exactly 15 valid questions, but found ${validQuestions.length}.`]
    });
  }

  return { errors, validQuestions, previewQuestions };
}

function deepClone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function createMemoryStore() {
  const sessions = new Map();

  return {
    async getSession(code) {
      return deepClone(sessions.get(code) || null);
    },
    async saveSession(session) {
      sessions.set(session.code, deepClone(session));
      return deepClone(session);
    },
    async mutateSession(code, updater) {
      const nextSession = await updater(deepClone(sessions.get(code) || null));
      if (!nextSession) {
        return null;
      }
      sessions.set(code, deepClone(nextSession));
      return deepClone(nextSession);
    }
  };
}

function createRedisStore() {
  const redisUrl = String(process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, "");
  const redisToken = String(process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();

  if (!redisUrl || !redisToken) {
    return null;
  }

  async function redisCommand(...args) {
    const response = await fetch(redisUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${redisToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(args)
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || payload.message || "Redis request failed.");
    }
    if (payload.error) {
      throw new Error(payload.error);
    }
    return payload.result;
  }

  function sessionKey(code) {
    return `quick-quiz:session:${code}`;
  }

  function lockKey(code) {
    return `quick-quiz:lock:${code}`;
  }

  async function acquireLock(code) {
    const token = crypto.randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;

    while (Date.now() < deadline) {
      const result = await redisCommand("SET", lockKey(code), token, "NX", "PX", String(LOCK_TTL_MS));
      if (result === "OK") {
        return token;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }

    throw new Error("Quiz session is busy. Please try again.");
  }

  async function releaseLock(code, token) {
    try {
      const current = await redisCommand("GET", lockKey(code));
      if (current === token) {
        await redisCommand("DEL", lockKey(code));
      }
    } catch {}
  }

  return {
    async getSession(code) {
      const raw = await redisCommand("GET", sessionKey(code));
      return raw ? JSON.parse(raw) : null;
    },
    async saveSession(session) {
      await redisCommand("SET", sessionKey(session.code), JSON.stringify(session), "EX", String(SESSION_TTL_SECONDS));
      return deepClone(session);
    },
    async mutateSession(code, updater) {
      const token = await acquireLock(code);

      try {
        const raw = await redisCommand("GET", sessionKey(code));
        const currentSession = raw ? JSON.parse(raw) : null;
        const nextSession = await updater(currentSession);
        if (!nextSession) {
          return null;
        }

        await redisCommand("SET", sessionKey(code), JSON.stringify(nextSession), "EX", String(SESSION_TTL_SECONDS));
        return deepClone(nextSession);
      } finally {
        await releaseLock(code, token);
      }
    }
  };
}

function generateCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: SESSION_CODE_LENGTH }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function getLocalIpAddress() {
  const networkInterfaces = os.networkInterfaces();
  for (const adapters of Object.values(networkInterfaces)) {
    for (const adapter of adapters || []) {
      if (adapter.family === "IPv4" && !adapter.internal) {
        return adapter.address;
      }
    }
  }
  return "localhost";
}

function getRequestOrigin(request) {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const forwardedHost = request.headers["x-forwarded-host"];
  const protocol = typeof forwardedProto === "string" && forwardedProto ? forwardedProto.split(",")[0].trim() : "http";
  const host = typeof forwardedHost === "string" && forwardedHost ? forwardedHost.split(",")[0].trim() : request.headers.host;
  return `${protocol}://${host}`;
}

function getDefaultLocalAppUrl() {
  return `http://${getLocalIpAddress()}:${PORT}${BASE_PATH}`;
}

function getPublicAppUrl(request) {
  if (PUBLIC_APP_URL) {
    return PUBLIC_APP_URL;
  }

  if (request) {
    return `${getRequestOrigin(request)}${BASE_PATH}`;
  }

  return getDefaultLocalAppUrl();
}

function getJoinUrl(publicAppUrl, code) {
  return `${publicAppUrl}/?code=${encodeURIComponent(code)}`;
}

function normalizeQuestionTimeMs(timerSeconds) {
  const numericSeconds = Number(timerSeconds);
  if (!Number.isFinite(numericSeconds)) {
    return DEFAULT_QUESTION_TIME_MS;
  }

  return Math.min(MAX_QUESTION_TIME_MS, Math.max(MIN_QUESTION_TIME_MS, Math.round(numericSeconds * 1000)));
}

function createSession(questions, filename, questionTimeMs, publicAppUrl) {
  return {
    code: "",
    hostToken: crypto.randomUUID(),
    filename,
    publicAppUrl,
    questionTimeMs,
    questions,
    participants: {},
    status: "lobby",
    currentQuestionIndex: -1,
    questionStartedAt: null,
    questionEndsAt: null,
    revealEndsAt: null,
    submissions: {},
    provisionalSelections: {},
    qrCodeDataUrl: "",
    revealedAnswer: null,
    lastLeaderboard: []
  };
}

function participantEntries(session) {
  return Object.values(session.participants || {});
}

function leaderboardForSession(session) {
  const leaderboard = participantEntries(session)
    .map((participant) => ({
      id: participant.id,
      name: participant.name,
      score: participant.score,
      correctCount: participant.correctCount,
      lastEarnedPoints: participant.lastEarnedPoints || 0,
      rank: 0
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.correctCount !== left.correctCount) {
        return right.correctCount - left.correctCount;
      }
      return left.name.localeCompare(right.name);
    })
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  session.lastLeaderboard = leaderboard;
  return leaderboard;
}

function currentQuestionPayload(session) {
  if (session.currentQuestionIndex < 0 || session.currentQuestionIndex >= session.questions.length) {
    return null;
  }

  const question = session.questions[session.currentQuestionIndex];
  return {
    index: session.currentQuestionIndex,
    number: session.currentQuestionIndex + 1,
    total: session.questions.length,
    question: question.question,
    options: question.options,
    correctAnswer: session.status === "reveal" || session.status === "final" ? question.correctAnswer : null,
    startedAt: session.questionStartedAt,
    endsAt: session.status === "reveal" ? session.revealEndsAt : session.questionEndsAt
  };
}

function hostState(session) {
  const leaderboard = leaderboardForSession(session);
  const winner = leaderboard[0] || null;
  return {
    role: "host",
    code: session.code,
    joinUrl: getJoinUrl(session.publicAppUrl, session.code),
    qrCodeDataUrl: session.qrCodeDataUrl,
    filename: session.filename,
    timerSeconds: session.questionTimeMs / 1000,
    revealSeconds: REVEAL_TIME_MS / 1000,
    status: session.status,
    participantCount: participantEntries(session).length,
    participants: participantEntries(session).map((participant) => ({
      id: participant.id,
      name: participant.name,
      score: participant.score
    })),
    currentQuestion: currentQuestionPayload(session),
    leaderboard,
    winner,
    revealedAnswer: session.revealedAnswer,
    submissionsCount: Object.keys(session.submissions || {}).length
  };
}

function isAuthorizedHost(session, hostToken) {
  return Boolean(session && hostToken && session.hostToken === hostToken);
}

function participantState(session, participantId) {
  const participant = session.participants[participantId];
  if (!participant) {
    return { role: "participant", exists: false };
  }

  const submission = session.submissions[participantId];
  const provisionalSelection = session.provisionalSelections[participantId];
  const leaderboard = leaderboardForSession(session);
  return {
    role: "participant",
    exists: true,
    code: session.code,
    participant: {
      id: participant.id,
      name: participant.name,
      score: participant.score,
      rank: leaderboard.find((entry) => entry.id === participant.id)?.rank || null,
      lastEarnedPoints: participant.lastEarnedPoints || 0
    },
    timerSeconds: session.questionTimeMs / 1000,
    revealSeconds: REVEAL_TIME_MS / 1000,
    status: session.status,
    currentQuestion: currentQuestionPayload(session),
    hasSubmitted: Boolean(submission),
    submittedAnswer: submission?.answer || null,
    autoSubmitted: Boolean(submission?.autoSubmitted),
    draftAnswer: submission ? submission.answer : provisionalSelection?.answer || null,
    revealedAnswer: session.revealedAnswer,
    leaderboard,
    winner: leaderboard[0] || null
  };
}

function calculatePoints(submittedAt, questionEndsAt, questionTimeMs) {
  const remainingMs = Math.max(0, questionEndsAt - submittedAt);
  const totalMs = Math.max(1, questionTimeMs);
  const ratio = remainingMs / totalMs;
  return Math.round(MIN_CORRECT_POINTS + (MAX_CORRECT_POINTS - MIN_CORRECT_POINTS) * ratio);
}

function finalizeSession(session) {
  session.status = "final";
  session.revealEndsAt = null;
  session.questionEndsAt = null;
}

function revealCurrentQuestion(session) {
  if (session.status !== "question") {
    return;
  }

  const question = session.questions[session.currentQuestionIndex];
  session.status = "reveal";
  session.revealedAnswer = question.correctAnswer;
  session.revealEndsAt = (session.questionEndsAt || Date.now()) + REVEAL_TIME_MS;

  for (const participant of participantEntries(session)) {
    let submission = session.submissions[participant.id];
    if (!submission) {
      const draftSelection = session.provisionalSelections[participant.id];
      if (draftSelection?.answer) {
        submission = {
          answer: draftSelection.answer,
          submittedAt: session.questionEndsAt || Date.now(),
          autoSubmitted: true
        };
        session.submissions[participant.id] = submission;
      }
    }

    if (!submission || submission.answer !== question.correctAnswer) {
      participant.lastEarnedPoints = 0;
      continue;
    }

    const points = calculatePoints(submission.submittedAt, session.questionEndsAt || Date.now(), session.questionTimeMs);
    participant.score += points;
    participant.correctCount += 1;
    participant.lastEarnedPoints = points;
  }
}

function startNextQuestion(session, startAt = Date.now()) {
  session.currentQuestionIndex += 1;
  session.submissions = {};
  session.provisionalSelections = {};
  session.revealedAnswer = null;
  session.revealEndsAt = null;

  if (session.currentQuestionIndex >= session.questions.length) {
    finalizeSession(session);
    return;
  }

  session.status = "question";
  session.questionStartedAt = startAt;
  session.questionEndsAt = startAt + session.questionTimeMs;
}

function syncSessionProgress(session, now = Date.now()) {
  let changed = false;

  while (true) {
    if (session.status === "question" && session.questionEndsAt && now >= session.questionEndsAt) {
      revealCurrentQuestion(session);
      changed = true;
      continue;
    }

    if (session.status === "reveal" && session.revealEndsAt && now >= session.revealEndsAt) {
      if (session.currentQuestionIndex >= session.questions.length - 1) {
        finalizeSession(session);
      } else {
        startNextQuestion(session, session.revealEndsAt);
      }
      changed = true;
      continue;
    }

    break;
  }

  return changed;
}

async function assignUniqueCode(store, session) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = generateCode();
    const createdSession = await store.mutateSession(code, async (currentSession) => {
      if (currentSession) {
        return currentSession;
      }

      return {
        ...session,
        code
      };
    });

    if (createdSession && createdSession.hostToken === session.hostToken) {
      return createdSession;
    }
  }

  throw new Error("Unable to create a unique quiz code. Please try again.");
}

async function createSessionFromCsv(store, filename, csvText, timerSeconds, request) {
  const parsed = parseQuizCsv(csvText);
  if (parsed.errors.length > 0) {
    return { ok: false, ...parsed };
  }

  const draftSession = createSession(
    parsed.validQuestions,
    filename,
    normalizeQuestionTimeMs(timerSeconds),
    getPublicAppUrl(request)
  );

  const session = await assignUniqueCode(store, draftSession);
  session.qrCodeDataUrl = await QRCode.toDataURL(getJoinUrl(session.publicAppUrl, session.code), {
    width: 320,
    margin: 1
  });
  await store.saveSession(session);

  return {
    ok: true,
    code: session.code,
    hostToken: session.hostToken,
    timerSeconds: session.questionTimeMs / 1000,
    joinUrl: getJoinUrl(session.publicAppUrl, session.code),
    qrCodeDataUrl: session.qrCodeDataUrl,
    previewQuestions: parsed.previewQuestions,
    errors: []
  };
}

async function buildSessionResponse(store, session) {
  session.qrCodeDataUrl = await QRCode.toDataURL(getJoinUrl(session.publicAppUrl, session.code), {
    width: 320,
    margin: 1
  });
  await store.saveSession(session);

  return {
    ok: true,
    code: session.code,
    hostToken: session.hostToken,
    timerSeconds: session.questionTimeMs / 1000,
    joinUrl: getJoinUrl(session.publicAppUrl, session.code),
    qrCodeDataUrl: session.qrCodeDataUrl
  };
}

async function restartSessionFromExisting(store, session) {
  const nextDraftSession = createSession(session.questions, session.filename, session.questionTimeMs, session.publicAppUrl);
  const nextSession = await assignUniqueCode(store, nextDraftSession);
  return buildSessionResponse(store, nextSession);
}

function validateCsvOnly(csvText) {
  const parsed = parseQuizCsv(csvText);
  return {
    ok: parsed.errors.length === 0,
    ...parsed
  };
}

function serveStaticFile(response, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".csv": "text/csv; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    }[ext] || "application/octet-stream";

  fs.readFile(filePath, (error, buffer) => {
    if (error) {
      sendJson(response, 404, { error: "File not found" });
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    response.end(buffer);
  });
}

function createQuizApp({ rootDir = __dirname } = {}) {
  const PUBLIC_DIR = path.join(rootDir, "public");
  const store = createRedisStore() || createMemoryStore();

  function serveIndexHtml(response) {
    const indexPath = path.join(PUBLIC_DIR, "index.html");
    fs.readFile(indexPath, "utf8", (error, html) => {
      if (error) {
        sendJson(response, 404, { error: "File not found" });
        return;
      }

      const renderedHtml = html.replaceAll("__QUIZ_BASE_PATH__", BASE_PATH);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate"
      });
      response.end(renderedHtml);
    });
  }

  async function loadSessionForRead(code) {
    const session = await store.getSession(code);
    if (!session) {
      return null;
    }

    if (syncSessionProgress(session)) {
      await store.saveSession(session);
    }

    return session;
  }

  async function handleApiRequest(request, response, pathname) {
    if (request.method === "GET" && pathname === "/api/meta") {
      sendJson(response, 200, {
        port: PORT,
        hostUrl: getPublicAppUrl(request),
        basePath: BASE_PATH || "/",
        defaultTimerSeconds: DEFAULT_QUESTION_TIME_MS / 1000,
        minTimerSeconds: MIN_QUESTION_TIME_MS / 1000,
        maxTimerSeconds: MAX_QUESTION_TIME_MS / 1000,
        revealSeconds: REVEAL_TIME_MS / 1000,
        realtimeMode: process.env.UPSTASH_REDIS_REST_URL ? "durable-polling" : "local-polling",
        scoring: `Correct answer points = ${MIN_CORRECT_POINTS} + (${MAX_CORRECT_POINTS - MIN_CORRECT_POINTS} * remainingTime / configured timer)`
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/session/validate") {
      const body = JSON.parse(await readRequestBody(request));
      const result = validateCsvOnly(body.csvText || "");
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    if (request.method === "POST" && pathname === "/api/session/create") {
      const body = JSON.parse(await readRequestBody(request));
      const result = await createSessionFromCsv(store, body.filename || "quiz.csv", body.csvText || "", body.timerSeconds, request);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    const pathMatch = pathname.match(/^\/api\/session\/([A-Z0-9]+)\/([a-z-]+)$/);
    if (!pathMatch) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const [, code, action] = pathMatch;
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && action === "host-state") {
      const hostToken = String(url.searchParams.get("hostToken") || "");
      const session = await loadSessionForRead(code);
      if (!session) {
        sendJson(response, 404, { error: "Quiz session not found." });
        return;
      }
      if (!isAuthorizedHost(session, hostToken)) {
        sendJson(response, 403, { error: "Host authorization failed." });
        return;
      }

      sendJson(response, 200, hostState(session));
      return;
    }

    if (request.method === "GET" && action === "participant-state") {
      const participantId = String(url.searchParams.get("participantId") || "");
      const session = await loadSessionForRead(code);
      if (!session) {
        sendJson(response, 404, { error: "Quiz session not found." });
        return;
      }

      sendJson(response, 200, participantState(session, participantId));
      return;
    }

    const body = request.method === "POST" ? JSON.parse(await readRequestBody(request)) : {};

    if (request.method === "POST" && action === "join") {
      const updatedSession = await store.mutateSession(code, async (session) => {
        if (!session) {
          throw new Error("Quiz session not found.");
        }

        syncSessionProgress(session);

        if (session.status === "final") {
          throw new Error("The quiz has already finished.");
        }
        if (session.currentQuestionIndex >= 0) {
          throw new Error("Joining is closed after the quiz begins.");
        }

        const name = String(body.name || "").trim().slice(0, 30);
        if (!name) {
          throw new Error("Please enter a participant name.");
        }

        const duplicateName = participantEntries(session).some(
          (participant) => participant.name.toLowerCase() === name.toLowerCase()
        );
        if (duplicateName) {
          throw new Error("That name is already in use for this quiz.");
        }

        const participantId = crypto.randomUUID();
        session.participants[participantId] = {
          id: participantId,
          name,
          score: 0,
          correctCount: 0,
          lastEarnedPoints: 0
        };
        session.lastJoinedParticipantId = participantId;
        return session;
      });

      sendJson(response, 200, { participantId: updatedSession.lastJoinedParticipantId });
      return;
    }

    const session = await store.mutateSession(code, async (currentSession) => {
      if (!currentSession) {
        throw new Error("Quiz session not found.");
      }

      syncSessionProgress(currentSession);

      if (action === "start-quiz") {
        if (!isAuthorizedHost(currentSession, body.hostToken)) {
          throw new Error("Host authorization failed.");
        }
        if (currentSession.status !== "lobby") {
          throw new Error("Quiz is already in progress.");
        }
        currentSession.status = "ready";
        return currentSession;
      }

      if (action === "start-question") {
        if (!isAuthorizedHost(currentSession, body.hostToken)) {
          throw new Error("Host authorization failed.");
        }
        if (currentSession.status !== "ready") {
          throw new Error("You can only start the quiz questions from the waiting state.");
        }
        startNextQuestion(currentSession);
        return currentSession;
      }

      if (action === "restart") {
        if (!isAuthorizedHost(currentSession, body.hostToken)) {
          throw new Error("Host authorization failed.");
        }
        if (currentSession.status !== "final") {
          throw new Error("You can only restart the quiz after it finishes.");
        }
        return currentSession;
      }

      if (action === "submit") {
        if (currentSession.status !== "question") {
          throw new Error("Answering is closed for this question.");
        }

        const participantId = String(body.participantId || "");
        const answer = String(body.answer || "").trim().toUpperCase();
        if (!currentSession.participants[participantId]) {
          throw new Error("Participant not found.");
        }
        if (!["A", "B", "C", "D"].includes(answer)) {
          throw new Error("Answer must be A, B, C, or D.");
        }
        if (currentSession.submissions[participantId]) {
          throw new Error("Answer already submitted.");
        }

        currentSession.submissions[participantId] = {
          answer,
          submittedAt: Date.now(),
          autoSubmitted: false
        };
        return currentSession;
      }

      if (action === "select") {
        if (currentSession.status !== "question") {
          throw new Error("Selection is closed for this question.");
        }

        const participantId = String(body.participantId || "");
        const answer = String(body.answer || "").trim().toUpperCase();
        if (!currentSession.participants[participantId]) {
          throw new Error("Participant not found.");
        }
        if (!["A", "B", "C", "D"].includes(answer)) {
          throw new Error("Answer must be A, B, C, or D.");
        }
        if (currentSession.submissions[participantId]) {
          throw new Error("Answer already submitted.");
        }

        currentSession.provisionalSelections[participantId] = {
          answer,
          selectedAt: Date.now()
        };
        return currentSession;
      }

      throw new Error("Not found");
    });

    if (request.method === "POST" && action === "restart") {
      const result = await restartSessionFromExisting(store, session);
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 200, { ok: true });
  }

  async function handleRequest(request, response) {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const effectivePathname = requestUrl.searchParams.get("__quiz_path") || requestUrl.pathname;
    const strippedPathname = stripBasePath(effectivePathname);

    try {
      if (strippedPathname === null) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      if (BASE_PATH && effectivePathname === BASE_PATH) {
        response.writeHead(302, {
          Location: `${BASE_PATH}/${requestUrl.search || ""}`
        });
        response.end();
        return;
      }

      if (strippedPathname.startsWith("/api/")) {
        await handleApiRequest(request, response, strippedPathname);
        return;
      }

      const relativeStaticPath = strippedPathname === "/" ? "index.html" : strippedPathname.replace(/^\/+/, "");
      const filePath = path.join(PUBLIC_DIR, relativeStaticPath);
      if (!filePath.startsWith(PUBLIC_DIR)) {
        sendJson(response, 403, { error: "Forbidden" });
        return;
      }

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        serveIndexHtml(response);
        return;
      }

      if (path.basename(filePath).toLowerCase() === "index.html") {
        serveIndexHtml(response);
        return;
      }

      serveStaticFile(response, filePath);
    } catch (error) {
      const knownMessage = error.message || "Unexpected server error.";
      const badRequestMessages = new Set([
        "The quiz has already finished.",
        "Joining is closed after the quiz begins.",
        "Please enter a participant name.",
        "That name is already in use for this quiz.",
        "Quiz is already in progress.",
        "You can only start the quiz questions from the waiting state.",
        "You can only restart the quiz after it finishes.",
        "Answering is closed for this question.",
        "Selection is closed for this question.",
        "Answer must be A, B, C, or D.",
        "Answer already submitted.",
        "Quiz session is busy. Please try again."
      ]);

      const statusCode =
        knownMessage === "Quiz session not found."
          ? 404
          : knownMessage === "Host authorization failed."
            ? 403
            : knownMessage === "Participant not found."
              ? 404
              : knownMessage === "Not found"
                ? 404
                : badRequestMessages.has(knownMessage)
                  ? 400
                  : 500;

      sendJson(response, statusCode, { error: knownMessage });
    }
  }

  return { handleRequest };
}

module.exports = {
  BASE_PATH,
  PORT,
  createQuizApp,
  getLocalIpAddress
};
