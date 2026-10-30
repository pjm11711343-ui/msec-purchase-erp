// 공정(구역 × 공종) 관리
//  - 회사 공통 구역·공종 목록 (erp_processMaster/main)
//  - 현장별 공정 설정: 쓰는 칸(켜고 끄기) + 공정분리 툴 이름 → 구역·공종 맞춤표 (erp_siteProcess/{siteId})
//  - 현장 공정별 기본 청구서 = 내역 품목표 (erp_baseSheets/{siteId}__{zoneId}__{tradeId})
//    공정분리 툴 내역에서 만들고 자재부가 품목을 빼거나 더할 수 있다. 실행수량은 ERP에서 입력
//  - 청구서 1장 = 공정 1칸. 기반입·잔여는 같은 현장·공정·품목끼리만 쌓는다
import { useEffect, useState } from 'react';
import { collection, doc, getDoc, getDocs, getFirestore, onSnapshot, query, where } from 'firebase/firestore';
import LZString from 'lz-string';
import { app, C, db } from './firebase';
import { itemKey } from './itemMaster';
import { nameKey, num } from './normalize';
import type { Requisition } from '../types';

export interface Zone {
  id: string;
  name: string;
  order: number;
  keywords: string[]; // 공정분리 툴 6자리 공종 이름에 이 말이 있으면 이 구역으로 추천
  subs?: string[]; // 청구서에서 고르는 세부 위치 (예: 세대외배관 → 복도·입상·동지하)
  defaultTrades: string[]; // 새 현장에서 기본으로 켜는 공종
}
export interface Trade {
  id: string;
  name: string;
  order: number;
  keywords: string[];
}
export interface ProcessMaster {
  zones: Zone[];
  trades: Trade[];
  exclude: string[]; // 외주 등 공정 관리에서 빼는 말 (환기·덕트·보온·가스·자동제어)
}

export const DEFAULT_MASTER: ProcessMaster = {
  zones: [
    { id: 'unit', name: '단위세대', order: 1, keywords: ['세대내', '단위세대'], defaultTrades: ['wi', 'nan', 'so'] },
    { id: 'outer', name: '세대외배관', order: 2, keywords: ['세대외', '복도', '입상', '동지하'], subs: ['복도', '입상', '동지하'], defaultTrades: ['wi', 'nan', 'obs', 'so'] },
    { id: 'park', name: '지하주차장', order: 3, keywords: ['주차장'], defaultTrades: ['wi', 'nan', 'obs', 'so'] },
    { id: 'aux', name: '부대시설', order: 4, keywords: ['부대시설', '부대동'], defaultTrades: ['wi', 'nan', 'obs', 'so'] },
    { id: 'comm', name: '주민공동시설', order: 5, keywords: ['주민공동', '커뮤니티', '공동시설'], defaultTrades: ['wi', 'nan', 'obs', 'so'] },
    { id: 'shop', name: '근린생활시설', order: 6, keywords: ['근린', '상가'], defaultTrades: ['wi', 'nan', 'obs', 'so'] },
    { id: 'mech', name: '기계실', order: 7, keywords: ['기계실'], defaultTrades: ['wi', 'nan', 'obs', 'so'] },
    { id: 'yard', name: '옥외배관', order: 8, keywords: ['옥외'], defaultTrades: ['wi', 'nan', 'obs', 'so'] },
    { id: 'equip', name: '장비설치', order: 9, keywords: ['장비설치', '장비'], defaultTrades: ['wi', 'nan', 'obs', 'so'] },
  ],
  trades: [
    { id: 'wi', name: '위생', order: 1, keywords: ['위생', '급수', '급탕'] },
    { id: 'nan', name: '난방', order: 2, keywords: ['난방'] },
    { id: 'obs', name: '오배수', order: 3, keywords: ['오배수', '배수', '오수', '우수'] },
    { id: 'so', name: '소화', order: 4, keywords: ['소화', '소방', '스프링클러', '옥내소화전'] },
  ],
  exclude: ['환기', '덕트', '보온', '가스', '자동제어'],
};

export const cellKey = (zoneId: string, tradeId: string) => `${zoneId}|${tradeId}`;
export const sheetId = (siteId: string, zoneId: string, tradeId: string) => `${siteId}__${zoneId}__${tradeId}`;

export function useProcessMaster(): { master: ProcessMaster; saved: boolean; loading: boolean } {
  const [s, setS] = useState<{ master: ProcessMaster; saved: boolean; loading: boolean }>({ master: DEFAULT_MASTER, saved: false, loading: true });
  useEffect(
    () =>
      onSnapshot(
        doc(db, C.processMaster, 'main'),
        (d) => {
          const v = d.data() as ProcessMaster | undefined;
          setS(v?.zones?.length ? { master: { ...DEFAULT_MASTER, ...v }, saved: true, loading: false } : { master: DEFAULT_MASTER, saved: false, loading: false });
        },
        () => setS({ master: DEFAULT_MASTER, saved: false, loading: false }),
      ),
    [],
  );
  return s;
}
export const sortedZones = (m: ProcessMaster) => [...m.zones].sort((a, b) => a.order - b.order);
export const sortedTrades = (m: ProcessMaster) => [...m.trades].sort((a, b) => a.order - b.order);
export const zoneName = (m: ProcessMaster, id?: string) => m.zones.find((z) => z.id === id)?.name ?? '';
export const tradeName = (m: ProcessMaster, id?: string) => m.trades.find((t) => t.id === id)?.name ?? '';
/** 청구서에 보이는 공정 이름: "세대외배관(복도) 위생" */
export function processLabel(m: ProcessMaster, r: { zoneId?: string; tradeId?: string; zoneSub?: string }) {
  if (!r.zoneId) return '';
  const z = zoneName(m, r.zoneId) + (r.zoneSub ? `(${r.zoneSub})` : '');
  return [z, tradeName(m, r.tradeId)].filter(Boolean).join(' ');
}

/* ───────── 현장 공정 설정 ───────── */
export type MapTarget = { zoneId: string; tradeId: string } | 'skip';
export interface SiteProcess {
  id: string; // = siteId
  cells: string[]; // 켜 둔 칸 (cellKey)
  map: Record<string, MapTarget>; // "6자리 이름|8자리 이름" → 구역·공종 / 제외
  source?: { projectId: string; projectName: string; importedAt: number; byName: string };
  updatedAt: number;
}
export function useSiteProcess(siteId?: string) {
  const [s, setS] = useState<{ data?: SiteProcess; loading: boolean }>({ loading: true });
  useEffect(() => {
    if (!siteId) return setS({ loading: false });
    setS({ loading: true });
    return onSnapshot(
      doc(db, C.siteProcess, siteId),
      (d) => setS({ data: d.exists() ? ({ ...(d.data() as Omit<SiteProcess, 'id'>), id: d.id } as SiteProcess) : undefined, loading: false }),
      () => setS({ loading: false }),
    );
  }, [siteId]);
  return s;
}
export const defaultCells = (m: ProcessMaster) => m.zones.flatMap((z) => z.defaultTrades.map((t) => cellKey(z.id, t)));

/* ───────── 기본 청구서 (내역 품목표) ───────── */
export interface BaseLine {
  key: string; // 품목 키 (itemKey + 단위)
  itemName: string;
  spec: string;
  unit: string;
  contractQty: number; // 계약수량
  contractPrice: number; // 계약단가 (재료비)
  contractAmount: number; // 계약금액 (재료비)
  execQty: number; // 실행수량 (ERP 입력)
  execPrice?: number; // 실행단가
  catText?: string; // 공정분리 툴 자재분류
  siteCategoryId?: string; // 현장 자재분류
  lump?: boolean; // 1식 (소모잡자재·공구손료·안전·가설 등) — 수량 대신 금액으로 관리
  added?: boolean; // 자재부가 내역 밖에서 추가한 품목
  off?: boolean; // 기본 청구서에서 뺀 품목 (내역에는 남음)
  priorStart?: number; // 이관 기반입 (ERP 이전)
  srcSections?: string[]; // 원래 공정 (평형별 등, 참고)
}
export interface BaseSheet {
  id: string;
  siteId: string;
  zoneId: string;
  tradeId: string;
  lines: BaseLine[];
  updatedAt: number;
  updatedByName: string;
  importedAt?: number;
}
export function useBaseSheets(siteId?: string) {
  const [s, setS] = useState<{ data: BaseSheet[]; loading: boolean; error?: string }>({ data: [], loading: true });
  useEffect(() => {
    if (!siteId) return setS({ data: [], loading: false });
    setS((x) => ({ ...x, loading: true }));
    return onSnapshot(
      query(collection(db, C.baseSheets), where('siteId', '==', siteId)),
      (snap) => setS({ data: snap.docs.map((d) => ({ ...(d.data() as Omit<BaseSheet, 'id'>), id: d.id })), loading: false }),
      (e) => setS({ data: [], loading: false, error: e.message }),
    );
  }, [siteId]);
  return s;
}
export const baseLineKey = (item: string, spec: string, unit: string) => `${itemKey(item, spec)}|${nameKey(unit)}`;
const LUMP_RE = /소모|잡자재|공구손료|안전|가설/;
export const isLumpText = (s: string) => LUMP_RE.test(s.replace(/\s/g, ''));

/* ───────── 기반입 (공정별) ─────────
 * 승인된 청구서 중 같은 현장·공정의 발주수량(없으면 금회청구) 합계 + 기본 청구서의 이관 기반입 */
export function processPriorMap(reqs: Requisition[], siteId: string, zoneId: string, tradeId: string, excludeId?: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of reqs) {
    if (r.siteId !== siteId || r.zoneId !== zoneId || r.tradeId !== tradeId || r.id === excludeId || r.status !== 'approved') continue;
    for (const l of r.lines) {
      const k = itemKey(l.itemName, l.spec);
      m.set(k, (m.get(k) ?? 0) + (l.orderQty || l.reqQty || 0));
    }
  }
  return m;
}

/* ───────── 공정분리 툴 데이터 ───────── */
// 같은 Firebase 프로젝트의 다른 데이터베이스 (읽기만)
export const SEPARATOR_DB = 'ai-studio-6e6bb104-f0f9-4ce2-b5cb-69287ff57a67';
let sepDb: ReturnType<typeof getFirestore> | null = null;
const sep = () => (sepDb ??= getFirestore(app, SEPARATOR_DB));

export interface SepItem {
  name: string;
  specification: string;
  unit: string;
  quantity: number;
  materialUnitPrice: number;
  materialAmount: number;
  category: string;
  section: string;
  sectionParent?: string;
  executionAmount?: number;
}
export interface SepProject {
  id: string;
  name: string;
  status?: string;
  itemCount?: number;
  updatedAt?: number;
  processCodes?: { code: string; name: string }[];
}
export async function listSepProjects(): Promise<SepProject[]> {
  const snap = await getDocs(collection(sep(), 'projects'));
  return snap.docs
    .map((d) => {
      const v = d.data();
      return { id: d.id, name: String(v.name ?? d.id), status: v.status, itemCount: v.itemCount ?? (Array.isArray(v.items) ? v.items.length : undefined), updatedAt: v.updatedAt, processCodes: v.processCodes };
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
export async function loadSepProject(id: string): Promise<{ project: SepProject; items: SepItem[] }> {
  const d = await getDoc(doc(sep(), 'projects', id));
  if (!d.exists()) throw new Error('공정분리 툴에서 현장을 찾지 못했습니다.');
  const v = d.data();
  let raw: Record<string, unknown>[] = [];
  if (v.itemsCompressed) {
    const s = LZString.decompressFromUTF16(v.itemsCompressed);
    raw = s ? JSON.parse(s) : [];
  } else if (Array.isArray(v.items)) raw = v.items;
  const items = raw.map((x) => ({
    name: String(x.name ?? '').trim(),
    specification: String(x.specification ?? '').trim(),
    unit: String(x.unit ?? '').trim(),
    quantity: num(x.quantity),
    materialUnitPrice: num(x.materialUnitPrice),
    materialAmount: num(x.materialAmount),
    category: String(x.category ?? ''),
    section: String(x.section ?? ''),
    sectionParent: typeof x.sectionParent === 'string' ? x.sectionParent : undefined,
    executionAmount: num(x.executionAmount),
  }));
  return { project: { id: d.id, name: String(v.name ?? d.id), status: v.status, processCodes: v.processCodes }, items };
}

/** 공정 경로에서 6자리(중공종)·8자리(소공종) 이름 찾기 */
export function sectionNames(it: SepItem, codes: Map<string, string>): { l6: string; l8: string; l10: string } {
  const segs = `${it.sectionParent ?? ''} › ${it.section}`.split('›').map((s) => s.trim()).filter(Boolean);
  let l6 = '';
  let l8 = '';
  let l10 = '';
  let code6 = '';
  let code8 = '';
  for (const s of segs) {
    const m = s.match(/(\d{6,12})\s*(.*)$/);
    if (!m) continue;
    const c = m[1];
    const rest = m[2].trim();
    if (c.length === 6) (code6 = c), (l6 = rest || l6);
    else if (c.length === 8) (code8 = c), (l8 = rest || l8);
    else if (c.length >= 10) {
      code6 ||= c.slice(0, 6);
      code8 ||= c.slice(0, 8);
      l10 = rest || codes.get(c) || l10;
    }
  }
  if (!l6 && code6) l6 = codes.get(code6) ?? code6;
  if (!l8 && code8) l8 = codes.get(code8) ?? code8;
  if (!l6 && !l8) l6 = it.section || '기타 공정';
  return { l6, l8, l10 };
}
export const pairKey = (l6: string, l8: string, l10 = '') => `${l6}|${l8}${l10 ? `|${l10}` : ''}`;
/** 맞춤표 한 줄의 키: 6자리 이름으로 구역을 알 수 있으면 6·8자리로, 모르면(예: 소방배관공사) 10자리 이름까지 나눠서 */
export function mapKeyOf(m: ProcessMaster, n: { l6: string; l8: string; l10: string }) {
  const zoneKnown = sortedZones(m).some((z) => z.keywords.some((k) => k && `${n.l6}${n.l8}`.replace(/\s/g, '').includes(k)));
  return zoneKnown || !n.l10 ? pairKey(n.l6, n.l8) : pairKey(n.l6, n.l8, n.l10);
}

/** 이름으로 구역·공종 추천 (외주는 제외로) */
export function suggestTarget(m: ProcessMaster, l6: string, l8: string, l10 = ''): MapTarget | null {
  const both = `${l6} ${l8} ${l10}`.replace(/\s/g, '');
  if (m.exclude.some((x) => x && l8.replace(/\s/g, '').includes(x))) return 'skip';
  if (!l8 && m.exclude.some((x) => x && l6.replace(/\s/g, '').includes(x))) return 'skip';
  const hit = (kw: string[], s: string) => kw.some((k) => k && s.replace(/\s/g, '').includes(k));
  const zones = sortedZones(m);
  // 8자리 이름이 구역을 말하면 (예: 장비설치공사) 그쪽 우선
  const zone = zones.find((z) => hit(z.keywords, l8) && z.id === 'equip') ?? zones.find((z) => hit(z.keywords, l6)) ?? zones.find((z) => hit(z.keywords, both));
  const trade = sortedTrades(m).find((t) => hit(t.keywords, l8)) ?? sortedTrades(m).find((t) => hit(t.keywords, both));
  if (!zone && !trade) return null;
  return { zoneId: zone?.id ?? '', tradeId: trade?.id ?? '' };
}
