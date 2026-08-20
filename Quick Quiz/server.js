const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { parse } = require("csv-parse/sync");
const QRCode = require("qrcode");
const WebSocket = require("ws");

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
const PUBLIC_DIR = path.join(__dirname, "public");

const sessions = new Map();

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

function buildAppPath(pathname = "/") {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${BASE_PATH}${normalizedPath}` || "/";
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

function generateCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: SESSION_CODE_LENGTH }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (sessions.has(code));
  return code;
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
  const code = generateCode();
  const session = {
    code,
    hostToken: crypto.randomUUID(),
    filename,
    publicAppUrl,
    questionTimeMs,
    questions,
    participants: new Map(),
    playerSockets: new Map(),
    hostSockets: new Set(),
    status: "lobby",
    currentQuestionIndex: -1,
    questionStartedAt: null,
    questionEndsAt: null,
    revealEndsAt: null,
    currentQuestionTimer: null,
    stageTransitionTimer: null,
    submissions: new Map(),
    provisionalSelections: new Map(),
    qrCodeDataUrl: "",
    revealedAnswer: null,
    lastLeaderboard: []
  };
  sessions.set(code, session);
  return session;
}

function leaderboardForSession(session) {
  const leaderboard = [...session.participants.values()]
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
    participantCount: session.participants.size,
    participants: [...session.participants.values()].map((participant) => ({
      id: participant.id,
      name: participant.name,
      score: participant.score
    })),
    currentQuestion: currentQuestionPayload(session),
    leaderboard,
    winner,
    revealedAnswer: session.revealedAnswer,
    submissionsCount: session.submissions.size
  };
}

function isAuthorizedHost(session, hostToken) {
  return Boolean(session && hostToken && session.hostToken === hostToken);
}

function participantState(session, participantId) {
  const participant = session.participants.get(participantId);
  if (!participant) {
    return { role: "participant", exists: false };
  }

  const submission = session.submissions.get(participantId);
  const provisionalSelection = session.provisionalSelections.get(participantId);
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

function broadcastSession(session) {
  const hostPayload = JSON.stringify({ type: "state", state: hostState(session) });
  for (const socket of session.hostSockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(hostPayload);
    }
  }

  for (const [participantId, socket] of session.playerSockets.entries()) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "state", state: participantState(session, participantId) }));
    }
  }
}

function clearQuestionTimer(session) {
  if (session.currentQuestionTimer) {
    clearTimeout(session.currentQuestionTimer);
    session.currentQuestionTimer = null;
  }
}

function clearStageTransitionTimer(session) {
  if (session.stageTransitionTimer) {
    clearTimeout(session.stageTransitionTimer);
    session.stageTransitionTimer = null;
  }
}

function calculatePoints(submittedAt, questionEndsAt, questionTimeMs) {
  const remainingMs = Math.max(0, questionEndsAt - submittedAt);
  const totalMs = Math.max(1, questionTimeMs);
  const ratio = remainingMs / totalMs;
  return Math.round(MIN_CORRECT_POINTS + (MAX_CORRECT_POINTS - MIN_CORRECT_POINTS) * ratio);
}

function finalizeSession(session) {
  clearQuestionTimer(session);
  clearStageTransitionTimer(session);
  session.status = "final";
  session.revealEndsAt = null;
  broadcastSession(session);
}

function advanceFromReveal(session) {
  clearStageTransitionTimer(session);

  if (session.currentQuestionIndex >= session.questions.length - 1) {
    finalizeSession(session);
    return;
  }

  startNextQuestion(session);
}

function revealCurrentQuestion(session) {
  clearQuestionTimer(session);
  if (session.status !== "question") {
    return;
  }

  const question = session.questions[session.currentQuestionIndex];
  session.status = "reveal";
  session.revealedAnswer = question.correctAnswer;
  session.revealEndsAt = Date.now() + REVEAL_TIME_MS;

  for (const participant of session.participants.values()) {
    let submission = session.submissions.get(participant.id);
    if (!submission) {
      const draftSelection = session.provisionalSelections.get(participant.id);
      if (draftSelection?.answer) {
        submission = {
          answer: draftSelection.answer,
          submittedAt: session.questionEndsAt,
          autoSubmitted: true
        };
        session.submissions.set(participant.id, submission);
      }
    }
    if (!submission || submission.answer !== question.correctAnswer) {
      participant.lastEarnedPoints = 0;
      continue;
    }

    const points = calculatePoints(submission.submittedAt, session.questionEndsAt, session.questionTimeMs);
    participant.score += points;
    participant.correctCount += 1;
    participant.lastEarnedPoints = points;
  }

  broadcastSession(session);
  clearStageTransitionTimer(session);
  session.stageTransitionTimer = setTimeout(() => advanceFromReveal(session), REVEAL_TIME_MS);
}

function startNextQuestion(session) {
  clearQuestionTimer(session);
  clearStageTransitionTimer(session);
  session.currentQuestionIndex += 1;
  session.submissions = new Map();
  session.provisionalSelections = new Map();
  session.revealedAnswer = null;
  session.revealEndsAt = null;

  if (session.currentQuestionIndex >= session.questions.length) {
    finalizeSession(session);
    return;
  }

  session.status = "question";
  session.questionStartedAt = Date.now();
  session.questionEndsAt = session.questionStartedAt + session.questionTimeMs;
  session.currentQuestionTimer = setTimeout(() => revealCurrentQuestion(session), session.questionTimeMs + 50);
  broadcastSession(session);
}

async function createSessionFromCsv(filename, csvText, timerSeconds, request) {
  const parsed = parseQuizCsv(csvText);
  if (parsed.errors.length > 0) {
    return { ok: false, ...parsed };
  }

  const session = createSession(
    parsed.validQuestions,
    filename,
    normalizeQuestionTimeMs(timerSeconds),
    getPublicAppUrl(request)
  );
  session.qrCodeDataUrl = await QRCode.toDataURL(getJoinUrl(session.publicAppUrl, session.code), {
    width: 320,
    margin: 1
  });

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

async function buildSessionResponse(session) {
  session.qrCodeDataUrl = await QRCode.toDataURL(getJoinUrl(session.publicAppUrl, session.code), {
    width: 320,
    margin: 1
  });

  return {
    ok: true,
    code: session.code,
    hostToken: session.hostToken,
    timerSeconds: session.questionTimeMs / 1000,
    joinUrl: getJoinUrl(session.publicAppUrl, session.code),
    qrCodeDataUrl: session.qrCodeDataUrl
  };
}

async function restartSessionFromExisting(session) {
  const nextSession = createSession(session.questions, session.filename, session.questionTimeMs, session.publicAppUrl);
  return buildSessionResponse(nextSession);
}

function validateCsvOnly(csvText) {
  const parsed = parseQuizCsv(csvText);
  return {
    ok: parsed.errors.length === 0,
    ...parsed
  };
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
    const result = await createSessionFromCsv(body.filename || "quiz.csv", body.csvText || "", body.timerSeconds, request);
    sendJson(response, result.ok ? 200 : 400, result);
    return;
  }

  const pathMatch = pathname.match(/^\/api\/session\/([A-Z0-9]+)\/([a-z-]+)$/);
  if (!pathMatch) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  const [, code, action] = pathMatch;
  const session = sessions.get(code);
  if (!session) {
    sendJson(response, 404, { error: "Quiz session not found." });
    return;
  }

  const body = request.method === "POST" ? JSON.parse(await readRequestBody(request)) : {};

  if (request.method === "POST" && action === "join") {
    if (session.status === "final") {
      sendJson(response, 400, { error: "The quiz has already finished." });
      return;
    }
    if (session.currentQuestionIndex >= 0) {
      sendJson(response, 400, { error: "Joining is closed after the quiz begins." });
      return;
    }

    const name = String(body.name || "").trim().slice(0, 30);
    if (!name) {
      sendJson(response, 400, { error: "Please enter a participant name." });
      return;
    }

    const duplicateName = [...session.participants.values()].some(
      (participant) => participant.name.toLowerCase() === name.toLowerCase()
    );
    if (duplicateName) {
      sendJson(response, 400, { error: "That name is already in use for this quiz." });
      return;
    }

    const participantId = crypto.randomUUID();
    session.participants.set(participantId, {
      id: participantId,
      name,
      score: 0,
      correctCount: 0,
      lastEarnedPoints: 0
    });
    broadcastSession(session);
    sendJson(response, 200, { participantId });
    return;
  }

  if (request.method === "POST" && action === "start-quiz") {
    if (!isAuthorizedHost(session, body.hostToken)) {
      sendJson(response, 403, { error: "Host authorization failed." });
      return;
    }
    if (session.status !== "lobby") {
      sendJson(response, 400, { error: "Quiz is already in progress." });
      return;
    }
    session.status = "ready";
    broadcastSession(session);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && action === "start-question") {
    if (!isAuthorizedHost(session, body.hostToken)) {
      sendJson(response, 403, { error: "Host authorization failed." });
      return;
    }
    if (session.status !== "ready") {
      sendJson(response, 400, { error: "You can only start the quiz questions from the waiting state." });
      return;
    }
    startNextQuestion(session);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && action === "restart") {
    if (!isAuthorizedHost(session, body.hostToken)) {
      sendJson(response, 403, { error: "Host authorization failed." });
      return;
    }
    if (session.status !== "final") {
      sendJson(response, 400, { error: "You can only restart the quiz after it finishes." });
      return;
    }

    const result = await restartSessionFromExisting(session);
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && action === "submit") {
    if (session.status !== "question") {
      sendJson(response, 400, { error: "Answering is closed for this question." });
      return;
    }

    const participantId = String(body.participantId || "");
    const answer = String(body.answer || "").trim().toUpperCase();
    if (!session.participants.has(participantId)) {
      sendJson(response, 404, { error: "Participant not found." });
      return;
    }
    if (!["A", "B", "C", "D"].includes(answer)) {
      sendJson(response, 400, { error: "Answer must be A, B, C, or D." });
      return;
    }
    if (session.submissions.has(participantId)) {
      sendJson(response, 400, { error: "Answer already submitted." });
      return;
    }

    session.submissions.set(participantId, {
      answer,
      submittedAt: Date.now(),
      autoSubmitted: false
    });
    broadcastSession(session);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && action === "select") {
    if (session.status !== "question") {
      sendJson(response, 400, { error: "Selection is closed for this question." });
      return;
    }

    const participantId = String(body.participantId || "");
    const answer = String(body.answer || "").trim().toUpperCase();
    if (!session.participants.has(participantId)) {
      sendJson(response, 404, { error: "Participant not found." });
      return;
    }
    if (!["A", "B", "C", "D"].includes(answer)) {
      sendJson(response, 400, { error: "Answer must be A, B, C, or D." });
      return;
    }
    if (session.submissions.has(participantId)) {
      sendJson(response, 400, { error: "Answer already submitted." });
      return;
    }

    session.provisionalSelections.set(participantId, {
      answer,
      selectedAt: Date.now()
    });
    sendJson(response, 200, { ok: true });
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

function serveStaticFile(response, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
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

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const strippedPathname = stripBasePath(requestUrl.pathname);

  try {
    if (strippedPathname === null) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    if (BASE_PATH && requestUrl.pathname === BASE_PATH) {
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
    let filePath = path.join(PUBLIC_DIR, relativeStaticPath);
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
    sendJson(response, 500, { error: error.message || "Unexpected server error." });
  }
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (socket, request) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const code = requestUrl.searchParams.get("code");
  const role = requestUrl.searchParams.get("role");
  const participantId = requestUrl.searchParams.get("participantId");
  const hostToken = requestUrl.searchParams.get("hostToken");
  const session = code ? sessions.get(code) : null;

  if (!session || !role) {
    socket.close();
    return;
  }

  if (role === "host") {
    if (!isAuthorizedHost(session, hostToken)) {
      socket.close();
      return;
    }
    session.hostSockets.add(socket);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "state", state: hostState(session) }));
    }
    socket.on("close", () => session.hostSockets.delete(socket));
    return;
  }

  if (role === "participant" && participantId && session.participants.has(participantId)) {
    session.playerSockets.set(participantId, socket);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "state", state: participantState(session, participantId) }));
    }
    socket.on("close", () => {
      if (session.playerSockets.get(participantId) === socket) {
        session.playerSockets.delete(participantId);
      }
    });
    return;
  }

  socket.close();
});

server.listen(PORT, "0.0.0.0", () => {
  const hostUrl = `http://localhost:${PORT}${BASE_PATH}`;
  const networkUrl = `http://${getLocalIpAddress()}:${PORT}${BASE_PATH}`;
  console.log(`Quick Quiz host is running.`);
  console.log(`Open locally: ${hostUrl}`);
  console.log(`Share on your Wi-Fi: ${networkUrl}`);
});
