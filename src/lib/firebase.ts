import { initializeApp, getApps, type FirebaseOptions } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import fileConfig from '../config/firebase-config.json';

const env = import.meta.env;

// .env 값이 있으면 그것을, 없으면 src/config/firebase-config.json 을 쓴다 (웹 설정값은 공개돼도 되는 값)
export const firebaseConfig: FirebaseOptions = {
  apiKey: env.VITE_FIREBASE_API_KEY || fileConfig.apiKey,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || fileConfig.authDomain,
  projectId: env.VITE_FIREBASE_PROJECT_ID || fileConfig.projectId,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || fileConfig.storageBucket,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || fileConfig.messagingSenderId,
  appId: env.VITE_FIREBASE_APP_ID || fileConfig.appId,
};

export const isConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

// 설정이 비어 있어도 화면이 깨지지 않게 임시 값으로 띄우고, 로그인 화면에서 안내한다
export const app = getApps()[0] ?? initializeApp(isConfigured ? firebaseConfig : { ...firebaseConfig, apiKey: 'not-configured', projectId: 'not-configured' });
export const auth = getAuth(app);
// AI Studio로 만든 프로젝트는 (default)가 아닌 이름 붙은 데이터베이스를 쓴다
export const FIRESTORE_DB: string = env.VITE_FIRESTORE_DB || fileConfig.firestoreDatabaseId || '(default)';
export const db = FIRESTORE_DB === '(default)' ? getFirestore(app) : getFirestore(app, FIRESTORE_DB);

/** 단가관리시스템 단가 컬렉션 이름 (vendors/{업체}/prices 아래에 있으면 컬렉션 그룹으로 읽는다) */
export const PRICE_COLLECTION: string = env.VITE_PRICE_COLLECTION || 'prices';
export const PRICE_VENDOR_COLLECTION: string = env.VITE_PRICE_VENDOR_COLLECTION || 'vendors';
export const ID_LOGIN_DOMAIN: string = env.VITE_ID_LOGIN_DOMAIN || 'msec-erp.local';

/** 아이디 로그인용 가상 이메일 */
export function idToEmail(loginId: string): string {
  return `${loginId.trim().toLowerCase()}@${ID_LOGIN_DOMAIN}`;
}

/** 업체 포털 로그인용 가상 이메일 */
export function vendorEmail(code: string): string {
  return `vendor-${code.trim().toLowerCase()}@${ID_LOGIN_DOMAIN}`;
}

/** 입력값이 이메일이 아니면 아이디로 보고 가상 이메일로 바꾼다 */
export function loginToEmail(input: string): string {
  return input.includes('@') ? input.trim() : idToEmail(input);
}

/** ERP 컬렉션 이름 — 단가관리시스템 컬렉션과 섞이지 않게 접두어를 붙인다 */
export const C = {
  users: 'erp_users',
  sites: 'erp_sites',
  vendors: 'erp_vendors',
  standardCategories: 'erp_standardCategories',
  siteCategories: 'erp_siteCategories',
  ledger: 'erp_inputLedger',
  invoices: 'erp_invoices',
  approvalLines: 'erp_approvalLines',
  settings: 'erp_settings',
  auditLogs: 'erp_auditLogs',
  requisitions: 'erp_requisitions',
  purchaseOrders: 'erp_purchaseOrders',
  receipts: 'erp_receipts',
  vendorAccounts: 'erp_vendorAccounts',
} as const;
