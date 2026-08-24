import json
import os
import smtplib
import ssl
import time
from email.message import EmailMessage
from html import escape
from pathlib import Path


gmail_user = os.environ["GMAIL_USER"].strip()
gmail_password = os.environ["GMAIL_APP_PASSWORD"].replace(" ", "").strip()
recipients = [item.strip() for item in os.environ["EMAIL_TO"].replace(";", ",").split(",") if item.strip()]
report_url = os.environ["REPORT_URL"].strip()

if not recipients:
    raise RuntimeError("EMAIL_TO has no recipients")

briefing = json.loads(Path("public/briefing.json").read_text(encoding="utf-8"))
meta = briefing.get("meta", {})
date = meta.get("briefing_date", "")
headline = briefing.get("insights", {}).get("headline") or briefing.get("executive_judgment", "오늘의 CRO STAFF 브리핑")

items = []
for section in ("critical", "daily_news", "subsidiary_news", "additional_news"):
    for item in briefing.get(section, []):
        items.append(item)

top_items = "".join(
    f'<li style="margin:7px 0"><a href="{escape(item.get("url", ""))}">{escape(item.get("title", ""))}</a></li>'
    for item in items[:10]
)

html_body = f"""
<div style="font-family:Arial,'Apple SD Gothic Neo',sans-serif;line-height:1.6;color:#172033;max-width:680px;margin:auto">
  <p style="font-size:12px;color:#5b6b80;margin-bottom:4px">WOORI FINANCIAL GROUP · DAILY RISK INTELLIGENCE</p>
  <h1 style="font-size:24px;margin:0 0 12px;color:#003b70">CRO STAFF 일일 리스크 브리핑</h1>
  <p style="font-size:14px;color:#334155">{escape(date)} KST</p>
  <p style="font-size:17px;font-weight:700">{escape(headline)}</p>
  <ul style="padding-left:20px">{top_items}</ul>
  <p style="margin:24px 0">
    <a href="{escape(report_url)}" style="background:#0067ac;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:700">전체 브리핑 및 CRO STAFF Q&amp;A 열기</a>
  </p>
  <p style="font-size:12px;color:#64748b">보고서 열람에는 API Key가 필요하지 않습니다. 하단 질문 전송 시에만 AI 사용량이 발생합니다.</p>
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
