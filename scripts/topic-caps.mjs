// 같은 주제(사건군) 기사가 한 판에 몰리지 않도록 하는 상한. 점수순으로 훑으며 상한을 넘는 기사는 제외한다.
// section: 한 섹션(공통 또는 한 업권) 안 최대 건수, total: 브리핑 전체(공통+모든 업권) 최대 건수.
export const TOPICS = [
  { id: 'security-incident', label: '해킹·정보유출 사고', section: 1, total: 3,
    re: /해킹|정보\s?유출|개인정보.{0,6}유출|침해\s?사고|뚫렸|뚫린|사이버\s?(공격|침해)|보안\s?사고|랜섬웨어/ },
  { id: 'woori-group-earnings', label: '우리금융 지주 실적', section: 2, total: 2,
    re: /^(?!.*(저축은행|카드|캐피탈|투자증권|생명|자산운용|에프아이에스)).*우리금융(지주|그룹)?.*(분기|누적|순익|순이익|실적|이익|1조)/ },
  { id: 'fx-level', label: '원·달러 환율 수준', section: 1, total: 2, re: /환율/ },
  { id: 'household-loan', label: '가계대출 증가', section: 1, total: 2, re: /가계대출|주담대|가계부채/ },
  { id: 'base-rate', label: '기준금리·금통위', section: 1, total: 2, re: /기준금리|금통위|금융통화위원회/ }
];

export function topicsOf(text) {
  const t = String(text || '');
  return TOPICS.filter((x) => x.re.test(t)).map((x) => x.id);
}

// accepted: 이번 섹션에서 이미 통과시킨 기사들, taken: 다른 섹션에서 이미 확정된 기사들
export function topicBlock(c, accepted, taken, textOf = (x) => `${x.title} ${x.entity || ''}`) {
  for (const topic of TOPICS) {
    if (!topic.re.test(textOf(c))) continue;
    const inSection = accepted.filter((a) => topic.re.test(textOf(a))).length;
    if (inSection >= topic.section) return `${topic.label} 섹션 상한 ${topic.section}`;
    const inTotal = inSection + taken.filter((a) => topic.re.test(textOf(a))).length;
    if (inTotal >= topic.total) return `${topic.label} 전체 상한 ${topic.total}`;
  }
  return '';
}
