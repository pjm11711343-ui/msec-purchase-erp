import { deleteApp, initializeApp } from 'firebase/app';
import { createUserWithEmailAndPassword, getAuth, signOut } from 'firebase/auth';
import { firebaseConfig } from './firebase';

/** 관리자 로그인을 유지한 채 다른 계정을 만들기 위해 보조 Firebase 앱을 잠깐 띄운다 */
export async function createAccount(email: string, password: string): Promise<string> {
  const sub = initializeApp(firebaseConfig, `create-${Date.now()}`);
  try {
    const cred = await createUserWithEmailAndPassword(getAuth(sub), email, password);
    await signOut(getAuth(sub));
    return cred.user.uid;
  } finally {
    await deleteApp(sub);
  }
}

/** 숫자 접속코드 (기본 8자리) */
export function randomCode(len = 8): string {
  const a = new Uint32Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => String(x % 10)).join('');
}
