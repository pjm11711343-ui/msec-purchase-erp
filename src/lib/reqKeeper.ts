// 구매청구서 작성 보관 · 되돌리기
//  - 작성 중인 내용을 이 브라우저에 자동 보관 → 다른 화면에 갔다 오거나 새로고침해도 이어서 작성
//  - 되돌리기(↶) · 다시 하기(↷): 줄 추가·삭제·품목 선택 등 잘못한 작업을 한 단계씩 취소
import { useCallback, useEffect, useRef, useState } from 'react';

const PREFIX = 'msec.reqDraft.';
const keyOf = (uid: string, id?: string) => `${PREFIX}${uid}.${id || 'new'}`;

export interface Kept<T> {
  at: number;
  d: T;
}
export function readKept<T>(uid: string | undefined, id?: string): Kept<T> | null {
  if (!uid) return null;
  try {
    const raw = localStorage.getItem(keyOf(uid, id));
    return raw ? (JSON.parse(raw) as Kept<T>) : null;
  } catch {
    return null;
  }
}
export function dropKept(uid: string | undefined, id?: string) {
  if (!uid) return;
  try {
    localStorage.removeItem(keyOf(uid, id));
  } catch {
    /* 저장 공간을 못 쓰면 무시 */
  }
}

const MAX = 60; // 되돌리기 단계
const GROUP_MS = 700; // 이 시간 안의 연속 변경(글자 입력 등)은 한 단계로

export function useReqKeeper<T extends { id?: string }>(d: T | null, setD: (v: T) => void, uid: string | undefined, active: boolean) {
  const h = useRef<{ past: T[]; future: T[]; last: T | null; t: number; skip: boolean; loadedAt: number }>({ past: [], future: [], last: null, t: 0, skip: false, loadedAt: 0 });
  const dirty = useRef(false);
  const [, bump] = useState(0);

  // 변경 기록
  useEffect(() => {
    const x = h.current;
    if (!d) return;
    if (!x.last) {
      x.last = d;
      x.loadedAt = Date.now();
      return;
    }
    if (x.skip || Date.now() - x.loadedAt < 1500) {
      // 처음 불러온 직후 자동으로 채워지는 값(결재선 등)·되돌리기 자체는 기록하지 않음
      x.skip = false;
      x.last = d;
      return;
    }
    if (x.last === d) return;
    const now = Date.now();
    if (!(now - x.t < GROUP_MS && x.past.length)) x.past = [...x.past.slice(-(MAX - 1)), x.last];
    x.future = [];
    x.last = d;
    x.t = now;
    dirty.current = true;
    bump((n) => n + 1);
  }, [d]);

  // 이 브라우저에 자동 보관 (0.6초 쉬면 저장)
  useEffect(() => {
    if (!d || !uid || !active || !dirty.current) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(keyOf(uid, d.id), JSON.stringify({ at: Date.now(), d }));
      } catch {
        /* 저장 공간이 없으면 보관만 안 됨 */
      }
    }, 600);
    return () => clearTimeout(t);
  }, [d, uid, active]);

  // 창을 닫거나 새로고침할 때 저장 안 한 내용이 있으면 확인
  useEffect(() => {
    const f = (e: BeforeUnloadEvent) => {
      if (dirty.current && active) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', f);
    return () => window.removeEventListener('beforeunload', f);
  }, [active]);

  const undo = useCallback(() => {
    const x = h.current;
    const prev = x.past.at(-1);
    if (!prev || !x.last) return;
    x.past = x.past.slice(0, -1);
    x.future = [x.last, ...x.future].slice(0, MAX);
    x.skip = true;
    x.t = 0;
    dirty.current = true;
    setD(prev);
    bump((n) => n + 1);
  }, [setD]);
  const redo = useCallback(() => {
    const x = h.current;
    const next = x.future[0];
    if (!next || !x.last) return;
    x.future = x.future.slice(1);
    x.past = [...x.past, x.last].slice(-MAX);
    x.skip = true;
    x.t = 0;
    dirty.current = true;
    setD(next);
    bump((n) => n + 1);
  }, [setD]);

  /** 서버에 저장한 뒤: 보관본 지우기 (되돌리기 기록은 남김) */
  const markSaved = useCallback(
    (id?: string) => {
      dirty.current = false;
      h.current.skip = true;
      dropKept(uid, undefined);
      if (id) dropKept(uid, id);
      bump((n) => n + 1);
    },
    [uid],
  );
  /** 보관본을 불러왔을 때: 계속 보관되도록 */
  const markDirty = useCallback(() => {
    dirty.current = true;
  }, []);
  /** 다른 청구서로 바꿀 때: 기록 비우기 */
  const reset = useCallback(() => {
    h.current = { past: [], future: [], last: null, t: 0, skip: false, loadedAt: 0 };
    dirty.current = false;
    bump((n) => n + 1);
  }, []);

  return { undo, redo, canUndo: h.current.past.length > 0, canRedo: h.current.future.length > 0, markSaved, markDirty, reset, dirty: dirty.current };
}
