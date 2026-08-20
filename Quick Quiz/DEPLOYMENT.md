# `/quiz` Deployment Guide

This app can now run behind a Ruby site at a path like:

- `https://devengers.com/quiz`

## Recommended architecture

- Keep `devengers.com` on Ruby
- Run this quiz app as a separate Node process
- Put Nginx in front
- Reverse proxy `/quiz/` traffic to the Node app

## Required environment variables

Example:

```bash
PORT=3000
QUIZ_BASE_PATH=/quiz
QUIZ_PUBLIC_URL=https://devengers.com/quiz
```

What they do:

- `PORT`: internal Node port
- `QUIZ_BASE_PATH`: tells the app it is mounted under `/quiz`
- `QUIZ_PUBLIC_URL`: used for join links and QR codes

## Start command

```bash
npm install
PORT=3000 QUIZ_BASE_PATH=/quiz QUIZ_PUBLIC_URL=https://devengers.com/quiz node server.js
```

For long-running process management, use `pm2` or `systemd`.

## Nginx example

Use a path-preserving reverse proxy so the Node app receives `/quiz/...` requests.

```nginx
server {
    listen 443 ssl http2;
    server_name devengers.com;

    # Your existing Ruby app
    location / {
        proxy_pass http://127.0.0.1:9292;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Quiz app
    location /quiz/ {
        proxy_pass http://127.0.0.1:3000/quiz/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 90s;
    }

    # Optional convenience redirect
    location = /quiz {
        return 301 /quiz/;
    }
}
```

## Production checklist

### Platform

- Install a current Node.js LTS release
- Run the quiz app with `pm2`, `systemd`, or another process manager
- Make sure the server allows long-lived WebSocket connections

### Reverse proxy

- Preserve the `/quiz` path
- Enable WebSocket upgrades
- Forward `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto`
- Add a redirect from `/quiz` to `/quiz/`

### SSL and domain

- Serve the app over HTTPS
- Set `QUIZ_PUBLIC_URL=https://devengers.com/quiz`
- Confirm generated QR codes open the HTTPS domain URL, not localhost

### App behavior

- Test host flow from `https://devengers.com/quiz`
- Test participant join link from a second browser or phone
- Verify the participant cannot switch into host mode from a shared join link
- Verify leaderboard auto-advance and restart-same-quiz flow

### Data and reliability

- Current sessions are stored in process memory
- A server restart clears active quizzes
- For production traffic, move session state to Redis
- Add a cleanup job for abandoned sessions if you expect frequent usage

### Observability

- Capture stdout/stderr logs
- Add process restart alerts
- Monitor memory usage during live sessions
- Log unexpected socket disconnect rates

### Security

- Keep the host token private
- Restrict server access to trusted admins if needed
- Add rate limiting on join/create endpoints if the public URL will be exposed broadly
- Consider adding host authentication before session creation

## Recommended next production step

If this will be used for real client or team events, the next best upgrade is:

1. Move live session state to Redis
2. Keep the current Node app for real-time delivery
3. Add simple admin auth for host creation

## Vercel deployment

This repo now includes a Vercel-compatible server entrypoint:

- [vercel.json](C:\Users\Hrithik Sadawarte\Documents\ChatGPT\Quick Quiz\vercel.json)
- [api/index.js](C:\Users\Hrithik Sadawarte\Documents\ChatGPT\Quick Quiz\api\index.js)
- [quiz-app.js](C:\Users\Hrithik Sadawarte\Documents\ChatGPT\Quick Quiz\quiz-app.js)

### Required for safe live sessions

Set these environment variables in Vercel:

```text
QUIZ_PUBLIC_URL=https://your-project.vercel.app
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

Why:

- Vercel can run multiple function instances for the same deployment.
- Live quiz state must be shared across those instances so hosts and participants stay in sync.
- This app now uses HTTP polling plus Redis-backed session storage on Vercel to preserve quiz behavior.

### Vercel checklist

- Create an Upstash Redis database and copy the REST URL/token into Vercel env vars.
- Set `QUIZ_PUBLIC_URL` to the final Vercel production URL or custom domain URL.
- Deploy from this project root so [vercel.json](C:\Users\Hrithik Sadawarte\Documents\ChatGPT\Quick Quiz\vercel.json) is picked up.
- Test one host browser and at least one participant browser after deploy.
- Verify create session, join, start quiz, start question, submit answer, reveal, and restart flows.

### Behavior change

- Local mode still works with in-memory session storage.
- Vercel mode uses Redis-backed polling rather than in-process WebSockets.
- User-facing quiz functionality stays the same, but the transport is now compatible with Vercel hosting.
