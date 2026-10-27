// =====================================================================================
// DRY_RUN=1 용 목(mock) 응답. OpenAI 호출 없이 generate-daily-briefing.mjs 의 전체 흐름을 검증한다.
//
// 시나리오 (env DRY_RUN_SCENARIO):
//   default : 후보 51건(공통 30 + 업권 21). 중복·홍보·정치·오래된 기사·날짜 없는 기사·이전 브리핑 재등장·경쟁사 중복·
//             글로벌 상한·critical 판정·작성 모델 404 폴백·금지어 재요청·업권 계열사명 누락 재요청·
//             공통↔업권 같은 사건 중복 제거(우리투자증권 유상증자)·업권 내 critical(○○은행 90, ○○증권 92)을 모두 통과한다.
//   sparse  : 후보 9건(일부는 3일 전). 폴백 사다리(4일 윈도우 → 점수 25)와 shortfall_reason 을 검증한다. 업권은 대부분 비어
//             meta.sector_shortfall 이 채워진다.
//   shortfall: 후보 7건. 점수 임계 25 단계와 meta.shortfall_reason 기록(가짜 기사로 채우지 않음)을 검증한다.
//   outage  : 모든 조사 단계가 빈 응답. createFailureBriefing(fallback_notice) 경로를 검증한다.
//
// 실행 예: BRIEFING_DATE=2026-10-28 DRY_RUN=1 node scripts/generate-daily-briefing.mjs
//   (BRIEFING_DATE 를 기존 briefing.json 날짜보다 하루 뒤로 주면 10/27 브리핑이 '전일'로 비교된다.)
// =====================================================================================

const SCENARIO = process.env.DRY_RUN_SCENARIO || 'default';

function shift(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}

// 후보 테이블. age = 실행일 기준 며칠 전. age=null 이면 조사 단계가 날짜를 못 찾은 것(날짜 검증에서 보강).
// s = 채점 결과(모델이 돌려줄 값).
function buildFixture(date) {
  const D = (age, time) => (age === null ? '' : `${shift(date, -age)}${time ? ` ${time}` : ''}`);
  const rows = [
    // ── korean_media ──
    { stage: 'korean_media', url: 'https://n.news.naver.com/mnews/article/001/0015600001', title: '은행 연체율 10년래 최고…중소기업 대출 부실 확산', age: 1, time: '09:12',
      s: { axis: 'market', sector: 'bank', shook: '우리은행 중소기업 대출 연체율과 3분기 대손비용률에 닿습니다.', score: 70, entity: '국내 은행권', event_key: '은행|연체율 10년래 최고', fact: '금융감독원 집계 기준 9월 말 국내 은행 원화대출 연체율은 0.62%로 2015년 이후 가장 높았습니다.', hook: '우리은행 중소기업 대출 포트폴리오의 연체율과 충당금 적립률에 직접 닿는 지표입니다.', severity: true } },
    { stage: 'korean_media', url: 'https://www.hankyung.com/article/2026102770011', title: '은행권 연체율 0.62% 10년 만에 최고…금감원 "중기대출 부실 경계"', age: 0, time: '07:40',
      s: { axis: 'market', sector: 'bank', shook: '우리은행 중소기업 대출 연체율과 충당금 적립률, 신용비용 가이던스에 닿습니다.', score: 72, entity: '국내 은행권', event_key: '은행|연체율 10년래 최고', fact: '금융감독원은 9월 말 은행 연체율이 0.62%로 전월 대비 0.05%포인트 올랐다고 밝혔습니다.', hook: '우리은행 중소기업 대출 연체율과 3분기 대손비용률이 같은 방향으로 움직이는지가 관건입니다.', severity: true } },
    { stage: 'korean_media', url: 'https://n.news.naver.com/mnews/article/018/0006200003', title: '원·달러 환율 1,450원 돌파…외환당국 구두개입', age: 0, time: '15:30',
      s: { axis: 'market', score: 75, entity: '원·달러 환율', event_key: '환율|1450원 돌파', fact: '원·달러 환율은 장중 1,452원까지 올라 전일 대비 1.1% 상승했고 외환당국은 구두개입에 나섰습니다.', hook: '우리은행 외화 유동성비율과 외화 RWA, 해외법인 자본의 원화 환산 손익에 닿습니다.', severity: true } },
    { stage: 'korean_media', url: 'https://www.sedaily.com/NewsView/2GZ1234ABC', title: '저축은행 PF 정리 지연…2차 경·공매 성과 미흡', age: 1, time: '',
      s: { axis: 'market', sector: 'card_capital', shook: '우리금융저축은행의 PF 경·공매 대상 잔액과 매각 진행률, 충당금 커버리지에 닿습니다.', score: 60, entity: '저축은행 부동산 PF', event_key: '저축은행|PF 경공매 지연', fact: '저축은행중앙회에 따르면 2차 PF 경·공매 대상 1조2천억원 중 실제 매각은 3,100억원에 그쳤습니다.', hook: '우리금융저축은행과 우리금융캐피탈의 PF 익스포저 회수율과 충당금 커버리지에 연결됩니다.', severity: false } },
    { stage: 'korean_media', url: 'https://www.mk.co.kr/news/economy/12190005', title: '10월 가계대출 증가폭 다시 확대…주담대 4조원 늘어', age: 2, time: '11:05',
      s: { axis: 'market', score: 55, entity: '가계대출', event_key: '가계대출|10월 증가폭 확대', fact: '금융당국 속보치 기준 10월 1~24일 5대 은행 주택담보대출은 4조원 증가했습니다.', hook: '우리은행 가계대출 총량 관리 목표와 월별 한도 소진 속도에 닿습니다.', severity: false } },
    { stage: 'korean_media', url: 'https://www.edaily.co.kr/news/read?newsId=01234567890006', title: '[사설] 금융규제 완화, 속도보다 방향이 중요하다', age: 0, time: '05:00',
      s: { axis: 'none', score: 0, entity: '', event_key: '사설|금융규제', fact: '', hook: '', political: true } },
    { stage: 'korean_media', url: 'https://www.fnnews.com/news/202610200000007', title: '지난주 코스피 외국인 순매도 전환', age: 5, time: '',
      s: { axis: 'market', sector: 'securities_am', shook: '우리투자증권 위탁매매 수익과 시장 리스크 한도에 닿습니다.', score: 45, entity: '코스피', event_key: '코스피|외국인 순매도', fact: '외국인은 지난주 코스피에서 1조원을 순매도했습니다.', hook: '우리투자증권 위탁매매 수익과 시장 리스크 한도에 닿습니다.', severity: false } },
    { stage: 'korean_media', url: 'https://www.asiae.co.kr/article/2026102700000008', title: '카드론 금리 15% 육박…취약차주 부담 가중', age: null, time: '', verifiedAge: 1,
      s: { axis: 'market', sector: 'card_capital', shook: '우리카드 카드론 잔액과 취약차주 비중에 닿습니다.', score: 52, entity: '카드론', event_key: '카드론|금리 15%', fact: '여신금융협회 공시 기준 9월 카드론 평균금리는 14.8%로 전월 대비 0.3%포인트 올랐습니다.', hook: '우리카드 카드론 잔액과 다중채무자 비중, 연체율 추이에 닿습니다.', severity: false } },
    // ── woori_media ──
    { stage: 'woori_media', url: 'https://n.news.naver.com/mnews/article/008/0005300009', title: '우리금융, 3분기 순익 1조492억…누적 2조7천억 역대 최대', age: 2, time: '16:00',
      s: { axis: 'group', score: 78, entity: '우리금융지주', event_key: '우리금융|3Q실적', fact: '우리금융지주는 3분기 지배지분 순이익 1조492억원, 누적 2조7,000억원을 기록했다고 공시했습니다.', hook: '그룹 CET1 비율과 대손비용률, 비이자이익 변동성이 자본정책 설명력에 직접 닿습니다.', severity: false } },
    { stage: 'woori_media', url: 'https://www.mt.co.kr/stock/2026/10/27/2026102710000010', title: '베트남우리은행, 부실채권비율 2.1%로 상승…현지 부동산 익스포저 점검', age: 1, time: '10:20',
      s: { axis: 'group', sector: 'bank', shook: '우리은행 해외점포 자산건전성 지표와 베트남 법인 부동산 담보 재평가 주기에 닿습니다.', score: 82, entity: '베트남우리은행', event_key: '베트남우리은행|NPL 2.1%', fact: '베트남우리은행의 3분기 말 부실채권비율은 2.1%로 전분기 1.6%에서 0.5%포인트 상승했습니다.', hook: '우리은행 해외법인 자산건전성과 그룹 해외 익스포저 한도, 현지 부동산 담보 평가에 닿습니다.', severity: true } },
    { stage: 'woori_media', url: 'https://www.news1.kr/finance/bank/5900000011', title: '우리카드 3분기 연체율 1.9%…전분기比 0.2%p 상승', age: 0, time: '09:00',
      s: { axis: 'group', sector: 'card_capital', shook: '우리카드 연체율 상승 구간과 대손충당금 적립률, 카드론·리볼빙 잔액 관리 목표에 닿습니다.', score: 74, entity: '우리카드', event_key: '우리카드|3Q 연체율 1.9%', fact: '우리카드의 3분기 말 연체율은 1.9%로 전분기 대비 0.2%포인트 올랐습니다.', hook: '우리카드 대손충당금 적립률과 카드론·리볼빙 잔액 관리 목표에 닿습니다.', severity: false } },
    { stage: 'woori_media', url: 'https://www.etoday.co.kr/news/view/2640012', title: '우리은행, 반려동물 특화 체크카드 출시', age: 0, time: '10:00',
      s: { axis: 'none', score: 0, entity: '우리은행', event_key: '우리은행|체크카드 출시', fact: '', hook: '', promo: true } },
    { stage: 'woori_media', url: 'https://biz.chosun.com/stock/finance/2026/10/27/ABCDEF13', title: '동양생명 K-ICS 비율 180%대 유지…금리 하락 땐 하방 압력', age: 1, time: '14:15',
      s: { axis: 'group', sector: 'insurance', shook: '동양생명 K-ICS 비율 버퍼와 금리 10bp 하락 시 자본 영향에 닿습니다.', score: 70, entity: '동양생명', event_key: '동양생명|K-ICS 180%', fact: '동양생명의 3분기 말 K-ICS 비율은 182%로 전분기 대비 4%포인트 하락했습니다.', hook: '동양생명·ABL생명 편입 이후 그룹 보험 자본비율과 금리 민감도 관리에 닿습니다.', severity: false } },
    { stage: 'woori_media', url: 'https://www.infomax.co.kr/news/articleView.html?idxno=4400014', title: '우리금융지주, 자기자본이익률 전망치 하향…목표가 하향 조정-키움증권', age: 0, time: '08:30',
      s: { axis: 'group', score: 66, entity: '우리금융지주', event_key: '우리금융|ROE 전망 하향', fact: '키움증권은 우리금융지주의 ROE 전망치를 하향하고 목표주가를 낮춘다고 분석했습니다.', hook: '그룹 자본효율성과 주주환원 커뮤니케이션에 닿습니다.', repeat: true } },
    // ── peer_media ──
    { stage: 'peer_media', url: 'https://www.heraldcorp.com/article/10920015', title: '하나금융, 3분기 누적 순익 3.6조 역대 최대…4분기 NIM 회복 기대', age: 1, time: '',
      s: { axis: 'peer', score: 38, entity: '하나금융', event_key: '하나금융|3Q실적', fact: '하나금융은 3분기 누적 순이익 3조6,000억원을 기록했습니다.', hook: '경쟁 지주의 NIM 회복 전망이 우리은행 조달 경쟁에 닿습니다.', repeat: true } },
    { stage: 'peer_media', url: 'https://n.news.naver.com/mnews/article/015/0005100016', title: 'KB국민은행 지점서 120억원 횡령 사고…금감원 현장검사 착수', age: 0, time: '11:50',
      s: { axis: 'peer', score: 85, entity: 'KB국민은행', event_key: 'KB국민은행|120억 횡령', fact: 'KB국민은행 지점 직원이 약 120억원을 횡령한 사고가 확인돼 금융감독원이 현장검사에 착수했습니다.', hook: '우리은행 영업점 내부통제 점검 주기와 자금 이체 승인 체계, 운영리스크 손실 데이터에 닿습니다.', severity: true } },
    { stage: 'peer_media', url: 'https://www.yna.co.kr/view/AKR20261027000000017', title: '신한은행, 불완전판매로 기관경고…과태료 32억원', age: 1, time: '17:00',
      s: { axis: 'peer', sector: 'bank', shook: '우리은행 비예금상품 판매 프로세스와 불완전판매 자체 점검 결과에 닿습니다.', score: 80, entity: '신한은행', event_key: '신한은행|기관경고 과태료 32억', fact: '금융감독원은 신한은행에 불완전판매 관련 기관경고와 과태료 32억원을 부과했습니다.', hook: '우리은행 비예금상품 판매 프로세스와 소비자보호 준법 리스크에 닿습니다.', severity: true } },
    { stage: 'peer_media', url: 'https://www.news1.kr/finance/card/5900000018', title: '신한카드 3분기 연체율 1.7%…업계 평균 상회', age: 0, time: '09:10',
      s: { axis: 'peer', sector: 'card_capital', shook: '우리카드 연체율과 신한카드 연체율의 격차에 닿습니다.', score: 55, entity: '신한카드', event_key: '신한카드|3Q 연체율', fact: '신한카드의 3분기 연체율은 1.7%였습니다.', hook: '우리카드 연체율 벤치마크에 닿습니다.', severity: false } },
    { stage: 'peer_media', url: 'https://biz.heraldcorp.com/article/10920019', title: 'IBK기업은행, 3분기 순익 소폭 감소…"중기대출 충당금 보수적 적립"', age: 1, time: '',
      s: { axis: 'peer', sector: 'bank', shook: '우리은행 중기대출 충당금 정책 비교에 닿습니다.', score: 30, entity: 'IBK기업은행', event_key: 'IBK기업은행|3Q실적', fact: 'IBK기업은행의 3분기 순이익은 전년 대비 2% 감소했습니다.', hook: '중기대출 충당금 정책 비교에 닿습니다.', severity: false } },
    { stage: 'peer_media', url: 'https://www.mk.co.kr/news/economy/12190020', title: 'BNK금융 3분기 순익 28% 급감…비이자이익 부진', age: 1, time: '',
      s: { axis: 'peer', score: 60, entity: 'BNK금융', event_key: 'BNK금융|3Q 순익 급감', fact: 'BNK금융의 3분기 순이익은 전년 대비 28% 감소했습니다.', hook: '지방은행 신용비용 압력이 우리은행 지역 포트폴리오에 닿습니다.', severity: false } },
    // ── global_media ──
    { stage: 'global_media', url: 'https://www.reuters.com/markets/us/fed-holds-rates-2026-10-27/', title: 'Fed holds rates steady, signals cautious path as inflation stays sticky', age: 0, time: '04:30',
      s: { axis: 'overseas', score: 65, entity: '미 연준', event_key: '연준|금리 동결', fact: '미 연준은 기준금리를 4.25~4.50%로 동결하고 추가 인하에 신중하겠다고 밝혔습니다.', hook: '우리은행 외화 조달금리와 달러 RWA, 우리아메리카은행 NIM에 닿습니다.', severity: false } },
    { stage: 'global_media', url: 'https://www.bloomberg.com/news/articles/2026-10-27/vietnam-central-bank-tightens-property-lending', title: 'Vietnam Central Bank Tightens Property Lending Rules for Banks', age: 1, time: '',
      s: { axis: 'overseas', score: 60, entity: '베트남 중앙은행', event_key: '베트남중앙은행|부동산 대출 규제', fact: '베트남 중앙은행은 은행의 부동산 대출 위험가중치를 상향하는 규정을 발표했습니다.', hook: '베트남우리은행 부동산 익스포저와 현지 자본비율에 닿습니다.', severity: false } },
    { stage: 'global_media', url: 'https://apnews.com/article/0ca3059bb35a0f70e15eb0ccb9c2aaaa', title: 'In his own words: Trump on gas prices and energy costs since taking office', age: 0, time: '',
      s: { axis: 'none', score: 0, entity: '', event_key: '트럼프|유가 발언', fact: '', hook: '', political: true } },
    { stage: 'global_media', url: 'https://www.ft.com/content/regional-bank-cre-loss-2026', title: 'US regional bank books $400mn commercial property loss', age: 1, time: '',
      s: { axis: 'overseas', score: 58, entity: '미 지역은행', event_key: '미지역은행|CRE 손실 4억달러', fact: '미국 지역은행 한 곳이 상업용 부동산 대출에서 4억달러 손실을 인식했습니다.', hook: '우리아메리카은행 상업용 부동산 대출 비중과 담보 재평가 주기에 닿습니다.', severity: true } },
    { stage: 'global_media', url: 'https://www.reuters.com/markets/asia/indonesia-rupiah-slides-2026-10-26/', title: 'Indonesia rupiah slides to 7-month low as outflows accelerate', age: 2, time: '',
      s: { axis: 'overseas', score: 50, entity: '인도네시아 루피아', event_key: '루피아|7개월 최저', fact: '인도네시아 루피아는 외국인 자금 유출로 7개월 만의 최저치로 하락했습니다.', hook: '우리소다라은행 외화 조달과 현지 자본의 원화 환산에 닿습니다.', severity: false } },
    { stage: 'global_media', url: 'https://www.reuters.com/markets/currencies/korea-fx-intervention-2026-10-27/', title: 'South Korea warns of FX intervention as won hits 1,450 per dollar', age: 0, time: '',
      s: { axis: 'market', score: 62, entity: '원·달러 환율', event_key: '환율|1450원 돌파', fact: '한국 외환당국은 원화가 달러당 1,450원을 넘자 시장 안정 조치를 경고했습니다.', hook: '우리은행 외화 유동성비율에 닿습니다.', severity: true } },
    // ── official ──
    { stage: 'official', url: 'https://www.fss.or.kr/fss/bbs/B0000188/view.do?nttId=200027', title: '○○은행에 대한 검사결과 제재 공개(기관경고, 과태료 45억원)', age: 1, time: '',
      s: { axis: 'supervision', sector: 'bank', shook: '우리은행 내부통제 기준 준수 여부와 동일 유형 위반 가능성, 준법감시 점검 항목에 닿습니다.', score: 90, entity: '금융감독원', event_key: '금감원|○○은행 기관경고 45억', fact: '금융감독원은 ○○은행에 내부통제 미흡을 이유로 기관경고와 과태료 45억원을 부과했다고 공개했습니다.', hook: '우리은행 내부통제 기준 준수 여부와 동일 유형 위반 가능성, 준법감시 점검 항목에 닿습니다.', severity: true } },
    { stage: 'official', url: 'https://www.fsc.go.kr/no010101/86028', title: '은행업감독규정 개정안 규정변경예고(스트레스 완충자본 산정 기준 변경)', age: 0, time: '',
      s: { axis: 'supervision', score: 84, entity: '금융위원회', event_key: '금융위|스트레스완충자본 규정변경예고', fact: '금융위원회는 스트레스 완충자본 산정 기준을 바꾸는 은행업감독규정 개정안을 규정변경예고했습니다.', hook: '우리은행·우리금융지주 CET1 요구 수준과 배당 가능 자본 산정에 닿습니다.', severity: false } },
    { stage: 'official', url: 'https://www.bok.or.kr/portal/bbs/B0000245/view.do?nttId=10090029', title: '통화안정증권 경쟁입찰 결과(10월 27일)', age: 0, time: '',
      s: { axis: 'none', score: 0, entity: '한국은행', event_key: '한은|통안증권 입찰', fact: '', hook: '', promo: true } },
    { stage: 'official', url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20261027000030', title: '우리금융지주 수시공시 - 자회사 유상증자 참여 결정(우리투자증권 3,000억원)', age: 1, time: '',
      s: { axis: 'group', score: 75, entity: '우리금융지주', event_key: '우리금융|우리투자증권 유상증자 3000억', fact: '우리금융지주는 우리투자증권 유상증자에 3,000억원을 출자하기로 결정했다고 공시했습니다.', hook: '그룹 이중레버리지비율과 지주 자본적정성, 증권 자회사 리스크 익스포저 한도에 닿습니다.', severity: false } },
    // ── sector_nonbank_lending (여전·저축은행) ── 31~
    { stage: 'sector_nonbank_lending', url: 'https://www.news1.kr/finance/card/5900000031', title: '카드사 리볼빙 잔액 7.8조 사상 최대…우리카드 비중 확대', age: 0, time: '08:20',
      s: { axis: 'market', sector: 'card_capital', score: 68, entity: '카드업권', event_key: '카드사|리볼빙 7.8조', fact: '여신금융협회 공시 기준 9월 말 카드사 리볼빙 잔액은 7조8,000억원으로 사상 최대였습니다.', hook: '우리카드 리볼빙 잔액 증가 속도와 다중채무자 비중이 그룹 소매신용 리스크에 닿습니다.', shook: '우리카드 리볼빙 잔액 증가율과 리볼빙 이용자의 다중채무 비중, 월별 연체 전이율에 닿습니다.', severity: false } },
    { stage: 'sector_nonbank_lending', url: 'https://www.edaily.co.kr/news/read?newsId=01234567890032', title: '여전채 AA- 스프레드 다시 확대…캐피탈사 조달비용 상승', age: 1, time: '',
      s: { axis: 'market', sector: 'card_capital', score: 62, entity: '여전채 시장', event_key: '여전채|스프레드 확대', fact: '여전채 AA- 3년물 스프레드는 국고채 대비 85bp로 한 달 새 12bp 확대됐습니다.', hook: '우리금융캐피탈·우리카드의 조달금리와 마진에 닿습니다.', shook: '우리금융캐피탈의 4분기 만기 도래 여전채 차환 금리와 우리카드 조달비용 가정에 닿습니다.', severity: false } },
    { stage: 'sector_nonbank_lending', url: 'https://www.asiae.co.kr/article/2026102700000008', title: '카드론 금리 15% 육박…취약차주 부담 가중', age: 1, time: '',
      s: { axis: 'market', sector: 'card_capital', score: 52, entity: '카드론', event_key: '카드론|금리 15%', fact: '여신금융협회 공시 기준 9월 카드론 평균금리는 14.8%로 전월 대비 0.3%포인트 올랐습니다.', hook: '우리카드 카드론 잔액과 다중채무자 비중, 연체율 추이에 닿습니다.', shook: '우리카드 카드론 잔액과 취약차주 비중에 닿습니다.', severity: false } },
    { stage: 'sector_nonbank_lending', url: 'https://www.mk.co.kr/news/economy/12190033', title: '현대캐피탈, 신차 할부 금리 인하 이벤트 실시', age: 0, time: '',
      s: { axis: 'none', sector: 'card_capital', score: 0, entity: '현대캐피탈', event_key: '현대캐피탈|할부 이벤트', fact: '', hook: '', shook: '', promo: true } },
    { stage: 'sector_nonbank_lending', url: 'https://www.fnnews.com/news/202610270000034', title: '금감원, ○○캐피탈 PF 대출 한도 위반에 기관경고…과태료 12억', age: 1, time: '10:30',
      s: { axis: 'supervision', sector: 'card_capital', score: 78, entity: '금융감독원', event_key: '금감원|○○캐피탈 기관경고 PF', fact: '금융감독원은 ○○캐피탈의 부동산 PF 대출 한도 위반에 기관경고와 과태료 12억원을 부과했습니다.', hook: '우리금융캐피탈 PF 대출 한도 준수 여부와 동일 유형 위반 가능성에 닿습니다.', shook: '우리금융캐피탈의 PF 대출 총량 한도 준수 현황과 자체 점검 결과에 닿습니다.', severity: true } },
    { stage: 'sector_nonbank_lending', url: 'https://www.sedaily.com/NewsView/2GZ1234ABC', title: '저축은행 PF 정리 지연…2차 경·공매 성과 미흡', age: 1, time: '',
      s: { axis: 'market', sector: 'card_capital', score: 60, entity: '저축은행 부동산 PF', event_key: '저축은행|PF 경공매 지연', fact: '저축은행중앙회에 따르면 2차 PF 경·공매 대상 1조2천억원 중 실제 매각은 3,100억원에 그쳤습니다.', hook: '우리금융저축은행과 우리금융캐피탈의 PF 익스포저 회수율과 충당금 커버리지에 연결됩니다.', shook: '우리금융저축은행의 PF 경·공매 대상 잔액과 매각 진행률, 충당금 커버리지에 닿습니다.', severity: false } },
    { stage: 'sector_nonbank_lending', url: 'https://n.news.naver.com/mnews/article/011/0004500035', title: '저축은행 연체율 9%대 진입…79개사 중 12곳 BIS 비율 권고치 하회', age: 0, time: '09:30',
      s: { axis: 'market', sector: 'card_capital', score: 74, entity: '저축은행 업권', event_key: '저축은행|연체율 9%대', fact: '금융감독원 집계 기준 9월 말 저축은행 연체율은 9.1%였고 12개사의 BIS 비율이 권고치를 밑돌았습니다.', hook: '우리금융저축은행 연체율·BIS 비율과 업권 구조조정 전이 위험에 닿습니다.', shook: '우리금융저축은행의 연체율 추이와 BIS 비율 버퍼, 권고치 하회 저축은행과의 거래 익스포저에 닿습니다.', severity: true } },
    { stage: 'sector_nonbank_lending', url: 'https://www.hankyung.com/article/2026102770036', title: '○○저축은행, 금감원 적기시정조치 유예 종료…경영개선명령 가능성', age: 3, time: '',
      s: { axis: 'supervision', sector: 'card_capital', score: 72, entity: '금융감독원', event_key: '금감원|○○저축은행 적기시정조치', fact: '금융감독원은 ○○저축은행의 적기시정조치 유예가 종료돼 경영개선명령 부과를 검토한다고 밝혔습니다.', hook: '저축은행 업권 신뢰 저하가 우리금융저축은행 예금 이탈 위험에 닿습니다.', shook: '우리금융저축은행의 예금 잔액 일별 변동과 예금자보호 한도 초과 예금 비중에 닿습니다.', severity: true } },
    { stage: 'sector_nonbank_lending', url: 'https://www.etoday.co.kr/news/view/2640037', title: '저축은행 연체율 9% 돌파…부동산 PF 부실이 주범', age: 0, time: '11:00',
      s: { axis: 'market', sector: 'card_capital', score: 66, entity: '저축은행 업권', event_key: '저축은행|연체율 9%대', fact: '저축은행 연체율은 9월 말 9.1%로 전분기 대비 0.6%포인트 상승했습니다.', hook: '우리금융저축은행 연체율 벤치마크에 닿습니다.', shook: '우리금융저축은행 연체율과 업권 평균의 격차에 닿습니다.', severity: true } },
    // ── sector_insurance (보험) ── 40~
    { stage: 'sector_insurance', url: 'https://n.news.naver.com/mnews/article/009/0005400040', title: '생보사 K-ICS 비율 하락세…금리 하락에 경과조치 종료 부담', age: 0, time: '08:00',
      s: { axis: 'market', sector: 'insurance', score: 70, entity: '생명보험 업권', event_key: '생보사|K-ICS 하락', fact: '금융감독원 집계 기준 6월 말 생보사 평균 K-ICS 비율은 198%로 전분기 대비 6%포인트 하락했습니다.', hook: '동양생명·ABL생명 K-ICS 비율과 그룹 보험 자본 보강 수요에 닿습니다.', shook: '동양생명·ABL생명의 K-ICS 비율 금리 민감도와 경과조치 종료 시 자본 영향 추정치에 닿습니다.', severity: false } },
    { stage: 'sector_insurance', url: 'https://biz.chosun.com/stock/finance/2026/10/27/ABCDEF13', title: '동양생명 K-ICS 비율 180%대 유지…금리 하락 땐 하방 압력', age: 1, time: '14:15',
      s: { axis: 'group', sector: 'insurance', score: 70, entity: '동양생명', event_key: '동양생명|K-ICS 180%', fact: '동양생명의 3분기 말 K-ICS 비율은 182%로 전분기 대비 4%포인트 하락했습니다.', hook: '동양생명·ABL생명 편입 이후 그룹 보험 자본비율과 금리 민감도 관리에 닿습니다.', shook: '동양생명 K-ICS 비율 버퍼와 금리 10bp 하락 시 자본 영향에 닿습니다.', severity: false } },
    { stage: 'sector_insurance', url: 'https://www.yna.co.kr/view/AKR20261027000000041', title: '금감원, ○○생명에 기관경고…보험금 지급 지연·계리가정 부적정', age: 1, time: '16:00',
      s: { axis: 'supervision', sector: 'insurance', score: 80, entity: '금융감독원', event_key: '금감원|○○생명 기관경고', fact: '금융감독원은 ○○생명의 보험금 지급 지연과 계리가정 부적정 운영에 기관경고를 부과했습니다.', hook: 'ABL생명·동양생명의 계리가정 적정성과 보험금 지급 절차 준법 리스크에 닿습니다.', shook: 'ABL생명·동양생명의 해지율·손해율 계리가정이 금감원 가이드라인과 일치하는지, 보험금 지급 지연 건수 추이에 닿습니다.', severity: true } },
    { stage: 'sector_insurance', url: 'https://www.mt.co.kr/insurance/2026/10/27/2026102710000042', title: '해외 부동산 펀드 손실 확산…생보사 대체투자 평가손 1조원 넘어', age: 2, time: '',
      s: { axis: 'market', sector: 'insurance', score: 64, entity: '생명보험 업권', event_key: '생보사|대체투자 평가손 1조', fact: '생보사가 투자한 해외 부동산 펀드 평가손실이 누적 1조원을 넘었다고 집계됐습니다.', hook: 'ABL생명·동양생명 대체투자 포트폴리오의 평가손과 자산운용 리스크에 닿습니다.', shook: 'ABL생명·동양생명의 해외 부동산 대체투자 잔액과 만기 도래 펀드의 평가손 반영 시점에 닿습니다.', severity: false } },
    { stage: 'sector_insurance', url: 'https://www.heraldcorp.com/article/10920043', title: '한화생명, 보장성 신상품 출시…건강보험 라인업 강화', age: 0, time: '',
      s: { axis: 'none', sector: 'insurance', score: 0, entity: '한화생명', event_key: '한화생명|신상품 출시', fact: '', hook: '', shook: '', promo: true } },
    { stage: 'sector_insurance', url: 'https://www.edaily.co.kr/news/read?newsId=01234567890044', title: '[인터뷰] 생보협회장 "IFRS17 안정화에 업계 역량 집중"', age: 0, time: '',
      s: { axis: 'none', sector: 'insurance', score: 0, entity: '생명보험협회', event_key: '생보협회장|인터뷰', fact: '', hook: '', shook: '', political: true } },
    // ── sector_securities (증권·운용) ── 46~
    { stage: 'sector_securities', url: 'https://n.news.naver.com/mnews/article/014/0005500046', title: '증권사 PF 채무보증 잔액 19조…중소형사 NCR 하락', age: 0, time: '09:40',
      s: { axis: 'market', sector: 'securities_am', score: 66, entity: '증권 업권', event_key: '증권사|PF 채무보증 19조', fact: '금융투자협회 집계 기준 9월 말 증권사 PF 채무보증 잔액은 19조원이었고 중소형사 NCR은 평균 30%포인트 하락했습니다.', hook: '우리투자증권 PF 채무보증 한도와 NCR 버퍼에 닿습니다.', shook: '우리투자증권의 PF 채무보증 잔액과 NCR 버퍼, 유상증자 이후 자본 여력에 닿습니다.', severity: false } },
    { stage: 'sector_securities', url: 'https://www.sedaily.com/NewsView/2GZ1234XYZ47', title: '홍콩H지수 급락에 ELS 손실 구간 재진입…증권사 헤지 손실 우려', age: 1, time: '',
      s: { axis: 'market', sector: 'securities_am', score: 62, entity: 'ELS 시장', event_key: 'ELS|H지수 손실구간', fact: '홍콩H지수가 하루 4% 급락해 일부 ELS가 손실 구간에 재진입했고 증권사 헤지 손실이 거론됩니다.', hook: '우리투자증권 파생결합증권 발행 잔액과 헤지 운용 리스크에 닿습니다.', shook: '우리투자증권의 ELS 발행 잔액과 자체 헤지 비중, 헤지 손익 한도 사용률에 닿습니다.', severity: true } },
    { stage: 'sector_securities', url: 'https://www.yna.co.kr/view/AKR20261027000000048', title: '금감원, ○○증권 랩·신탁 돌려막기 제재…일부 영업정지 3개월', age: 1, time: '15:00',
      s: { axis: 'supervision', sector: 'securities_am', score: 92, entity: '금융감독원', event_key: '금감원|○○증권 랩신탁 영업정지', fact: '금융감독원은 ○○증권의 랩·신탁 돌려막기에 일부 영업정지 3개월과 과태료를 부과했습니다.', hook: '우리투자증권·우리자산운용의 랩·신탁 운용 내부통제와 동일 유형 위반 가능성에 닿습니다.', shook: '우리투자증권 랩·신탁 계좌 간 거래 통제와 우리자산운용의 펀드 간 자전거래 점검 체계에 닿습니다.', severity: true } },
    { stage: 'sector_securities', url: 'https://www.mk.co.kr/news/stock/12190049', title: '○○자산운용 부동산 펀드 환매 연기…투자자 2천억 묶여', age: 0, time: '10:10',
      s: { axis: 'market', sector: 'securities_am', score: 70, entity: '○○자산운용', event_key: '○○자산운용|펀드 환매 연기', fact: '○○자산운용의 부동산 펀드 2,000억원이 환매 연기돼 투자자 자금이 묶였습니다.', hook: '우리자산운용 부동산 펀드 유동성과 판매사인 우리은행·우리투자증권의 소비자보호 리스크에 닿습니다.', shook: '우리자산운용 부동산 펀드의 만기 구조와 유동성 비율, 우리투자증권 판매 잔액에 닿습니다.', severity: true } },
    { stage: 'sector_securities', url: 'https://www.infomax.co.kr/news/articleView.html?idxno=4400050', title: '우리투자증권, 3,000억 유상증자로 NCR 450%대 회복 전망-NICE신평', age: 0, time: '09:00',
      s: { axis: 'group', sector: 'securities_am', score: 72, entity: '우리투자증권', event_key: '우리금융|우리투자증권 유상증자 3000억', fact: 'NICE신용평가는 우리투자증권이 3,000억원 유상증자로 NCR을 450%대로 회복할 것이라고 분석했습니다.', hook: '그룹 증권 자회사 자본적정성에 닿습니다.', shook: '우리투자증권 NCR 전망치와 증자 자금의 PF·IB 익스포저 배분 계획에 닿습니다.', severity: false } },
    { stage: 'sector_securities', url: 'https://www.fnnews.com/news/202610270000051', title: '코스피 외국인 순매도 지속…증권사 신용융자 잔액 20조 육박', age: 1, time: '',
      s: { axis: 'market', sector: 'securities_am', score: 48, entity: '증권 업권', event_key: '증권사|신용융자 20조', fact: '증권사 신용융자 잔액은 19조8,000억원으로 20조원에 근접했습니다.', hook: '우리투자증권 신용공여 한도와 담보 비율에 닿습니다.', shook: '우리투자증권 신용융자 잔액과 반대매매 담보유지비율 하회 계좌 비중에 닿습니다.', severity: false } }
  ];
  rows.forEach((r) => { r.published = D(r.age, r.time); });
  if (SCENARIO === 'sparse') {
    // 적격 후보가 적은 날: 3일 전(age=3) 기사 2건은 4일 윈도우에서만 살아난다. 점수 30짜리는 임계 25에서 살아난다.
    const keep = new Set([2, 3, 8, 9, 15, 16, 20, 26, 29]);
    const sparse = rows.filter((_, i) => keep.has(i));
    sparse[1].age = 3; sparse[1].published = D(3, ''); // 환율 → age 3
    sparse[3].age = 3; sparse[3].published = D(3, ''); // 우리금융 3Q → age 3
    sparse[6].s.score = 30; // IBK → 점수 임계 25에서만 통과
    return sparse;
  }
  if (SCENARIO === 'shortfall') {
    // 8건을 못 채우는 날: 7건만 있고 그중 IBK(점수 30)는 임계 25에서만 살아난다 → 7건 + shortfall_reason 기록.
    const keep = new Set([2, 8, 9, 15, 16, 18, 26]);
    return rows.filter((_, i) => keep.has(i));
  }
  if (SCENARIO === 'outage') return [];
  return rows;
}

let fixture = null;
let writingCalls = 0;

function textResponse(text, model) {
  return { status: 'completed', model, output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 6000, output_tokens: 2500 } };
}

const stageByLabel = {
  'Korean financial media research': 'korean_media',
  'Woori Financial Group media research': 'woori_media',
  'Peer competitor media research': 'peer_media',
  'Global financial media research': 'global_media',
  'Regulator and official source research': 'official',
  'Card/capital and savings bank sector research': 'sector_nonbank_lending',
  'Insurance sector research': 'sector_insurance',
  'Securities and asset management sector research': 'sector_securities'
};

export async function mockResponse(label, requestBody, { date }) {
  fixture ||= buildFixture(date);
  const model = requestBody.model;

  if (stageByLabel[label]) {
    if (SCENARIO === 'outage') return textResponse('', model);
    const rows = fixture.filter((r) => r.stage === stageByLabel[label]);
    const memo = rows.map((r, i) => `${i + 1}. ${r.title}\n   매체: ${new URL(r.url).hostname} / 게시: ${r.published || '게시 시각 미확인'} / URL: ${r.url}\n   확인된 사실: ${r.s.fact || '(홍보·칼럼성 기사로 핵심 사실 없음)'}\n   CRO 관점: ${r.s.hook || '-'}`).join('\n');
    const meta = JSON.stringify(rows.map((r) => ({ url: r.url, title: r.title, published: r.published })));
    return textResponse(`${memo}\n\n[[SOURCE_METADATA]]\n${meta}\n[[/SOURCE_METADATA]]`, model);
  }

  if (label === 'Date verification') {
    const lines = fixture.filter((r) => r.age === null && r.verifiedAge !== undefined)
      .map((r, i) => `${i + 1}. ${r.url} | ${shift(date, -r.verifiedAge)}`);
    return textResponse(lines.join('\n'), model);
  }

  if (label === 'CRO scoring') {
    const block = String(requestBody.input).match(/\[\[CANDIDATES\]\]([\s\S]*?)\[\[\/CANDIDATES\]\]/);
    const batch = JSON.parse(block[1].trim());
    const candidates = batch.map((c) => {
      const r = fixture.find((f) => f.url === c.url);
      const s = r?.s || { axis: 'none', score: 10, entity: '', event_key: c.title.slice(0, 20), fact: '', hook: '' };
      return {
        id: c.id, url: c.url, title: c.title, published: c.published, source_type: c.source_type,
        entity: s.entity, event_key: s.event_key, axis: s.axis, sector: s.sector || 'group', score: s.score,
        is_promo: Boolean(s.promo), is_political_or_column: Boolean(s.political), is_repeat_of_previous: Boolean(s.repeat),
        severity_flag: Boolean(s.severity), one_line_fact: s.fact, cro_hook: s.hook, sector_hook: s.sector ? (s.shook || '') : ''
      };
    });
    return textResponse(JSON.stringify({ candidates }), model);
  }

  if (label.startsWith('CRO sector writing')) {
    // 업권 묶음 작성. 첫 묶음의 첫 시도에는 계열사명 누락을 섞어 업권 품질 검사 → 재요청 경로를 검증한다.
    const block = String(requestBody.input).match(/\[\[SECTORS\]\]\s*(\[[\s\S]*\])\s*\[\[\/SECTORS\]\]/);
    const input = JSON.parse(block[1].trim());
    const hasFeedback = /이전 시도의 품질 문제/.test(String(requestBody.input));
    const omitCompany = SCENARIO === 'default' && !hasFeedback && input[0]?.sector === 'bank';
    const sectors = input.map((sec) => {
      const company = sec.companies.join('·');
      const news = sec.news.map((it, idx) => ({
        title: it.title, url: it.url, published: it.published, source_name: it.source_name, source_type: it.source_type,
        // 1차 시도(피드백 없음)는 일부러 의문문·3문장 why 를 내보내 재요청 경로를 검증하고, 2차 시도는 규칙대로 서술문만 낸다.
        summary: `${it.source_name}이(가) ${it.published.slice(0, 10)}에 보도한 바에 따르면 ${it.one_line_fact || it.title + '라는 내용입니다.'} 관련 수치는 ${it.published.slice(0, 10)} 기준입니다.${hasFeedback ? '' : ` 오늘 ${company} 리스크관리부는 관련 익스포저가 내부 한도 안에 있는지 확인할 필요가 있을까요?`}`,
        why_woori_cro: omitCompany && idx === 0
          ? '그룹 리스크 지표에 영향을 줄 수 있는 사안입니다. 관련 지표의 30~90일 변화가 의사결정 포인트입니다.'
          : `그룹 관점에서는 ${it.cro_hook || '그룹 리스크 지표에 영향을 줄 수 있습니다.'} ${company} 관점에서는 ${it.sector_hook || `${sec.label_ko} 업권 익스포저에 닿습니다.`}${hasFeedback ? '' : ` ${company} 리스크관리부는 30~90일 안에 관련 한도·충당금 지표의 변화를 의사결정 포인트로 둡니다.`}`,
        entity: it.entity || '', channel: it.axis === 'group' ? '우리금융그룹 계열사' : it.axis === 'supervision' ? '감독당국·정책' : it.axis === 'peer' ? '경쟁사 동향' : '금융시장',
        risk_type: it.axis === 'supervision' ? '준법·규제' : it.axis === 'group' ? '자본·건전성' : '신용·시장',
        urgency: it.score >= 85 ? '높음' : it.score >= 60 ? '중간' : '낮음', confidence: it.source_type === 'official' ? '높음' : '중간',
        critical: it.critical, window: it.window,
        watchpoints: [`${it.entity || '관련 기관'} 후속 발표 일정`, `${company} 관련 지표 기준값 대비 변화`]
      }));
      const top = [...sec.news].sort((a, b) => b.score - a.score)[0];
      const judgment = top
        ? `오늘 ${sec.label_ko} 업권의 가장 큰 리스크는 ${top.entity || top.title} 관련 사안이며, ${top.sector_hook || top.cro_hook || `${company} 관련 지표에 영향을 줄 수 있습니다.`} ${company} 리스크관리부는 관련 익스포저와 한도 사용률이 내부 기준치 안에 있는지를 오늘의 확인 사항으로 둡니다.`
        : `오늘 ${sec.label_ko} 업권에서 새로 확인된 리스크 사건은 없습니다. ${company} 리스크관리부는 연체율·자본비율 등 상시 지표가 내부 기준치 안에 있는지를 오늘의 확인 사항으로 둡니다.`;
      return { sector: sec.sector, judgment, news };
    });
    return textResponse(JSON.stringify({ sectors }), model);
  }

  if (label === 'CRO writing') {
    writingCalls += 1;
    // 1) 기본 작성 모델(gpt-5.4)이 없는 환경을 흉내 낸다 → OPENAI_MODEL 로 폴백해야 한다.
    if (model === 'gpt-5.4' && SCENARIO === 'default') {
      const error = new Error(`CRO writing failed (404): The model \`gpt-5.4\` does not exist or you do not have access to it.`);
      error.status = 404; error.code = 'model_not_found';
      throw error;
    }
    const block = String(requestBody.input).match(/\[\[SELECTED\]\]\s*(\{[\s\S]*\})\s*\[\[\/SELECTED\]\]/);
    const input = JSON.parse(block[1].trim());
    const hasFeedback = /이전 시도의 품질 문제/.test(String(requestBody.input));
    // 2) 첫 작성 시도에는 금지어를 섞어 품질 검사 → 재요청 경로를 검증한다.
    const injectBanned = SCENARIO === 'default' && !hasFeedback;
    const item = (it, idx) => ({
      title: it.title, url: it.url, published: it.published, source_name: it.source_name, source_type: it.source_type,
      summary: `${it.source_name}이(가) ${it.published.slice(0, 10)}에 보도한 바에 따르면 ${it.one_line_fact || it.title + '라는 내용입니다.'} 관련 수치는 ${it.published.slice(0, 10)} 기준입니다.${injectBanned && idx === 0 ? ' 오늘 CRO는 관련 익스포저가 그룹 한도 안에 있는지 확인할 필요가 있을까요?' : ''}`,
      why_woori_cro: `${it.cro_hook || '우리금융 관련 지표에 영향을 줄 수 있습니다.'} 30~90일 안에 관련 한도와 충당금 수준을 재점검할지가 의사결정 포인트입니다.${injectBanned && idx === 0 ? ' 관련 지표를 점검해야 합니다.' : ''}`,
      entity: it.entity || '', channel: it.axis === 'group' ? '우리금융그룹 계열사' : it.axis === 'supervision' ? '감독당국·정책' : it.axis === 'peer' ? '경쟁사 동향' : it.axis === 'overseas' ? '해외·글로벌' : '금융시장',
      risk_type: it.axis === 'supervision' ? '준법·규제' : it.axis === 'group' ? '자본·건전성' : '신용·시장',
      urgency: it.score >= 85 ? '높음' : it.score >= 60 ? '중간' : '낮음', confidence: it.source_type === 'official' ? '높음' : '중간',
      critical: it.critical, window: it.window,
      watchpoints: [`${it.entity || '관련 기관'} 후속 발표 일정`, `${it.axis === 'group' ? '그룹' : '우리은행'} 관련 지표 기준값 대비 변화`]
    });
    const top = Object.values(input).flat().sort((a, b) => b.score - a.score);
    const draft = {
      executive_judgment: `오늘 가장 큰 리스크는 ${top[0]?.entity || '주요 사안'} 관련 사안입니다. ${top[0]?.cro_hook || '그룹 지표에 영향을 줄 수 있습니다.'} 오늘 주시할 것은 동일 유형 리스크가 우리은행에서도 확인되는지 여부입니다.`,
      executive_judgment_bullets: top.slice(0, 4).map((c) => `${c.one_line_fact || c.title} ${c.cro_hook || '우리금융 지표에 영향을 줄 수 있습니다.'}`),
      critical: (input.critical || []).map(item), daily_news: (input.daily_news || []).map(item),
      subsidiary_news: (input.subsidiary_news || []).map(item), additional_news: (input.additional_news || []).map(item),
      forward_looking_points: top.slice(0, 2).map((c) => ({ title: `${c.entity || c.title} 후속 전개`, horizon: '1~2주', likelihood: '중간', cro_angle: `${c.cro_hook || '관련 지표에 영향을 줄 수 있습니다.'} 후속 발표가 나오면 영향 범위를 다시 평가합니다.`, trigger: `${c.entity || '관련 기관'}의 추가 발표 또는 수치 변화입니다.` })),
      insights: {
        headline: `${top[0]?.entity || '주요 리스크'}를 중심으로 내부통제와 건전성 지표를 함께 봅니다.`,
        bullets: top.slice(0, 3).map((c) => `${c.one_line_fact || c.title} 이 사안은 ${c.cro_hook || '그룹 지표에 닿습니다.'}`),
        action_items: ['리스크관리부는 금일 중 관련 익스포저와 한도 사용률을 집계합니다.', '준법감시실은 이번 주 안에 동일 유형 위반 가능성을 자체 점검 결과로 보고합니다.', '해외사업부는 11월 첫째 주까지 해외법인 자산건전성 수치를 갱신합니다.'],
        stance: `확인된 사실 범위 안에서 보수적으로 대응합니다.${injectBanned ? ' 검증 가능한 기사만 반영했습니다.' : ''}`
      },
      monitoring_points: ['은행 원화대출 연체율 0.6% 이상 지속 여부', '원·달러 환율 1,450원 상회 지속 일수', '베트남우리은행 NPL 비율 2% 초과 여부', '금감원 제재 확정 공시 일정', '그룹 CET1 비율 12% 이상 유지 여부']
    };
    return textResponse(JSON.stringify(draft), model);
  }

  throw new Error(`[DRY_RUN] no mock for label: ${label}`);
}
