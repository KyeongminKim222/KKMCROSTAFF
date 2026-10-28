import json
import os
import smtplib
import ssl
import sys
import time
from email.message import EmailMessage
from html import escape
from pathlib import Path
from urllib.parse import urlparse


# 사용법
#   python scripts/send-gmail.py                         전체본(all) 발송 → EMAIL_TO
#   python scripts/send-gmail.py --edition bank          은행업 판 발송 → EMAIL_TO_BANK (비어 있으면 skip)
#   python scripts/send-gmail.py --all-editions          전체 + 수신자가 있는 업권 판 순차 발송
#   REPORT_URL = 웹 리포트 주소 (GitHub Pages, 기본 https://kyeongminkim222.github.io/KKMCROSTAFF/). 판 링크는 ?edition=<id>.
#   python scripts/send-gmail.py --preview out.html [--edition bank]   HTML만 생성 (SMTP·수신자 env 불필요)
PREVIEW_PATH = None
EDITION_ARG = "all"
ALL_EDITIONS = False
_argv = sys.argv[1:]
_i = 0
while _i < len(_argv):
    _a = _argv[_i]
    if _a == "--preview" and _i + 1 < len(_argv):
        PREVIEW_PATH = _argv[_i + 1]
        _i += 2
    elif _a == "--edition" and _i + 1 < len(_argv):
        EDITION_ARG = _argv[_i + 1].strip().lower() or "all"
        _i += 2
    elif _a == "--all-editions":
        ALL_EDITIONS = True
        _i += 1
    else:
        raise SystemExit(f"Unknown argument: {_a}")

# 업권본 수신자 env (콤마 구분). 비어 있으면 해당 판은 조용히 skip. 실제 주소는 코드에 두지 않는다.
EDITION_RECIPIENT_ENV = {
    "all": "EMAIL_TO",
    "bank": "EMAIL_TO_BANK",
    "card_capital": "EMAIL_TO_CARD_CAPITAL",  # 여전·저축은행 (2026-10-27 savings 병합)
    "insurance": "EMAIL_TO_INSURANCE",
    "securities_am": "EMAIL_TO_SECURITIES_AM",
}
DEFAULT_REPORT_URL = "https://kyeongminkim222.github.io/KKMCROSTAFF/"


def normalize_report_url(raw):
    """REPORT_URL: 임의의 https URL 허용 (GitHub Pages). 비어 있으면 기본 Pages 주소."""
    url = (raw or "").strip() or DEFAULT_REPORT_URL
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise RuntimeError(f"REPORT_URL must be an https URL (got: {url!r})")
    return url


def recipients_for(edition_id):
    env_name = EDITION_RECIPIENT_ENV.get(edition_id, "")
    raw = os.environ.get(env_name, "") if env_name else ""
    return [item.strip() for item in raw.replace(";", ",").split(",") if item.strip()]


if PREVIEW_PATH is None:
    gmail_user = os.environ["GMAIL_USER"].strip()
    gmail_password = os.environ["GMAIL_APP_PASSWORD"].replace(" ", "").strip()
    recipients = recipients_for("all")
    report_url = normalize_report_url(os.environ.get("REPORT_URL", ""))

    if not recipients and (ALL_EDITIONS or EDITION_ARG == "all"):
        raise RuntimeError("EMAIL_TO has no recipients")
else:
    gmail_user = ""
    gmail_password = ""
    recipients = []
    report_url = normalize_report_url(os.environ.get("REPORT_URL", ""))

briefing = json.loads(Path("docs/briefing.json").read_text(encoding="utf-8"))
meta = briefing.get("meta", {})
date = meta.get("briefing_date", "")
headline = briefing.get("insights", {}).get("headline") or briefing.get("executive_judgment", "오늘의 CRO STAFF 브리핑")

# ===== 업권 정의: config/sectors.json 이 기준 (라벨·순서). briefing.json 의 옛 라벨('은행본')이나 알 수 없는 sector id(savings)는 무시 =====
_SECTOR_CFG_PATH = Path(__file__).resolve().parent.parent / "config" / "sectors.json"
try:
    _SECTOR_CFG = json.loads(_SECTOR_CFG_PATH.read_text(encoding="utf-8"))
except Exception:  # noqa: BLE001 - 설정 파일이 없으면 코드 기본값 사용
    _SECTOR_CFG = {}
SECTOR_ORDER = [s["id"] for s in (_SECTOR_CFG.get("sectors") or []) if isinstance(s, dict) and s.get("id")] or ["bank", "card_capital", "insurance", "securities_am"]
SECTOR_NAV = {s["id"]: str(s.get("label_ko") or s["id"]) for s in (_SECTOR_CFG.get("sectors") or []) if isinstance(s, dict) and s.get("id")}
SECTOR_NAV.setdefault("bank", "은행"); SECTOR_NAV.setdefault("card_capital", "여전·저축은행")
SECTOR_NAV.setdefault("insurance", "보험"); SECTOR_NAV.setdefault("securities_am", "증권·자산운용")
EDITION_LABELS = {"all": str((_SECTOR_CFG.get("group") or {}).get("edition_label_ko") or "전체")}
for _s in (_SECTOR_CFG.get("sectors") or []):
    if isinstance(_s, dict) and _s.get("id"):
        EDITION_LABELS[_s["id"]] = str(_s.get("edition_label_ko") or f"{_s.get('label_ko', _s['id'])}업")
for _k, _v in {"bank": "은행업", "card_capital": "여전·저축은행업", "insurance": "보험업", "securities_am": "증권·운용업"}.items():
    EDITION_LABELS.setdefault(_k, _v)

SECTORS = briefing.get("sectors") if isinstance(briefing.get("sectors"), dict) else {}
SECTORS = {k: v for k, v in SECTORS.items() if k in SECTOR_ORDER and isinstance(v, dict)}
EDITIONS = [e for e in (briefing.get("editions") or []) if isinstance(e, dict) and e.get("id") and (e["id"] == "all" or e["id"] in SECTORS)]
if not SECTORS or not EDITIONS:
    EDITIONS = [{"id": "all", "label_ko": "전체", "sections": ["common"]}]
    SECTORS = {}
for _e in EDITIONS:
    _e["label_ko"] = EDITION_LABELS.get(_e["id"], str(_e.get("label_ko") or _e["id"]).removesuffix("본"))
EDITION_BY_ID = {e["id"]: e for e in EDITIONS}


def edition_sectors(ed):
    ids = [s for s in (ed.get("sections") or []) if s != "common" and s in SECTORS]
    if ed.get("id") == "all":
        ids = [s for s in SECTOR_ORDER if s in ids]
    return ids


def edition_short(ed):
    """판 짧은 이름 (제목 태그·목차용): '은행업' → '은행', '여전·저축은행업' → '여전·저축은행'."""
    eid = ed.get("id") or ""
    if eid in SECTOR_NAV:
        return SECTOR_NAV[eid]
    return str(ed.get("label_ko") or eid or "")

# ===== 안전장치: 기사가 너무 적으면 28명에게 발송하지 않는다 =====
# 얇은(1~2건) 브리핑이 전 수신자에게 가는 사고(2026-10-11) 재발 방지.
MIN_TO_SEND = 5
article_count = sum(len(briefing.get(k, [])) for k in ("critical", "daily_news", "subsidiary_news", "additional_news"))
if article_count < MIN_TO_SEND and PREVIEW_PATH is None:
    print(f"SKIPPED email to recipients: only {article_count} articles (below MIN_TO_SEND={MIN_TO_SEND}). Not broadcasting to {len(recipients)} recipients.")
    raise SystemExit(0)

# ===== 우리금융그룹 CI 팔레트 (이메일: solid 색상·테이블·인라인 스타일만, 웹폰트·배경이미지 없음) =====
WOORI = "#0067AC"
SKY = "#4FB3E8"
NAVY = "#0B2A4A"
INK = "#2b3340"
MUTED = "#6b7684"
LINE = "#dde4ec"
TINT = "#EAF4FB"
TINT2 = "#F4F9FD"
OUTER = "#F4F6F9"
CRIT = "#B42318"
FONT = "'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo','Noto Sans KR',Arial,sans-serif"
# 로고: GitHub Pages 가 docs/assets/woori_group_kr.png 를 서빙하므로 REPORT_URL 폴더 기준으로 자동 지정. MAIL_LOGO_URL 로 덮어쓸 수 있다.
def _default_logo_url(url):
    try:
        p = urlparse(url)
        base = p.path if p.path.endswith("/") else p.path.rsplit("/", 1)[0] + "/"
        return f"{p.scheme}://{p.netloc}{base}assets/woori_group_kr.png"
    except Exception:  # noqa: BLE001
        return ""
LOGO_URL = os.environ.get("MAIL_LOGO_URL", "").strip() or _default_logo_url(report_url)

URGENCY_STYLE = {
    "높음": ("#B42318", "#FFF1F0", "#F3C6C2"),
    "중간": ("#9A5B00", "#FFF6E5", "#F8DFA8"),
    "낮음": ("#6b7684", "#F2F5F8", "#E4E9EF"),
}
AXIS_META = {
    "supervision": ("감독당국", "#0B2A4A"),
    "group": ("그룹·계열사", "#0067AC"),
    "peer": ("경쟁사", "#4FB3E8"),
    "market": ("시장", "#E69500"),
    "overseas": ("해외법인", "#0B6B47"),
}
AXIS_ORDER = ["supervision", "group", "peer", "market", "overseas"]

# ===== 섹션 색 시스템 (웹 index.html .sec-band 와 동일) =====
# key: (bar, bar_light, panel_bg, panel_line, title, kicker)
SEC = {
    "judgment":   ("#0B2A4A", "#1B5FA8", "#F1F5FA", "#C9D6E5", "#0B2A4A", "EXECUTIVE JUDGMENT"),
    "critical":   ("#B42318", "#F97066", "#FFF7F6", "#F0C7C2", "#8F1D18", "DESK FOCUS"),
    "daily":      ("#0067AC", "#20C4F4", "#F4F9FD", "#C5D8EA", "#0A2F4A", "MARKET SCAN"),
    "subsidiary": ("#067647", "#32D583", "#F3FBF6", "#C6E2D0", "#085041", "GROUP WATCH"),
    "overseas":   ("#0E7490", "#36CFC9", "#F0FAFB", "#BFE3E8", "#0E5C66", "GLOBAL"),
    "forward":    ("#B54708", "#F5B94C", "#FFF9EE", "#F2DDB0", "#7A4B00", "FORWARD LOOKING"),
    "insights":   ("#5B3DB5", "#A78BFA", "#F7F4FD", "#D9CDF0", "#4A2F8C", "INSIGHTS"),
    "monitor":    ("#475569", "#94A3B8", "#F4F6F9", "#D5DCE5", "#334155", "MONITORING"),
}
CALLOUT_BG = {"critical": "#FFF1EF", "subsidiary": "#EAF7EF", "overseas": "#E6F5F7"}

# 업권 섹션 팔레트 (웹 .sec-bank 등과 동일): bar, bar_light, panel_bg, panel_line, title, kicker
SECTOR_SEC = {
    "bank":          ("#0067AC", "#4FB3E8", "#EDF5FC", "#9CC2E0", "#053E6B", "BANK"),
    "card_capital":  ("#4F46E5", "#A5B4FC", "#F1F0FD", "#C7C4F5", "#3730A3", "CARD, CAPITAL & SAVINGS BANK"),
    "insurance":     ("#BE185D", "#F9A8D4", "#FDF2F8", "#F0BFD6", "#9D174D", "INSURANCE"),
    "securities_am": ("#155E75", "#67E8F9", "#ECF8FA", "#9FCBD6", "#164E63", "SECURITIES & ASSET MANAGEMENT"),
}
SEC.update(SECTOR_SEC)
for _sid in SECTOR_SEC:
    CALLOUT_BG[_sid] = SECTOR_SEC[_sid][2]
SECTOR_PANEL_BORDER = {"bank": "1.5px solid #0067AC", "securities_am": "1.5px solid #155E75"}


def chip(text, color, bg, border):
    return (
        f'<span style="display:inline-block;padding:1px 7px;font-size:11px;font-weight:700;'
        f'line-height:16px;color:{color};background:{bg};border:1px solid {border};border-radius:10px;'
        f'white-space:nowrap;font-family:{FONT}">{escape(str(text))}</span>'
    )


def axis_of(item):
    a = str(item.get("axis", "") or "").lower()
    return a if a in AXIS_META else ""


def fmt_date(d):
    try:
        import datetime as _dt
        y, m, dd = [int(x) for x in str(d)[:10].split("-")]
        dow = "월화수목금토일"[_dt.date(y, m, dd).weekday()]
        return f"{y}.{m:02d}.{dd:02d} ({dow})"
    except Exception:
        return str(d)


def fmt_date_ko(d):
    try:
        y, m, dd = [int(x) for x in str(d)[:10].split("-")]
        return f"{y}년 {m}월 {dd}일"
    except Exception:
        return str(d)


def fmt_generated(iso):
    try:
        import datetime as _dt
        s = str(iso or "")
        if not s:
            return ""
        dt = _dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_dt.timezone.utc)
        kst = dt.astimezone(_dt.timezone(_dt.timedelta(hours=9)))
        return kst.strftime("%Y.%m.%d %H:%M KST")
    except Exception:
        return str(iso or "")


def split_sentences(text):
    import re as _re
    raw = str(text or "").strip()
    if not raw:
        return []
    return [p.strip() for p in _re.split(r"(?<=[.!?])\s+", raw) if p.strip()]


# ===== 질문형 문장 제거 (웹 index.html stripQuestions 와 동일 규칙) =====
import re as _qre
_QUESTION_RE = _qre.compile(r"(\?|까요|합니까|입니까|습니까|나요|는가)[.?!)\s]*$")


def is_question(s):
    return bool(_QUESTION_RE.search(str(s or "").strip()))


def strip_questions(text):
    return " ".join(s for s in split_sentences(text) if not is_question(s))


# ===== 메일 v6: CTA 최상단 + 핵심판단 3문장 + 챕터별 기사 리스트(번호·제목·매체·긴급) =====
# 본문은 짧게 (기사 15건 기준 모바일 3~4화면). summary/시사점/체크포인트는 웹 리포트에서.
CHAPTER_COLOR = {"group": NAVY, "bank": "#0067AC", "card_capital": "#4F46E5", "insurance": "#BE185D", "securities_am": "#155E75"}


def pages_anchor(ed, anchor):
    base = report_url_for(ed)
    return base + "#" + anchor


def cta_button(url, label="리포트 보기 →", on_dark=True):
    """전폭 48px CTA. 네이비 밴드 위에서는 흰 배경 + 네이비 글자."""
    bg, fg, border = ("#ffffff", NAVY, "#ffffff") if on_dark else (WOORI, "#ffffff", WOORI)
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
        f'<td align="center" style="background:{bg};border:1px solid {border};border-radius:8px;height:48px">'
        f'<a href="{escape(url)}" style="display:block;line-height:48px;height:48px;font-family:{FONT};font-size:16px;font-weight:700;'
        f'color:{fg};text-decoration:none;letter-spacing:-0.2px">{escape(label)}</a>'
        f'</td></tr></table>'
    )


RISK_COLOR = {
    "신용리스크": "#D14343", "시장리스크": "#0067AC", "운영리스크": "#7B57B8", "금리리스크": "#E08A2C",
    "유동성리스크": "#12968A", "시스템리스크": "#4A5D7A", "평판리스크": "#CC5A96",
}
LEVEL_STYLE = {"높음": ("#B42323", "#FDECEC", "#F6C9C9"), "중간": ("#A8620A", "#FFF4E3", "#F4DDB5"), "낮음": ("#1F7A45", "#EAF6EE", "#C6E6D2")}


def risk_tag_html(tags):
    out = ""
    for t in tags or []:
        c = RISK_COLOR.get(t, WOORI)
        out += (f'<span style="display:inline-block;font-family:{FONT};font-size:10.5px;font-weight:700;line-height:16px;'
                f'padding:0 6px;margin:0 3px 0 0;border:1px solid {c};border-radius:9px;color:{c};background:#ffffff">'
                f'{escape(str(t).replace("리스크", ""))}</span>')
    return out


def render_judgment_short(b):
    cards = [r for r in (b.get("risk_brief") or []) if isinstance(r, dict) and r.get("risk") and r.get("headline")]
    if not cards:
        sents = [s for s in split_sentences(b.get("executive_judgment")) if not is_question(s)][:3]
        if not sents:
            return ""
        body = "".join(
            f'<p style="margin:0 0 8px;font-family:{FONT};font-size:14.5px;line-height:1.65;color:{NAVY};font-weight:700">{escape(s)}</p>'
            for s in sents
        )
        return f"""
    <tr><td style="padding:18px 20px 6px">
      <div style="font-family:{FONT};font-size:12px;font-weight:700;color:{WOORI};margin:0 0 8px">핵심 판단</div>
      <div style="border-left:3px solid {WOORI};padding:2px 0 0 12px">{body}</div>
    </td></tr>
    """
    rows = ""
    for r in cards:
        c = RISK_COLOR.get(r["risk"], WOORI)
        fg, bg, bd = LEVEL_STYLE.get(r.get("level"), LEVEL_STYLE["중간"])
        head = escape(" ".join(p for p in [strip_questions(str(r.get("headline") or ""))] if p))
        chk = escape(strip_questions(str(r.get("check") or "")))
        check_row = (
            f'<tr><td style="padding:6px 0 0"><span style="display:inline-block;font-family:{FONT};font-size:10.5px;font-weight:800;'
            f'color:#ffffff;background:{c};border-radius:3px;padding:0 6px;line-height:17px;margin-right:6px">확인</span>'
            f'<span style="font-family:{FONT};font-size:12.5px;line-height:1.55;color:{INK}">{chk}</span></td></tr>'
        ) if chk else ""
        rows += (
            f'<tr><td style="padding:0 0 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            f'style="border:1px solid {LINE};border-left:4px solid {c};border-radius:6px;background:#ffffff"><tr><td style="padding:10px 12px">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
            f'<td style="font-family:{FONT};font-size:13px;font-weight:800;color:{c}">{escape(r["risk"])}</td>'
            f'<td align="right"><span style="display:inline-block;font-family:{FONT};font-size:10.5px;font-weight:700;line-height:17px;'
            f'padding:0 8px;border-radius:9px;border:1px solid {bd};background:{bg};color:{fg}">{escape(str(r.get("level") or "중간"))}</span></td></tr>'
            f'<tr><td colspan="2" style="padding:4px 0 0;font-family:{FONT};font-size:14.5px;line-height:1.5;font-weight:700;color:{NAVY}">{head}</td></tr>'
            f'{check_row}</table></td></tr></table></td></tr>'
        )
    return f"""
    <tr><td style="padding:18px 20px 6px">
      <div style="font-family:{FONT};font-size:12px;font-weight:700;color:{WOORI};margin:0 0 8px">핵심 판단 · 리스크별 확인 포인트</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{rows}</table>
    </td></tr>
    """


def list_row(item, idx, last):
    title = escape(str(item.get("title") or "").strip())
    url = escape(str(item.get("url") or "").strip())
    src = escape(str(item.get("source_name") or "").strip())
    urg = str(item.get("urgency") or "").strip()
    crit = bool(item.get("critical"))
    uc = URGENCY_STYLE.get(urg)
    chips = ""
    if crit:
        chips += chip("긴급", "#ffffff", CRIT, CRIT)
    elif uc:
        chips += chip(urg, *uc)
    border = "" if last else f"border-bottom:1px solid {LINE};"
    link = f'<a href="{url}" style="color:{NAVY};text-decoration:none;font-weight:700">{title}</a>' if url else f'<b style="color:{NAVY}">{title}</b>'
    return (
        f'<tr>'
        f'<td valign="top" width="26" style="padding:9px 0 9px;{border}font-family:{FONT};font-size:12px;color:{MUTED};font-weight:700">{idx:02d}</td>'
        f'<td valign="top" style="padding:9px 8px 9px 0;{border}font-family:{FONT};font-size:14px;line-height:1.5;color:{INK}">'
        f'{link}'
        f'<div style="font-size:12px;color:{MUTED};margin-top:2px">{src}</div>'
        f'<div style="margin-top:4px">{risk_tag_html(item.get("risk_tags"))}</div>'
        f'</td>'
        f'<td valign="top" align="right" width="46" style="padding:10px 0 9px;{border}">{chips}</td>'
        f'</tr>'
    )


def render_chapter_list(ed, cid, title, items, sub=""):
    color = CHAPTER_COLOR.get(cid, NAVY)
    rows = "".join(list_row(it, i + 1, i == len(items) - 1) for i, it in enumerate(items))
    if not rows:
        rows = f'<tr><td style="padding:8px 0;font-family:{FONT};font-size:13px;color:{MUTED}">오늘 해당 업권 기사 없음</td></tr>'
    web = escape(pages_anchor(ed, "ch-" + cid))
    subtxt = f' <span style="font-weight:400;color:{MUTED};font-size:12px">· {escape(sub)}</span>' if sub else ""
    return f"""
    <tr><td style="padding:16px 20px 0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td valign="bottom" style="padding:0 0 6px;border-bottom:2px solid {color};font-family:{FONT};font-size:15px;font-weight:700;color:{color}">
            {escape(title)} <span style="font-size:12px;color:{MUTED};font-weight:700">{len(items)}건</span>{subtxt}
          </td>
          <td valign="bottom" align="right" style="padding:0 0 6px;border-bottom:2px solid {color};font-family:{FONT};font-size:12px;white-space:nowrap">
            <a href="{web}" style="color:{WOORI};text-decoration:none">웹에서 보기 →</a>
          </td>
        </tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{rows}</table>
    </td></tr>
    """


insights = briefing.get("insights", {})
critical_items = briefing.get("critical", []) or []
daily_items = (briefing.get("daily_news", []) or []) + (briefing.get("additional_news", []) or [])
subsidiary_items = briefing.get("subsidiary_news", []) or []
overseas_items = briefing.get("overseas_news", []) or []
if not overseas_items:
    keep = []
    for it in daily_items:
        (overseas_items if axis_of(it) == "overseas" else keep).append(it)
    daily_items = keep
groups = {"critical": critical_items, "daily": daily_items, "subsidiary": subsidiary_items, "overseas": overseas_items}


def group_items_ordered(groups):
    """그룹 공통 기사: 긴급 → 뉴스 → 계열사 → 해외 순, 중복(url) 제거."""
    out, seen = [], set()
    for k in ("critical", "daily", "subsidiary", "overseas"):
        for it in groups.get(k) or []:
            key = it.get("url") or it.get("title")
            if key in seen:
                continue
            seen.add(key)
            out.append(it)
    return out


def build_sections(ed):
    """판별 리스트 순서.
    all   : 핵심판단 → 그룹 공통 리스트 → 업권 리스트 4개
    업권본 : 핵심판단 → 그룹 공통 리스트 → 해당 업권 리스트
    """
    sector_ids = edition_sectors(ed)
    parts = [render_judgment_short(briefing)]
    parts.append(render_chapter_list(ed, "group", "그룹 공통", group_items_ordered(groups)))
    for sid in sector_ids:
        s = SECTORS.get(sid) or {}
        comps = [str(c) for c in (s.get("companies") or [])]
        parts.append(render_chapter_list(ed, sid, SECTOR_NAV.get(sid, sid), list(s.get("news") or []), "·".join(comps)))
    return "".join(parts)


date_label = fmt_date(date)
generated_label = fmt_generated(meta.get("generated_at"))
if LOGO_URL:
    logo_html = (
        f'<a href="{escape(report_url)}" style="text-decoration:none">'
        f'<img src="{escape(LOGO_URL)}" width="150" alt="우리금융그룹" style="display:block;width:150px;height:auto;border:0;outline:none"></a>'
    )
else:
    logo_html = (
        f'<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
        f'<td valign="middle" style="padding:0 7px 0 0"><span style="display:inline-block;width:20px;height:20px;border-radius:10px;background:{WOORI};font-size:0;line-height:0">&nbsp;</span></td>'
        f'<td valign="middle" style="font-family:{FONT};font-size:20px;font-weight:700;color:{WOORI};letter-spacing:-0.5px;white-space:nowrap">우리금융그룹</td>'
        f'</tr></table>'
    )


def report_url_for(ed):
    eid = ed.get("id") or "all"
    if eid == "all":
        return report_url
    return report_url + ("&" if "?" in report_url else "?") + "edition=" + eid


def edition_title_tag(ed):
    return "[CRO STAFF]" if ed.get("id") == "all" else f"[CRO STAFF·{edition_short(ed)}]"


def edition_subject(ed):
    return f"{edition_title_tag(ed)} {date} 일일 리스크 브리핑"


def build_html(ed):
    sections_html = build_sections(ed)
    sector_ids = edition_sectors(ed)
    eid = ed.get("id") or "all"
    ed_label = str(ed.get("label_ko") or "전체")
    common_n = len(group_items_ordered(groups))
    sector_n = sum(len((SECTORS.get(sid) or {}).get("news") or []) for sid in sector_ids)
    if not SECTORS:
        hero_line = "우리금융그룹 CRO 관점"
    elif eid == "all":
        hero_line = f"우리금융그룹 CRO 관점 · 그룹 공통 {common_n}건 + 업권 {sector_n}건"
    else:
        hero_line = f"{escape(ed_label)} · 그룹 공통 {common_n}건 + {escape(edition_short(ed))} {sector_n}건"
    this_report_url = report_url_for(ed)
    title_tag = edition_title_tag(ed)
    html_body = f"""<!DOCTYPE html>
    <html lang="ko">
    <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{escape(title_tag)} {escape(date)} 일일 리스크 브리핑</title>
    </head>
    <body style="margin:0;padding:0;background:{OUTER};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{OUTER}">
      <tr><td align="center" style="padding:16px 8px">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:100%;background:#ffffff;border-collapse:collapse">
          <tr><td style="height:4px;background:{SKY};font-size:0;line-height:0">&nbsp;</td></tr>
          <!-- (1) 흰 브랜드 바 -->
          <tr><td align="center" style="padding:12px 20px 10px;border-bottom:1px solid {LINE}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td valign="middle" align="center">{logo_html}</td>
            </tr></table>
          </td></tr>
          <!-- (2) 네이비 밴드 + 큰 CTA -->
          <tr><td align="center" style="background:{NAVY};background-image:linear-gradient(180deg,#061B33,#0B2A4A 60%,#123E6B);padding:22px 20px 20px">
            <div style="font-family:{FONT};font-size:24px;font-weight:700;color:#ffffff;line-height:1.25;letter-spacing:-0.5px">일일 리스크 브리핑</div>
            <div style="font-family:{FONT};font-size:14px;color:{SKY};line-height:1.5;margin-top:6px"><b style="color:#9FD6F7">{escape(fmt_date_ko(date))}</b> · {escape(date_label)} KST</div>
            <div style="font-family:{FONT};font-size:12px;color:#C9DCEC;margin:4px 0 16px">{hero_line}</div>
            {cta_button(this_report_url)}
          </td></tr>
          <!-- (3) 핵심판단 (4) 챕터별 기사 리스트 -->
          <tr><td style="padding:0 0 10px;font-family:{FONT};color:{INK}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              {sections_html}
              <!-- (5) 푸터 안내 (CTA 버튼은 최상단 1개만) -->
              <tr><td align="center" style="padding:0 20px 14px;font-family:{FONT};font-size:11.5px;color:{MUTED};line-height:1.6">기사 요약·시사점·체크포인트는 웹 리포트에서 확인</td></tr>
            </table>
          </td></tr>
          <tr><td align="center" style="padding:12px 20px;background:{NAVY};border-top:3px solid {SKY};font-family:{FONT};font-size:11.5px;color:#B9CCDD;line-height:1.6">
            <b style="color:#ffffff;font-size:12.5px">우리금융그룹 리스크관리부문</b> · CRO Staff · 내부 참고용{(' · 생성 ' + escape(generated_label)) if generated_label else ''}
          </td></tr>
        </table>
      </td></tr>
    </table>
    </body>
    </html>
    """
    return html_body


def resolve_edition(eid):
    ed = EDITION_BY_ID.get(eid)
    if ed is None:
        if eid == "all":
            return EDITIONS[0]
        return None
    return ed


if PREVIEW_PATH is not None:
    ed = resolve_edition(EDITION_ARG)
    if ed is None:
        print(f"SKIPPED preview: edition '{EDITION_ARG}' not in briefing (sectors/editions missing)")
        raise SystemExit(0)
    html_body = build_html(ed)
    Path(PREVIEW_PATH).write_text(html_body, encoding="utf-8")
    print(f"Preview written: {PREVIEW_PATH} ({len(html_body)} chars, {article_count} common articles, edition={ed.get('id')})")
    raise SystemExit(0)

# 발송 계획: [(edition, recipients)]
plan = []
if ALL_EDITIONS:
    plan.append((EDITION_BY_ID.get("all") or EDITIONS[0], recipients))
    for ed in EDITIONS:
        eid = ed.get("id")
        if eid == "all":
            continue
        rcpts = recipients_for(eid)
        if not rcpts:
            print(f"SKIPPED edition '{eid}': {EDITION_RECIPIENT_ENV.get(eid, '?')} is empty")
            continue
        plan.append((ed, rcpts))
else:
    ed = resolve_edition(EDITION_ARG)
    if ed is None:
        print(f"SKIPPED edition '{EDITION_ARG}': not present in briefing.json (no sectors/editions)")
        raise SystemExit(0)
    rcpts = recipients if ed.get("id") == "all" else recipients_for(ed.get("id"))
    if not rcpts:
        print(f"SKIPPED edition '{ed.get('id')}': {EDITION_RECIPIENT_ENV.get(ed.get('id'), '?')} is empty")
        raise SystemExit(0)
    plan.append((ed, rcpts))

context = ssl.create_default_context()
with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context, timeout=30) as smtp:
    smtp.login(gmail_user, gmail_password)
    for n, (ed, rcpts) in enumerate(plan):
        if n > 0:
            time.sleep(2)
        html_body = build_html(ed)
        subject = edition_subject(ed)
        link = report_url_for(ed)
        print(f"Sending edition '{ed.get('id')}' ({ed.get('label_ko')}) to {len(rcpts)} recipient(s)")
        for recipient in rcpts:
            message = EmailMessage()
            message["From"] = f"CRO STAFF <{gmail_user}>"
            message["To"] = recipient
            message["Subject"] = subject
            message.set_content(f"{date} CRO STAFF 브리핑 ({ed.get('label_ko')}): {link}")
            message.add_alternative(html_body, subtype="html")
            smtp.send_message(message)
            print(f"Sent {ed.get('id')} briefing email to {recipient}")
            time.sleep(1)
