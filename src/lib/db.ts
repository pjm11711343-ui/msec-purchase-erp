import { useEffect, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type QueryConstraint,
  type DocumentData,
} from 'firebase/firestore';
import { auth, C, db } from './firebase';
import { DEFAULT_SETTINGS, type Settings } from '../types';

/** 컬렉션 실시간 구독. key가 바뀌면 다시 구독한다. enabled=false면 구독하지 않는다. */
export function useCollection<T extends { id: string }>(
  name: string,
  constraints: QueryConstraint[] = [],
  key = '',
  enabled = true,
): { data: T[]; loading: boolean; error?: string } {
  const [state, setState] = useState<{ data: T[]; loading: boolean; error?: string }>({ data: [], loading: true });
  useEffect(() => {
    if (!enabled) {
      setState({ data: [], loading: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    const q = query(collection(db, name), ...constraints);
    return onSnapshot(
      q,
      (snap) => setState({ data: snap.docs.map((d) => ({ ...(d.data() as DocumentData), id: d.id }) as T), loading: false }),
      (err) => setState({ data: [], loading: false, error: err.message }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, key, enabled]);
  return state;
}

/**
 * 현장 단위 데이터 구독. 전체 권한(siteIds=null)이면 한 번에, 현장 사용자면 담당 현장마다 `siteId ==` 로 구독해 합친다.
 * (보안 규칙이 현장별 조건을 확실히 검증할 수 있게 하려는 것)
 */
export function useSiteScoped<T extends { id: string }>(name: string, siteIds: string[] | null): { data: T[]; loading: boolean; error?: string } {
  const key = siteIds === null ? '*' : [...siteIds].sort().join(',');
  const [state, setState] = useState<{ data: T[]; loading: boolean; error?: string }>({ data: [], loading: true });
  useEffect(() => {
    const queries = siteIds === null ? [query(collection(db, name))] : siteIds.map((id) => query(collection(db, name), where('siteId', '==', id)));
    if (!queries.length) {
      setState({ data: [], loading: false });
      return;
    }
    const parts = new Map<number, T[]>();
    setState((s) => ({ ...s, loading: true }));
    const unsubs = queries.map((q, i) =>
      onSnapshot(
        q,
        (snap) => {
          parts.set(i, snap.docs.map((d) => ({ ...(d.data() as DocumentData), id: d.id }) as T));
          setState({ data: [...parts.values()].flat(), loading: parts.size < queries.length });
        },
        (err) => setState({ data: [], loading: false, error: err.message }),
      ),
    );
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, key]);
  return state;
}

export async function saveDoc(name: string, id: string, data: object, merge = true) {
  await setDoc(doc(db, name, id), stripUndefined(data), { merge });
}

export async function createDoc(name: string, data: object): Promise<string> {
  const ref = await addDoc(collection(db, name), stripUndefined(data));
  return ref.id;
}

export async function removeDoc(name: string, id: string) {
  await deleteDoc(doc(db, name, id));
}

export function newId(name: string): string {
  return doc(collection(db, name)).id;
}

type BatchOp =
  | { type: 'set'; col: string; id: string; data: object; merge?: boolean }
  | { type: 'delete'; col: string; id: string };

/** 여러 건 저장 — Firestore 한 번에 500건 제한이 있어 나눠서 커밋한다 */
export async function commitBatch(ops: BatchOp[], onProgress?: (done: number, total: number) => void) {
  const CHUNK = 450;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const b = writeBatch(db);
    for (const op of ops.slice(i, i + CHUNK)) {
      const ref = doc(db, op.col, op.id);
      if (op.type === 'set') b.set(ref, stripUndefined(op.data), { merge: op.merge ?? true });
      else b.delete(ref);
    }
    await b.commit();
    onProgress?.(Math.min(i + CHUNK, ops.length), ops.length);
  }
}

export async function fetchWhere<T extends { id: string }>(name: string, field: string, value: unknown): Promise<T[]> {
  const snap = await getDocs(query(collection(db, name), where(field, '==', value)));
  return snap.docs.map((d) => ({ ...(d.data() as DocumentData), id: d.id }) as T);
}

export async function audit(action: string, target: string, detail: object = {}) {
  try {
    await addDoc(collection(db, C.auditLogs), {
      action,
      target,
      detail: stripUndefined(detail),
      uid: auth.currentUser?.uid ?? null,
      email: auth.currentUser?.email ?? null,
      at: serverTimestamp(),
    });
  } catch {
    // 기록 실패는 작업을 막지 않는다
  }
}

/* 설정 */
export function useSettings(): Settings {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  useEffect(
    () =>
      onSnapshot(
        doc(db, C.settings, 'main'),
        (d) => setS({ ...DEFAULT_SETTINGS, ...(d.data() as Partial<Settings> | undefined) }),
        () => undefined,
      ),
    [],
  );
  return s;
}

export async function getSettings(): Promise<Settings> {
  const d = await getDoc(doc(db, C.settings, 'main'));
  return { ...DEFAULT_SETTINGS, ...(d.data() as Partial<Settings> | undefined) };
}

/** Firestore는 undefined 값을 거부하므로 재귀적으로 제거 */
export function stripUndefined<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => stripUndefined(x)) as unknown as T;
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (val !== undefined) out[k] = stripUndefined(val);
    return out as T;
  }
  return v;
}
