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

GitHub Actions runs at 22:00 UTC, which is 07:00 KST. It researches the latest 24 hours with the OpenAI Responses API web-search tool, updates `public/briefing.json`, pushes the change, waits for Render auto-deploy, and sends the stable report link through Gmail.

### Gmail preparation

1. Turn on Google 2-Step Verification.
2. Create a 16-digit Google App Password for this automation.
3. Do not use or upload the normal Gmail password.

### GitHub Actions secrets

In the GitHub repository, open `Settings` → `Secrets and variables` → `Actions` and add:

- `OPENAI_API_KEY`: OpenAI project API key used for daily web research.
- `GMAIL_USER`: sender Gmail address.
- `GMAIL_APP_PASSWORD`: 16-digit Google App Password.
- `EMAIL_TO`: one or more recipients separated by commas.
- `REPORT_URL`: the complete tokenized link, such as `https://YOUR-DOMAIN/report/YOUR_REPORT_ACCESS_TOKEN`.

Optionally add the Actions variable `OPENAI_MODEL`; the default is `gpt-5.4-mini`.

Under `Settings` → `Actions` → `General` → `Workflow permissions`, enable `Read and write permissions` so the workflow can commit `public/briefing.json`.

In Render, set `Auto-Deploy` to `On Commit` for the `main` branch.

### First test

Open the repository's `Actions` tab, select `Daily CRO Staff Briefing`, click `Run workflow`, and monitor all five stages. Gmail is sent only after Render's `/healthz` reports the newly generated briefing date.

## Production notes

- Deploy behind HTTPS.
- Set an OpenAI project budget and usage alerts.
- Rotate `REPORT_ACCESS_TOKEN` if an email link is forwarded outside the intended audience.
- The included limiter is process-memory based. For multiple server instances, replace it with a shared rate-limit store before broad deployment.
- GitHub scheduled workflows can start later than the exact cron minute during platform congestion; the configured schedule target is 07:00 KST.
