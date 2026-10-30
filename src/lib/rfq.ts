// 견적 의뢰 (RFQ)
//  - 자재부가 품명·규격·단위·수량, 현장·납품 장소를 적어 여러 업체에 보낸다
//  - 업체는 포털에서 단가·제조사·비고를 넣어 제출하거나, 자재부가 업체 견적서(엑셀·직접 입력)를 대신 넣는다
//  - 받은 견적은 전부 ERP 단가표(품목·단가)에 업체별 단가로 반영 → 구매청구서 단가 자동 채우기에 쓰임
//  - 업체는 자기에게 온 의뢰서와 자기 견적만 본다 (다른 업체 견적·내부 정보는 안 보임)
import { where } from 'firebase/firestore';
import { commitBatch, newId, useCollection } from './db';
import { C } from './firebase';
import { itemKey, type PriceEntry } from './itemMaster';

export interface RfqLine {
  key: string;
  itemName: string;
  spec: string;
  unit: string;
  qty: number;
  note?: string;
}
export interface Rfq {
  id: string;
  rfqNo: string; // 견적번호 (Q-YYMMDD-NN)
  title: string;
  siteId?: string; // 현장 (현장명·납품 장소로 업체에 보임)
  siteName?: string;
  deliveryPlace?: string;
  scope: 'common' | 'site'; // 단가표 적용: 공통 단가 / 이 현장 예외 단가
  note?: string; // 업체에 보이는 안내
  lines: RfqLine[];
  vendorIds: string[]; // 보낼 업체 (업체 포털 조회 조건)
  status: 'draft' | 'sent' | 'closed';
  createdAt: number;
  createdByName: string;
  sentAt?: number;
  updatedAt: number;
}
export interface QuoteLine {
  key: string; // RfqLine.key
  price: number; // 단가 (0 = 견적 없음)
  maker?: string;
  note?: string;
}
export interface RfqQuote {
  id: string; // `${rfqId}_${vendorId}`
  rfqId: string;
  vendorId: string;
  vendorName: string;
  lines: QuoteLine[];
  status: 'draft' | 'submitted';
  by: 'vendor' | 'office'; // 업체 포털 제출 / 자재부 대신 입력
  byName?: string;
  note?: string;
  fileName?: string; // 엑셀로 넣은 경우 파일 이름
  submittedAt?: number;
  appliedAt?: number; // ERP 단가표에 반영한 시각
  updatedAt: number;
}
export const quoteId = (rfqId: string, vendorId: string) => `${rfqId}_${vendorId}`;

export function useRfqs() {
  return useCollection<Rfq>(C.rfqs);
}
export function useQuotes(rfqId?: string) {
  return useCollection<RfqQuote>(C.rfqQuotes, rfqId ? [where('rfqId', '==', rfqId)] : [], rfqId ?? 'all');
}
/** 업체 포털: 내게 온 의뢰서 · 내 견적 */
export function useVendorRfqs(vendorId?: string) {
  const rfqs = useCollection<Rfq>(C.rfqs, vendorId ? [where('vendorIds', 'array-contains', vendorId)] : [], vendorId ?? '', !!vendorId);
  const quotes = useCollection<RfqQuote>(C.rfqQuotes, vendorId ? [where('vendorId', '==', vendorId)] : [], vendorId ?? '', !!vendorId);
  return { rfqs, quotes };
}

/** 받은 견적 → ERP 단가표 (업체별, 의뢰서가 현장 단가면 그 현장 예외 단가). 바뀐 단가는 이력으로 */
export async function applyQuotes(rfq: Rfq, quotes: RfqQuote[], list: PriceEntry[], who: string): Promise<{ added: number; changed: number; same: number }> {
  const now = Date.now();
  const siteId = rfq.scope === 'site' ? rfq.siteId : undefined;
  const ops: Parameters<typeof commitBatch>[0] = [];
  let added = 0;
  let changed = 0;
  let same = 0;
  const byKey = new Map(list.map((p) => [`${itemKey(p.itemName, p.spec)}|${p.vendorId}|${p.siteId ?? ''}`, p]));
  for (const q of quotes) {
    if (q.status !== 'submitted') continue;
    for (const ql of q.lines) {
      const l = rfq.lines.find((x) => x.key === ql.key);
      if (!l || !(ql.price > 0)) continue;
      const k = `${itemKey(l.itemName, l.spec)}|${q.vendorId}|${siteId ?? ''}`;
      const ex = byKey.get(k);
      if (ex && ex.price === ql.price && (ex.maker ?? '') === (ql.maker ?? '')) {
        same++;
        continue;
      }
      const data = {
        itemName: l.itemName,
        spec: l.spec,
        unit: l.unit,
        vendorId: q.vendorId,
        vendorName: q.vendorName,
        ...(siteId ? { siteId, siteName: rfq.siteName ?? '' } : {}),
        ...(ql.maker || ex?.maker ? { maker: ql.maker || ex?.maker } : {}),
        listPrice: 0,
        negoRate: 0,
        price: ql.price,
        validFrom: new Date(now + 9 * 3600e3).toISOString().slice(0, 10),
        note: `견적 ${rfq.rfqNo}${ql.note ? ` · ${ql.note}` : ''}`,
        updatedAt: now,
        updatedByName: who,
        history: ex ? (ex.price !== ql.price ? [...(ex.history ?? []), { at: ex.updatedAt, by: ex.updatedByName, price: ex.price, listPrice: ex.listPrice, negoRate: ex.negoRate }] : ex.history ?? []) : [],
      };
      const id = ex?.id ?? newId(C.priceList);
      ops.push({ type: 'set', col: C.priceList, id, data, merge: false });
      byKey.set(k, { ...(data as Omit<PriceEntry, 'id'>), id });
      if (ex) changed++;
      else added++;
    }
    ops.push({ type: 'set', col: C.rfqQuotes, id: q.id, data: { appliedAt: now } });
  }
  if (ops.length) await commitBatch(ops);
  return { added, changed, same };
}

export function nextRfqNo(rfqs: Rfq[]) {
  const d = new Date(Date.now() + 9 * 3600e3).toISOString().slice(2, 10).replace(/-/g, '');
  const n = rfqs.filter((r) => r.rfqNo.startsWith(`Q-${d}`)).length + 1;
  return `Q-${d}-${String(n).padStart(2, '0')}`;
}
