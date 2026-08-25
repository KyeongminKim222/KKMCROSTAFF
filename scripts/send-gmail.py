import json
import os
import smtplib
import ssl
import time
from email.message import EmailMessage
from html import escape
from pathlib import Path
from urllib.parse import unquote, urlparse


gmail_user = os.environ["GMAIL_USER"].strip()
gmail_password = os.environ["GMAIL_APP_PASSWORD"].replace(" ", "").strip()
recipients = [item.strip() for item in os.environ["EMAIL_TO"].replace(";", ",").split(",") if item.strip()]
report_url = os.environ["REPORT_URL"].strip()

parsed_report_url = urlparse(report_url)
report_path_parts = [unquote(part) for part in parsed_report_url.path.split("/") if part]
if parsed_report_url.scheme != "https" or len(report_path_parts) != 2 or report_path_parts[0] != "report":
    raise RuntimeError(
        "REPORT_URL must be the complete HTTPS link: "
        "https://kkmcrostaff.onrender.com/report/YOUR_REPORT_ACCESS_TOKEN"
    )
if len(report_path_parts[1]) < 32:
    raise RuntimeError("The token inside REPORT_URL must contain at least 32 characters.")

if not recipients:
    raise RuntimeError("EMAIL_TO has no recipients")

briefing = json.loads(Path("public/briefing.json").read_text(encoding="utf-8"))
meta = briefing.get("meta", {})
date = meta.get("briefing_date", "")
headline = briefing.get("insights", {}).get("headline") or briefing.get("executive_judgment", "오늘의 CRO STAFF 브리핑")

URGENCY_COLOR = {"높음": "#d92d20", "중간": "#dc6803", "낮음": "#667085"}


def render_news_item(item):
    """뉴스 항목 하나를 상세 정보와 함께 HTML로 변환"""
    source_label = "언론" if item.get("source_type") == "media" else "공식"
    source_name = escape(item.get("source_name", "출처"))
    title = escape(item.get("title", ""))
    url = escape(item.get("url", ""))
    published = escape(item.get("published", ""))
    urgency = item.get("urgency", "")
    urgency_color = URGENCY_COLOR.get(urgency, "#667085")
    risk_type = escape(item.get("risk_type", ""))
    summary = escape(item.get("summary", ""))
    why_woori = escape(item.get("why_woori_cro", ""))
    watchpoints = item.get("watchpoints", [])

    watchpoints_html = ""
    if watchpoints:
        wp_list = "".join(f'<li style="margin:3px 0">{escape(w)}</li>' for w in watchpoints)
        watchpoints_html = f'<div style="margin-top:6px;font-size:12px;color:#475569"><b>Watchpoints</b><ul style="padding-left:18px;margin:4px 0">{wp_list}</ul></div>'

    return f"""
    <li style="margin:16px 0;list-style:none;border-left:3px solid {urgency_color};padding-left:12px">
      <div style="font-size:11px;color:#64748b">[{source_label} · {source_name} · {published}]
        <span style="color:{urgency_color};font-weight:700"> 긴급도 {escape(urgency)}</span>
        {f' · {risk_type}' if risk_type else ''}
      </div>
      <div style="font-size:15px;font-weight:700;margin-top:2px"><a href="{url}" style="color:#003b70;text-decoration:none">{title}</a></div>
      <div style="font-size:13px;color:#334155;margin-top:4px">{summary}</div>
      {f'<div style="font-size:13px;color:#0067ac;margin-top:5px"><b>CRO 시사점</b> {why_woori}</div>' if why_woori else ''}
      {watchpoints_html}
    </li>
    """


def render_news_section(title_kr, items):
    if not items:
        return ""
    body = "".join(render_news_item(item) for item in items)
    return f"""
    <h2 style="font-size:17px;color:#003b70;border-bottom:2px solid #e2e8f0;padding-bottom:6px;margin-top:28px">{escape(title_kr)}</h2>
    <ul style="padding-left:0;margin:10px 0">{body}</ul>
    """


def render_bullets(title_kr, bullets):
    if not bullets:
        return ""
    body = "".join(f'<li style="margin:6px 0;font-size:14px">{escape(b)}</li>' for b in bullets)
    return f"""
    <h2 style="font-size:17px;color:#003b70;border-bottom:2px solid #e2e8f0;padding-bottom:6px;margin-top:28px">{escape(title_kr)}</h2>
    <ul style="padding-left:20px">{body}</ul>
    """


def render_forward_looking(items):
    if not items:
        return ""
    rows = ""
    for it in items:
        rows += f"""
        <li style="margin:10px 0;font-size:14px">
          <b>{escape(it.get('title',''))}</b>
          <span style="font-size:12px;color:#667085"> ({escape(it.get('horizon',''))} · 가능성 {escape(it.get('likelihood',''))})</span>
          <div style="font-size:13px;color:#334155;margin-top:2px">{escape(it.get('cro_angle',''))}</div>
          <div style="font-size:12px;color:#64748b">Trigger: {escape(it.get('trigger',''))}</div>
        </li>
        """
    return f"""
    <h2 style="font-size:17px;color:#003b70;border-bottom:2px solid #e2e8f0;padding-bottom:6px;margin-top:28px">Forward Looking Points</h2>
    <ul style="padding-left:20px">{rows}</ul>
    """


insights = briefing.get("insights", {})

sections_html = "".join([
    render_bullets("Executive Judgment", briefing.get("executive_judgment_bullets", [])),
    render_news_section("Priority Watch", briefing.get("critical", [])),
    render_news_section("Daily News", briefing.get("daily_news", [])),
    render_news_section("Subsidiary Radar(우리금융그룹 계열사 뉴스)", briefing.get("subsidiary_news", [])),
    render_news_section("Additional News", briefing.get("additional_news", [])),
    render_forward_looking(briefing.get("forward_looking_points", [])),
    render_bullets("Insights", insights.get("bullets", [])),
    render_bullets("Action Items", insights.get("action_items", [])),
    render_bullets("Monitoring Points", briefing.get("monitoring_points", [])),
])

stance = insights.get("stance", "")
stance_html = f'<p style="font-size:14px;color:#0067ac;font-weight:600;margin-top:10px">Stance: {escape(stance)}</p>' if stance else ""

html_body = f"""
<div style="font-family:Arial,'Apple SD Gothic Neo',sans-serif;line-height:1.6;color:#172033;max-width:680px;margin:auto">
  <p style="font-size:12px;color:#5b6b80;margin-bottom:4px">WOORI FINANCIAL GROUP · DAILY RISK INTELLIGENCE</p>
  <h1 style="font-size:24px;margin:0 0 12px;color:#003b70">CRO STAFF 일일 리스크 브리핑</h1>
  <p style="font-size:14px;color:#334155">{escape(date)} KST</p>
  <p style="font-size:17px;font-weight:700">{escape(headline)}</p>
  <h2 style="font-size:17px;color:#003b70;border-bottom:2px solid #e2e8f0;padding-bottom:6px;margin-top:20px">핵심판단</h2>
  <p style="font-size:14px;color:#334155">{escape(briefing.get("executive_judgment", ""))}</p>
  {stance_html}

  {sections_html}

  <p style="margin:28px 0 8px">
    <a href="{escape(report_url)}" style="background:#0067ac;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:700">웹에서 전체 브리핑 및 CRO STAFF Q&A 열기</a>
  </p>
  <p style="font-size:12px;color:#64748b">사내망에서 위 링크가 열리지 않는 경우, 이 이메일 본문이 전체 브리핑 내용입니다. 웹 버전은 외부망 접속 가능 환경에서만 사용해 주세요.</p>
</div>
"""

context = ssl.create_default_context()
with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context, timeout=30) as smtp:
    smtp.login(gmail_user, gmail_password)
    for recipient in recipients:
        message = EmailMessage()
        message["From"] = f"CRO STAFF <{gmail_user}>"
        message["To"] = recipient
        message["Subject"] = f"[CRO STAFF] {date} 일일 리스크 브리핑"
        message.set_content(f"{date} CRO STAFF 브리핑: {report_url}")
        message.add_alternative(html_body, subtype="html")
        smtp.send_message(message)
        print(f"Sent briefing email to {recipient}")
        time.sleep(1)
