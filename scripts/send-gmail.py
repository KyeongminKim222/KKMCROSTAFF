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
        f'<span style="display:inline-block;padding:2px 8px;margin:0 4px 4px 0;font-size:11px;font-weight:700;'
        f'line-height:16px;color:{color};background:{bg};border:1px solid {border};border-radius:10px;'
        f'font-family:{FONT}">{escape(str(text))}</span>'
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


def change_state(item):
    ch = meta.get("changes") if isinstance(meta.get("changes"), dict) else None
    key = item.get("event_key")
    if not ch or not key:
        return ""
    if key in (ch.get("new") or []):
        return "new"
    if key in (ch.get("continued") or []):
        return "cont"
    return ""


def section_title(title_kr, count=None, note="", sec="daily"):
    bar, bar2, bg, line, title_c, kicker = SEC.get(sec, SEC["daily"])
    cnt = ""
    if count is not None:
        cnt = (
            f'<span style="display:inline-block;margin-left:8px;padding:1px 9px;font-size:12px;font-weight:700;'
            f'color:{bar};background:#ffffff;border:1px solid {line};border-radius:10px;vertical-align:middle;font-family:{FONT}">{count}건</span>'
        )
    right = (
        f'<td align="right" valign="bottom" style="font-size:10.5px;color:{MUTED};font-family:{FONT};letter-spacing:1.5px;white-space:nowrap;padding-bottom:2px">{escape(note.upper())}</td>'
        if note else ""
    )
    return f"""
    <tr><td style="padding:0 0 12px">
      <div style="font-size:10px;font-weight:700;letter-spacing:2px;color:{bar};font-family:{FONT};margin:0 0 6px">{escape(kicker)}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="font-family:{FONT}">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td width="5" style="width:5px;background:{bar};border-radius:3px;font-size:0;line-height:0">&nbsp;</td>
              <td style="padding:0 0 0 10px;font-size:19px;font-weight:700;color:{title_c};font-family:{FONT};letter-spacing:-0.3px;line-height:22px">{escape(title_kr)}{cnt}</td>
            </tr></table>
          </td>
          {right}
        </tr>
      </table>
    </td></tr>
    """


def band_open(sec):
    """섹션 틴트 패널(라운드 박스) 열기 — 내부는 중첩 테이블 행으로 채운다."""
    bar, bar2, bg, line, title_c, kicker = SEC.get(sec, SEC["daily"])
    border = SECTOR_PANEL_BORDER.get(sec, f"1px solid {line}")
    return f"""
    <tr><td style="padding:0 0 22px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{bg};border:{border};border-radius:16px;border-collapse:separate">
        <tr><td style="padding:16px 14px 6px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    """


def band_close():
    return """
          </table>
        </td></tr>
      </table>
    </td></tr>
    """


def band(sec, inner_rows):
    return band_open(sec) + inner_rows + band_close()


def empty_row():
    return f"""
    <tr><td style="padding:0">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding:12px 14px;border:1px dashed #c9d5e2;border-radius:10px;background:{TINT2};font-size:13px;color:{MUTED};font-family:{FONT}">오늘 해당 없음</td></tr>
      </table>
    </td></tr>
    """


def render_news_item(item, idx, force_axis=None, sec="daily", hook_label=""):
    """뉴스 항목 하나를 카드(테이블)로 변환. 새 파이프라인 필드(score/axis/event_key)는 있을 때만 표시."""
    sbar, sbar2, sbg, sline, stitle, _k = SEC.get(sec, SEC["daily"])
    callout_bg = CALLOUT_BG.get(sec, TINT)
    callout_fg = sbar if sec in CALLOUT_BG else WOORI
    title = escape(item.get("title", ""))
    url = escape(item.get("url", ""))
    published = escape(item.get("published", ""))
    source_name = escape(item.get("source_name", "") or "")
    urgency = item.get("urgency", "")
    summary = escape(item.get("summary", ""))
    why_woori = escape(item.get("why_woori_cro", ""))
    watchpoints = item.get("watchpoints", []) or []
    axis = axis_of(item)  # 축은 칩으로만 표시, 좌측 바는 섹션 색
    bar_color = sbar
    is_crit = bool(item.get("critical")) or sec == "critical"
    border_color = SEC["critical"][0] if is_crit else sline

    chips = f'<span style="font-size:12px;font-weight:700;color:{sbar};margin:0 8px 0 0;font-family:{FONT}">{idx:02d}</span>'
    if axis:
        label, color = AXIS_META[axis]
        fg = NAVY if axis == "peer" else "#ffffff"
        chips += chip(label, fg, color, color)
    if item.get("source_type") == "official":
        chips += chip("공식자료", WOORI, TINT, "#C9E0F1")
    if source_name:
        chips += chip(source_name, MUTED, "#F3F6F9", "#E4E9EF")
    if item.get("entity") and not axis:
        chips += chip(item["entity"], WOORI, TINT, "#C9E0F1")
    if published:
        chips += chip(published, MUTED, "#F3F6F9", "#E4E9EF")
    if item.get("window") == "related":
        chips += chip("유관(날짜외)", MUTED, "#F3F6F9", "#E4E9EF")
    if urgency:
        c, bg, bd = URGENCY_STYLE.get(urgency, (MUTED, "#F2F5F8", "#E4E9EF"))
        chips += chip(f"긴급도 {urgency}", c, bg, bd)
    st = change_state(item)
    if st == "new":
        chips += chip("신규", "#ffffff", WOORI, WOORI)
    elif st == "cont":
        chips += chip("지속", INK, "#F3F6F9", "#E4E9EF")

    score_html = ""
    score = item.get("score")
    try:
        if score is not None and score != "":
            score_html = (
                f'<td align="right" valign="top" style="padding:0 0 0 8px;white-space:nowrap">'
                f'<span style="display:inline-block;padding:2px 8px;font-size:11px;font-weight:700;color:{sbar};'
                f'background:{sbg};border:1px solid {sline};border-radius:10px;font-family:{FONT}">{int(round(float(score)))}'
                f'<span style="font-weight:400;color:{MUTED};font-size:10px">/100</span></span></td>'
            )
    except (TypeError, ValueError):
        score_html = ""

    ribbon = ""
    if is_crit:
        ribbon = (
            f'<tr><td colspan="2" style="background:{SEC["critical"][0]};color:#ffffff;font-size:11px;font-weight:700;letter-spacing:2px;'
            f'padding:7px 16px;font-family:{FONT};border-radius:11px 11px 0 0">'
            f'<span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:#FFD3CE;margin:0 8px 1px 0"></span>CRITICAL · PRIORITY WATCH</td></tr>'
        )

    why_html = ""
    if why_woori:
        why_html = f"""
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 0">
            <tr><td style="background:{callout_bg};padding:10px 14px;border-radius:8px">
              <div style="font-size:12px;font-weight:700;color:{callout_fg};margin:0 0 3px;font-family:{FONT}"><span style="display:inline-block;width:10px;height:10px;border-radius:5px;background:{callout_fg};margin:0 6px 0 0;vertical-align:-1px"></span>우리금융그룹 CRO 시사점</div>
              <div style="font-size:13.5px;line-height:1.6;color:{INK};font-family:{FONT}">{why_woori}</div>
            </td></tr>
          </table>"""

    hook_html = ""
    if hook_label and item.get("sector_hook"):
        hook_html = f"""
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0">
            <tr><td style="background:#ffffff;border:1px dashed {sline};border-left:3px solid {sbar};padding:8px 12px;border-radius:0 8px 8px 0">
              <div style="font-size:11.5px;font-weight:700;color:{sbar};margin:0 0 2px;font-family:{FONT}">{escape(hook_label)}</div>
              <div style="font-size:13px;line-height:1.6;color:{INK};font-family:{FONT}">{escape(str(item.get("sector_hook")))}</div>
            </td></tr>
          </table>"""

    wp_html = ""
    if watchpoints:
        wp_list = "".join(f'<li style="margin:3px 0">{escape(w)}</li>' for w in watchpoints)
        wp_html = (
            f'<div style="margin:12px 0 0;font-size:13px;color:{INK};font-family:{FONT}">'
            f'<b style="color:{NAVY}">Watchpoints</b>'
            f'<ul style="padding-left:18px;margin:4px 0 0;line-height:1.6">{wp_list}</ul></div>'
        )

    tags = []
    if item.get("entity") and axis:
        tags.append(item["entity"])
    if item.get("channel"):
        tags.append(item["channel"])
    if item.get("risk_type") and item.get("risk_type") != item.get("channel"):
        tags.append(item["risk_type"])
    tags_html = ""
    if tags:
        tags_html = '<div style="margin:10px 0 0">' + "".join(chip(t, MUTED, "#F3F6F9", "#E4E9EF") for t in tags) + "</div>"

    radius_left = "0 0 0 11px" if is_crit else "11px 0 0 11px"
    return f"""
    <tr><td style="padding:0 0 14px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid {border_color};border-radius:12px;border-collapse:separate;background:#ffffff">
        {ribbon}
        <tr>
          <td width="4" style="width:4px;background:{bar_color};border-radius:{radius_left};font-size:0;line-height:0">&nbsp;</td>
          <td style="padding:14px 18px 16px 16px;font-family:{FONT}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="top" style="font-family:{FONT}">{chips}</td>
                {score_html}
              </tr>
            </table>
            <div style="font-size:16px;font-weight:700;line-height:1.45;margin:6px 0 6px;font-family:{FONT}">
              <a href="{url}" style="color:{NAVY};text-decoration:none">{title}</a>
            </div>
            <div style="font-size:14px;line-height:1.6;color:{INK};font-family:{FONT}">{summary}</div>
            {why_html}
            {hook_html}
            {wp_html}
            {tags_html}
          </td>
        </tr>
      </table>
    </td></tr>
    """


def render_news_section(title_kr, items, note="", force_axis=None, sec="daily"):
    html = section_title(title_kr, len(items), note, sec)
    if not items:
        return band(sec, html + empty_row())
    return band(sec, html + "".join(render_news_item(item, i + 1, force_axis, sec) for i, item in enumerate(items)))


def render_sector_section(sid):
    """업권 패널: 키커(label_en) + 제목(label_ko) + 계열사 칩 + 업권 판단 박스 + 카드."""
    s = SECTORS.get(sid) or {}
    bar, bar2, bg, line, title_c, kicker = SEC.get(sid, SEC["daily"])
    items = s.get("news") or []
    comps = [str(c) for c in (s.get("companies") or [])]
    comp_chips = "".join(chip(c, "#ffffff", bar, bar) for c in comps)
    label_ko = SECTOR_NAV.get(sid) or str(s.get("label_ko") or sid)
    html = f"""
    <tr><td style="padding:0 0 12px">
      <div style="font-size:10px;font-weight:700;letter-spacing:2px;color:{bar};font-family:{FONT};margin:0 0 6px">{escape(str(kicker or s.get("label_en") or sid).upper())}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="font-family:{FONT}">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td width="5" style="width:5px;background:{bar};border-radius:3px;font-size:0;line-height:0">&nbsp;</td>
              <td style="padding:0 0 0 10px;font-size:19px;font-weight:700;color:{title_c};font-family:{FONT};letter-spacing:-0.3px;line-height:22px">{escape(label_ko)}<span style="display:inline-block;margin-left:8px;padding:1px 9px;font-size:12px;font-weight:700;color:{bar};background:#ffffff;border:1px solid {line};border-radius:10px;vertical-align:middle;font-family:{FONT}">{len(items)}건</span></td>
            </tr></table>
          </td>
          <td align="right" valign="bottom" style="font-family:{FONT};white-space:nowrap">{comp_chips}</td>
        </tr>
      </table>
    </td></tr>
    """
    if s.get("judgment"):
        html += f"""
    <tr><td style="padding:0 0 14px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="background:{bg};border:1px solid {line};border-left:4px solid {bar};padding:12px 16px;border-radius:0 10px 10px 0;font-family:{FONT}">
          <div style="font-size:11.5px;font-weight:700;color:{bar};letter-spacing:1px;margin:0 0 4px">{escape(label_ko)} 업권 판단 · {escape("·".join(comps))}</div>
          <div style="font-size:14px;line-height:1.7;color:{INK}">{escape(str(s["judgment"]))}</div>
        </td></tr>
      </table>
    </td></tr>
    """
    hook_label = ("·".join(comps) if comps else label_ko) + " 관점"
    if items:
        html += "".join(render_news_item(it, i + 1, None, sid, hook_label=hook_label) for i, it in enumerate(items))
    else:
        html += empty_row()
    if s.get("shortfall_reason"):
        html += f'<tr><td style="padding:0 0 8px;font-size:12px;color:{MUTED};font-family:{FONT}">※ {escape(str(s["shortfall_reason"]))}</td></tr>'
    return band(sid, html)


def render_bullets(title_kr, bullets, note="", sec="monitor"):
    if not bullets:
        return ""
    bar, bar2, bg, line, title_c, kicker = SEC[sec]
    body = "".join(f'<li style="margin:6px 0">{escape(b)}</li>' for b in bullets)
    return band(sec, section_title(title_kr, None, note, sec) + f"""
    <tr><td style="padding:0 0 8px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid {line};border-left:4px solid {bar};border-radius:0 12px 12px 0;border-collapse:separate;background:#ffffff">
        <tr><td style="padding:14px 18px;font-size:14px;line-height:1.6;color:{INK};font-family:{FONT}">
          <ul style="padding-left:20px;margin:0">{body}</ul>
        </td></tr>
      </table>
    </td></tr>
    """)


def render_forward_looking(items):
    bar, bar2, bg, line, title_c, kicker = SEC["forward"]
    html = section_title("전망 · 발생가능 포인트", len(items), "Outlook", "forward")
    if not items:
        return band("forward", html + empty_row())
    rows = ""
    for i, it in enumerate(items):
        meta_bits = [f'<span style="font-size:12px;font-weight:700;color:{bar};margin:0 8px 0 0;font-family:{FONT}">{i + 1:02d}</span>']
        if it.get("horizon"):
            meta_bits.append(chip(it["horizon"], MUTED, "#F3F6F9", "#E4E9EF"))
        if it.get("likelihood"):
            meta_bits.append(chip(f"가능성 {it['likelihood']}", bar, "#FFF3DF", line))
        trig = (
            f'<div style="margin:8px 0 0;font-size:12.5px;color:{MUTED};font-family:{FONT}"><b style="color:{bar}">Trigger</b> · {escape(it.get("trigger", ""))}</div>'
            if it.get("trigger") else ""
        )
        rows += f"""
        <tr><td style="padding:0 0 12px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid {line};border-top:4px solid {bar2};border-radius:12px;border-collapse:separate;background:#ffffff">
            <tr><td style="padding:14px 18px;font-family:{FONT}">
              <div>{''.join(meta_bits)}</div>
              <div style="font-size:15px;font-weight:700;color:{NAVY};margin:6px 0 6px;line-height:1.45">{escape(it.get('title', ''))}</div>
              <div style="font-size:14px;line-height:1.6;color:{INK}">{escape(it.get('cro_angle', ''))}</div>
              {trig}
            </td></tr>
          </table>
        </td></tr>
        """
    return band("forward", html + rows)


def render_insights(ins):
    if not ins:
        return ""
    has = ins.get("headline") or ins.get("bullets") or ins.get("action_items") or ins.get("stance")
    bar, bar2, bg, line, title_c, kicker = SEC["insights"]
    html = section_title("오늘 CRO Staff 인사이트", None, "CRO Staff View", "insights")
    if not has:
        return band("insights", html + empty_row())
    body = ""
    if ins.get("as_of"):
        body += f'<div style="font-size:12px;color:{MUTED};margin:0 0 8px">{escape(ins["as_of"])} · 우리금융그룹 CRO 스태프 판단</div>'
    if ins.get("headline"):
        body += f'<div style="font-size:17px;font-weight:700;color:{NAVY};line-height:1.5;margin:0 0 10px">{escape(ins["headline"])}</div>'
    if ins.get("bullets"):
        body += '<ul style="padding-left:20px;margin:0 0 12px;font-size:14px;line-height:1.6;color:' + INK + '">' + "".join(
            f'<li style="margin:5px 0">{escape(b)}</li>' for b in ins["bullets"]) + "</ul>"
    if ins.get("action_items"):
        body += f'<div style="font-size:12px;font-weight:700;color:{bar};margin:0 0 4px;letter-spacing:1px">권고 액션</div>'
        body += '<ol style="padding-left:20px;margin:0 0 12px;font-size:14px;line-height:1.6;color:' + INK + '">' + "".join(
            f'<li style="margin:5px 0">{escape(a)}</li>' for a in ins["action_items"]) + "</ol>"
    if ins.get("stance"):
        body += f"""
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="background:#F1ECFB;border-left:4px solid {bar};padding:10px 14px;border-radius:0 8px 8px 0;font-family:{FONT}">
              <div style="font-size:12px;font-weight:700;color:{bar};margin:0 0 3px;letter-spacing:1px">STANCE</div>
              <div style="font-size:14px;line-height:1.6;color:{INK}">{escape(ins["stance"])}</div>
            </td></tr>
          </table>"""
    return band("insights", html + f"""
    <tr><td style="padding:0 0 8px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid {line};border-top:4px solid {bar};border-radius:12px;border-collapse:separate;background:#ffffff">
        <tr><td style="padding:16px 18px;font-family:{FONT}">{body}</td></tr>
      </table>
    </td></tr>
    """)


def judgment_lines(b):
    arr = b.get("executive_judgment_bullets") or []
    return [str(x) for x in arr if x]


def split_sentences(text):
    import re as _re
    raw = str(text or "").strip()
    if not raw:
        return []
    parts = [p.strip() for p in _re.split(r"(?<=[.!?])\s+", raw) if p.strip()]
    return parts


# ===== 오늘 한눈에 (At a Glance): 판단 3문장 + 카테고리별 기사 목차 (웹 index.html renderGlance 와 동일 구성) =====
GLANCE_CATS = [
    ("critical", "긴급", "#B42318"),
    ("supervision", "감독·규제", "#0B2A4A"),
    ("group", "그룹·계열사", "#0067AC"),
    ("peer", "경쟁사", "#1F8BCB"),
    ("market", "시장·거시", "#B86E00"),
    ("overseas", "해외", "#0B6B47"),
    ("other", "기타", "#6b7684"),
]


def glance_buckets(groups):
    buckets = {k: [] for k, _, _ in GLANCE_CATS}
    seen = set()

    def put(cat, it):
        key = it.get("url") or it.get("title")
        if not key or key in seen:
            return
        seen.add(key)
        buckets.setdefault(cat, buckets["other"]).append(it)

    for it in groups["critical"]:
        put("critical", it)
    for it in groups["subsidiary"]:
        put(axis_of(it) or "group", it)
    for it in groups["daily"]:
        put("critical" if it.get("critical") else (axis_of(it) or "other"), it)
    for it in groups["overseas"]:
        put("overseas", it)
    return buckets


def glance_row(it, color):
    urgency = it.get("urgency", "")
    urg = ""
    if urgency:
        c, bg, bd = URGENCY_STYLE.get(urgency, (MUTED, "#F2F5F8", "#E4E9EF"))
        urg = (
            f'<td align="right" valign="top" style="padding:3px 0 3px 8px;white-space:nowrap">'
            f'<span style="display:inline-block;padding:0 7px;font-size:10.5px;font-weight:700;line-height:16px;color:{c};background:{bg};border:1px solid {bd};border-radius:9px;font-family:{FONT}">{escape(urgency)}</span></td>'
        )
    return (
        f'<tr><td width="14" valign="top" style="padding:3px 0;width:14px"><span style="display:inline-block;width:6px;height:6px;border-radius:3px;background:{color};vertical-align:middle"></span></td>'
        f'<td valign="top" style="padding:3px 0;font-size:13.5px;font-weight:700;line-height:1.45;font-family:{FONT}">'
        f'<a href="{escape(it.get("url", ""))}" style="color:{INK};text-decoration:none">{escape(it.get("title", ""))}</a></td>{urg}</tr>'
    )


def render_glance(b, groups, ed, sector_ids=()):
    sentences = split_sentences(b.get("executive_judgment"))
    buckets = glance_buckets(groups)
    bar, bar2, bg, line, title_c, kicker = SEC["judgment"]

    judg = f'<div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:{WOORI};margin:0 0 8px;font-family:{FONT}">EXECUTIVE JUDGMENT · CRO STAFF</div>'
    if sentences:
        for i, t in enumerate(sentences):
            sep = f"border-top:1px dashed {LINE};margin-top:9px;padding-top:9px;" if i else ""
            judg += f'<div style="{sep}font-size:16px;font-weight:700;line-height:1.6;color:{NAVY};font-family:{FONT}">{escape(t)}</div>'
    else:
        judg += f'<div style="font-size:14px;color:{MUTED};font-family:{FONT}">오늘 해당 없음</div>'

    toc = f'<div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:{MUTED};margin:0 0 8px;font-family:{FONT}">기사 목차 · 제목을 누르면 원문으로 이동</div>'
    for key, label, color in GLANCE_CATS:
        items = buckets.get(key) or []
        if not items:
            continue
        toc += (
            f'<div style="margin:0 0 4px;font-size:12.5px;font-weight:700;color:{color};font-family:{FONT}">'
            f'<span style="display:inline-block;width:9px;height:9px;border-radius:5px;background:{color};margin:0 6px 1px 0;vertical-align:middle"></span>{escape(label)} <span style="font-weight:400;color:{MUTED};font-size:12px">{len(items)}</span></div>'
        )
        toc += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px 15px">' + "".join(glance_row(it, color) for it in items) + "</table>"
    sector_items = []
    sector_html = ""
    for sid in sector_ids:
        sdef = SECTORS.get(sid) or {}
        news = sdef.get("news") or []
        if not news:
            continue
        sector_items += news
        color = SEC.get(sid, SEC["daily"])[0]
        comps = "·".join(str(c) for c in (sdef.get("companies") or []))
        sector_html += (
            f'<div style="margin:6px 0 2px 15px;font-size:12px;font-weight:700;color:{color};font-family:{FONT}">{escape(SECTOR_NAV.get(sid, sid))}{(" · " + escape(comps)) if comps else ""} '
            f'<span style="font-weight:400;color:{MUTED};font-size:11.5px">{len(news)}</span></div>'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 6px 15px">' + "".join(glance_row(it, color) for it in news) + "</table>"
        )
    if sector_html:
        toc += (
            f'<div style="margin:0 0 2px;font-size:12.5px;font-weight:700;color:{NAVY};font-family:{FONT}">'
            f'<span style="display:inline-block;width:9px;height:9px;border-radius:5px;background:{NAVY};margin:0 6px 1px 0;vertical-align:middle"></span>업권별 <span style="font-weight:400;color:{MUTED};font-size:12px">{len(sector_items)}</span></div>' + sector_html
        )

    all_items = [it for v in groups.values() for it in v] + sector_items
    crit = len(groups["critical"]) + sum(1 for it in sector_items if it.get("critical"))
    official = sum(1 for it in all_items if it.get("source_type") == "official")
    ed_label = str((ed or {}).get("label_ko") or "전체")
    foot = (
        f'<div style="margin:12px 0 0;padding-top:9px;border-top:1px solid {LINE};font-size:12px;color:{MUTED};font-family:{FONT}">'
        f'전체 <b style="color:{NAVY}">{len(all_items)}건</b> · 긴급 <b style="color:{NAVY}">{crit}</b> · 공식자료 <b style="color:{NAVY}">{official}</b> · {escape(ed_label)} 기준</div>'
    )
    return f"""
    <tr><td style="padding:0 0 22px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid {line};border-radius:16px;border-collapse:separate">
        <tr><td style="padding:16px 16px 14px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            {section_title("오늘 한눈에", None, "At a Glance · " + fmt_date(date), "judgment").replace("EXECUTIVE JUDGMENT", "TODAY AT A GLANCE")}
            <tr><td style="padding:0 0 14px;font-family:{FONT}">{judg}</td></tr>
            <tr><td style="padding:12px 14px 10px;background:#F7F9FB;border:1px solid {LINE};border-radius:10px;font-family:{FONT}">{toc}</td></tr>
            <tr><td style="font-family:{FONT}">{foot}</td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>
    """


def render_judgment(b, groups, sector_ids=()):
    """핵심 판단 포인트: executive_judgment_bullets 만 (판단 본문·기사 목록은 '오늘 한눈에'로 이동)."""
    lines = judgment_lines(b)
    bar, bar2, bg, line, title_c, kicker = SEC["judgment"]
    body = ""
    if lines:
        body += '<ul style="padding-left:20px;margin:0">' + "".join(
            f'<li style="margin:6px 0;font-size:14.5px;line-height:1.65;color:{INK};font-family:{FONT}">{escape(x)}</li>' for x in lines
        ) + "</ul>"
    ch = meta.get("changes") if isinstance(meta.get("changes"), dict) else None
    if ch and ((ch.get("new") or []) or (ch.get("continued") or [])):
        body += '<div style="margin:12px 0 0">' + chip(f"신규 {len(ch.get('new') or [])}", "#ffffff", WOORI, WOORI) + chip(f"지속 {len(ch.get('continued') or [])}", INK, "#F3F6F9", "#E4E9EF") + "</div>"
    if meta.get("shortfall_reason"):
        body += f'<div style="margin:8px 0 0;font-size:12px;color:{MUTED};font-family:{FONT}">※ {escape(str(meta["shortfall_reason"]))}</div>'
    if not body:
        body = f'<div style="font-size:14px;color:{MUTED};font-family:{FONT}">오늘 해당 없음 · 판단 요지는 상단 \'오늘 한눈에\'를 참고하세요.</div>'
    return band("judgment", section_title("핵심 판단 포인트", len(lines) or None, "CRO Staff · " + fmt_date(date), "judgment").replace("EXECUTIVE JUDGMENT", "KEY JUDGMENT POINTS") + f"""
    <tr><td style="padding:0 0 8px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="background:#ffffff;border:1px solid {line};border-left:4px solid {bar};padding:16px 18px;border-radius:0 10px 10px 0;font-family:{FONT}">
          {body}
        </td></tr>
      </table>
    </td></tr>
    """)


def render_summary_strip(b, groups, ed=None, sector_ids=()):
    common_total = sum(len(v) for v in groups.values())
    sector_items = [it for sid in sector_ids for it in ((SECTORS.get(sid) or {}).get("news") or [])]
    total = common_total + len(sector_items)
    crit = len(groups.get("critical", [])) + sum(1 for it in sector_items if it.get("critical"))
    mix = meta.get("source_mix") if isinstance(meta.get("source_mix"), dict) else {}
    official = mix.get("official")
    if official is None or sector_ids:
        official = sum(1 for items in groups.values() for it in items if it.get("source_type") == "official") + \
            sum(1 for it in sector_items if it.get("source_type") == "official")
    media = mix.get("media") if not sector_ids else None
    if media is None:
        media = total - official
    sel_hint = f"공통 {common_total} · 업권 {len(sector_items)}" if (ed and SECTORS) else f"언론 {media} · 공식 {official}"
    cells = [
        ("긴급", f"{crit}<span style='font-size:12px;font-weight:400;color:{MUTED}'> 건</span>", "Critical · 즉시 확인"),
        ("선정 기사", f"{total}<span style='font-size:12px;font-weight:400;color:{MUTED}'> 건</span>", sel_hint),
        ("공식자료", f"{official}<span style='font-size:12px;font-weight:400;color:{MUTED}'> 건</span>", "금융위·금감원·한은·DART"),
    ]
    ch = meta.get("changes") if isinstance(meta.get("changes"), dict) else None
    if ch and (isinstance(ch.get("new"), list) or isinstance(ch.get("continued"), list)):
        n, c = len(ch.get("new") or []), len(ch.get("continued") or [])
        cells.append(("신규 · 지속", f"{n}<span style='font-size:12px;font-weight:400;color:{MUTED}'> 신규</span> / {c}<span style='font-size:12px;font-weight:400;color:{MUTED}'> 지속</span>", "최근 3일 대비"))
    elif ed and ed.get("id") != "all":
        comps = [c for sid in sector_ids for c in ((SECTORS.get(sid) or {}).get("companies") or [])]
        cells.append(("관점", f"<span style='font-size:15px'>{escape(str(ed.get('label_ko') or ''))}</span>", "·".join(comps) or "Sector Risk Lens"))
    else:
        cells.append(("관점", f"<span style='font-size:15px'>우리금융그룹 CRO</span>", "Group Risk Lens · 전체" if SECTORS else "Group Risk Lens"))

    def cell(label, value, hint, last):
        pad = "0" if last else "0 8px 0 0"
        return f"""
          <td width="25%" valign="top" style="padding:{pad}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid {LINE};border-top:3px solid {SKY};border-radius:8px;border-collapse:separate;background:#ffffff">
              <tr><td style="padding:10px 12px;font-family:{FONT}">
                <div style="font-size:11px;font-weight:700;color:{NAVY};white-space:nowrap;letter-spacing:0.3px">{escape(label)}</div>
                <div style="font-size:22px;font-weight:700;color:{NAVY};line-height:1.2;margin-top:2px;white-space:nowrap">{value}</div>
                <div style="font-size:11px;color:{MUTED};margin-top:3px;white-space:nowrap;overflow:hidden">{escape(hint)}</div>
              </td></tr>
            </table>
          </td>"""

    tds = "".join(cell(*c, last=(i == len(cells) - 1)) for i, c in enumerate(cells))
    return f"""
    <tr><td style="padding:0 0 24px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>{tds}</tr></table>
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


def build_sections(ed):
    """판별 섹션 순서.
    all   : 핵심판단 → 긴급 → 뉴스 → 계열사 → 글로벌 → 업권 5개 → 전망 이하
    업권본 : 핵심판단 → 해당 업권 → 긴급 → 뉴스 → 계열사 → 글로벌 → 전망 이하
    """
    sector_ids = edition_sectors(ed)
    is_sector_ed = ed.get("id") != "all"
    sector_blocks = "".join(render_sector_section(sid) for sid in sector_ids)
    parts = [render_glance(briefing, groups, ed, sector_ids), render_judgment(briefing, groups, sector_ids)]
    if is_sector_ed:
        parts.append(sector_blocks)
    parts += [
        render_news_section("긴급", critical_items, "Priority Watch", sec="critical"),
        render_news_section("오늘의 리스크 뉴스", daily_items, "Daily News", sec="daily"),
        render_news_section("우리금융그룹 · 계열사", subsidiary_items, "Group & Subsidiaries", sec="subsidiary"),
        render_news_section("해외 · 글로벌", overseas_items, "Overseas & Global", sec="overseas") if overseas_items else "",
    ]
    if not is_sector_ed:
        parts.append(sector_blocks)
    parts += [
        render_forward_looking(briefing.get("forward_looking_points", []) or []),
        render_insights(insights),
        render_bullets("모니터링 포인트", briefing.get("monitoring_points", []) or [], "Watchlist", sec="monitor"),
    ]
    return "".join(parts)


date_label = fmt_date(date)
generated_label = fmt_generated(meta.get("generated_at"))
if LOGO_URL:
    logo_html = (
        f'<a href="{escape(report_url)}" style="text-decoration:none">'
        f'<img src="{escape(LOGO_URL)}" width="160" alt="우리금융그룹" style="display:block;width:160px;height:auto;border:0;outline:none"></a>'
    )
    logo_html_dark = logo_html
else:
    # 텍스트 워드마크: 스카이블루 구체 + 우리금융그룹 (이미지 호스팅 불가 시)
    def wordmark(color, sphere):
        return (
            f'<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
            f'<td valign="middle" style="padding:0 7px 0 0"><span style="display:inline-block;width:20px;height:20px;border-radius:10px;background:{sphere};font-size:0;line-height:0">&nbsp;</span></td>'
            f'<td valign="middle" style="font-family:{FONT};font-size:20px;font-weight:700;color:{color};letter-spacing:-0.5px;white-space:nowrap">우리금융그룹</td>'
            f'</tr></table>'
        )
    logo_html = wordmark(WOORI, WOORI)
    logo_html_dark = wordmark("#ffffff", SKY)


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
    comps = [c for sid in sector_ids for c in ((SECTORS.get(sid) or {}).get("companies") or [])]
    common_n = sum(len(v) for v in groups.values())
    sector_n = sum(len((SECTORS.get(sid) or {}).get("news") or []) for sid in sector_ids)
    if not SECTORS:
        hero_line = "우리금융그룹 CRO 관점 · 어제·오늘(KST) 우선, 부족 시 최근 3일 이내 유관·배경 자료"
        hero_badge = ""
    elif eid == "all":
        hero_line = f"우리금융그룹 CRO 관점 · 전체 · 그룹 공통 {common_n}건 + 업권 {sector_n}건"
        hero_badge = ""
    else:
        hero_line = f"{escape(ed_label)} · {escape('·'.join(comps) or ed_label)} 리스크관리부 · 그룹 공통 {common_n}건 + {escape(edition_short(ed))} {sector_n}건"
        hero_badge = (
            f'<div style="margin:0 0 12px"><span style="display:inline-block;padding:3px 12px;font-family:{FONT};font-size:11.5px;font-weight:700;'
            f'letter-spacing:1px;color:#ffffff;background:{SEC.get(sector_ids[0], SEC["daily"])[0] if sector_ids else WOORI};border-radius:12px">{escape(ed_label)}</span></div>'
        )
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
      <tr><td align="center" style="padding:20px 10px">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:100%;background:#ffffff;border-collapse:collapse">
          <!-- Sky line -->
          <tr><td style="height:4px;background:{SKY};font-size:0;line-height:0">&nbsp;</td></tr>
          <!-- White brand bar (공식 홈: 중앙 로고) -->
          <tr><td align="center" style="padding:14px 28px 12px;border-bottom:1px solid {LINE}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td valign="middle" style="font-family:{FONT};font-size:11.5px;color:{MUTED};white-space:nowrap"><b style="color:{NAVY}">리스크관리부문</b> · CRO Staff</td>
              <td valign="middle" align="center">{logo_html}</td>
              <td valign="middle" align="right" style="font-family:{FONT};font-size:12px;color:{NAVY};font-weight:700;white-space:nowrap">{escape(date_label)} <span style="font-weight:400;color:{MUTED};font-size:10.5px">KST</span></td>
            </tr></table>
          </td></tr>
          <!-- Navy key-visual header (중앙 정렬) -->
          <tr><td align="center" style="background:{NAVY};background-image:linear-gradient(180deg,#061B33,#0B2A4A 60%,#123E6B);padding:34px 28px 36px">
            {hero_badge}<div style="font-family:{FONT};font-size:10.5px;font-weight:700;letter-spacing:3px;color:#9FC9E8;margin:0 0 12px">WOORI FINANCIAL GROUP · RISK MANAGEMENT</div>
            <div style="font-family:{FONT};font-size:30px;font-weight:700;color:#ffffff;line-height:1.2;letter-spacing:-0.5px">일일 리스크 브리핑</div>
            <div style="font-family:{FONT};font-size:15px;color:{SKY};line-height:1.5;margin-top:10px"><b style="color:#9FD6F7">{escape(fmt_date_ko(date))}</b> · {escape(date_label)} KST</div>
            <div style="font-family:{FONT};font-size:12px;color:#C9DCEC;margin-top:6px">{hero_line}</div>
          </td></tr>
          <!-- Body -->
          <tr><td style="padding:18px 20px 10px;font-family:{FONT};color:{INK};background:#F7F9FB">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              {render_summary_strip(briefing, groups, ed, sector_ids)}
              {sections_html}
              <!-- CTA -->
              <tr><td align="center" style="padding:32px 0 8px">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr><td align="center" style="background:{WOORI};border-radius:24px">
                    <a href="{escape(this_report_url)}" style="display:inline-block;padding:13px 30px;font-family:{FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none">리포트 전체 보기 →</a>
                  </td></tr>
                </table>
              </td></tr>
              <tr><td align="center" style="padding:0 0 12px;font-family:{FONT};font-size:12px;color:{MUTED};line-height:1.6">
                웹 리포트(GitHub Pages)에서는 우하단 'AI에게 질문' 버튼으로 브리핑 근거 답변을 받을 수 있습니다.<br>사내망에서 링크가 열리지 않는 경우, 이 메일 본문이 전체 브리핑 내용입니다.
              </td></tr>
            </table>
          </td></tr>
          <!-- Footer -->
          <tr><td style="padding:18px 28px 20px;background:{NAVY};border-top:4px solid {SKY};font-family:{FONT};font-size:11.5px;color:#B9CCDD;line-height:1.6">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle" style="font-family:{FONT};font-size:14px;font-weight:700;color:#ffffff;white-space:nowrap">우리금융그룹 리스크관리부문</td>
                <td valign="middle" align="right" style="font-family:{FONT};font-size:11.5px;color:#B9CCDD;line-height:1.6">
                  <b style="color:#ffffff">CRO Staff</b> · 내부 참고용{(' · 생성 ' + escape(generated_label)) if generated_label else ''}<br>
                  기사 요약·시사점은 CRO Staff 분석이며 그룹의 공식 입장이 아닙니다.
                </td>
              </tr>
            </table>
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
