// 경쟁사 기사 선정 편향: 4대금융(KB·신한·하나 + 우리) 위주, 지방금융지주·기타 기사는 후순위.
// 점수(score)에 가감해 선정 순서만 바꾼다. 원점수와 표시용 점수는 건드리지 않는다.
export const BIG4_PEERS = [
  { id: 'KB금융', re: /KB금융|KB국민|국민은행|KB증권|KB손해|KB라이프|KB카드|KB캐피탈|KB자산운용/ },
  { id: '신한금융', re: /신한금융|신한은행|신한카드|신한투자|신한라이프|신한캐피탈|신한EZ|신한자산운용/ },
  { id: '하나금융', re: /하나금융|하나은행|하나카드|하나증권|하나생명|하나캐피탈|하나손해/ }
];
export const REGIONAL_OR_OTHER = /BNK|부산은행|경남은행|iM금융|iM뱅크|DGB|대구은행|JB금융|전북은행|광주은행|제주은행|농협|NH|기업은행|IBK|산업은행|수협|새마을|신협|카카오뱅크|케이뱅크|토스뱅크|SC제일|한국씨티|한국금융지주|한국투자|삼성(카드|생명|화재|증권)|미래에셋|메리츠|한화|현대(카드|해상|캐피탈)|롯데/;

export function big4Of(text) {
  const t = String(text || '');
  const hit = BIG4_PEERS.find((p) => p.re.test(t));
  return hit ? hit.id : '';
}
// 우리 계열사 언급이 있으면 편향을 적용하지 않는다(우리 기사 자체는 항상 우선).
export function peerBias(text, isWoori) {
  if (isWoori) return 0;
  if (big4Of(text)) return 8;
  if (REGIONAL_OR_OTHER.test(String(text || ''))) return -12;
  return 0;
}
