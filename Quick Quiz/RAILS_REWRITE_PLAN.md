# Ruby/Rails Rewrite Plan

This is the clean long-term path if you want the quiz to live fully inside the `devengers.com` Ruby stack instead of running as a separate Node service.

## Goal

Rebuild the current Node quiz backend into Ruby while preserving:

- host and participant real-time sync
- CSV validation and import
- join code and QR join flow
- configurable timer
- speed-based scoring
- leaderboard after every question
- restart-same-quiz support

## Recommended Rails stack

- Rails 7 or Rails 8
- Action Cable for real-time updates
- Redis for Action Cable and ephemeral quiz state
- Sidekiq or Active Job for timed stage transitions if you want durable scheduling
- PostgreSQL for persisted quiz definitions, hosts, and audit data

## What should stay ephemeral

During the rewrite, treat active live sessions as short-lived runtime state:

- current quiz session
- current question index
- question timer end time
- current submissions
- provisional selections for auto-submit
- leaderboard snapshot

Redis is the best fit for this.

## What should be persisted

Store these in PostgreSQL:

- users or hosts
- uploaded quiz definitions
- parsed questions and answers
- historical completed sessions
- participant performance history if you want reporting later

## Suggested Rails domain model

### Persistent models

- `User`
- `Quiz`
- `QuizQuestion`
- `QuizSession`
- `QuizParticipant`
- `QuizResult`

### Redis-backed live session keys

- `quiz_session:{code}:state`
- `quiz_session:{code}:participants`
- `quiz_session:{code}:submissions`
- `quiz_session:{code}:draft_selections`
- `quiz_session:{code}:leaderboard`

## Controller and channel layout

### Controllers

- `QuizSessionsController`
  - create session
  - restart session
  - host state bootstrap
- `QuizJoinsController`
  - participant join
- `QuizAnswersController`
  - save draft selection
  - submit answer
- `QuizUploadsController`
  - validate CSV
  - import quiz template

### Channels

- `HostQuizChannel`
  - host receives stage changes, participant count, leaderboard, answer reveal
- `ParticipantQuizChannel`
  - participant receives current question, timer, reveal state, leaderboard, final ranking

## Timer and stage logic

Current Node behavior:

1. Host opens lobby
2. Host starts first question
3. Question runs for configured seconds
4. Saved draft selection is auto-submitted if needed
5. Correct answer is revealed
6. Leaderboard shows for 5 seconds
7. Next question starts automatically
8. Final leaderboard shows after question 15

Recommended Rails implementation:

- store `question_started_at` and `question_ends_at`
- enqueue a background job when a question starts
- reveal stage job computes points and publishes updates through Action Cable
- enqueue the next transition job for the 5-second leaderboard window

If you want stronger resilience, every transition job should re-check the current session state before acting.

## CSV import rewrite plan

### Parser behavior to keep

- exact required column support
- quoted commas in fields
- missing-value validation
- case-insensitive answer resolution
- support for extra columns
- require exactly 15 valid questions

### Ruby implementation options

- use Ruby CSV standard library for parsing
- build a service object like `QuizCsvValidator`
- normalize headers before validation
- return row-level errors for host preview

## Scoring logic to preserve

Current formula:

```text
points = 400 + 600 * (remainingTime / configuredQuestionTime)
```

Ruby service suggestion:

- `QuizScoringService.calculate(submitted_at:, question_ends_at:, question_time_ms:)`

## Suggested rollout phases

### Phase 1

Move quiz definitions and CSV validation into Rails while leaving live sessions in Node.

### Phase 2

Rebuild join, submit, and leaderboard flow in Rails + Action Cable.

### Phase 3

Move all runtime state to Redis and decommission the Node process.

### Phase 4

Add production features:

- host login
- branded quiz pages
- historical reports
- reusable quiz library

## Biggest rewrite risks

- keeping timers accurate under real traffic
- handling reconnects cleanly
- preventing duplicate submissions
- making scheduled transitions durable across deploys or restarts
- matching the existing participant experience exactly

## Recommendation

If you need this live soon, deploy the current Node app under `/quiz` first.

If you want long-term maintenance simplicity inside the Ruby stack, do the Rails rewrite after the first production launch so we can rewrite against proven behavior instead of guessing at requirements.
