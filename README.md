.github/workflows/daily-briefing.yml
scripts/generate-daily-briefing.mjs
scripts/send-gmail.py
public/briefing.json

# CRO Staff Secure Briefing Server

This package serves the daily HTML briefing and keeps the OpenAI API key on the server. Report recipients never enter or receive the OpenAI key.

## 1. Configure secrets

Create environment variables on the hosting service:

- `OPENAI_API_KEY`: the OpenAI project API key.
- `REPORT_ACCESS_TOKEN`: a random string of at least 32 characters.
- `OPENAI_MODEL`: defaults to `gpt-5.4-mini`.
- `DAILY_REQUEST_LIMIT_PER_IP`: defaults to `30` questions per KST day.
- `NODE_ENV`: set to `production` when HTTPS is enabled.

Generate an access token locally:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Do not put `OPENAI_API_KEY` in the HTML, email, source repository, or report URL.

## 2. Run

```bash
npm start
```

Docker is also supported:

```bash
docker build -t cro-staff-briefing .
docker run --rm -p 8080:8080 --env-file .env cro-staff-briefing
```

## 3. Email link

Send this form of link to recipients:

```text
https://YOUR-DOMAIN/report/YOUR_REPORT_ACCESS_TOKEN
```

The server validates the token, stores authorization in an HttpOnly cookie, and redirects to the report. Readers can view the report and use the Q&A without an API key prompt.

## 4. Daily report update

Replace `public/index.html` with the newly generated briefing and restart or redeploy the service. The email link can remain unchanged because the server always serves the current `public/index.html`.

## Production notes

- Deploy behind HTTPS.
- Set an OpenAI project budget and usage alerts.
- Rotate `REPORT_ACCESS_TOKEN` if an email link is forwarded outside the intended audience.
- The included limiter is process-memory based. For multiple server instances, replace it with a shared rate-limit store before broad deployment.
