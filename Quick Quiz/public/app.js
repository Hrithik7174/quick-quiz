const state = {
  mode: "host",
  hostModeAllowed: true,
  csvText: "",
  csvFilename: "",
  sessionCode: "",
  hostToken: "",
  hostPollInterval: null,
  participantPollInterval: null,
  hostPollInFlight: false,
  participantPollInFlight: false,
  participantId: localStorage.getItem("quickQuizParticipantId") || "",
  participantCode: localStorage.getItem("quickQuizCode") || "",
  selectedAnswer: null,
  lastQuestionNumber: null,
  countdownInterval: null,
  pendingAutoSubmitQuestionNumber: null,
  autoSubmittedQuestionNumber: null,
  hostViewState: null,
  participantViewState: null,
  meta: null
};

const APP_BASE_PATH = (() => {
  const meta = document.querySelector('meta[name="quiz-base-path"]');
  const rawValue = meta?.content || "";
  if (!rawValue || rawValue === "/") {
    return "";
  }
  return rawValue.endsWith("/") ? rawValue.slice(0, -1) : rawValue;
})();

function buildAppPath(pathname = "/") {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${APP_BASE_PATH}${normalizedPath}` || "/";
}

function buildAppUrl(searchParams = "") {
  const search = searchParams ? `?${searchParams}` : "";
  return `${buildAppPath("/")}${search}`;
}

function readHostSessions() {
  try {
    return JSON.parse(localStorage.getItem("quickQuizHostSessions") || "{}");
  } catch {
    return {};
  }
}

function writeHostSessions(hostSessions) {
  localStorage.setItem("quickQuizHostSessions", JSON.stringify(hostSessions));
}

function saveHostSession(code, hostToken) {
  const hostSessions = readHostSessions();
  hostSessions[code] = hostToken;
  writeHostSessions(hostSessions);
  localStorage.setItem("quickQuizLastHostCode", code);
}

function getSavedHostToken(code) {
  return readHostSessions()[code] || "";
}

const elements = {
  modeToggle: document.getElementById("modeToggle"),
  hostScreen: document.getElementById("hostScreen"),
  participantScreen: document.getElementById("participantScreen"),
  csvFileInput: document.getElementById("csvFileInput"),
  fileStatus: document.getElementById("fileStatus"),
  metaBox: document.getElementById("metaBox"),
  createSessionButton: document.getElementById("createSessionButton"),
  timerSecondsInput: document.getElementById("timerSecondsInput"),
  startQuizButton: document.getElementById("startQuizButton"),
  startQuestionButton: document.getElementById("startQuestionButton"),
  restartQuizButton: document.getElementById("restartQuizButton"),
  hostHomeButton: document.getElementById("hostHomeButton"),
  hostMessage: document.getElementById("hostMessage"),
  joinCode: document.getElementById("joinCode"),
  joinUrl: document.getElementById("joinUrl"),
  qrImage: document.getElementById("qrImage"),
  participantCount: document.getElementById("participantCount"),
  hostTimer: document.getElementById("hostTimer"),
  hostStage: document.getElementById("hostStage"),
  validationSummary: document.getElementById("validationSummary"),
  previewList: document.getElementById("previewList"),
  leaderboard: document.getElementById("leaderboard"),
  participantCodeInput: document.getElementById("participantCodeInput"),
  participantNameInput: document.getElementById("participantNameInput"),
  joinButton: document.getElementById("joinButton"),
  participantMessage: document.getElementById("participantMessage"),
  joinPanel: document.getElementById("joinPanel"),
  waitingPanel: document.getElementById("waitingPanel"),
  questionPanel: document.getElementById("questionPanel"),
  revealPanel: document.getElementById("revealPanel"),
  participantTitle: document.getElementById("participantTitle"),
  participantStatus: document.getElementById("participantStatus"),
  participantScore: document.getElementById("participantScore"),
  participantRank: document.getElementById("participantRank"),
  participantLastPoints: document.getElementById("participantLastPoints"),
  questionNumber: document.getElementById("questionNumber"),
  questionText: document.getElementById("questionText"),
  participantTimer: document.getElementById("participantTimer"),
  optionGrid: document.getElementById("optionGrid"),
  submitAnswerButton: document.getElementById("submitAnswerButton"),
  submissionStatus: document.getElementById("submissionStatus"),
  revealTitle: document.getElementById("revealTitle"),
  revealText: document.getElementById("revealText"),
  correctAnswerHighlight: document.getElementById("correctAnswerHighlight"),
  participantAnswerStatus: document.getElementById("participantAnswerStatus"),
  roundSummary: document.getElementById("roundSummary"),
  participantLeaderboard: document.getElementById("participantLeaderboard"),
  participantHomeButton: document.getElementById("participantHomeButton")
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setMessage(element, text, type = "") {
  element.textContent = text || "";
  element.className = `callout ${type}`.trim();
}

function api(path, payload) {
  return fetch(buildAppPath(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).then(async (response) => {
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || "Request failed.");
    }
    return body;
  });
}

function fetchJson(path) {
  return fetch(buildAppPath(path)).then(async (response) => {
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || "Request failed.");
    }
    return body;
  });
}

function setMode(mode) {
  if (mode === "host" && !state.hostModeAllowed) {
    mode = "participant";
  }

  state.mode = mode;
  const host = mode === "host";
  elements.hostScreen.classList.toggle("hidden", !host);
  elements.participantScreen.classList.toggle("hidden", host);
  elements.modeToggle.textContent = host ? "Switch to Participant" : "Switch to Host";
  elements.modeToggle.classList.toggle("hidden", !state.hostModeAllowed);
}

function renderMeta() {
  if (!state.meta) {
    return;
  }

  elements.metaBox.innerHTML = `
    <div class="metric">
      <span class="label">Host URL</span>
      <strong>${escapeHtml(state.meta.hostUrl)}</strong>
    </div>
    <div class="metric">
      <span class="label">Timer Range</span>
      <strong>${escapeHtml(`${state.meta.minTimerSeconds}s-${state.meta.maxTimerSeconds}s`)}</strong>
    </div>
    <div class="metric">
      <span class="label">Scoring</span>
      <strong>${escapeHtml(state.meta.scoring)}</strong>
    </div>
  `;
}

function renderValidation(previewQuestions = [], errors = []) {
  if (!previewQuestions.length && !errors.length) {
    elements.validationSummary.textContent = "Upload a CSV to preview your questions.";
    elements.previewList.innerHTML = "";
    return;
  }

  const validCount = previewQuestions.filter((item) => item.valid).length;
  const issues = errors.flatMap((error) => error.issues.map((issue) => ({ rowNumber: error.rowNumber, issue })));

  elements.validationSummary.innerHTML = `
    <div class="validation-item ${issues.length ? "invalid" : ""}">
      <strong>${validCount} valid questions</strong>
      <div>${issues.length ? `${issues.length} validation issue(s) found.` : "CSV looks ready to launch."}</div>
    </div>
    ${issues
      .map(
        (entry) => `
          <div class="validation-item invalid">
            <strong>${entry.rowNumber ? `Row ${entry.rowNumber}` : "Quiz file"}</strong>
            <div>${escapeHtml(entry.issue)}</div>
          </div>
        `
      )
      .join("")}
  `;

  elements.previewList.innerHTML = previewQuestions
    .map(
      (question) => `
        <article class="preview-item ${question.valid ? "" : "invalid"}">
          <strong>Row ${question.rowNumber}</strong>
          <div>${question.question ? escapeHtml(question.question) : "<em>Missing question text</em>"}</div>
          <div class="preview-options">
            ${["A", "B", "C", "D"]
              .map(
                (letter) => `
                  <div>${letter}. ${
                    question.options[letter] ? escapeHtml(question.options[letter]) : "<em>Missing</em>"
                  }${question.correctAnswer === letter ? " <strong>(Correct)</strong>" : ""}</div>
                `
              )
              .join("")}
          </div>
        </article>
      `
    )
    .join("");
}

function renderLeaderboard(target, leaderboard, currentParticipantId = "") {
  if (!leaderboard?.length) {
    target.innerHTML =
      '<div class="leader-row"><strong>-</strong><span>No participants yet</span><span>0 pts</span><span>0 correct</span></div>';
    return;
  }

  target.innerHTML = leaderboard
    .map(
      (entry) => `
        <div class="leader-row ${entry.rank === 1 ? "leader-row-top" : ""}">
          <strong>#${entry.rank}</strong>
          <span>${escapeHtml(entry.name)}${entry.id === currentParticipantId ? " (You)" : ""}</span>
          <span>${entry.score} pts</span>
          <span>${entry.correctCount} correct</span>
        </div>
      `
    )
    .join("");
}

function stopCountdown() {
  if (state.countdownInterval) {
    clearInterval(state.countdownInterval);
    state.countdownInterval = null;
  }
}

function startCountdown(endsAt, targetElement, onExpire) {
  stopCountdown();
  let expiredHandled = false;
  const update = () => {
    const remainingMs = Math.max(0, endsAt - Date.now());
    const remaining = Math.ceil(remainingMs / 1000);
    targetElement.textContent = remaining;

    if (remainingMs <= 150 && !expiredHandled) {
      expiredHandled = true;
      if (typeof onExpire === "function") {
        onExpire();
      }
    }
  };
  update();
  state.countdownInterval = setInterval(update, 250);
}

function resetToHome(targetMode = "host") {
  stopCountdown();
  stopHostPolling();
  stopParticipantPolling();

  localStorage.removeItem("quickQuizLastHostCode");
  localStorage.removeItem("quickQuizParticipantId");
  localStorage.removeItem("quickQuizCode");
  state.participantId = "";
  state.participantCode = "";
  state.sessionCode = "";
  state.hostToken = "";
  state.selectedAnswer = null;
  state.pendingAutoSubmitQuestionNumber = null;
  state.autoSubmittedQuestionNumber = null;
  state.participantViewState = null;
  state.hostViewState = null;
  location.href = targetMode === "participant" ? buildAppUrl("participant=1") : buildAppUrl();
}

async function submitSelectedAnswer() {
  if (!state.selectedAnswer || !state.participantCode || !state.participantId) {
    return;
  }

  await api(`/api/session/${state.participantCode}/submit`, {
    participantId: state.participantId,
    answer: state.selectedAnswer
  });
}

async function saveDraftSelection(answer) {
  if (!answer || !state.participantCode || !state.participantId) {
    return;
  }

  try {
    await api(`/api/session/${state.participantCode}/select`, {
      participantId: state.participantId,
      answer
    });
  } catch {}
}

function stopHostPolling() {
  if (state.hostPollInterval) {
    clearInterval(state.hostPollInterval);
    state.hostPollInterval = null;
  }
}

function stopParticipantPolling() {
  if (state.participantPollInterval) {
    clearInterval(state.participantPollInterval);
    state.participantPollInterval = null;
  }
}

async function refreshHostState() {
  if (!state.sessionCode || !state.hostToken || state.hostPollInFlight) {
    return;
  }

  state.hostPollInFlight = true;
  try {
    state.hostViewState = await fetchJson(
      `/api/session/${state.sessionCode}/host-state?hostToken=${encodeURIComponent(state.hostToken)}`
    );
    renderHostState();
  } catch (error) {
    setMessage(elements.hostMessage, error.message, "error");
  } finally {
    state.hostPollInFlight = false;
  }
}

async function refreshParticipantState() {
  if (!state.participantCode || !state.participantId || state.participantPollInFlight) {
    return;
  }

  state.participantPollInFlight = true;
  try {
    state.participantViewState = await fetchJson(
      `/api/session/${state.participantCode}/participant-state?participantId=${encodeURIComponent(state.participantId)}`
    );
    renderParticipantState();
  } catch (error) {
    if (state.participantViewState) {
      setMessage(elements.participantMessage, error.message, "error");
    }
  } finally {
    state.participantPollInFlight = false;
  }
}

function startHostPolling(code, hostToken) {
  state.sessionCode = code;
  state.hostToken = hostToken;
  stopHostPolling();
  void refreshHostState();
  state.hostPollInterval = setInterval(() => {
    void refreshHostState();
  }, 1000);
}

function startParticipantPolling(code, participantId) {
  state.participantCode = code;
  state.participantId = participantId;
  stopParticipantPolling();
  void refreshParticipantState();
  state.participantPollInterval = setInterval(() => {
    void refreshParticipantState();
  }, 1000);
}

function renderHostStage(hostViewState) {
  let heading = "Session ready";
  let detail = "Create a quiz session to generate the join code and QR link.";

  if (hostViewState.status === "lobby") {
    heading = "Join lobby live";
    detail = "Participants can join now. Review the deck, then open the quiz lobby when everyone is in.";
  } else if (hostViewState.status === "ready") {
    heading = "Question standby";
    detail = hostViewState.currentQuestion
      ? `Next up: Question ${hostViewState.currentQuestion.number}. Start when the room is ready.`
      : "The lobby is open. Start Question 1 when participants are ready.";
  } else if (hostViewState.status === "question") {
    heading = `Question ${hostViewState.currentQuestion.number} in progress`;
    detail = `${hostViewState.submissionsCount} of ${hostViewState.participantCount} participants have locked an answer.`;
  } else if (hostViewState.status === "reveal") {
    heading = `Question ${hostViewState.currentQuestion.number} revealed`;
    detail = `Correct answer: ${hostViewState.revealedAnswer}. Leaderboard is live and the next question will start automatically.`;
  } else if (hostViewState.status === "final") {
    const winnerName = hostViewState.winner?.name || "No winner";
    heading = "Quiz complete";
    detail = `${winnerName} is currently on top of the final leaderboard.`;
  }

  elements.hostStage.innerHTML = `
    <div class="stage-copy">
      <strong>${escapeHtml(heading)}</strong>
      <span>${escapeHtml(detail)}</span>
    </div>
  `;
}

function renderHostState() {
  const hostViewState = state.hostViewState;
  if (!hostViewState) {
    return;
  }

  elements.joinCode.textContent = hostViewState.code;
  elements.joinUrl.href = hostViewState.joinUrl;
  elements.joinUrl.textContent = hostViewState.joinUrl;
  elements.qrImage.src = hostViewState.qrCodeDataUrl;
  elements.participantCount.textContent = String(hostViewState.participantCount);
  renderHostStage(hostViewState);

  if (hostViewState.currentQuestion?.endsAt && ["question", "reveal"].includes(hostViewState.status)) {
    startCountdown(hostViewState.currentQuestion.endsAt, elements.hostTimer);
  } else {
    stopCountdown();
    elements.hostTimer.textContent = String(hostViewState.timerSeconds || state.meta?.defaultTimerSeconds || 15);
  }

  elements.startQuizButton.disabled = hostViewState.status !== "lobby";
  elements.startQuestionButton.disabled = hostViewState.status !== "ready";
  elements.timerSecondsInput.disabled = hostViewState.status !== "lobby";
  elements.restartQuizButton.classList.toggle("hidden", hostViewState.status !== "final");
  elements.hostHomeButton.classList.toggle("hidden", hostViewState.status !== "final");

  if (hostViewState.status === "lobby") {
    setMessage(elements.hostMessage, "Participants can join now. Open the quiz lobby when you're ready.", "success");
  } else if (hostViewState.status === "ready") {
    setMessage(
      elements.hostMessage,
      `Lobby is open. Question timer is ${hostViewState.timerSeconds} seconds. Start the quiz when everyone is ready.`,
      "success"
    );
  } else if (hostViewState.status === "question") {
    setMessage(
      elements.hostMessage,
      `${hostViewState.submissionsCount}/${hostViewState.participantCount} answers submitted for Question ${hostViewState.currentQuestion.number}.`,
      "success"
    );
  } else if (hostViewState.status === "reveal") {
    setMessage(
      elements.hostMessage,
      `Correct answer: ${hostViewState.revealedAnswer}. Auto-advancing to the next question in ${hostViewState.revealSeconds} seconds.`,
      "success"
    );
  } else if (hostViewState.status === "final") {
    const winner = hostViewState.winner?.name ? `${hostViewState.winner.name} wins the quiz.` : "Quiz complete.";
    setMessage(elements.hostMessage, winner, "success");
  }

  renderLeaderboard(elements.leaderboard, hostViewState.leaderboard);
}

function renderQuestionOptions(question, locked, submittedAnswer, revealedAnswer) {
  elements.optionGrid.innerHTML = ["A", "B", "C", "D"]
    .map((letter) => {
      const classes = ["option-button"];
      if (state.selectedAnswer === letter) {
        classes.push("selected");
      }
      if (locked) {
        classes.push("locked");
      }
      if (revealedAnswer === letter) {
        classes.push("correct");
      }

      return `
        <button class="${classes.join(" ")}" type="button" data-answer="${letter}" ${locked ? "disabled" : ""}>
          <strong>${letter}</strong>
          <div>${escapeHtml(question.options[letter])}</div>
          ${submittedAnswer === letter ? "<div><small>Submitted</small></div>" : ""}
        </button>
      `;
    })
    .join("");

  for (const button of elements.optionGrid.querySelectorAll("[data-answer]")) {
    button.addEventListener("click", () => {
      state.selectedAnswer = button.dataset.answer;
      void saveDraftSelection(state.selectedAnswer);
      renderParticipantState();
    });
  }
}

function renderParticipantWaiting(participantState) {
  if (participantState.status === "lobby") {
    elements.participantTitle.textContent = "Waiting in the join lobby";
    elements.participantStatus.textContent = "You're connected. The host will open the live quiz shortly.";
    return;
  }

  elements.participantTitle.textContent = "Get ready";
  elements.participantStatus.textContent = participantState.currentQuestion
    ? "The host is lining up the next question."
    : "The host has opened the lobby and will start Question 1 soon.";
}

function renderParticipantReveal(participantState, participant) {
  stopCountdown();
  const isFinalState = participantState.status === "final";
  elements.waitingPanel.classList.add("hidden");
  elements.questionPanel.classList.add("hidden");
  elements.revealPanel.classList.remove("hidden");
  elements.revealPanel.classList.toggle("final-celebration", isFinalState);
  elements.revealTitle.textContent =
    isFinalState ? "Final Results" : `Question ${participantState.currentQuestion.number} Results`;
  const correctLetter = participantState.revealedAnswer || "-";
  const correctText = participantState.currentQuestion?.options?.[correctLetter] || "";
  const submittedAnswer = participantState.submittedAnswer;
  const submittedText = submittedAnswer ? participantState.currentQuestion?.options?.[submittedAnswer] || "" : "";
  const answeredCorrectly = Boolean(submittedAnswer && submittedAnswer === correctLetter);
  const answeredWrong = Boolean(submittedAnswer && submittedAnswer !== correctLetter);
  const wasAutoSubmitted = Boolean(participantState.autoSubmitted);

  if (isFinalState) {
    elements.revealText.textContent = "";
    elements.revealText.classList.add("hidden");
    elements.correctAnswerHighlight.classList.add("hidden");
    elements.participantAnswerStatus.classList.add("hidden");
    elements.correctAnswerHighlight.innerHTML = "";
    elements.participantAnswerStatus.className = "answer-status-banner hidden";
    elements.participantAnswerStatus.innerHTML = "";
  } else {
    elements.revealText.classList.remove("hidden");
    elements.correctAnswerHighlight.classList.remove("hidden");
    elements.participantAnswerStatus.classList.remove("hidden");
    elements.revealText.textContent = `You earned ${participant.lastEarnedPoints} point(s) this round.`;
    elements.correctAnswerHighlight.innerHTML = `
      <span class="answer-highlight-label">Correct Answer</span>
      <strong>${escapeHtml(correctLetter)}</strong>
      <span>${escapeHtml(correctText)}</span>
    `;

    if (answeredCorrectly) {
      elements.participantAnswerStatus.className = "answer-status-banner correct";
      elements.participantAnswerStatus.innerHTML = `
        <strong>Correct</strong>
        <span>You chose ${escapeHtml(submittedAnswer)}. ${escapeHtml(submittedText)}</span>
      `;
    } else if (answeredWrong) {
      elements.participantAnswerStatus.className = "answer-status-banner wrong";
      elements.participantAnswerStatus.innerHTML = `
        <strong>Incorrect</strong>
        <span>You chose ${escapeHtml(submittedAnswer)}. ${escapeHtml(submittedText)}</span>
      `;
    } else {
      elements.participantAnswerStatus.className = "answer-status-banner missed";
      elements.participantAnswerStatus.innerHTML = `
        <strong>No Answer Submitted</strong>
        <span>Time expired before an answer was locked in.</span>
      `;
    }
  }

  if (isFinalState && participantState.winner) {
    elements.roundSummary.className = "result-banner winner-banner";
    elements.roundSummary.innerHTML = `
      <span class="winner-crown" aria-hidden="true">👑</span>
      <strong>${escapeHtml(participantState.winner.name)}</strong>
      <span>Winner with ${escapeHtml(participantState.winner.score)} points</span>
    `;
  } else {
    const winnerText = `Current rank: ${participant.rank ? `#${participant.rank}` : "-"} with ${participant.score} points.`;
    elements.roundSummary.className = "result-banner";
    elements.roundSummary.innerHTML = `<strong>${escapeHtml(winnerText)}</strong>`;
  }
  elements.participantHomeButton.classList.toggle("hidden", !isFinalState);

  if (wasAutoSubmitted) {
    setMessage(
      elements.submissionStatus,
      "Your selected answer was auto-submitted when time ended. Please click Submit Answer next time.",
      "success"
    );
  }
  state.autoSubmittedQuestionNumber = wasAutoSubmitted ? participantState.currentQuestion?.number || null : null;
}

function renderParticipantState() {
  const participantState = state.participantViewState;
  if (!participantState?.exists) {
    return;
  }

  const participant = participantState.participant;
  elements.participantScore.textContent = String(participant.score);
  elements.participantRank.textContent = participant.rank ? `#${participant.rank}` : "-";
  elements.participantLastPoints.textContent = String(participant.lastEarnedPoints);

  elements.joinPanel.classList.add("hidden");
  elements.waitingPanel.classList.remove("hidden");
  elements.questionPanel.classList.add("hidden");
  elements.revealPanel.classList.add("hidden");

  renderLeaderboard(elements.participantLeaderboard, participantState.leaderboard, participant.id);

  if (participantState.status === "lobby" || participantState.status === "ready") {
    renderParticipantWaiting(participantState);
    return;
  }

  if (participantState.status === "question") {
    if (state.lastQuestionNumber !== participantState.currentQuestion.number) {
      state.selectedAnswer = null;
      state.lastQuestionNumber = participantState.currentQuestion.number;
    }

    elements.waitingPanel.classList.add("hidden");
    elements.questionPanel.classList.remove("hidden");
    elements.questionNumber.textContent = `Question ${participantState.currentQuestion.number} of ${participantState.currentQuestion.total}`;
    elements.questionText.textContent = participantState.currentQuestion.question;
    state.selectedAnswer = participantState.hasSubmitted
      ? participantState.submittedAnswer
      : participantState.draftAnswer || state.selectedAnswer;
    startCountdown(participantState.currentQuestion.endsAt, elements.participantTimer);
    renderQuestionOptions(participantState.currentQuestion, participantState.hasSubmitted, participantState.submittedAnswer, null);
    elements.submitAnswerButton.disabled = participantState.hasSubmitted || !state.selectedAnswer;
    const showNextQuestionReminder =
      !participantState.hasSubmitted &&
      state.autoSubmittedQuestionNumber !== null &&
      participantState.currentQuestion.number === state.autoSubmittedQuestionNumber + 1;
    setMessage(
      elements.submissionStatus,
      participantState.hasSubmitted
        ? participantState.autoSubmitted
          ? `Answer auto-submitted: ${participantState.submittedAnswer}. Please click Submit Answer next time.`
          : `Answer locked: ${participantState.submittedAnswer}.`
        : showNextQuestionReminder
          ? "Reminder: last time your selected answer was auto-submitted when the timer ended. Please click Submit Answer this round."
          : "Choose one option before time runs out.",
      participantState.hasSubmitted ? "success" : ""
    );
    if (showNextQuestionReminder) {
      state.autoSubmittedQuestionNumber = null;
    }
    return;
  }

  renderParticipantReveal(participantState, participant);
}

async function handleCreateSession() {
  try {
    state.hostViewState = null;
    const result = await api("/api/session/create", {
      filename: state.csvFilename,
      csvText: state.csvText,
      timerSeconds: Number(elements.timerSecondsInput.value || state.meta?.defaultTimerSeconds || 15)
    });
    state.sessionCode = result.code;
    state.hostToken = result.hostToken;
    saveHostSession(result.code, result.hostToken);
    startHostPolling(result.code, result.hostToken);
    elements.startQuizButton.disabled = false;
    setMessage(elements.hostMessage, "Session created. Participants can now join with the code or QR.", "success");
  } catch (error) {
    setMessage(elements.hostMessage, error.message, "error");
  }
}

async function handleRestartQuiz() {
  try {
    const result = await api(`/api/session/${state.sessionCode}/restart`, {
      hostToken: state.hostToken
    });
    state.hostViewState = null;
    state.sessionCode = result.code;
    state.hostToken = result.hostToken;
    saveHostSession(result.code, result.hostToken);
    startHostPolling(result.code, result.hostToken);
    elements.startQuizButton.disabled = false;
    elements.startQuestionButton.disabled = true;
    setMessage(elements.hostMessage, "Fresh session created from the same quiz. Share the new code or QR to play again.", "success");
  } catch (error) {
    setMessage(elements.hostMessage, error.message, "error");
  }
}

async function uploadPreview(csvText, filename) {
  try {
    const response = await fetch(buildAppPath("/api/session/validate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, csvText })
    });
    const result = await response.json();
    renderValidation(result.previewQuestions || [], result.errors || []);
    elements.createSessionButton.disabled = !response.ok;

    if (response.ok) {
      setMessage(elements.hostMessage, "CSV validated successfully. Create the live session when ready.", "success");
    } else {
      setMessage(elements.hostMessage, "Fix the CSV validation issues before creating the session.", "error");
    }
  } catch (error) {
    renderValidation([], [{ rowNumber: 0, issues: [error.message] }]);
    setMessage(elements.hostMessage, error.message, "error");
  }
}

async function fetchMeta() {
  const response = await fetch(buildAppPath("/api/meta"));
  state.meta = await response.json();
  renderMeta();
}

elements.modeToggle.addEventListener("click", () => setMode(state.mode === "host" ? "participant" : "host"));

elements.csvFileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  state.csvFilename = file.name;
  state.csvText = await file.text();
  elements.fileStatus.textContent = `Loaded ${file.name}`;
  await uploadPreview(state.csvText, state.csvFilename);
});

elements.createSessionButton.addEventListener("click", handleCreateSession);
elements.restartQuizButton.addEventListener("click", handleRestartQuiz);

elements.startQuizButton.addEventListener("click", async () => {
  try {
    await api(`/api/session/${state.sessionCode}/start-quiz`, { hostToken: state.hostToken });
    await refreshHostState();
  } catch (error) {
    setMessage(elements.hostMessage, error.message, "error");
  }
});

elements.startQuestionButton.addEventListener("click", async () => {
  try {
    await api(`/api/session/${state.sessionCode}/start-question`, { hostToken: state.hostToken });
    await refreshHostState();
  } catch (error) {
    setMessage(elements.hostMessage, error.message, "error");
  }
});

elements.hostHomeButton.addEventListener("click", () => resetToHome("host"));

elements.joinButton.addEventListener("click", async () => {
  try {
    const code = elements.participantCodeInput.value.trim().toUpperCase();
    const name = elements.participantNameInput.value.trim();
    const result = await api(`/api/session/${code}/join`, { name });
    state.participantId = result.participantId;
    state.participantCode = code;
    localStorage.setItem("quickQuizParticipantId", result.participantId);
    localStorage.setItem("quickQuizCode", code);
    startParticipantPolling(code, result.participantId);
    setMessage(elements.participantMessage, "Joined successfully. Waiting for the host.", "success");
  } catch (error) {
    setMessage(elements.participantMessage, error.message, "error");
  }
});

elements.submitAnswerButton.addEventListener("click", async () => {
  try {
    if (!state.selectedAnswer) {
      return;
    }

    await submitSelectedAnswer();
    await refreshParticipantState();
  } catch (error) {
    setMessage(elements.submissionStatus, error.message, "error");
  }
});

elements.participantHomeButton.addEventListener("click", () => resetToHome("participant"));

function restoreParticipantFromUrl() {
  const params = new URLSearchParams(location.search);
  const codeFromUrl = params.get("code");
  const participantHome = params.get("participant") === "1";
  let preferredMode = "host";
  let hostModeAllowed = true;

  if (participantHome) {
    preferredMode = "participant";
    hostModeAllowed = false;
  }

  if (codeFromUrl) {
    preferredMode = "participant";
    hostModeAllowed = false;
    elements.participantCodeInput.value = codeFromUrl.toUpperCase();
  }

  if (state.participantId && state.participantCode) {
    preferredMode = "participant";
    elements.participantCodeInput.value = state.participantCode;
    startParticipantPolling(state.participantCode, state.participantId);
  }

  state.hostModeAllowed = hostModeAllowed;

  setMode(preferredMode);
}

fetchMeta();
restoreParticipantFromUrl();
