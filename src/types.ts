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
  signImage?: string; // 결재 싸인 (PNG data URL, 바탕 투명)
  telegramChatId?: string; // 개인 텔레그램 (결재 차례 알림)
  menus?: string[] | null; // 결재자 개인별 보일 메뉴 (없으면 설정의 공통값)
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
  telegramChatId?: string; // 현장 단톡방 (발주 발송·입고 등록 알림)
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
  mobile?: string; // 담당자 휴대폰
  fax?: string;
  address?: string;
  bizNo?: string; // 사업자등록번호
  ceoName?: string; // 대표자
  vendorNote?: string; // 업체가 남긴 안내 (납품 가능 시간 등)
  vendorUpdatedAt?: number; // 업체가 포털에서 정보를 고친 시각
  accessCodeHash?: string; // 업체 포털(4단계)용
  active: boolean;
}

/** 업체가 포털에서 직접 고칠 수 있는 정보 */
export const VENDOR_SELF_FIELDS = ['contactName', 'phone', 'mobile', 'email', 'fax', 'address', 'bizNo', 'ceoName', 'vendorNote'] as const;

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
  execMenus?: string[]; // 결재자(대표·사장)에게 보여 줄 메뉴 주소 (없으면 전부)
  roleMenus?: Partial<Record<Role, string[]>>; // 현장소장·현장담당 공통 메뉴 (없으면 전부)
}

/** 관리자가 메뉴를 정해 줄 수 있는 역할 */
export const MENU_ROLES: Role[] = ['executive', 'siteManager', 'siteStaff'];
/** 역할에 원래 열려 있는 메뉴 (월별 품목은 결재자만) */
export const menusForRole = (role: Role) => EXEC_MENUS.filter((m) => m.to !== '/items' || role === 'executive');
/** 역할의 공통 메뉴 설정 (없으면 null = 전부) */
export const roleMenusOf = (s: Partial<Settings> | undefined, role: Role): string[] | null => (role === 'executive' ? s?.execMenus : s?.roleMenus?.[role]) ?? null;

/** 결재자(대표·사장) 화면에서 관리자가 켜고 끌 수 있는 메뉴 */
export const EXEC_MENUS: { to: string; label: string; group: string }[] = [
  { to: '/', label: '대시보드', group: '현황' },
  { to: '/summary', label: '투입집계', group: '현황' },
  { to: '/items', label: '월별 품목', group: '현황' },
  { to: '/process', label: '공정별 청구', group: '구매 흐름' },
  { to: '/req', label: '구매청구', group: '구매 흐름' },
  { to: '/po', label: '발주', group: '구매 흐름' },
  { to: '/receipt', label: '입고 현황', group: '구매 흐름' },
  { to: '/statements', label: '거래명세서', group: '구매 흐름' },
];
/** 주소 → 해당 메뉴 ('/req/123'은 '/req') */
export const execMenuOf = (path: string) => EXEC_MENUS.find((m) => (m.to === '/' ? path === '/' : path === m.to || path.startsWith(`${m.to}/`)));

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
  srcItem?: string; // 엑셀·붙여넣기에 적혀 있던 품명 (목록과 달라 바꾼 경우)
  srcSpec?: string;
  aliasHit?: boolean; // 기억된 다른 표기로 자동 인식
  reqQty: number; // 금회청구
  note?: string; // 본/(비고)
  orderQty: number; // 발주수량 (본사 작성)
  orderPrice: number; // 단가 (본사 작성)
  priceSource?: '계산서' | 'ERP단가' | '단가표' | '직전발주' | '직접입력' | '엑셀';
  vendorId?: string; // 거래선
  vendorName?: string;
  remark?: string; // 비고 (청구 내용)
  dueDate?: string; // 희망 납기일
  location?: string; // 사용 위치/공정
  siteCategoryId?: string; // 자재분류(현장분류)
  inBase?: boolean; // 기본 청구서(내역)에 있는 품목인지 (false = 내역 외)
  catAuto?: boolean; // 품목의 자재분류로 자동으로 들어간 값 (품목을 바꾸면 다시 찾음)
  hhCount?: number; // 세대 단위 청구: 세대수 (금회청구 = 세대수 × 세대당 수량)
  hhType?: string; // 세대 타입 (예: 59A) — 타입별 세대당 수량일 때
  hhPer?: number; // 그때 적용한 세대당 수량
  hhUnit?: string; // 세대당 수량 단위 (M · 롤)
}

/** 현장별 세대당 수량 (에어컨 매립 동관·멀티튜브, PB난방 롤관 주문제작 등) — id = siteId */
export interface HhRates {
  id: string;
  siteId: string;
  types: string[]; // 세대 타입 목록 (예: 59A, 84B)
  rules: HhRule[];
  updatedAt?: number;
  updatedBy?: string;
}
export interface HhRule {
  id: string;
  itemName: string;
  spec?: string; // 비우면 모든 규격
  unit: string; // M · 롤
  byType: boolean; // true = 타입별 세대당 수량, false = 현장 하나의 값
  qty?: number; // byType=false
  perType?: Record<string, number>; // byType=true: 타입 → 세대당 수량
}

export interface ApprovalStepState {
  label: string;
  userId?: string;
  userName?: string;
  result?: 'approved' | 'rejected' | 'skipped'; // skipped = 결재자 미지정으로 건너뜀
  comment?: string;
  at?: number;
}

/** 구매청구서 하단 결재자 의견·지시사항 */
export interface ReqOpinion {
  at: number;
  byId?: string;
  by: string;
  label: string; // 결재 칸 (예: 본사 대표이사)
  result: 'approved' | 'rejected';
  text: string;
}

export interface Requisition {
  id: string;
  siteId: string;
  siteName: string;
  docNo: string; // 결의번호 (직접 입력)
  requestDate: string; // YYYY-MM-DD
  purpose?: string; // 사용 목적 (화면 위쪽 첫 칸, 엑셀 B7 제목 줄)
  usePurpose?: string; // 사용 위치·공정 (청구서 1칸, 엑셀 T8). 없으면 줄별 사용 위치(예전 자료)를 모아 보여줌
  zoneId?: string; // 공정: 구역 (청구서 1장 = 공정 1칸)
  tradeId?: string; // 공정: 공종
  zoneSub?: string; // 구역 안 세부 위치 (예: 세대외배관 → 복도)
  processName?: string; // 공정 이름 (저장 시점, 예: "세대외배관(복도) 위생")
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
  opinions?: ReqOpinion[]; // 결재자 의견 및 지시사항 (결재 차례에 작성, 회수·재상신해도 남음)
  deletedAt?: number; // 휴지통으로 옮긴 시각 (있으면 목록·집계에서 빠짐)
  deletedBy?: string;
  deletedByName?: string;
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
  priceBy?: 'vendor'; // 업체가 기입·변경한 단가
  priceOld?: number; // 변경 전 단가 (업체 변경 요청 승인)
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
  preOrder?: boolean; // 선발주: 청구서 결재가 끝나기 전에 발주 (자재부·관리자)
  revisedAt?: number; // 발주 수정 시각 (업체가 다시 확인해야 함)
  createdAt: number;
  sentAt?: number;
  cancelledAt?: number;
  ackAt?: number; // 업체 발주 확인
  ackBy?: string;
  deliveries?: DeliveryPlan[]; // 업체가 알린 납품 일정 (차량·기사)
  history: { at: number; by: string; action: string }[];
}

/** 업체가 알리는 납품 일정 */
export interface DeliveryPlan {
  id: string;
  date: string; // YYYY-MM-DD
  time?: string; // 예: 09:00, 오전
  vehicle?: string; // 차량 (예: 5톤 카고, 12가3456)
  driverName?: string;
  driverPhone?: string;
  note?: string; // 하차 장비·인원 요청 등
  by: string; // 업체명 또는 입력한 사람
  at: number;
  done?: boolean; // 납품 완료 표시
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
  billMonth?: string; // 계산서월 YYYY-MM (자재부 지정). 없으면 입고일 기준 자동(21일~ 다음 달)
  billBy?: string;
  billAt?: number;
  createdAt: number;
}

/** 업체 공지사항 (자재부 → 업체 포털) */
export interface Notice {
  id: string;
  title: string;
  body: string;
  toAll: boolean; // 전체 업체
  vendorIds: string[]; // toAll=false 일 때 받는 업체
  pinned?: boolean; // 위에 고정
  important?: boolean; // 중요 (포털 상단 배너)
  createdAt: number;
  updatedAt?: number;
  byName: string;
}
/** 업체 공지 읽음 (id = 공지id_업체id) */
export interface NoticeRead {
  id: string;
  noticeId: string;
  vendorId: string;
  vendorName: string;
  at: number;
}
