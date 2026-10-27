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

GitHub Actions starts at 22:07 UTC (07:07 KST). The generator (`scripts/generate-daily-briefing.mjs`, pipeline `v3-sectors`) runs eight paced research stages (Korean media, Woori group, peers, global media, regulators/official sources, plus three sector stages: card/capital + savings bank, insurance, securities/asset management), then one LLM **scoring** call per 30 candidates (axis / sector / score / event_key / promo flags / sector_hook per candidate), a deterministic **selection** step in code, and three LLM **writing** calls (one for the group-common section, two batched calls for the five sector sections). It updates `public/briefing.json`, stores a copy in `public/briefing_history/<date>.json` (30 days), waits for Render auto-deploy, and sends the stable report link at 07:00 KST. Manual workflow runs accept `send_email` (default true) and `force_regenerate` (default false).

### Editions: 전체본 1 + 업권본 5

Since `v3-sectors` the briefing is built as one **group-common** section (지주 관점, target 7 articles, min 6, max 8, guaranteed slots for supervision / group / peer / market / overseas) plus five **sector** sections (은행 / 여신전문금융 / 저축은행 / 보험 / 증권·자산운용, target 3 articles each, min 2, max 4, one own-subsidiary article preferred). Sector definitions — companies, Korean/English keywords, scope, specialist sources — live in `config/sectors.json`; the code reads that file to build the sector research prompts, the scoring `sector` enum, the selection slots and the output structure. Selection is common-first: an event already chosen for the common section is never repeated in a sector section, event dedupe and the 3-briefing history check apply across all sections, and a sector with too few verified candidates ships short and records why in `meta.sector_shortfall[sector]`. Total output is roughly 20–23 articles. `critical[]` (≤2) is judged only on common articles; a sector article with score ≥90 and a severity flag is flagged `critical:true` inside its own section.

Output JSON stays backward compatible: the existing top-level keys (`executive_judgment`, `critical`, `daily_news`, `subsidiary_news`, `additional_news`, `insights`, …) now contain **only the common articles**, so the current web page and mail render the common part of the full edition unchanged. New keys: each news item gets `sector` (`group` for common) and `sector_hook`; `sectors` holds `{ bank, card_capital, savings, insurance, securities_am }` each with `label_ko`, `label_en`, `companies`, `judgment` (2 sentences: today's biggest sector risk / the question for that subsidiary's risk team), `news[]` (same newsItem shape; `why_woori_cro` = one group-view sentence + 1–2 subsidiary-view sentences naming the company) and `shortfall_reason`; `editions` lists the renderable editions (`all` = common + all five sectors, `bank` = common + bank, …) with their `sections`; `meta` gains `pipeline_version: 'v3-sectors'`, `sector_counts`, `sector_shortfall`, `sector_selection_steps`, `editions`. History files written before v3 (no `sectors`) are still read for cross-day dedupe.

If fewer than 6 qualified common articles exist, the briefing ships with what is verified (after promoting any sector candidate scoring ≥70 into the common section) and records the reason in `meta.shortfall_reason`; it never pads with promotional, political, or fabricated items. A failure notice is written only when every research stage returns nothing (API outage).

The narrative quality gate: formal Korean `합니다체`, 3-sentence summaries (fact with figures → where it touches Woori → one question for today), 2-3 CRO implication sentences, 2-3 concrete watchpoints, no stock phrases such as "점검해야 합니다", and no process/meta commentary.

Local dry run without an API key (mocked OpenAI calls, output to `public/briefing.dryrun.json`):

```
DRY_RUN=1 node scripts/generate-daily-briefing.mjs
DRY_RUN=1 DRY_RUN_SCENARIO=sparse node scripts/generate-daily-briefing.mjs      # fallback ladder + sector shortfall
DRY_RUN=1 DRY_RUN_SCENARIO=shortfall node scripts/generate-daily-briefing.mjs   # <6 common articles + shortfall_reason
DRY_RUN=1 DRY_RUN_SCENARIO=outage node scripts/generate-daily-briefing.mjs      # failure notice
node scripts/validate-briefing.mjs public/briefing.dryrun.json                   # schema + sectors/editions checks, exit 1 on failure
```

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

Optional Actions variables: `OPENAI_MODEL` (default `gpt-5.4-mini`, used for research and as the writing fallback), `OPENAI_MODEL_RESEARCH`, `OPENAI_MODEL_SCORING` (default `gpt-5.4-mini`), `OPENAI_MODEL_WRITING` (default `gpt-5.4`; the script falls back to `OPENAI_MODEL` automatically if that model returns 400/404).

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
