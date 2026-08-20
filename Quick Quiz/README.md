# Cyber Launch Quiz

Real-time quiz app for host-and-participant game sessions with:

- CSV upload and validation
- 15-question live quiz flow
- host join code and QR code
- participant and host browser views
- configurable per-question timer
- speed-based scoring
- automatic answer reveal and leaderboard transitions
- local hosting, path-based deployment, or Vercel deployment

## Run locally

From this folder in VS Code terminal or PowerShell:

```powershell
.\start-quiz.ps1
```

or:

```powershell
& "C:\Users\Hrithik Sadawarte\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" .\server.js
```

Open:

- Host view: `http://localhost:3000`
- Participant join URL: generated after session creation

## Deploy under `/quiz`

This app now supports a base path, so you can run it under:

- `https://devengers.com/quiz`

Set these environment variables before starting the Node process:

```powershell
$env:PORT = "3000"
$env:QUIZ_BASE_PATH = "/quiz"
$env:QUIZ_PUBLIC_URL = "https://devengers.com/quiz"
node .\server.js
```

Key variables:

- `PORT`: Node app port
- `QUIZ_BASE_PATH`: URL prefix such as `/quiz`
- `QUIZ_PUBLIC_URL`: public URL used for join links and QR codes

## Deploy on Vercel

This project now includes a Vercel entrypoint and routing config:

- [vercel.json](C:\Users\Hrithik Sadawarte\Documents\ChatGPT\Quick Quiz\vercel.json)
- [api/index.js](C:\Users\Hrithik Sadawarte\Documents\ChatGPT\Quick Quiz\api\index.js)

Recommended Vercel environment variables:

```text
QUIZ_PUBLIC_URL=https://your-project.vercel.app
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

Notes:

- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` keep quiz sessions durable across Vercel function instances.
- Without those Redis variables, the app still runs locally, but Vercel session state would not be safe for multi-user live games.
- The browser client now uses durable HTTP polling instead of process-bound WebSockets, which keeps the quiz flow compatible with Vercel’s serverless model.

## CSV format

Required columns:

- `Question`
- `A`
- `B`
- `C`
- `D`
- `Correct answer(s) - Choose at least one, answers separated by a comma`

Notes:

- The app validates missing questions, missing options, and missing correct answers.
- Commas inside question or option text are supported when the CSV is properly quoted.
- Correct answers can be written as `A`, `B`, `C`, `D`, or the full option text.
- Answer matching is case-insensitive.
- Extra columns are ignored.
- The app requires exactly 15 valid questions before a session can be created.

## Scoring

Only correct answers earn points.

```text
points = 400 + 600 * (remainingTime / configuredQuestionTime)
```

- Fastest correct answer: up to `1000` points
- Last-moment correct answer: about `400` points
- Incorrect answer or no answer: `0` points

## Production docs

- [Path-based deployment and server checklist](C:\Users\Hrithik Sadawarte\Documents\ChatGPT\Quick Quiz\DEPLOYMENT.md)
- [Ruby/Rails rewrite plan](C:\Users\Hrithik Sadawarte\Documents\ChatGPT\Quick Quiz\RAILS_REWRITE_PLAN.md)

## Included sample

Use [sample-quiz.csv](C:\Users\Hrithik Sadawarte\Documents\ChatGPT\Quick Quiz\sample-quiz.csv) to test the flow quickly.
