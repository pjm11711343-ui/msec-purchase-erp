// 관리자 전용 메모: 청구서 줄(= 발주 줄)마다 관리자만 보고 쓰는 메모
//  - 청구서·발주서와 다른 컬렉션에 따로 저장 → 보안 규칙으로 관리자(admin)만 읽고 쓸 수 있다
//  - 같은 줄의 메모는 구매청구서와 발주서 화면에 함께 보인다
import { useAuth } from '../auth/AuthContext';
import { commitBatch, useCollection } from './db';
import { C } from './firebase';

export interface AdminMemo {
  id: string; // `${reqId}_${lineKey}`
  reqId: string;
  lineKey: string;
  text: string;
  itemName?: string;
  spec?: string;
  byName: string;
  at: number;
}
export const memoId = (reqId: string, lineKey: string) => `${reqId}_${lineKey}`.replace(/\//g, '_');

/** 관리자만 구독 (다른 역할은 아무것도 읽지 않음) */
export function useAdminMemos() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const s = useCollection<AdminMemo>(C.adminMemos, [], '', isAdmin);
  return { isAdmin, map: new Map(s.data.map((m) => [m.id, m])) };
}

export async function saveAdminMemo(m: { reqId: string; lineKey: string; text: string; itemName?: string; spec?: string; byName: string }) {
  const id = memoId(m.reqId, m.lineKey);
  const text = m.text.trim();
  await commitBatch([
    text
      ? { type: 'set', col: C.adminMemos, id, data: { reqId: m.reqId, lineKey: m.lineKey, text, itemName: m.itemName ?? '', spec: m.spec ?? '', byName: m.byName, at: Date.now() }, merge: false }
      : { type: 'delete', col: C.adminMemos, id },
  ]);
}
