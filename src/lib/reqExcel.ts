// 구매청구서 엑셀 읽기(업로드) / 쓰기(다운로드) — 기존 청구서 시트 열 배치를 그대로 따른다
//   B 품명 · C 규격 · D 단위 · E 계약수량 · F 계약단가 · G 실행량 · H 기반입 · I 금회청구 · J 본/비고
//   K 발주수량 · N 단가 · P 금액 · R 거래선 · T 비고
import * as XLSX from 'xlsx';
import type { ReqLine, Requisition } from '../types';
import { nameKey, num, toDateStr } from './normalize';

export interface ParsedReqSheet {
  siteLabel: string;
  siteLabel2?: string; // 오른쪽 위(U2) 현장 표기
  docDate?: string;
  purpose?: string;
  lines: Omit<ReqLine, 'key'>[];
}

const SKIP = ['품명', '위와같이', '계약내역', '합계', '소계'];

export function parseReqSheet(wb: XLSX.WorkBook): ParsedReqSheet {
  const ws = wb.Sheets['청구서'];
  if (!ws) throw new Error('"청구서" 시트가 없습니다.');
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  const s = (r: unknown[], i: number) => {
    const v = r[i];
    if (v == null) return '';
    const t = String(v).trim();
    return t === '"' || t === '0' ? '' : t;
  };
  const siteLabel = s(rows[3] ?? [], 1).replace(/^현장명\s*[:：]\s*/, '').replace(/(\s*현장)+\s*$/, '').trim();
  const siteLabel2 = s(rows[1] ?? [], 20) || undefined;
  const d = (rows[3] ?? [])[14];
  const docDate = toDateStr(d);
  let purpose = '';
  const lines: Omit<ReqLine, 'key'>[] = [];
  rows.forEach((r, idx) => {
    if (idx < 6) return;
    const t = s(r, 19);
    if (t.startsWith('사용 목적') || t.startsWith('사용목적')) {
      purpose = s(rows[idx + 1] ?? [], 19) || purpose;
    }
    const item = s(r, 1);
    if (!item) return;
    const k = nameKey(item);
    if (SKIP.some((x) => k.startsWith(x))) return;
    if (typeof r[2] === 'number' && r[2] > 1000) return; // 아래쪽 분류 요약표(금액 열)
    if (r[1] instanceof Date) return;
    lines.push({
      itemName: item,
      spec: s(r, 2),
      unit: s(r, 3),
      contractQty: num(r[4]),
      contractPrice: num(r[5]),
      execQty: num(r[6]),
      priorQty: num(r[7]),
      priorQtyManual: r[7] == null || r[7] === '' ? undefined : num(r[7]),
      reqQty: num(r[8]),
      note: s(r, 9) || undefined,
      orderQty: num(r[10]) || num(r[8]),
      orderPrice: num(r[13]),
      priceSource: num(r[13]) ? '엑셀' : undefined,
      vendorName: s(r, 17) || undefined,
      remark: s(r, 19) || undefined,
    });
  });
  return { siteLabel, siteLabel2, docDate, purpose: purpose || undefined, lines };
}

/** 원 양식 열 배치로 내려받기 */
export function exportReq(req: Requisition, catName: (id?: string) => string | undefined) {
  const aoa: (string | number | null)[][] = [];
  const blank = () => Array(30).fill(null) as (string | number | null)[];
  const r1 = blank();
  r1[20] = req.siteName;
  aoa.push(blank(), r1);
  const r3 = blank();
  r3[7] = '구  매  청  구  서';
  aoa.push(r3);
  const r4 = blank();
  r4[1] = `현장명 : ${req.siteName}`;
  r4[11] = `결의번호 : 제 ${req.docNo} 호`;
  r4[20] = `청구일 ${req.requestDate}`;
  aoa.push(r4);
  const h1 = blank();
  Object.assign(h1, { 1: '품  명', 2: '규  격', 3: '단위', 4: '계약내역량', 6: '실 행 량', 7: '청 구 및 반 입 수 량', 9: '본 / (비고)', 10: '발   주   결   의 (본사 작성분)', 17: '거래선', 19: '비    고', 24: '실행물량 잔여수량', 25: '기반입+금회청구 수량', 26: '기반입 총금액', 27: '실행잔여 총금액', 28: '희망 납기일', 29: '사용 위치/공정' });
  const h2 = blank();
  Object.assign(h2, { 4: '수량', 5: '단가', 7: '기반입', 8: '금회청구', 10: '발주수량', 13: '단   가', 15: '금   액' });
  aoa.push(h1, h2);
  const p = blank();
  p[19] = '사용 목적';
  aoa.push(p);
  const p2 = blank();
  p2[19] = req.purpose ?? '';
  aoa.push(p2);
  for (const l of req.lines) {
    const r = blank();
    const prior = l.priorQty;
    Object.assign(r, {
      1: l.itemName,
      2: l.spec,
      3: l.unit,
      4: l.contractQty || null,
      5: l.contractPrice || null,
      6: l.execQty || null,
      7: prior || null,
      8: l.reqQty,
      9: l.note ?? null,
      10: l.orderQty || null,
      13: l.orderPrice || null,
      15: l.orderQty * l.orderPrice || null,
      17: l.vendorName ?? null,
      19: [l.remark, catName(l.siteCategoryId) ? `[${catName(l.siteCategoryId)}]` : ''].filter(Boolean).join(' ') || null,
      24: l.execQty ? l.execQty - prior - l.reqQty : null,
      25: prior + l.reqQty,
      26: prior * l.orderPrice || null,
      27: l.execQty ? (l.execQty - prior - l.reqQty) * l.orderPrice : null,
      28: l.dueDate ?? null,
      29: l.location ?? null,
    });
    aoa.push(r);
  }
  const sum = blank();
  sum[1] = '합   계';
  sum[15] = req.totalAmount;
  aoa.push(sum, blank());
  const sign = blank();
  sign[1] = '결재';
  req.steps.forEach((st, i) => (sign[3 + i * 2] = `${st.label}: ${st.userName ?? ''} ${st.result === 'approved' ? '승인' : st.result === 'rejected' ? '반려' : ''}`.trim()));
  aoa.push(sign);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = Array.from({ length: 30 }, (_, i) => ({ wch: [0, 0, 1, 2].includes(i) ? (i === 1 ? 28 : i === 2 ? 16 : 6) : i === 19 ? 30 : 10 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '청구서');
  XLSX.writeFile(wb, `구매청구서_${req.siteName}_${req.docNo || req.requestDate}.xlsx`);
}
