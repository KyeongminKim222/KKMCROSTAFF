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

The server validates the token, serves the report directly, and stores authorization in an HttpOnly cookie. This also supports email-app embedded browsers that do not reliably retain cookies across an immediate redirect. Readers can view the report and use the Q&A without an API key prompt.

## 4. Daily report update

GitHub Actions starts at 21:30 UTC, which is 06:30 KST. It runs three paced media-research stages for Korean financial news, Woori and peer news, and global financial news, followed by a separate official-source verification stage. After an independent CRO quality-gate synthesis, it updates `public/briefing.json`, waits for Render auto-deploy, and sends the stable report link at 07:00 KST. Manual workflow runs send immediately after a successful deploy.

The production quality gate requires exactly 10 unique URLs: 3 critical issues, 3 daily financial-risk items, 3 Woori/subsidiary items, and 1 additional high-relevance issue. At least 6 must be reporting from reliable media, while official releases and filings are capped at 4 and serve primarily as verification. The primary window is the latest 24 hours. When needed to complete the 10-item baseline without fabricating news, directly relevant background sources from the previous seven days may be included and are visibly marked as related.

The narrative quality gate follows the original Gumloop briefing style: formal Korean `합니다체`, 3-5 fact-rich sentences per article, 2-3 CRO implication sentences, 2-3 concrete watchpoints, and a cross-article insight covering transmission paths and near-term management questions.

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
- GitHub scheduled workflows can start later than the exact cron minute during platform congestion. The configured research start is 06:30 KST and the delivery target is 07:00 KST; if GitHub starts late, email is sent as soon as research and deployment finish.
