// 청구서 엑셀 품명·규격 "다른 표기" 기억 (회사 공용)
//  - 엑셀에 적힌 품명·규격(정규화 키) → 기준 품명·규격
//  - 자재부·관리자가 청구서에서 고쳐 저장하면 기억하고, 다음 엑셀 불러오기 때 자동으로 바꾼다
import { collection, onSnapshot } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { commitBatch } from './db';
import { C, db } from './firebase';
import { normItem, normSpec } from './itemNorm';

export interface ReqAlias {
  id: string;
  fromItem: string; // 엑셀에 적혀 있던 그대로
  fromSpec: string;
  toItem: string; // 기준 품명·규격
  toSpec: string;
  byName: string;
  at: number;
}

/** 엑셀 표기 → 기억 키 (띄어쓰기·대소문자·흔한 표기 차이 무시) */
export const aliasKey = (item: string, spec: string) => `${normItem(item)}|${normSpec(spec)}`;
/** Firestore 문서 id로 쓸 수 있게 ('/' 등 제거) */
export const aliasId = (item: string, spec: string) =>
  encodeURIComponent(aliasKey(item, spec)).replace(/%/g, '_').replace(/\./g, '-').slice(0, 700) || '_';

export function useReqAliases() {
  const [list, setList] = useState<ReqAlias[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(
    () =>
      onSnapshot(
        collection(db, C.reqAlias),
        (snap) => {
          setList(snap.docs.map((d) => ({ ...(d.data() as Omit<ReqAlias, 'id'>), id: d.id })));
          setLoading(false);
        },
        () => setLoading(false),
      ),
    [],
  );
  return { list, loading };
}

/** 기억 저장 (자재부·관리자) */
export async function saveReqAliases(items: Omit<ReqAlias, 'id' | 'at'>[]) {
  if (!items.length) return;
  const at = Date.now();
  await commitBatch(items.map((a) => ({ type: 'set' as const, col: C.reqAlias, id: aliasId(a.fromItem, a.fromSpec), data: { ...a, at }, merge: false })));
}

export async function deleteReqAliases(ids: string[]) {
  await commitBatch(ids.map((id) => ({ type: 'delete' as const, col: C.reqAlias, id })));
}
