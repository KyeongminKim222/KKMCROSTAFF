# CRO Staff Daily Risk Briefing

Daily CRO STAFF risk briefing for Woori Financial Group: GitHub Actions researches and writes the briefing, commits `docs/briefing.json`, GitHub Pages publishes the static report (`docs/`), and Gmail delivers the edition emails. A small Node server on Render provides only the AI Q&A relay (`/api/ask`) so the OpenAI key never reaches readers.

## 1. Hosting layout (since 2026-10-27, `v5`)

| Piece | Where | Notes |
| --- | --- | --- |
| Report web page + `briefing.json` + assets | **GitHub Pages**, branch `main`, folder `/docs` → `https://kyeongminkim222.github.io/KKMCROSTAFF/` | Static. Editions via `?edition=bank` etc. All articles are public press/official sources, so no link token; `<meta name="robots" content="noindex,nofollow">` is set. `docs/.nojekyll` disables Jekyll. |
| AI Q&A relay (`/api/ask`, `/api/health`, `/healthz`) | **Render** (`server.mjs`, `https://kkmcrostaff.onrender.com`) | CORS-restricted to the Pages origin, per-IP rate limits (10/min, 30/day). `/`, `/report/*`, `/briefing.json` redirect to Pages for old links. |
| Email | GitHub Actions → Gmail SMTP (`scripts/send-gmail.py`) | Links point at the Pages URL. Corporate networks that block `onrender.com` still get the full briefing in the email and on Pages; only the AI button is disabled there. |

The web page reads `./briefing.json` relative to itself and calls the API at `window.CRO_API_BASE` (first `<script>` in `docs/index.html`). Change that one line if the Render host changes.

### One-time repository setup (owner)

1. `Settings` → `Pages` → **Build and deployment**: Source `Deploy from a branch`, Branch `main`, Folder `/docs`. Wait for the first `pages-build-deployment` run, then open `https://kyeongminkim222.github.io/KKMCROSTAFF/`.
2. `Settings` → `Secrets and variables` → `Actions` → **Variables**: `PAGES_BASE_URL` = `https://kyeongminkim222.github.io/KKMCROSTAFF/` (optional; this is the default in the workflow and in `send-gmail.py`).
3. **Secrets** (unchanged): `OPENAI_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `EMAIL_TO`, optional per-edition `EMAIL_TO_BANK`, `EMAIL_TO_CARD_CAPITAL`, `EMAIL_TO_INSURANCE`, `EMAIL_TO_SECURITIES_AM`. The `REPORT_URL` secret is no longer read (the workflow passes the Pages URL); `EMAIL_TO_SAVINGS` is no longer used.
4. Render service: keep `OPENAI_API_KEY` (and optional `OPENAI_MODEL`, `DAILY_REQUEST_LIMIT_PER_IP`, `MINUTE_REQUEST_LIMIT_PER_IP`, `NODE_ENV=production`). Optional `PAGES_BASE_URL` (default as above) and `ALLOWED_ORIGINS` (comma list) if the page is ever served from another origin. `REPORT_ACCESS_TOKEN` is no longer required. Auto-deploy on commit can stay on; the workflow no longer waits for Render.
5. `Settings` → `Actions` → `General` → `Workflow permissions`: `Read and write permissions` (the workflow commits `docs/briefing.json`).

## 2. Run the API server locally

```bash
OPENAI_API_KEY=sk-... npm start          # http://localhost:8080 — only /api/* and /healthz
```

Docker: `docker build -t cro-staff-api . && docker run --rm -p 8080:8080 --env-file .env cro-staff-api`.

To preview the web page locally, serve `docs/` with any static server (e.g. `python -m http.server 8791` inside `docs/`); localhost origins are accepted by the API server when `NODE_ENV` is not `production`.

## 3. Daily report update

GitHub Actions starts at 22:07 UTC (07:07 KST). The generator (`scripts/generate-daily-briefing.mjs`, pipeline `v3-sectors`) runs paced research stages (Korean media, Woori group, peers, global media, regulators/official sources, plus three sector stages: card/capital/savings bank, insurance, securities/asset management), then one LLM **scoring** call per 30 candidates, a deterministic **selection** step, and LLM **writing** calls (group-common section + batched sector sections). It updates `docs/briefing.json`, stores a copy in `docs/briefing_history/<date>.json` (30 days), waits until GitHub Pages serves the new `briefing.json` (`meta.briefing_date` check, up to 15 minutes), and then sends the emails. Manual runs accept `send_email` (default true) and `force_regenerate` (default false).

### Editions: 전체 1 + 업권 4

The briefing is one **group-common** section (지주 관점, target 7 articles, min 6, max 8, guaranteed slots for supervision / group / peer / market / overseas) plus four **sector** sections — 은행 / 여전·저축은행 (우리카드·우리금융캐피탈·우리금융저축은행, target 4) / 보험 / 증권·자산운용 (target 3 each; min 2, max 4). Sector definitions — companies, keywords, scope, specialist sources, per-sector `target`, edition labels (`전체`, `은행업`, `여전·저축은행업`, `보험업`, `증권·운용업`) — live in `config/sectors.json`; the code, the web page and the mail script read that file for sector ids, order and labels. Renderers skip unknown sector ids, so older `briefing.json` files that still contain a `savings` block render without it.

Selection is common-first: an event already chosen for the common section is never repeated in a sector section, event dedupe and the 3-briefing history check apply across all sections, and a sector with too few verified candidates ships short and records why in `meta.sector_shortfall[sector]`. `critical[]` (≤2) is judged only on common articles; a sector article with score ≥90 and a severity flag is flagged `critical:true` inside its own section.

Output JSON: top-level keys (`executive_judgment`, `executive_judgment_bullets`, `critical`, `daily_news`, `subsidiary_news`, `additional_news`, `forward_looking_points`, `insights`, `monitoring_points`) contain the common articles; `sectors{bank|card_capital|insurance|securities_am}` hold `label_ko`, `label_en`, `companies`, `judgment`, `news[]`, `shortfall_reason`; `editions[]` lists the renderable editions with their `sections`; `meta` carries `pipeline_version`, `sector_counts`, `sector_shortfall`, `editions`.

### Writing rules (quality gate)

Formal Korean `합니다체`, **declarative sentences only — no questions**. `summary` = 2–3 factual sentences from the article (figures, actors, dates); `why_woori_cro` = 1–2 sentences on where it touches Woori (the subsidiary for sector items); `executive_judgment` and each sector `judgment` = 3 declarative sentences (biggest risk / path into the group / what to watch today). The script rejects sentences ending in `?`, `까요`, `합니까`, `입니까`, `습니까`, `나요`, `는가` (and "확인이 필요합니다"-style requests), asks the model once more, and strips any that remain. No stock phrases such as "점검해야 합니다", no process/meta commentary.

Web page sections (in order): 오늘 한눈에 (judgment + categorized article index that scrolls to each card) → 핵심 판단 포인트 → 긴급 → 오늘의 뉴스 → 그룹·계열사 → 해외 → sector sections → 전망 → 인사이트 → 모니터링. The AI Q&A is a floating button at the bottom-right; it shows "사내망에서는 AI 질문이 제한됩니다" when the API host is unreachable.

Local dry run without an API key (mocked OpenAI calls, output to `docs/briefing.dryrun.json`):

```
DRY_RUN=1 node scripts/generate-daily-briefing.mjs
DRY_RUN=1 DRY_RUN_SCENARIO=sparse node scripts/generate-daily-briefing.mjs      # fallback ladder + sector shortfall
DRY_RUN=1 DRY_RUN_SCENARIO=shortfall node scripts/generate-daily-briefing.mjs   # <6 common articles + shortfall_reason
DRY_RUN=1 DRY_RUN_SCENARIO=outage node scripts/generate-daily-briefing.mjs      # failure notice
node scripts/validate-briefing.mjs docs/briefing.dryrun.json                     # schema + sectors/editions checks, exit 1 on failure
python scripts/send-gmail.py --preview out.html [--edition bank]                 # render the email HTML without sending
```

### Gmail preparation

1. Turn on Google 2-Step Verification.
2. Create a 16-digit Google App Password for this automation.
3. Do not use or upload the normal Gmail password.

Optional Actions variables: `OPENAI_MODEL` (default `gpt-5.4-mini`), `OPENAI_MODEL_RESEARCH`, `OPENAI_MODEL_SCORING`, `OPENAI_MODEL_WRITING` (default `gpt-5.4`; falls back to `OPENAI_MODEL` on 400/404), `PAGES_BASE_URL`.

### First test

Open the repository's `Actions` tab, select `Daily CRO Staff Briefing`, click `Run workflow`, and monitor the stages. Gmail is sent only after GitHub Pages serves the newly generated briefing date.

## Production notes

- Set an OpenAI project budget and usage alerts.
- The API rate limiter is process-memory based; for multiple server instances replace it with a shared store.
- GitHub scheduled workflows can start later than the exact cron minute during platform congestion; email goes out as soon as research and the Pages deploy finish.
