// 초기화면 계정 신청: 신청 즉시 Firebase 계정(승인 대기)을 만들고, 관리자가 승인하면 ERP 사용자로 등록
import { useEffect, useState } from 'react';
import { createUserWithEmailAndPassword } from 'firebase/auth';
import { doc, getDoc, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { auth, C, db, idToEmail } from './firebase';
import { notifyQuiet } from './notify';
import type { AccountRequest, Site } from '../types';

export interface PublicSite {
  id: string;
  name: string;
}

/** 로그인 전 신청 화면용 현장 목록 (사용 중인 현장 이름만 공개) */
export function usePublicSites() {
  const [list, setList] = useState<PublicSite[] | null>(null);
  useEffect(() => {
    getDoc(doc(db, C.publicInfo, 'sites'))
      .then((d) => setList(((d.data()?.list ?? []) as PublicSite[]).slice().sort((a, b) => a.name.localeCompare(b.name, 'ko'))))
      .catch(() => setList([]));
  }, []);
  return list;
}

/** 자재부·관리자 화면에서 현장 목록이 바뀌면 공개 목록을 맞춘다 */
export function usePublicSiteSync(sites: Site[], enabled: boolean, ready: boolean) {
  const [cur, setCur] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    return onSnapshot(
      doc(db, C.publicInfo, 'sites'),
      (d) => setCur(JSON.stringify(d.data()?.list ?? [])),
      () => undefined,
    );
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !ready || cur === null) return;
    const list = sites.filter((s) => s.active !== false).map((s) => ({ id: s.id, name: s.name }));
    if (!list.length) return;
    const next = JSON.stringify(list);
    if (next !== cur) setDoc(doc(db, C.publicInfo, 'sites'), { list, updatedAt: Date.now() }).catch(() => undefined);
  }, [sites, enabled, ready, cur]);
}

export interface ApplyForm {
  loginId: string;
  password: string;
  name: string;
  phone: string;
  memo: string;
  role: 'siteManager' | 'siteStaff';
  sites: PublicSite[];
}

/** 신청: 계정을 만들면 바로 그 계정으로 로그인된 상태가 되고, 화면은 '승인 대기'로 바뀐다 */
export async function submitAccountRequest(f: ApplyForm) {
  const loginId = f.loginId.trim().toLowerCase();
  const email = idToEmail(loginId);
  const cred = await createUserWithEmailAndPassword(auth, email, f.password);
  const data: Omit<AccountRequest, 'id'> = {
    loginId,
    email,
    name: f.name.trim(),
    ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
    ...(f.memo.trim() ? { memo: f.memo.trim() } : {}),
    role: f.role,
    siteIds: f.sites.map((s) => s.id),
    siteNames: f.sites.map((s) => s.name),
    status: 'pending',
    createdAt: Date.now(),
  };
  await setDoc(doc(db, C.accountRequests, cred.user.uid), data);
  notifyQuiet('account_request', {});
}

/** 반려된 신청을 고쳐서 다시 신청 (같은 계정·비밀번호 유지) */
export async function resubmitAccountRequest(uid: string, f: Omit<ApplyForm, 'loginId' | 'password'>) {
  await updateDoc(doc(db, C.accountRequests, uid), {
    name: f.name.trim(),
    phone: f.phone.trim(),
    memo: f.memo.trim(),
    role: f.role,
    siteIds: f.sites.map((s) => s.id),
    siteNames: f.sites.map((s) => s.name),
    status: 'pending',
    createdAt: Date.now(),
    rejectReason: '',
  });
  notifyQuiet('account_request', {});
}

export function useMyAccountRequest(uid: string | undefined) {
  const [req, setReq] = useState<AccountRequest | null | undefined>(undefined);
  useEffect(() => {
    if (!uid) return;
    return onSnapshot(
      doc(db, C.accountRequests, uid),
      (d) => setReq(d.exists() ? ({ ...(d.data() as Omit<AccountRequest, 'id'>), id: d.id }) : null),
      () => setReq(null),
    );
  }, [uid]);
  return req;
}
