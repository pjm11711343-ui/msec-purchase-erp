// 공통 타입 정의 — Firestore 컬렉션 구조와 1:1로 맞춘다.

export type Role = 'admin' | 'material' | 'executive' | 'siteManager' | 'siteStaff';

export const ROLE_LABEL: Record<Role, string> = {
  admin: '관리자',
  material: '자재부',
  executive: '결재자(대표·사장)',
  siteManager: '현장소장',
  siteStaff: '현장담당',
};

export type Trade = '기계' | '소방' | '공통';

export interface ErpUser {
  id: string; // = Firebase Auth uid
  name: string;
  email: string; // 이메일 로그인 주소 또는 아이디 로그인용 가상 이메일
  loginId?: string; // 아이디 로그인 사용자일 때만
  role: Role;
  siteIds: string[];
  active: boolean;
  position?: string; // 직급
}

export interface Site {
  id: string;
  code: string; // 현장코드 (예: MS-01)
  name: string; // 짧은 이름 (예: 다산지금(기계))
  fullName: string; // 정식명
  aliases: string[]; // 계산서·청구서 등에서 쓰는 다른 표기
  trade: Trade;
  groupName?: string; // 기계/소방 묶음 (예: 다산지금)
  contractor?: string; // 원청사
  address?: string;
  households?: string; // 세대수·규모
  managerContact?: string; // 소장 연락처 (예: 박광옥소장 : 010-...)
  officeContact?: string; // 공무 연락처
  orderDisplayName?: string; // 발주서 '현장' 칸 표기
  allowReqExcel?: boolean; // 현장 사용자(소장·담당)에게 '청구서 엑셀 불러오기' 허용
  active: boolean;
  createdAt?: number;
}

export interface Vendor {
  id: string;
  name: string; // 정식명
  aliases: string[];
  phone?: string;
  email?: string;
  contactName?: string;
  accessCodeHash?: string; // 업체 포털(4단계)용
  active: boolean;
}

export interface StandardCategory {
  id: string;
  name: string;
  order: number;
  trade: Trade;
  aliases?: string[]; // 분류 원문 사전: 계산서 '분류' 칸에 이렇게 적혀 오면 이 표준분류로 본다
}

export interface SiteCategory {
  id: string;
  siteId: string;
  name: string; // 현장 투입집계 원래 이름
  aliases: string[]; // 계산서 분류 열 표기 (예: "강관\n(기계)")
  order: number;
  standardCategoryId?: string;
  contractAmount: number; // 도급금액
  changeAmount: number; // 변경예상금액
  execAmount: number; // 실행금액
  migratedInput: number; // 이관 투입금액 (기준월까지)
  migratedMonth?: string; // 이관 기준월 YYYY-MM
}

export interface LedgerEntry {
  id: string;
  siteId: string;
  siteCategoryId: string;
  month: string; // YYYY-MM
  amount: number;
  source: 'invoice' | 'manual';
  invoiceId?: string;
  createdAt: number;
}

export type MatchIssue = '미발주' | '수량초과' | '단가차이' | '미입고';

export interface InvoiceLine {
  receivedDate?: string; // 현장입고일자 YYYY-MM-DD
  carryOver?: string; // 이월분 (반품 등)
  maker?: string; // 제품회사명(제조사)
  negoRate?: number;
  orderDate?: string; // 발주서 발주일자
  itemName: string;
  spec: string;
  unit: string;
  qty: number;
  unitPrice: number;
  amount: number;
  changedQty?: number;
  changedPrice?: number;
  changedAmount?: number;
  finalAmount: number; // 변경금액이 있으면 그 값, 없으면 금액
  categoryText: string; // 분류 원문
  process?: string; // 공정
  note?: string; // 비고 (예: '본사(안전) 배분')
  siteCategoryId?: string; // 매핑 결과
  matchStatus: 'migrated' | 'unmatched' | 'matched' | 'manual';
  poId?: string; // 연결된 발주서
  poLineKey?: string; // 연결된 발주 줄 (`${reqId}|${lineKey}`)
  matchIssue?: MatchIssue;
  receiptIds?: string[]; // 업체 포털에서 입고 기록으로 만든 줄
}

export interface Invoice {
  id: string; // `${month}_${vendorId}_${siteId}`
  month: string;
  vendorId: string;
  vendorName: string;
  siteId: string;
  sheetName: string;
  source: 'excel' | 'portal' | 'import'; // import = 예전 '계산서 월별 품목 관리' 백업에서 옮긴 자료
  fileName: string;
  totalAmount: number;
  lineCount: number;
  appliedToLedger: boolean; // 기준월 이후라 원장에 반영했는지
  submitted?: boolean; // 업체 포털 제출 (자재부 반영 전)
  submittedAt?: number;
  appliedAt?: number;
  lines: InvoiceLine[];
  uploadedBy: string;
  uploadedAt: number;
}

export interface ApprovalLine {
  id: string; // = siteId
  siteId: string;
  type: '2단계' | '6칸';
  steps: { label: string; userId?: string }[];
}

export interface Settings {
  cutoffMonth: string; // 이관 기준월 (예: 2026-09)
  priceTolerance: number; // 단가 허용 오차(원)
  siteCodePrefix: string; // 현장코드 접두어 (예: MS)
}

export const DEFAULT_SETTINGS: Settings = {
  cutoffMonth: '2026-09',
  priceTolerance: 1,
  siteCodePrefix: 'MS',
};

/* ───────── 2단계: 구매청구 ───────── */

export type ReqStatus = 'draft' | 'pending' | 'approved' | 'rejected';

export const REQ_STATUS_LABEL: Record<ReqStatus, string> = {
  draft: '작성중',
  pending: '결재중',
  approved: '승인',
  rejected: '반려',
};

export interface ReqLine {
  key: string; // 줄 고유값
  itemName: string;
  spec: string;
  unit: string;
  contractQty: number; // 계약내역량 수량
  contractPrice: number; // 계약내역량 단가
  execQty: number; // 실행량
  priorQty: number; // 기반입 (저장 시점 계산값 — 이전 승인 청구 + 이관)
  priorQtyManual?: number; // 엑셀에서 받은 기반입 (이관용, 있으면 우선)
  reqQty: number; // 금회청구
  note?: string; // 본/(비고)
  orderQty: number; // 발주수량 (본사 작성)
  orderPrice: number; // 단가 (본사 작성)
  priceSource?: '계산서' | '단가표' | '직전발주' | '직접입력' | '엑셀';
  vendorId?: string; // 거래선
  vendorName?: string;
  remark?: string; // 비고 (청구 내용)
  dueDate?: string; // 희망 납기일
  location?: string; // 사용 위치/공정
  siteCategoryId?: string; // 자재분류(현장분류)
}

export interface ApprovalStepState {
  label: string;
  userId?: string;
  userName?: string;
  result?: 'approved' | 'rejected' | 'skipped'; // skipped = 결재자 미지정으로 건너뜀
  comment?: string;
  at?: number;
}

export interface Requisition {
  id: string;
  siteId: string;
  siteName: string;
  docNo: string; // 결의번호 (직접 입력)
  requestDate: string; // YYYY-MM-DD
  purpose?: string; // 사용 목적
  status: ReqStatus;
  approvalType: '2단계' | '6칸';
  steps: ApprovalStepState[];
  currentStep: number; // pending일 때 결재할 단계 index
  currentApproverId?: string; // 결재함 조회용
  approverIds?: string[]; // 결재선에 지정된 사람 (전결 권한 확인용)
  lines: ReqLine[];
  totalAmount: number;
  createdBy: string;
  createdByName: string;
  createdAt: number;
  updatedAt: number;
  submittedAt?: number;
  approvedAt?: number;
  history: { at: number; by: string; action: string; comment?: string }[];
}

/* ───────── 3단계: 발주 ───────── */

export type PoStatus = 'issued' | 'sent' | 'cancelled';

export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  issued: '발주 생성',
  sent: '발송 완료',
  cancelled: '취소',
};

export interface PoLine {
  reqId: string;
  reqDocNo: string;
  lineKey: string; // 청구서 줄 key
  itemName: string;
  spec: string;
  unit: string;
  qty: number;
  price: number;
  amount: number;
  remark?: string;
  dueDate?: string;
  location?: string;
  siteCategoryId?: string;
  receivedQty?: number; // 4단계 입고 누계
}

export interface PurchaseOrder {
  id: string;
  poNo: string; // 현장코드-YYMMDD-순번
  siteId: string;
  siteName: string;
  vendorId: string;
  vendorName: string;
  vendorPhone?: string;
  vendorEmail?: string;
  orderDate: string; // YYYY-MM-DD
  deliveryTerm: string; // 납품기간 (기본: 현장 협의 후)
  notice: string; // 안내 문구
  memo?: string;
  reqIds: string[];
  reqDocNos: string[];
  lines: PoLine[];
  totalAmount: number;
  status: PoStatus;
  orderedBy: string;
  orderedByName: string; // 발주 담당자 (이름 직급)
  signNames: { label: string; name?: string }[]; // 결재란 (청구서 결재선에서)
  createdAt: number;
  sentAt?: number;
  cancelledAt?: number;
  ackAt?: number; // 업체 발주 확인
  ackBy?: string;
  history: { at: number; by: string; action: string }[];
}

/* ───────── 4단계: 업체 포털 · 입고 ───────── */

export interface VendorAccount {
  id: string; // = Firebase Auth uid
  vendorId: string;
  vendorName: string;
  code: string; // 업체코드 (로그인 아이디)
  accessCode?: string; // 접속코드 (사내 관리자 화면에서 다시 보기용)
  active: boolean;
  issuedAt: number;
  issuedBy: string;
}

export interface Receipt {
  id: string;
  poId: string;
  poNo: string;
  siteId: string;
  siteName: string;
  vendorId: string;
  vendorName: string;
  lineKey: string; // `${reqId}|${lineKey}` (발주 줄)
  itemName: string;
  spec: string;
  unit: string;
  qty: number;
  date: string; // 현장 입고일 YYYY-MM-DD
  note?: string;
  source: 'vendor' | 'office';
  enteredBy: string;
  enteredByName: string;
  confirmed?: boolean; // 현장 확인
  confirmedByName?: string;
  confirmedAt?: number;
  createdAt: number;
}
