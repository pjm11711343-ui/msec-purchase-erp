import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { audit, commitBatch, newId, stripUndefined } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSiteCategories, useSites, useStandardCategories, useVendors } from '../../lib/hooks';
import { fillReqForm, usePurposeOf } from '../../lib/reqForm';
import { looselyEqual, nameKey, num, won } from '../../lib/normalize';
import { readWorkbook } from '../../lib/parsers';
import { findPrices, priceKey, priceVendorIs, sameVendor, usePrices, type PriceRow } from '../../lib/prices';
import { bonText, lineBonLen, pipeLength, lastOrderPrice, lastOrderPriceFor, lineAmount, restoreReq, newLine, priorQtyMap, useApprovalLines, useRequisitions, useUsers } from '../../lib/reqs';
import { parseReqSheet } from '../../lib/reqExcel';
import { orderedKeys, usePurchaseOrders } from '../../lib/pos';
import { Empty, errMsg, Field, Modal, NumInput, PageHeader, useToast } from '../../components/ui';
import { isCeo, isMyTurn, myDecideStep, nextActive, StatusChip } from './ReqList';
import PickInput from '../../components/PickInput';
import ReqImportModal from './ReqImportModal';
import ReqAttachments from './ReqAttachments';
import { dealersFor } from '../../lib/dealers';
import { dropKept, readKept, useReqKeeper } from '../../lib/reqKeeper';
import { lumpCells } from '../../lib/lump';
import { useAutoFit } from '../../lib/autoFit';
import HhRatesEditor from '../../components/HhRatesEditor';
import { hhPerOf, hhRuleFor, isHhLine, useHhRates } from '../../lib/hh';
import { useItemCatalog, type CatItem, type LastPrice } from '../../lib/itemCatalog';
import { itemKey, makeItemStd, pickFixedPrice, pickListPrice, priceValid, siteCatOfStd, useItemCats, useItemEntries, usePriceList } from '../../lib/itemMaster';
import { normItem, normSpec } from '../../lib/itemNorm';
import { NO_CAT, reqSummary, type ReqSummary } from '../../lib/reqSummary';
import { cellKey, defaultCells, processLabel, processPriorMap, sortedTrades, sortedZones, useBaseSheets, useProcessMaster, useSiteProcess, type BaseLine } from '../../lib/process';
import { signMap } from '../../lib/sign';
import { useAdminMemos } from '../../lib/adminMemo';
import AdminMemoInput from '../../components/AdminMemoInput';
import { notifyQuiet } from '../../lib/notify';
import { aliasKey, saveReqAliases, useReqAliases } from '../../lib/reqAlias';
import { similarity } from '../../lib/catMatch';
import { ROLE_LABEL, type ApprovalStepState, type ReqLine, type Requisition, type SiteCategory, type Vendor } from '../../types';

import { TEMPLATES, TYPE_LABEL, upgradeSteps } from '../../lib/approvalTemplates';
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

type Draft = Omit<Requisition, 'id'> & { id?: string };


/** 단위 드롭다운 기본 목록 */
/** 목록에서 빼는 단위 */
const HIDDEN_UNITS = new Set(['본']);
const COMMON_UNITS = ['EA', 'M', 'SET', '개', 'KG', 'BOX', '롤', '식', '대', '조', 'L', 'TON', 'M2', '매', '통'];
export default function ReqEdit() {
  const { id } = useParams();
  const [qs] = useSearchParams();
  const nav = useNavigate();
  const { profile, can, readOnly } = useAuth();
  const toast = useToast();
  const sites = useSites();
  const vendors = useVendors();
  const cats = useSiteCategories();
  const reqs = useRequisitions();
  const lines = useApprovalLines();
  const users = useUsers();
  const adminMemo = useAdminMemos(); // 관리자 전용 줄 메모 (관리자만 읽음)
  const signs = useMemo(() => signMap(users.data), [users.data]);
  const aliases = useReqAliases();
  const aliasMap = useMemo(() => new Map(aliases.list.map((a) => [aliasKey(a.fromItem, a.fromSpec), a])), [aliases.list]);
  // 엑셀에서 못 알아본 줄의 비슷한 품명·규격 후보 (줄 key → 후보)
  const [cands, setCands] = useState<Record<string, { i: string; s: string }[]>>({});
  const prices = usePrices();
  const pos = usePurchaseOrders();
  const ordered = useMemo(() => orderedKeys(pos.data), [pos.data]);
  const [d, setD] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [pickRows, setPickRows] = useState<Set<string>>(new Set()); // 줄 번호를 눌러 고른 줄 (여러 줄 한 번에 붙여넣기)
  const lastPick = useRef<string | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [phoneTable, setPhoneTable] = useState(false);
  const [preview, setPreview] = useState(false); // 청구서 미리보기
  const [drag, setDrag] = useState<{ from: string; over?: string } | null>(null); // 줄 끌어서 옮기기 // 폰: 기본은 카드, 수정할 때 표
  const [priceFor, setPriceFor] = useState<string | null>(null); // 단가 후보 보기 (line key)
  const [newItem, setNewItem] = useState<{ itemName: string; spec: string; unit: string; note: string } | null>(null); // 새 품목 등록·요청

  const isNew = !id || id === 'new';
  const stored = reqs.data.find((r) => r.id === id) ?? reqs.trash.find((r) => r.id === id);
  const inTrash = !!stored?.deletedAt;
  const isOffice = can('admin', 'material');
  // 작성 보관(다른 화면에 갔다 와도 유지)·되돌리기
  const keepActive = !!d && !readOnly && !inTrash && ['draft', 'rejected', 'pending'].includes(d.status);
  const keeper = useReqKeeper<Draft>(d, setD as (v: Draft) => void, profile?.id, keepActive);
  const [restored, setRestored] = useState<{ at: number; offer?: Draft } | null>(null);

  // 처음 불러오기
  useEffect(() => {
    if (d) return;
    if (isNew) {
      if (!profile || sites.loading) return;
      // 저장 안 하고 나갔던 새 청구서가 있으면 이어서 (공정 보드 등에서 현장·공정을 정해 들어왔으면 고를 수 있게)
      const kept = readKept<Draft>(profile.id);
      if (kept?.d && !kept.d.id && kept.d.lines?.some((l) => l.itemName)) {
        if (!qs.get('site') && !qs.get('zone')) {
          setD(kept.d);
          keeper.markDirty();
          setRestored({ at: kept.at });
          return;
        }
        setRestored({ at: kept.at, offer: kept.d });
      }
      const qSite = sites.data.find((s) => s.id === qs.get('site'));
      const siteId = qSite?.id ?? sites.data[0]?.id ?? '';
      setD({
        siteId,
        siteName: (qSite ?? sites.data[0])?.name ?? '',
        ...(qs.get('zone') && qs.get('trade') ? { zoneId: qs.get('zone')!, tradeId: qs.get('trade')! } : {}),
        docNo: '',
        requestDate: today(),
        status: 'draft',
        approvalType: '2단계',
        steps: [],
        currentStep: 0,
        lines: [newLine()],
        totalAmount: 0,
        createdBy: profile.id,
        createdByName: profile.name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: [],
      });
    } else if (stored) {
      // 저장 안 한 고친 내용이 이 브라우저에 있으면(서버 저장본보다 나중) 이어서
      const kept = readKept<Draft>(profile?.id, stored.id);
      if (kept?.d && kept.at > (stored.updatedAt ?? 0) && kept.d.status === stored.status) {
        setD(kept.d);
        keeper.markDirty();
        setRestored({ at: kept.at });
      } else {
        if (kept) dropKept(profile?.id, stored.id);
        setD(structuredClone(stored));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, stored, profile, sites.loading, sites.data, d]);

  // 단축키: Ctrl+Z 되돌리기 · Ctrl+Y(Ctrl+Shift+Z) 다시 하기 (글자 입력칸 안에서는 그 칸의 글자 되돌리기) · Ctrl+S 저장
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type)));
      if (k === 's') {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>('[data-req-save]')?.click();
      } else if (!typing && k === 'z' && !e.shiftKey) (e.preventDefault(), keeper.undo());
      else if (!typing && (k === 'y' || (k === 'z' && e.shiftKey))) (e.preventDefault(), keeper.redo());
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [keeper]);

  // 새 청구서: 현장 결재선 기본값
  const defaultSteps = (siteId: string): { type: Requisition['approvalType']; steps: ApprovalStepState[] } => {
    const l = lines.data.find((x) => x.id === siteId) ?? lines.data.find((x) => x.id === '_default');
    const type = l?.type ?? '2단계';
    const steps = upgradeSteps(type, l?.steps ?? TEMPLATES[type].map((label) => ({ label, userId: undefined as string | undefined }))).map((s) => ({
      label: s.label,
      userId: s.userId,
      userName: users.data.find((u) => u.id === s.userId)?.name,
    }));
    return { type, steps };
  };
  useEffect(() => {
    if (d && isNew && !d.steps.length && d.siteId && !lines.loading && !users.loading) {
      const { type, steps } = defaultSteps(d.siteId);
      setD({ ...d, approvalType: type, steps });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.siteId, lines.loading, users.loading]);

  const prior = useMemo(() => (d ? priorQtyMap(reqs.data, d.siteId, d.id) : new Map<string, number>()), [reqs.data, d?.siteId, d?.id]);
  // 공정(구역 × 공종): 청구서 1장 = 공정 1칸. 기반입·잔여는 같은 공정끼리
  const pm = useProcessMaster();
  const sproc = useSiteProcess(d?.siteId);
  const hh = useHhRates(d?.siteId);
  const [hhOpen, setHhOpen] = useState(false);
  const baseSheets = useBaseSheets(d?.siteId);
  const procCells = sproc.data?.cells ?? defaultCells(pm.master);
  const baseSheet = d?.zoneId ? baseSheets.data.find((s) => s.zoneId === d.zoneId && s.tradeId === d.tradeId) : undefined;
  const baseByItem = useMemo(() => new Map((baseSheet?.lines ?? []).map((b) => [itemKey(b.itemName, b.spec), b])), [baseSheet]);
  const procPrior = useMemo(() => (d?.zoneId && d.tradeId ? processPriorMap(reqs.data, d.siteId, d.zoneId, d.tradeId, d.id) : null), [reqs.data, d?.siteId, d?.zoneId, d?.tradeId, d?.id]);
  const siteCats = cats.data.filter((c) => c.siteId === d?.siteId).sort((a, b) => a.order - b.order);
  // 1식 분류(소모잡자재·공구손료·안전장비류·가설공사 등): 계약내역 1식·금액, 붙어 있는 같은 분류는 칸 합치기
  const reqTblRef = useRef<HTMLTableElement>(null);
  useAutoFit(reqTblRef, !!d);
  const lumpRows = useMemo(() => lumpCells(d?.lines ?? [], siteCats), [d?.lines, siteCats]);
  // 품명·규격 목록: 월별 품목명세(계산서) + 단가표 + 지난 청구서. 같은 품목(표기 차이)은 한 줄, 계산서 표기를 먼저 씀
  const catalog = useItemCatalog();
  const itemEntries = useItemEntries();
  const priceList = usePriceList();
  const stdCats = useStandardCategories();
  const itemCats = useItemCats();
  // 품목 → 표준 자재분류 (기준정보 › 품목·단가에서 지정 / 계산서 자동)
  const itemStd = useMemo(
    () => makeItemStd({ itemCats: itemCats.data, entries: itemEntries.data, catalog: catalog.items, siteCats: cats.data, std: stdCats.data }),
    [itemCats.data, itemEntries.data, catalog.items, cats.data, stdCats.data],
  );
  const lists = useMemo(() => {
    const hidden = new Set(itemEntries.data.filter((e) => e.status === 'hidden').map((e) => itemKey(e.itemName, e.spec)));
    const requested = new Set(itemEntries.data.filter((e) => e.status === 'requested').map((e) => itemKey(e.itemName, e.spec)));
    const items = new Map<string, string>(); // normItem → 표시 이름
    const specs = new Map<string, Map<string, string>>(); // normItem → (normSpec → 표시 규격)
    const units = new Map<string, Set<string>>(); // normItem|normSpec → 단위
    const unitsItem = new Map<string, Set<string>>();
    const cat = new Map<string, CatItem>(); // normItem|normSpec → 계산서 최신 단가
    const put = (item: string, spec: string, unit: string) => {
      const ni = normItem(item);
      if (!ni) return;
      if (!items.has(ni)) items.set(ni, item.trim());
      const sp = (spec ?? '').trim();
      if (sp) {
        const m = specs.get(ni) ?? new Map<string, string>();
        if (!m.has(normSpec(sp))) m.set(normSpec(sp), sp);
        specs.set(ni, m);
      }
      const u = (unit ?? '').trim();
      if (u) {
        const k = `${ni}|${normSpec(sp)}`;
        units.set(k, (units.get(k) ?? new Set()).add(u));
        unitsItem.set(ni, (unitsItem.get(ni) ?? new Set()).add(u));
      }
    };
    for (const c of catalog.items) {
      cat.set(`${normItem(c.i)}|${normSpec(c.s)}`, c);
      if (!hidden.has(itemKey(c.i, c.s))) put(c.i, c.s, c.u);
    }
    // 직접 등록 품목 (승인됨 + 요청 중: 요청 중인 품목도 바로 쓸 수 있음)
    itemEntries.data.forEach((e) => (e.status === 'active' || e.status === 'requested') && put(e.itemName, e.spec, e.unit));
    priceList.data.forEach((p) => put(p.itemName, p.spec, p.unit));
    baseSheets.data.forEach((b) => b.lines.forEach((l) => put(l.itemName, l.spec, l.unit)));
    prices.rows.forEach((p) => !hidden.has(itemKey(p.itemName, p.spec)) && put(p.itemName, p.spec, p.unit));
    reqs.data.forEach((r) => r.lines.forEach((l) => !hidden.has(itemKey(l.itemName, l.spec)) && put(l.itemName, l.spec, l.unit)));
    return { items, specs, units, unitsItem, cat, requested };
  }, [catalog.items, prices.rows, reqs.data, itemEntries.data, priceList.data, baseSheets.data]);
  const itemOptions = useMemo(() => [...lists.items.values()].sort((a, b) => a.localeCompare(b, 'ko')), [lists]);
  const itemSet = useMemo(() => new Set(lists.items.keys()), [lists]);
  const sizeOf = (s: string) => {
    const m = s.match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  const specOptions = (item: string) => [...(lists.specs.get(normItem(item))?.values() ?? [])].sort((a, b) => sizeOf(a) - sizeOf(b) || a.localeCompare(b, 'ko'));
  const specOk = (item: string, spec: string) => specOptions(item).some((x) => normSpec(x) === normSpec(spec));
  const unitsOf = (item: string, spec: string) => lists.units.get(`${normItem(item)}|${normSpec(spec)}`);
  const unitOptions = (item: string, spec: string) => {
    const exact = [...(unitsOf(item, spec) ?? [])];
    const byItem = [...(lists.unitsItem.get(normItem(item)) ?? [])];
    return [...new Set([...exact, ...byItem, ...COMMON_UNITS])].filter((u) => !HIDDEN_UNITS.has(u));
  };
  /** 계산서 최신 단가: 같은 현장 → 회사 전체 */
  const invoicePrice = (item: string, spec: string, siteId?: string): (LastPrice & { scope: '현장' | '전체' }) | undefined => {
    const c = lists.cat.get(`${normItem(item)}|${normSpec(spec)}`);
    if (!c) return undefined;
    const sp = siteId ? c.site[siteId] : undefined;
    return sp ? { ...sp, scope: '현장' } : { ...c.last, scope: '전체' };
  };

  if (!d)
    return (
      <div className="text-muted">
        {reqs.loading || sites.loading ? '불러오는 중…' : readOnly ? '앞 단계(관리자·자재부) 결재가 끝나 결재 차례가 오면 볼 수 있습니다.' : '청구서를 찾을 수 없습니다.'}
      </div>
    );

  // 작성중·반려: 작성자·자재부 / 결재 중(최종 승인 전): 작성자·자재부·결재선에 있는 사람도 내용 수정 가능
  const draftEditable = !readOnly && !inTrash && (d.status === 'draft' || d.status === 'rejected') && (d.createdBy === profile?.id || isOffice);
  // 현장소장·현장담당은 결재 요청 후에는 고칠 수 없다 (고치려면 '결재 회수' 또는 반려 후)
  const isSiteRole = profile?.role === 'siteManager' || profile?.role === 'siteStaff';
  const pendEditable = !readOnly && !inTrash && d.status === 'pending' && (isOffice || (!isSiteRole && (d.createdBy === profile?.id || d.steps.some((s) => s.userId && s.userId === profile?.id))));
  const editable = draftEditable || pendEditable;
  const myTurn = !!d.id && isMyTurn(d as Requisition, profile?.id, can('admin'));
  // 관리자: 대표이사까지 승인이 끝난 뒤에도 거래선·발주 단가는 고칠 수 있다 (발주된 줄은 발주서에서)
  const adminAfterApproval = !readOnly && !inTrash && d.status === 'approved' && can('admin');
  const orderEditable = editable ? isOffice : (myTurn && isOffice) || adminAfterApproval;
  const dupDoc =
    d.docNo.trim() && reqs.data.some((r) => r.id !== d.id && r.siteId === d.siteId && nameKey(r.docNo) === nameKey(d.docNo));

  const priorOf = (l: ReqLine) => {
    if (l.priorQtyManual != null) return l.priorQtyManual;
    if (procPrior) {
      const k = itemKey(l.itemName, l.spec);
      return (procPrior.get(k) ?? 0) + (baseByItem.get(k)?.priorStart ?? 0);
    }
    return prior.get(priceKey(l.itemName, l.spec)) ?? 0;
  };
  /** 기본 청구서(내역) 품목 → 청구서 줄 값 */
  const fromBase = (b: BaseLine): Partial<ReqLine> => ({
    itemName: b.itemName,
    spec: b.spec,
    unit: b.unit,
    contractQty: b.lump ? 1 : b.contractQty,
    contractPrice: b.lump ? b.contractAmount : b.contractPrice,
    execQty: b.lump ? 0 : b.execQty,
    inBase: true,
    ...(b.siteCategoryId ? { siteCategoryId: b.siteCategoryId, catAuto: undefined } : {}),
  });
  /** 기본 청구서 불러오기: 아직 없는 내역 품목을 줄로 깐다 (금회청구는 비움) */
  const loadBase = () => {
    if (!baseSheet?.lines.length) return toast('이 공정의 기본 청구서(내역)가 없습니다. 공정별 청구 화면에서 자재부가 내역을 넣어야 합니다.', 'err');
    const have = new Set(d.lines.filter((l) => l.itemName.trim()).map((l) => itemKey(l.itemName, l.spec)));
    const add = baseSheet.lines.filter((b) => !b.off && !have.has(itemKey(b.itemName, b.spec))).map((b) => ({ ...newLine(), ...fromBase(b) }) as ReqLine);
    if (!add.length) return toast('기본 청구서 품목이 이미 모두 들어가 있습니다.');
    setD({ ...d, lines: [...d.lines.filter((l) => l.itemName.trim()), ...add.map((l) => (((y) => ({ ...y, ...(!y.orderPrice ? suggest(y) : {}) }))({ ...l, ...autoCat(l) })))] });
    toast(`기본 청구서 품목 ${add.length}줄을 불러왔습니다. 금회청구 수량을 넣으세요. (수량이 빈 내역 줄은 결재 올릴 때 빠집니다)`);
  };
  const setProcess = (p: { zoneId?: string; tradeId?: string; zoneSub?: string }) => {
    const n = { ...d, ...p };
    if (p.zoneId !== undefined && !pm.master.zones.find((z) => z.id === p.zoneId)?.subs?.length) n.zoneSub = undefined;
    setD(n);
  };

  /** 현장 대리점 순위 (0 = 대리점 아님) */
  const siteObj = sites.data.find((x) => x.id === d.siteId);
  const dealerRank = (vid: string | undefined, catId?: string) => dealersFor(siteObj, catId).indexOf(vid ?? '\u0000') + 1;
  const DealerChip = ({ vid, catId }: { vid?: string; catId?: string }) => (dealerRank(vid, catId) ? <span className="chip ml-1 bg-teal-50 text-[10.5px] text-teal-700">대리점 {dealerRank(vid, catId)}순위</span> : null);
  const setLine = (key: string, patch: Partial<ReqLine>) => setD((x) => x && { ...x, lines: x.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });

  /** 단가 자동: 현장 지정단가 → (거래선을 골랐으면 그 업체 단가만) → 현장 대리점(자재분류별 우선순위) → 최신 계산서 단가(같은 현장 → 전체) → ERP 단가표(현장 예외 → 거래선 → 최저) → 단가관리 단가표 → 직전 발주단가 */
  const suggest = (l: ReqLine): Partial<ReqLine> => {
    if (!l.itemName) return {};
    // 현장 지정단가가 맨 먼저
    const fp = pickFixedPrice(priceList.data, l.itemName, l.spec, d.siteId, l.vendorId || undefined);
    if (fp) return { orderPrice: fp.price, priceSource: '지정단가', unit: l.unit || fp.unit, ...(!l.vendorId ? { vendorId: fp.vendorId, vendorName: fp.vendorName } : {}) };
    // 거래선을 먼저 고른 줄: 그 업체 단가만 찾는다 (계산서 → ERP 품목·단가 → 단가관리 → 직전 발주). 없으면 단가는 비워 둔다
    if (l.vendorId) {
      const v = vendors.data.find((x) => x.id === l.vendorId);
      const src = (dealerRank(l.vendorId, l.siteCategoryId) ? '대리점' : null) as ReqLine['priceSource'] | null;
      const ip = invoicePrice(l.itemName, l.spec, d.siteId);
      if (ip && ip.vid === l.vendorId) {
        const u = lists.cat.get(`${normItem(l.itemName)}|${normSpec(l.spec)}`)?.u;
        return { orderPrice: ip.p, priceSource: src ?? '계산서', ...(u && !l.unit ? { unit: u } : {}) };
      }
      const de = pickListPrice(priceList.data, l.itemName, l.spec, d.siteId, l.vendorId);
      if (de && de.vendorId === l.vendorId) return { orderPrice: de.price, priceSource: src ?? 'ERP단가', unit: l.unit || de.unit };
      const pm = v ? findPrices(prices.rows, l.itemName, l.spec).find((p) => priceVendorIs(p, v)) : undefined;
      if (pm) return { orderPrice: pm.buyPrice, priceSource: src ?? '단가표', unit: l.unit || pm.unit };
      const lv = lastOrderPriceFor(reqs.data, l.itemName, l.spec, l.vendorId);
      if (lv) return { orderPrice: lv.price, priceSource: '직전발주' };
      return {};
    }
    // 현장 대리점 (자재분류에 맞는 우선순위 순): 단가관리시스템 단가 → ERP 품목·단가
    const dealers = dealersFor(siteObj, l.siteCategoryId).map((id) => vendors.data.find((v) => v.id === id)).filter((v): v is Vendor => !!v);
    for (const dv of dealers) {
      const pm = findPrices(prices.rows, l.itemName, l.spec).find((p) => priceVendorIs(p, dv));
      if (pm) return { orderPrice: pm.buyPrice, priceSource: '대리점', unit: l.unit || pm.unit, ...(!l.vendorId ? { vendorId: dv.id, vendorName: dv.name } : {}) };
      const de = pickListPrice(priceList.data, l.itemName, l.spec, d.siteId, dv.id);
      if (de && de.vendorId === dv.id) return { orderPrice: de.price, priceSource: '대리점', unit: l.unit || de.unit, ...(!l.vendorId ? { vendorId: dv.id, vendorName: dv.name } : {}) };
    }
    const ip = invoicePrice(l.itemName, l.spec, d.siteId);
    if (ip) {
      const u = lists.cat.get(`${normItem(l.itemName)}|${normSpec(l.spec)}`)?.u;
      const iv = !l.vendorId ? vendors.data.find((x) => x.id === ip.vid) : undefined;
      return { orderPrice: ip.p, priceSource: '계산서', ...(u && !l.unit ? { unit: u } : {}), ...(iv ? { vendorId: iv.id, vendorName: iv.name } : {}) };
    }
    const ep = pickListPrice(priceList.data, l.itemName, l.spec, d.siteId, l.vendorId || undefined);
    if (ep) return { orderPrice: ep.price, priceSource: 'ERP단가', unit: l.unit || ep.unit, ...(!l.vendorId ? { vendorId: ep.vendorId, vendorName: ep.vendorName } : {}) };
    const cands = findPrices(prices.rows, l.itemName, l.spec);
    const v = vendors.data.find((x) => x.id === l.vendorId);
    const forVendor = v ? cands.find((p) => priceVendorIs(p, v)) : undefined;
    const pick: PriceRow | undefined = forVendor ?? cands[0];
    if (pick) {
      const erpV = v ?? vendors.data.find((x) => priceVendorIs(pick, x));
      return { orderPrice: pick.buyPrice, priceSource: '단가표', unit: l.unit || pick.unit, ...(erpV && !l.vendorId ? { vendorId: erpV.id, vendorName: erpV.name } : {}) };
    }
    const last = lastOrderPrice(reqs.data, l.itemName, l.spec);
    if (last) return { orderPrice: last.price, priceSource: '직전발주', ...(!l.vendorId && last.vendorId ? { vendorId: last.vendorId, vendorName: last.vendorName } : {}) };
    return {};
  };
  /** 자재분류 자동: 품목에 정해진 표준분류 → 이 현장의 자재분류 (직접 고른 분류는 건드리지 않음) */
  const autoCat = (l: ReqLine): Partial<ReqLine> => {
    if (!l.itemName || (l.siteCategoryId && !l.catAuto)) return {};
    const id = siteCatOfStd(itemStd(l.itemName, l.spec).stdCatId, siteCats, stdCats.data);
    if (id) return { siteCategoryId: id, catAuto: true };
    return l.catAuto ? { siteCategoryId: undefined, catAuto: undefined } : {};
  };
  /** 공정이 있으면 내역(기본 청구서) 값을 채우고, 없는 품목은 내역 외로 */
  const baseFill = (l: ReqLine): Partial<ReqLine> => {
    if (!d.zoneId || !l.itemName) return {};
    const b = baseByItem.get(itemKey(l.itemName, l.spec));
    if (b) {
      const f = fromBase(b);
      return { contractQty: f.contractQty, contractPrice: f.contractPrice, execQty: f.execQty, inBase: true, ...(!l.siteCategoryId || l.catAuto ? { siteCategoryId: f.siteCategoryId ?? l.siteCategoryId, catAuto: f.siteCategoryId ? undefined : l.catAuto } : {}) };
    }
    return l.inBase ? { inBase: false, contractQty: 0, contractPrice: 0, execQty: 0 } : { inBase: false };
  };
  const autoPrice = (key: string) =>
    setD((x) => {
      if (!x) return x;
      return { ...x, lines: x.lines.map((l) => (l.key === key ? (((y) => ({ ...y, ...baseFill(y) }))(((c) => ({ ...c, ...(!c.orderPrice ? suggest(c) : {}) }))({ ...l, ...autoCat(l) }))) : l)) };
    });

  /** 새 품목: 자재부·관리자는 바로 등록, 현장은 등록 요청 (요청 중에도 사용 가능) */
  const saveNewItem = async () => {
    if (!newItem) return;
    const item = newItem.itemName.trim();
    const spec = newItem.spec.trim();
    if (!item) return toast('품명을 입력하세요.', 'err');
    if (itemSet.has(normItem(item)) && (!spec || specOk(item, spec))) return toast('이미 목록에 있는 품목입니다. 품명 칸에서 고르세요.', 'err');
    const now = Date.now();
    try {
      await commitBatch([
        {
          type: 'set',
          col: C.items,
          id: newId(C.items),
          data: stripUndefined({
            itemName: item,
            spec,
            unit: newItem.unit.trim(),
            note: newItem.note.trim() || undefined,
            status: isOffice ? 'active' : 'requested',
            requestedBy: profile?.id,
            requestedByName: profile?.name ?? '',
            requestSiteName: d.siteName,
            createdAt: now,
          }),
        },
      ]);
      toast(isOffice ? '품목을 등록했습니다. 품명 칸에서 고르세요.' : '등록 요청했습니다. 지금 바로 품명 칸에서 고를 수 있습니다.');
      setNewItem(null);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };
  /** 품명·규격은 목록에서 고른 값만. 바꾸면 자동 단가는 다시 찾는다 */
  const resetAuto = (l: ReqLine): Partial<ReqLine> => ({
    ...(l.priceSource === '지정단가' || l.priceSource === '대리점' || l.priceSource === '계산서' || l.priceSource === 'ERP단가' || l.priceSource === '단가표' || l.priceSource === '직전발주' ? { orderPrice: 0, priceSource: undefined } : {}),
    // 품명·규격이 바뀌면 세대 청구 값도 다시
    ...(l.hhCount != null ? { hhCount: undefined, hhType: undefined, hhPer: undefined, hhUnit: undefined } : {}),
  });
  const pickItem = (key: string, v: string) => {
    const l = d.lines.find((x) => x.key === key);
    if (!l || v === l.itemName) return;
    const keepSpec = !!l.spec && specOk(v, l.spec);
    setLine(key, { itemName: v, aliasHit: undefined, ...(keepSpec ? {} : { spec: '' }), ...resetAuto(l) });
    autoPrice(key);
  };
  const pickSpec = (key: string, item: string, v: string) => {
    const l = d.lines.find((x) => x.key === key);
    if (!l || v === l.spec) return;
    const us = unitsOf(item, v);
    setLine(key, { spec: v, aliasHit: undefined, ...(us?.size === 1 ? { unit: [...us][0] } : {}), ...resetAuto(l) });
    autoPrice(key);
  };
  /** 목록에 없는 품명·규격 줄 (엑셀·붙여넣기로 들어온 줄) */
  const invalidLine = (l: ReqLine) =>
    !!l.itemName.trim() && (!itemSet.has(normItem(l.itemName)) || (!!l.spec.trim() && !specOk(l.itemName, l.spec)));

  /** 발주수량 > 금회청구 (엑셀에서 불러온 예전 청구서 등) */
  const overOrder = (l: ReqLine) => !!l.itemName.trim() && (l.orderQty || 0) > (l.reqQty || 0);
  const total = d.lines.reduce((a, l) => a + lineAmount(l), 0);
  const summary = reqSummary(d, cats.data, reqs.data, pos.data);
  /** 이 청구서에서 이미 발주된 발주서 (결재 중이면 선발주) */
  const preOrdered = d.id ? d.lines.map((l) => ordered.get(`${d.id}|${l.key}`)).filter((p): p is NonNullable<typeof p> => !!p) : [];

  const build = (patch: Partial<Requisition>): Omit<Requisition, 'id'> => {
    const dropEmpty = patch.status === 'pending' && !!d.zoneId;
    const ls = d.lines
      .filter((l) => l.itemName.trim())
      .filter((l) => !(dropEmpty && l.inBase && !l.reqQty && !l.orderQty))
      .map((l) => ({ ...l, itemName: l.itemName.trim(), spec: l.spec.trim(), priorQty: priorOf(l), orderQty: l.orderQty || l.reqQty }));
    const site = sites.data.find((s) => s.id === d.siteId);
    const { id: _ignore, ...rest } = d;
    void _ignore;
    return stripUndefined({
      ...rest,
      siteName: site?.name ?? d.siteName,
      processName: d.zoneId ? processLabel(pm.master, d) : undefined,
      lines: ls,
      totalAmount: ls.reduce((a, l) => a + lineAmount(l), 0),
      updatedAt: Date.now(),
      ...patch,
    }) as Omit<Requisition, 'id'>;
  };

  const save = async (patch: Partial<Requisition>, action: string, okMsg: string) => {
    if (!d.siteId) return toast('현장을 고르세요.', 'err');
    const over = d.lines.filter(overOrder);
    if (over.length && patch.status !== 'rejected' && (editable || orderEditable))
      return toast(`발주수량이 금회청구보다 많은 줄이 ${over.length}개 있습니다 (빨간 칸: ${over.slice(0, 3).map((l) => l.itemName).join(', ')}${over.length > 3 ? ' …' : ''}). 발주수량을 금회청구 이하로 고치세요.`, 'err');
    setBusy(true);
    try {
      const rid = d.id ?? newId(C.requisitions);
      // 자재부·관리자가 고친 엑셀 표기 → 회사 공용 기억 (다음 불러오기 때 자동 인식)
      if (isOffice) {
        const learn = d.lines.filter(
          (l) => l.srcItem && !l.aliasHit && l.itemName.trim() && !invalidLine(l) && aliasKey(l.srcItem, l.srcSpec ?? '') !== aliasKey(l.itemName, l.spec),
        );
        const seen = new Set<string>();
        const items = learn
          .filter((l) => {
            const k = aliasKey(l.srcItem!, l.srcSpec ?? '');
            if (seen.has(k)) return false;
            seen.add(k);
            const ex = aliasMap.get(k);
            return !ex || ex.toItem !== l.itemName || ex.toSpec !== l.spec;
          })
          .map((l) => ({ fromItem: l.srcItem!, fromSpec: l.srcSpec ?? '', toItem: l.itemName.trim(), toSpec: l.spec.trim(), byName: profile?.name ?? '' }));
        if (items.length) {
          try {
            await saveReqAliases(items);
            toast(`고친 품명·규격 ${items.length}건을 기억했습니다. 다음 엑셀 불러오기부터 자동 인식합니다.`);
          } catch {
            /* 기억 저장이 실패해도 청구서 저장은 계속 */
          }
        }
      }
      const data = build({ ...patch, history: [...d.history, { at: Date.now(), by: profile?.name ?? '', action, ...(comment ? { comment } : {}) }] });
      // 첨부 목록은 첨부 칸에서 바로 저장되므로, 화면에 들고 있던 예전 목록으로 덮어쓰지 않는다
      const liveAtt = reqs.data.find((r) => r.id === rid)?.attachments;
      if (liveAtt) data.attachments = liveAtt;
      await commitBatch([{ type: 'set', col: C.requisitions, id: rid, data, merge: false }]);
      await audit(`구매청구 ${action}`, rid, { docNo: data.docNo, site: data.siteName });
      toast(okMsg);
      setComment('');
      keeper.markSaved(rid);
      setRestored(null);
      setD({ ...data, id: rid });
      if (!d.id) nav(`/req/${rid}`, { replace: true });
      return rid;
    } catch (e) {
      toast(errMsg(e), 'err');
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (!d.lines.some((l) => l.itemName.trim())) return toast('품목을 한 줄 이상 입력하세요.', 'err');
    // 금회청구 수량이 비어 있어도 결재를 올릴 수 있다 (수량은 결재 중 자재부가 발주수량으로 정함)
    const wrong = d.lines.filter(invalidLine);
    if (wrong.length) return toast(`내역·규격 수정 요함 ${wrong.length}줄 (빨간 칸) — 목록에서 품명·규격을 다시 고르세요: ${wrong.slice(0, 3).map((l) => `${l.itemName} ${l.spec}`).join(', ')}`, 'err');
    // 현장소장·현장담당·자재부·관리자 누가 작성해 올려도 현장 결재 칸(현장 담당·현장 소장)은 모두 승인 완료로 처리
    const bySite = ['siteManager', 'siteStaff', 'material', 'admin'].includes(profile?.role ?? '');
    const isSiteStep = (label: string) => /^현장/.test(label.replace(/\s/g, ''));
    const now = Date.now();
    const steps: ApprovalStepState[] = d.steps.map((s) => {
      if (bySite && isSiteStep(s.label))
        return { label: s.label, ...(s.userId ? { userId: s.userId } : {}), userName: s.userName ?? profile?.name, result: 'approved', comment: `현장 작성 완료 (${profile?.name ?? ''})`, at: now };
      // 결재자 미지정 칸은 건너뜀
      return s.userId ? { label: s.label, userId: s.userId, userName: s.userName } : { label: s.label, result: 'skipped' };
    });
    const first = nextActive(steps, 0);
    const approverIds = steps.filter((s) => s.userId).map((s) => s.userId!);
    if (first < 0) {
      if (!steps.some((s) => s.result === 'approved')) return toast('결재선에 결재자를 한 명 이상 지정하세요.', 'err');
      // 본사 결재자가 없으면 현장 승인으로 바로 최종 승인
      return void save({ status: 'approved', steps, currentStep: steps.length - 1, currentApproverId: undefined, approverIds, submittedAt: now, approvedAt: now }, '결재 요청 (현장 승인 완료)', '현장 결재가 끝나 최종 승인되었습니다.').then((rid) => rid && notifyQuiet('req_approved', { reqId: rid }));
    }
    // 결재 차례가 된 결재자에게 텔레그램 (개인 Chat ID가 있으면)
    void save(
      { status: 'pending', steps, currentStep: first, currentApproverId: steps[first].userId, approverIds, submittedAt: now },
      bySite && steps.some((s) => isSiteStep(s.label)) ? '결재 요청 (현장 결재 승인 완료)' : '결재 요청',
      bySite && steps.some((s) => isSiteStep(s.label)) ? `결재를 올렸습니다. 현장 결재는 승인 완료로 처리하고 ${steps[first].label} 차례로 넘겼습니다.` : '결재를 올렸습니다.',
    ).then((rid) => rid && notifyQuiet('approval_turn', { reqId: rid }));
  };

  const decide = (result: 'approved' | 'rejected') => {
    if (result === 'rejected' && !comment.trim()) return toast('반려 사유를 적어 주세요.', 'err');
    if (result === 'rejected' && preOrdered.length && !confirm(`이 청구서는 이미 선발주된 줄이 ${preOrdered.length}개 있습니다 (${[...new Set(preOrdered.map((p) => p.poNo))].join(', ')}).\n반려하면 발주서에 '청구 반려'로 표시됩니다. 발주 취소는 발주 화면에서 따로 해야 합니다.\n반려할까요?`)) return;
    const j = myDecideStep(d as Requisition, profile?.id, can('admin'));
    if (j < 0) return toast('지금 결재할 차례가 아닙니다.', 'err');
    const now = Date.now();
    const me = d.steps[j];
    const ceo = result === 'approved' && isCeo(me.label);
    // 전결: 내 칸보다 앞의 미결 칸(대표면 뒤의 칸까지)은 내 이름으로 전결 처리
    const steps: ApprovalStepState[] = d.steps.map((s, i) => {
      if (i === j) return { ...s, result, comment: comment || undefined, at: now, userName: s.userName ?? profile?.name };
      if (result !== 'approved' || s.result) return s;
      if (i < j || ceo) return s.userId ? { ...s, result: 'approved', comment: `${me.label} 전결`, at: now } : { ...s, result: 'skipped' };
      return s;
    });
    // 결재자 의견·지시사항: 하단 칸에 쌓이고 작성자·현장에 텔레그램
    const text = comment.trim();
    const opinions = text ? [...(d.opinions ?? []), { at: now, byId: profile?.id, by: profile?.name ?? '', label: me.label, result, text }] : d.opinions;
    const tellOpinion = (rid: string | void) => {
      if (rid && text) notifyQuiet('approval_opinion', { reqId: rid });
    };
    if (result === 'rejected') return void save({ status: 'rejected', steps, currentApproverId: undefined, opinions }, '반려', '반려했습니다.').then(tellOpinion);
    const next = ceo ? -1 : nextActive(steps, j + 1);
    if (next < 0)
      return void save({ status: 'approved', steps, currentStep: steps.length - 1, currentApproverId: undefined, approvedAt: now, opinions }, ceo ? `${me.label} 승인(최종)` : '최종 승인', '최종 승인했습니다. 3단계 발주 대기로 넘어갑니다.').then((rid) => {
        tellOpinion(rid);
        if (rid) notifyQuiet('req_approved', { reqId: rid });
      });
    void save({ steps, currentStep: next, currentApproverId: steps[next].userId, opinions }, j > d.currentStep ? `${me.label} 전결 승인` : `${me.label} 승인`, '승인했습니다.').then((rid) => {
      if (rid) notifyQuiet('approval_turn', { reqId: rid });
      tellOpinion(rid);
    });
  };

  /** 결재 중 수정 저장: 결재 진행은 그대로 두고, 바뀐 내용을 진행 기록에 남긴다 */
  const savePending = () => {
    if (!d.lines.some((l) => l.itemName.trim())) return toast('품목을 한 줄 이상 입력하세요.', 'err');
    const wrong = d.lines.filter(invalidLine);
    if (wrong.length) return toast(`목록에 없는 품명·규격이 ${wrong.length}줄 있습니다 (빨간 칸). 목록에서 다시 고르세요.`, 'err');
    const before = reqs.data.find((r) => r.id === d.id);
    const old = new Map((before?.lines ?? []).filter((l) => l.itemName).map((l) => [l.key, l]));
    const now = d.lines.filter((l) => l.itemName.trim());
    const parts: string[] = [];
    const added = now.filter((l) => !old.has(l.key));
    const removed = [...old.values()].filter((l) => !now.some((x) => x.key === l.key));
    const changed = now.filter((l) => {
      const o = old.get(l.key);
      return o && (o.itemName !== l.itemName || o.spec !== l.spec || o.reqQty !== l.reqQty || (o.orderQty || 0) !== (l.orderQty || 0) || (o.orderPrice || 0) !== (l.orderPrice || 0) || (o.vendorId || '') !== (l.vendorId || ''));
    });
    const nm = (l: ReqLine) => `${l.itemName} ${l.spec}`.trim();
    if (added.length) parts.push(`추가 ${added.length}줄(${added.slice(0, 3).map(nm).join(', ')}${added.length > 3 ? ' …' : ''})`);
    if (removed.length) parts.push(`삭제 ${removed.length}줄(${removed.slice(0, 3).map(nm).join(', ')}${removed.length > 3 ? ' …' : ''})`);
    if (changed.length) parts.push(`변경 ${changed.length}줄(${changed.slice(0, 3).map(nm).join(', ')}${changed.length > 3 ? ' …' : ''})`);
    if (before && (before.purpose ?? '') !== (d.purpose ?? '')) parts.push('사용 목적');
    if (before && usePurposeOf(before) !== usePurposeOf(d)) parts.push('사용 위치·공정');
    if (before && (before.docNo !== d.docNo || before.requestDate !== d.requestDate)) parts.push('결의번호·청구일');
    const summary = parts.join(' · ');
    save({}, summary ? `결재 중 수정: ${summary}` : '결재 중 저장', '수정 내용을 저장했습니다. 결재는 그대로 진행됩니다.');
  };

  const reopen = () =>
    preOrdered.length
      ? toast(`이미 선발주된 줄이 있어 회수할 수 없습니다 (${[...new Set(preOrdered.map((p) => p.poNo))].join(', ')}). 자재부에 문의하세요.`, 'err')
      : save({ status: 'draft', currentStep: 0, currentApproverId: undefined, steps: d.steps.map((s) => ({ label: s.label, userId: s.userId, userName: s.userName })) }, '다시 작성', '작성중으로 돌렸습니다.');

  /** 삭제 = 휴지통으로 (구매청구 › 휴지통에서 복원·영구 삭제) */
  const remove = async () => {
    if (!d.id) return;
    const done = d.lines.filter((l) => ordered.get(`${d.id}|${l.key}`));
    if (done.length) return toast(`이미 발주된 줄이 ${done.length}개 있어 삭제할 수 없습니다. 발주를 먼저 취소하세요.`, 'err');
    if (!confirm('이 청구서를 휴지통으로 옮길까요? 구매청구 › 휴지통에서 다시 복원할 수 있습니다.')) return;
    try {
      const now = Date.now();
      await commitBatch([
        {
          type: 'set',
          col: C.requisitions,
          id: d.id,
          data: { deletedAt: now, deletedBy: profile?.id ?? '', deletedByName: profile?.name ?? '', history: [...d.history, { at: now, by: profile?.name ?? '', action: '휴지통으로 이동' }] },
        },
      ]);
      await audit('구매청구 휴지통 이동', d.id, { docNo: d.docNo });
      toast('휴지통으로 옮겼습니다.');
      keeper.markSaved(d.id);
      nav('/req');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  /** 엑셀·붙여넣기 품명·규격 인식: 목록 표기(띄어쓰기·흔한 표기 차이 무시) → 기억된 다른 표기 → 못 찾으면 수정 요함 */
  const recognize = (l: ReqLine): ReqLine => {
    const item = l.itemName.trim();
    const spec = (l.spec ?? '').trim();
    if (!item) return l;
    const ni = normItem(item);
    const okItem = itemSet.has(ni);
    if (okItem && (!spec || specOk(item, spec))) {
      const stdItem = lists.items.get(ni) ?? item;
      const stdSpec = spec ? (lists.specs.get(ni)?.get(normSpec(spec)) ?? spec) : '';
      return { ...l, itemName: stdItem, spec: stdSpec };
    }
    const a = aliasMap.get(aliasKey(item, spec));
    if (a && itemSet.has(normItem(a.toItem))) return { ...l, itemName: a.toItem, spec: a.toSpec, srcItem: item, srcSpec: spec, aliasHit: true };
    return { ...l, srcItem: item, srcSpec: spec, aliasHit: undefined };
  };
  /** 비슷한 품명·규격 후보 3개 */
  const suggestPairs = (item: string, spec: string): { i: string; s: string }[] => {
    const ni = normItem(item);
    const scored = itemOptions.map((o) => ({ o, sc: similarity(ni, normItem(o)) })).filter((x) => x.sc > 0.3);
    scored.sort((a, b) => b.sc - a.sc);
    const out: { i: string; s: string; sc: number }[] = [];
    for (const { o, sc } of scored.slice(0, 6)) {
      const specs = specOptions(o);
      if (!specs.length) out.push({ i: o, s: '', sc });
      else {
        const best = specs.map((s) => ({ s, v: spec ? (normSpec(spec) === normSpec(s) ? 1 : similarity(normSpec(spec), normSpec(s))) : 0 })).sort((a, b) => b.v - a.v)[0];
        out.push({ i: o, s: best.s, sc: sc * 0.7 + best.v * 0.3 });
      }
    }
    return out.sort((a, b) => b.sc - a.sc).slice(0, 3).map(({ i, s }) => ({ i, s }));
  };

  const addFromRows = (rows0: Partial<ReqLine>[]) => {
    const nextCands: Record<string, { i: string; s: string }[]> = {};
    // 엑셀의 거래선: 위·아래 같은 업체 사이의 빈칸(" 표시)은 같은 업체로
    const rows = rows0.map((r) => ({ ...r }));
    let last = -1;
    rows.forEach((r, i) => {
      const v = (r.vendorName ?? '').trim();
      if (!v) return;
      if (last >= 0 && nameKey(rows[last].vendorName ?? '') === nameKey(v)) for (let k = last + 1; k < i; k++) if (!(rows[k].vendorName ?? '').trim()) rows[k].vendorName = v;
      last = i;
    });
    const added = rows.map((r) => {
      const l = recognize({ ...newLine(), ...r } as ReqLine);
      if (l.srcItem && !l.aliasHit) nextCands[l.key] = suggestPairs(l.srcItem, l.srcSpec ?? '');
      if (l.vendorName && !l.vendorId) {
        const v = vendors.data.find((x) => sameVendor(l.vendorName!, x.name, x.aliases));
        if (v) Object.assign(l, { vendorId: v.id, vendorName: v.name });
      }
      if (!l.orderPrice) Object.assign(l, suggest(l));
      Object.assign(l, autoCat(l));
      if (d.zoneId) {
        const keepQty = { contractQty: l.contractQty, execQty: l.execQty };
        Object.assign(l, baseFill(l));
        // 엑셀에 계약·실행 수량이 적혀 있으면 그 값을 우선
        if (keepQty.contractQty) l.contractQty = keepQty.contractQty;
        if (keepQty.execQty) l.execQty = keepQty.execQty;
      }
      return l;
    });
    setD((x) => x && { ...x, lines: [...x.lines.filter((l) => l.itemName.trim()), ...added] });
    setCands((c) => ({ ...c, ...nextCands }));
    return { fix: added.filter((l) => l.srcItem && !l.aliasHit && invalidLine(l)).length, auto: added.filter((l) => l.aliasHit).length };
  };

  /** 청구서에 적힌 현장 표기 → ERP 현장 (이름·정식명·다른 표기·묶음명 + 기계/소방 구분) */
  const findSiteByLabel = (labels: string[]) => {
    const trade = labels.some((x) => /소방/.test(x)) ? '소방' : labels.some((x) => /기계/.test(x)) ? '기계' : undefined;
    for (const label of labels) {
      const k = nameKey(label);
      if (!k) continue;
      const exact = sites.data.filter((s) => [s.name, s.fullName, ...(s.aliases ?? [])].some((x) => x && nameKey(x) === k));
      const hit = exact.length
        ? exact
        : sites.data.filter((s) => [s.name, s.fullName, s.groupName ?? '', ...(s.aliases ?? [])].some((x) => x && looselyEqual(x, label)));
      if (hit.length === 1) return { site: hit[0] };
      if (hit.length > 1) {
        const t = trade && hit.filter((s) => s.trade === trade);
        if (t && t.length === 1) return { site: t[0] };
        return { many: hit }; // 기계/소방처럼 여러 현장이 맞으면 직접 고르게 한다
      }
    }
    return {};
  };

  const onExcel = async (file?: File) => {
    if (!file) return;
    try {
      const p = parseReqSheet(readWorkbook(await file.arrayBuffer()));
      if (!p.lines.length) return toast('청구서 시트에 품목이 없습니다.', 'err');
      // 청구서의 현장명(B4 "현장명 : ○○ 현장", 오른쪽 위 U2)으로 현장 자동 선택
      const { site, many } = findSiteByLabel([p.siteLabel, p.siteLabel2].filter(Boolean) as string[]);
      let siteMsg = '';
      if (site && site.id !== d.siteId) {
        if (d.id) siteMsg = ` 청구서 현장(${site.name})이 지금 현장과 다릅니다. 저장된 청구서는 현장을 바꿀 수 없으니 확인하세요.`;
        else {
          const def = defaultSteps(site.id);
          setD((x) => x && { ...x, siteId: site.id, siteName: site.name, approvalType: def.type, steps: def.steps });
          siteMsg = ` 현장을 "${site.name}"(으)로 골랐습니다.`;
        }
      } else if (many) siteMsg = ` "${p.siteLabel}"에 맞는 현장이 여러 개입니다(${many.map((s) => s.name).join(', ')}). 현장을 직접 고르세요.`;
      else if (!site && p.siteLabel) siteMsg = ` 청구서 현장명 "${p.siteLabel}"과 맞는 현장을 찾지 못했습니다. 현장을 직접 고르세요.`;
      const rec = addFromRows(p.lines);
      setD((x) => x && { ...x, usePurpose: x.usePurpose || p.purpose || undefined, requestDate: x.requestDate || p.docDate || today() });
      const recMsg = (rec.auto ? ` 다른 표기 ${rec.auto}줄은 기준 품명·규격으로 자동 인식했습니다.` : '') + (rec.fix ? ` ${rec.fix}줄은 품명·규격을 알아보지 못했습니다 — "내역·규격 수정 요함" 줄을 고쳐 주세요.` : '');
      toast(`${p.lines.length}줄을 가져왔습니다.${recMsg}${siteMsg}`, rec.fix || (!site && p.siteLabel) ? 'err' : undefined);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const pasteRows = pasteText
    .split(/\r?\n/)
    .map((x) => x.split('\t'))
    .filter((c) => c[0]?.trim())
    .map((c) => ({ itemName: c[0].trim(), spec: (c[1] ?? '').trim(), unit: (c[2] ?? '').trim(), reqQty: num(c[3]), remark: (c[4] ?? '').trim() || undefined, location: (c[5] ?? '').trim() || undefined }));

  /** 거래선 목록: 등록된 업체 전부 (사용 중인 업체 먼저) */
  const vendorOptions = [...vendors.data].sort((a, b) => Number(a.active === false) - Number(b.active === false) || a.name.localeCompare(b.name, 'ko'));
  const NONE = '(없음)';
  const vLabel = (v: Vendor) => (v.active === false ? `${v.name} (사용 중지)` : v.name);
  const vendorLabels = [NONE, ...vendorOptions.map(vLabel)];
  const catLabels = [NONE, ...siteCats.map((c) => c.name)];

  /**
   * 첫 줄과 마지막 줄 값이 같으면 사이의 빈 줄도 같은 값으로 (엑셀 청구서의 " 표시처럼)
   * - 방금 고른 줄 위·아래로 가장 가까운 값이 있는 줄을 찾아, 같은 값이면 그 사이 빈 줄을 채운다
   */
  const fillBetween = (lines: ReqLine[], idx: number, get: (l: ReqLine) => string, patch: Partial<ReqLine>, canEdit: (l: ReqLine) => boolean): ReqLine[] => {
    const val = get(lines[idx]);
    if (!val) return lines;
    const out = [...lines];
    const isBlank = (l: ReqLine) => !!l.itemName.trim() && !get(l);
    for (const dir of [-1, 1]) {
      let j = idx + dir;
      while (j >= 0 && j < out.length && (isBlank(out[j]) || !out[j].itemName.trim())) j += dir;
      if (j < 0 || j >= out.length || get(out[j]) !== val) continue;
      for (let k = idx + dir; k !== j; k += dir) if (isBlank(out[k]) && canEdit(out[k])) out[k] = { ...out[k], ...patch };
    }
    return out;
  };
  const isLocked = (l: ReqLine) => !!d.id && (d.status === 'pending' || d.status === 'approved') && !!ordered.get(`${d.id}|${l.key}`);
  const pickVendor = (key: string, label: string) => {
    const v = label === NONE ? undefined : vendorOptions.find((x) => vLabel(x) === label);
    setD((x) => {
      if (!x) return x;
      const idx = x.lines.findIndex((l) => l.key === key);
      if (idx < 0) return x;
      const patch = { vendorId: v?.id, vendorName: v?.name };
      let lines = x.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l));
      if (v) lines = fillBetween(lines, idx, (l) => l.vendorId ?? '', patch, (l) => !isLocked(l));
      // 거래선을 바꾸면 자동으로 불러온 단가는 그 업체 단가로 다시 불러온다 (직접 입력·엑셀 단가는 그대로)
      if (v)
        lines = lines.map((l, i) => {
          const before = x.lines[i];
          if (!l.itemName || isLocked(l) || before?.vendorId === l.vendorId) return l;
          if (l.orderPrice && (l.priceSource === '직접입력' || l.priceSource === '엑셀' || !l.priceSource)) return l;
          const base = { ...l, orderPrice: 0, priceSource: undefined };
          return { ...base, ...suggest(base) };
        });
      return { ...x, lines };
    });
  };
  const pickCat = (key: string, label: string) => {
    const c = label === NONE ? undefined : siteCats.find((x) => x.name === label);
    setD((x) => {
      if (!x) return x;
      const idx = x.lines.findIndex((l) => l.key === key);
      if (idx < 0) return x;
      const patch = { siteCategoryId: c?.id, catAuto: undefined };
      let lines = x.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l));
      if (c) lines = fillBetween(lines, idx, (l) => l.siteCategoryId ?? '', patch, (l) => !isLocked(l));
      // 분류가 바뀌면 대리점이 달라질 수 있다: 대리점 단가로 불러온 줄은 다시 불러온다
      lines = lines.map((l, i) => {
        if (l.priceSource !== '대리점' || isLocked(l) || l.siteCategoryId === x.lines[i]?.siteCategoryId) return l;
        const base = { ...l, vendorId: undefined, vendorName: undefined, orderPrice: 0, priceSource: undefined };
        return { ...base, ...suggest(base) };
      });
      return { ...x, lines };
    });
  };
  const catName = (cid?: string) => cats.data.find((c) => c.id === cid)?.name;

  /**
   * 드롭다운 칸 붙여넣기 (품명·규격·거래선·분류)
   *  - 한 칸이면 그 줄, 여러 줄이면 아래 줄로 차례로 (줄이 모자라면 줄 추가)
   *  - 품명 칸에 '품명 ⇥ 규격' 2칸을 붙여넣으면 규격까지 같이
   *  - 목록에 없는 값은 건너뛴다 (발주된 줄도 건너뜀)
   */
  const pasteDown = (startKey: string, col: 'item' | 'spec' | 'vendor' | 'cat', rows: string[][]) => {
    const start = d.lines.findIndex((l) => l.key === startKey);
    if (start < 0 || !rows.length) return;
    // 줄을 여러 개 골라 둔 상태에서 값 하나를 붙여넣으면 고른 줄 모두에
    if (rows.length === 1 && pickRows.size > 1 && pickRows.has(startKey)) {
      const targets = d.lines.map((l, i) => (pickRows.has(l.key) ? i : -1)).filter((i) => i >= 0);
      return pasteAt(targets, col, targets.map(() => rows[0]));
    }
    return pasteAt(rows.map((_, i) => start + i), col, rows);
  };
  /** 아래로 채우기: 이 줄의 품명·규격(단위)을 아래 줄들에 (빈 줄이 이어지면 거기까지, 없으면 몇 줄인지 물어봄) */
  const fillDown = (key: string) => {
    const i = d.lines.findIndex((l) => l.key === key);
    const src = d.lines[i];
    if (i < 0 || !src?.itemName) return;
    let n = 0;
    while (i + 1 + n < d.lines.length && !d.lines[i + 1 + n].itemName.trim()) n++;
    if (!n) {
      const a = prompt(`"${src.itemName} ${src.spec}"을(를) 아래 몇 줄에 채울까요? (모자라면 줄을 추가합니다)`, '1');
      n = Math.max(0, Math.min(200, Math.floor(Number(a) || 0)));
      if (!n) return;
    }
    const cells = [src.itemName, src.spec];
    pasteAt(Array.from({ length: n }, (_, k) => i + 1 + k), 'item', Array.from({ length: n }, () => cells));
    toast(`아래 ${n}줄에 "${src.itemName} ${src.spec}"을(를) 채웠습니다. (되돌리기 Ctrl+Z)`);
  };
  const pasteAt = (targets: number[], col: 'item' | 'spec' | 'vendor' | 'cat', rows: string[][]) => {
    const find = (opts: string[], v: string) => (v ? opts.find((o) => nameKey(o) === nameKey(v)) : undefined);
    const lines = [...d.lines];
    const touched: string[] = [];
    let ok = 0;
    let skip = 0;
    rows.forEach((cells, i) => {
      const idx = targets[i];
      while (idx >= lines.length) lines.push(newLine());
      const l = lines[idx];
      const a = cells[0] ?? '';
      const b = cells[1] ?? '';
      if (isLocked(l) || (!a && !(col === 'item' && b))) return void (a && skip++);
      if (col === 'item' || col === 'spec') {
        const item = col === 'item' ? find(itemOptions, a) : l.itemName;
        if (!item) return void skip++;
        const specIn = col === 'item' ? b : a;
        const spec = specIn ? find(specOptions(item), specIn) : col === 'item' && l.spec && specOk(item, l.spec) ? l.spec : '';
        if (col === 'spec' && !spec) return void skip++;
        if (specIn && !spec) skip++;
        const us = spec ? unitsOf(item, spec) : undefined;
        lines[idx] = { ...l, itemName: item, spec: spec ?? '', aliasHit: undefined, ...(us?.size === 1 ? { unit: [...us][0] } : {}), ...resetAuto(l) };
        touched.push(l.key);
      } else if (col === 'vendor') {
        const v = vendorOptions.find((x) => nameKey(x.name) === nameKey(a) || nameKey(vLabel(x)) === nameKey(a) || x.aliases?.some((al) => nameKey(al) === nameKey(a)));
        if (!v && a !== NONE) return void skip++;
        lines[idx] = { ...l, vendorId: v?.id, vendorName: v?.name };
      } else {
        const c = siteCats.find((x) => nameKey(x.name) === nameKey(a));
        if (!c && a !== NONE) return void skip++;
        lines[idx] = { ...l, siteCategoryId: c?.id, catAuto: undefined };
      }
      ok++;
    });
    setD((x) => x && { ...x, lines });
    touched.forEach((k) => autoPrice(k));
    if (targets.length > 1 || skip) toast(`${ok}칸 붙여넣었습니다.${skip ? ` 목록에 없는 ${skip}칸은 건너뛰었습니다 (빨간 칸이 없게 목록 값으로 붙여넣으세요).` : ''}`, skip ? 'err' : undefined);
  };

  /** 세대 청구: 세대수·타입 → 금회청구 = 세대수 × 세대당 수량 (발주수량도 같이) */
  const setHh = (key: string, patch: { hhCount?: number; hhType?: string }) => {
    const l = d.lines.find((x) => x.key === key);
    const rule = l && hhRuleFor(hh.data, l.itemName, l.spec);
    if (!l || !rule) return;
    const count = patch.hhCount ?? l.hhCount ?? 0;
    const type = rule.byType ? (patch.hhType ?? l.hhType ?? hh.data?.types.find((t) => (rule.perType?.[t] ?? 0) > 0)) : undefined;
    const per = hhPerOf(rule, type);
    const qty = Math.round(count * per * 100) / 100;
    setLine(key, { hhCount: count, hhType: type, hhPer: per, hhUnit: rule.unit, unit: rule.unit || l.unit, reqQty: qty, orderQty: qty });
  };

  /** 기존 청구서 불러오기: 고른 줄을 지금 청구서 아래에 추가 (수량은 비우고, 단가·자재분류는 이 현장 기준으로 다시 자동) */
  const addFromReq = (src: ReqLine[], from: Requisition) => {
    const same = from.siteId === d.siteId;
    const add: ReqLine[] = src.map((l) => ({
      ...newLine(),
      itemName: l.itemName,
      spec: l.spec,
      unit: l.unit,
      note: l.note,
      remark: l.remark,
      vendorId: l.vendorId,
      vendorName: l.vendorName,
      // 자재분류는 현장마다 달라서 같은 현장일 때만 그대로
      ...(same && l.siteCategoryId ? { siteCategoryId: l.siteCategoryId, catAuto: l.catAuto } : {}),
      ...(same ? { contractQty: l.contractQty || 0, contractPrice: l.contractPrice || 0, execQty: l.execQty || 0 } : {}),
    }));
    setD((x) => x && { ...x, lines: [...x.lines.filter((l) => l.itemName.trim()), ...add] });
    add.forEach((l) => autoPrice(l.key));
    setImportOpen(false);
    toast(`${from.siteName} ${from.docNo || from.requestDate} 청구서에서 ${add.length}줄을 불러왔습니다. 금회청구 수량을 넣어 주세요.`);
  };

  /** 회사 청구서 양식(엑셀)으로 내려받기 */
  const downloadForm = async () => {
    try {
      setBusy(true);
      const [{ default: ExcelJS }, tpl, logo] = await Promise.all([
        import('exceljs'),
        fetch('/templates/req-form.xlsx').then((r) => r.arrayBuffer()),
        fetch('/templates/logo.png').then((r) => r.arrayBuffer()),
      ]);
      const req = { ...(build({}) as Requisition), id: d.id ?? '' };
      const sumX = reqSummary(req, cats.data, reqs.data, pos.data);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(tpl);
      const { truncated } = fillReqForm(wb, req, sumX, logo, signs.byId, new Map(cats.data.map((c) => [c.id, c.name])), siteCats);
      const blob = new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `구매청구서_${req.siteName}_${req.docNo || req.requestDate}.xlsx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      if (truncated) toast(`양식은 167줄까지라 ${truncated}줄은 빠졌습니다.`, 'err');
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  /** 발주수량은 금회청구 수량을 넘을 수 없다 */
  const setQty = (key: string, field: keyof ReqLine, n: number) => {
    const l = d.lines.find((x) => x.key === key);
    if (l && field === 'orderQty' && n > (l.reqQty || 0)) {
      toast(`발주수량은 금회청구 수량(${(l.reqQty || 0).toLocaleString()})보다 클 수 없습니다.`, 'err');
      return setLine(key, { orderQty: l.reqQty || 0 });
    }
    // 금회청구를 줄이면 그보다 큰 발주수량도 같이 줄임
    if (l && field === 'reqQty' && (l.orderQty || 0) > n) return setLine(key, { reqQty: n, orderQty: n });
    setLine(key, { [field]: n } as Partial<ReqLine>);
  };
  const N = (key: string, field: keyof ReqLine, v: number, on: boolean | undefined, w = 'w-20', bad = false) =>
    on ? (
      <NumInput className={`input h-7 ${w} px-1.5 text-right ${bad ? 'border-red-400 bg-red-50 text-red-700' : ''}`} value={v} onChange={(n) => setQty(key, field, n)} />
    ) : (
      <span className="tabular-nums">{v ? v.toLocaleString() : ''}</span>
    );
  /* ───── 줄 순서·빠른 편집 ───── */
  const moveTo = (key: string, toKey: string) =>
    setD((x) => {
      if (!x || key === toKey) return x;
      const ls = [...x.lines];
      const from = ls.findIndex((l) => l.key === key);
      const to = ls.findIndex((l) => l.key === toKey);
      if (from < 0 || to < 0) return x;
      const [m] = ls.splice(from, 1);
      ls.splice(to, 0, m);
      return { ...x, lines: ls };
    });
  const moveBy = (key: string, dir: -1 | 1) => {
    const i = d.lines.findIndex((l) => l.key === key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= d.lines.length) return;
    moveTo(key, d.lines[j].key);
  };
  /** 바로 아래에 빈 줄 / 같은 내용 복사 줄 */
  const insertBelow = (key: string, copy: boolean) =>
    setD((x) => {
      if (!x) return x;
      const i = x.lines.findIndex((l) => l.key === key);
      const src = x.lines[i];
      const nl: ReqLine = copy ? { ...src, key: newLine().key, reqQty: 0, orderQty: 0, priorQtyManual: undefined, srcItem: undefined, srcSpec: undefined, aliasHit: undefined } : newLine();
      const ls = [...x.lines];
      ls.splice(i + 1, 0, nl);
      return { ...x, lines: ls };
    });
  /** 줄 정렬 (품명·규격 / 자재분류 / 거래선 / 사용 위치) — 빈 줄은 맨 아래 */
  const sortLines = (by: string) => {
    if (!by) return;
    const sz = (sp: string) => {
      const m = sp.match(/(\d+(?:\.\d+)?)/);
      return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
    };
    const catOrder = (id?: string) => {
      const c = siteCats.find((x) => x.id === id);
      return c ? c.order : 1e9;
    };
    const byItem = (a: ReqLine, b: ReqLine) => a.itemName.localeCompare(b.itemName, 'ko') || sz(a.spec) - sz(b.spec) || a.spec.localeCompare(b.spec, 'ko');
    const cmp: Record<string, (a: ReqLine, b: ReqLine) => number> = {
      item: byItem,
      cat: (a, b) => catOrder(a.siteCategoryId) - catOrder(b.siteCategoryId) || byItem(a, b),
      vendor: (a, b) => (a.vendorName ?? '힣').localeCompare(b.vendorName ?? '힣', 'ko') || byItem(a, b),
      location: (a, b) => (a.location ?? '힣').localeCompare(b.location ?? '힣', 'ko') || byItem(a, b),
    };
    setD((x) => {
      if (!x) return x;
      const filled = x.lines.filter((l) => l.itemName.trim());
      const empty = x.lines.filter((l) => !l.itemName.trim());
      return { ...x, lines: [...[...filled].sort(cmp[by]), ...empty] };
    });
  };
  /** 숫자 칸에서 Enter → 아래 줄 같은 칸으로 (수량을 빠르게 입력) */
  const enterDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const el = e.target as HTMLElement;
    if (!(el instanceof HTMLInputElement) || !el.classList.contains('text-right')) return;
    const td = el.closest('td');
    const tr = td?.parentElement as HTMLTableRowElement | null;
    if (!td || !tr) return;
    const idx = Array.from(tr.children).indexOf(td);
    let next = tr.nextElementSibling as HTMLTableRowElement | null;
    while (next) {
      const inp = next.children[idx]?.querySelector('input.text-right') as HTMLInputElement | null;
      if (inp) {
        e.preventDefault();
        inp.focus();
        inp.select();
        return;
      }
      next = next.nextElementSibling as HTMLTableRowElement | null;
    }
  };
  /** 긴 글 칸(비고·사용 위치): 한 단계 작은 글씨, 칸을 넘으면 2·3줄로 늘어남 */
  const TA = (key: string, field: keyof ReqLine, v: string | undefined, on: boolean | undefined, placeholder = '') =>
    on ? (
      <textarea
        rows={1}
        className="input block h-auto min-h-7 w-full resize-none px-1.5 py-1 !text-[11px] leading-[1.35]"
        style={{ fieldSizing: 'content' } as React.CSSProperties}
        placeholder={placeholder}
        value={v ?? ''}
        onChange={(e) => setLine(key, { [field]: e.target.value } as Partial<ReqLine>)}
        onInput={(e) => {
          const t = e.currentTarget;
          if (!CSS.supports?.('field-sizing', 'content')) {
            t.style.height = 'auto';
            t.style.height = `${t.scrollHeight + 2}px`;
          }
        }}
      />
    ) : (
      <span className="block whitespace-pre-wrap break-words text-[11px] leading-[1.35]">{v}</span>
    );
  const T = (key: string, field: keyof ReqLine, v: string | undefined, on: boolean | undefined, w = 'w-28', extra: object = {}) =>
    on ? <input className={`input h-7 ${w} px-1.5`} value={v ?? ''} onChange={(e) => setLine(key, { [field]: e.target.value } as Partial<ReqLine>)} {...extra} /> : <span>{v}</span>;

  return (
    <div>
      <PageHeader
        title={isNew ? '구매청구서 작성' : `구매청구서 ${d.docNo || ''}`}
        desc={d.id ? `${d.siteName} · 작성 ${d.createdByName}` : '품목을 입력하고 결재를 올리세요. 단가는 최신 계산서 단가(이 현장 → 전체) → 단가표 → 직전 발주 순으로 자동으로 채웁니다.'}
        actions={
          <>
            <Link to="/req" className="btn-ghost">
              목록
            </Link>
            <button className="btn-ghost" onClick={() => setPreview(true)}>
              미리보기
            </button>
            {d.id && (
              <button className="btn-ghost" disabled={busy} onClick={downloadForm}>
                엑셀 다운로드
              </button>
            )}
            {(draftEditable || can('admin')) && d.id && (
              <button className="btn-danger" onClick={remove}>
                삭제
              </button>
            )}
            {pendEditable && (
              <button className="btn-primary" data-req-save={draftEditable ? undefined : ''} disabled={busy} onClick={savePending}>
                수정 저장
              </button>
            )}
            {draftEditable && (
              <>
                <button className="btn-ghost" data-req-save disabled={busy} title="서버에 저장 (Ctrl+S) — 결재는 올리지 않음" onClick={() => save({}, '임시 저장', '임시 저장했습니다. 구매청구 목록의 작성중에서 다시 열 수 있습니다.')}>
                  임시 저장
                </button>
                <button className="btn-primary" disabled={busy} onClick={submit}>
                  결재 올리기
                </button>
              </>
            )}
            {adminAfterApproval && (
              <button
                className="btn-primary"
                data-req-save=""
                disabled={busy}
                title="승인 완료 후 관리자 수정: 거래선·발주 단가만 (발주된 줄은 발주서에서 고치세요)"
                onClick={() => {
                  const before = reqs.data.find((r) => r.id === d.id);
                  const old = new Map((before?.lines ?? []).map((l) => [l.key, l]));
                  const ch = d.lines.filter((l) => {
                    const o = old.get(l.key);
                    return o && ((o.orderPrice || 0) !== (l.orderPrice || 0) || (o.vendorId || '') !== (l.vendorId || ''));
                  });
                  if (!ch.length) return toast('바뀐 거래선·단가가 없습니다.');
                  const txt = ch
                    .slice(0, 3)
                    .map((l) => `${l.itemName} ${l.spec}`.trim())
                    .join(', ');
                  void save({}, `승인 후 관리자 수정(거래선·단가) ${ch.length}줄: ${txt}${ch.length > 3 ? ' …' : ''}`, `거래선·단가 ${ch.length}줄을 저장했습니다. 승인 상태는 그대로입니다.`);
                }}
              >
                거래선·단가 저장
              </button>
            )}
            {myTurn && orderEditable && !pendEditable && (
              <button className="btn-ghost" disabled={busy} onClick={() => save({}, '발주 결의 수정', '저장했습니다.')}>
                발주 결의 저장
              </button>
            )}
            {d.status === 'pending' && d.createdBy === profile?.id && !d.steps.some((s) => (s.result === 'approved' && !s.comment?.startsWith('현장 작성 완료')) || s.result === 'rejected') && (
              <button className="btn-ghost" disabled={busy} onClick={reopen}>
                결재 회수
              </button>
            )}
          </>
        }
      />
      {isSiteRole && d.status === 'pending' && (
        <div className="no-print mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[12.5px] text-sky-900">
          🔒 결재 요청이 끝난 청구서는 현장에서 고칠 수 없습니다.
          {d.createdBy === profile?.id ? ' 본사 결재 전이면 [결재 회수]로 되돌려 고친 뒤 다시 올리세요. 본사 결재가 시작됐으면 자재부에 수정을 요청하거나 반려받은 뒤 고치세요.' : ' 고칠 내용은 자재부에 요청하세요.'}
        </div>
      )}
      {restored && (
        <div className="no-print mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[12.5px] text-sky-900">
          {restored.offer ? (
            <>
              <span>
                저장하지 않은 작성 중 청구서가 있습니다 ({new Date(restored.at).toLocaleString('ko-KR')} · {restored.offer.siteName} · {restored.offer.lines.filter((l) => l.itemName).length}줄).
              </span>
              <button
                className="btn-dark h-7 text-[12px]"
                onClick={() => {
                  setD(restored.offer!);
                  keeper.markDirty();
                  setRestored({ at: restored.at });
                }}
              >
                이어서 쓰기
              </button>
              <button className="btn-ghost h-7 text-[12px]" onClick={() => (dropKept(profile?.id), setRestored(null))}>
                버리기
              </button>
            </>
          ) : (
            <>
              <span>저장하지 않고 나갔던 작성 내용을 불러왔습니다 ({new Date(restored.at).toLocaleString('ko-KR')}). 다 쓰면 임시 저장이나 결재 올리기를 누르세요.</span>
              <button
                className="btn-ghost h-7 text-[12px]"
                onClick={() => {
                  if (!confirm(d.id ? '불러온 작성 내용을 버리고 서버에 저장된 내용으로 되돌릴까요?' : '불러온 작성 내용을 버리고 새로 쓸까요?')) return;
                  dropKept(profile?.id, d.id);
                  keeper.markSaved(d.id);
                  keeper.reset();
                  setRestored(null);
                  if (d.id && stored) setD(structuredClone(stored));
                  else setD(null);
                }}
              >
                {d.id ? '저장된 내용으로 되돌리기' : '버리고 새로 쓰기'}
              </button>
            </>
          )}
        </div>
      )}
      {keepActive && !restored && keeper.dirty && (
        <div className="no-print mb-2 text-right text-[11.5px] text-muted">작성 내용은 이 브라우저에 자동 보관됩니다 — 다른 화면에 갔다 와도 그대로 남습니다. 서버 저장은 [임시 저장]</div>
      )}

      {inTrash && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
          휴지통에 있는 청구서입니다 ({stored?.deletedByName} · {stored?.deletedAt ? new Date(stored.deletedAt).toLocaleString('ko-KR') : ''}). 목록·기반입·집계에서 빠져 있습니다.
          {!readOnly && (stored?.deletedBy === profile?.id || isOffice) && (
            <button className="btn-ghost ml-auto h-7 text-[12px]" disabled={busy} onClick={() => stored && restoreReq(stored, profile?.name ?? '').then(() => toast('복원했습니다.'), (e) => toast(errMsg(e), 'err'))}>
              복원
            </button>
          )}
        </div>
      )}
      {pendEditable && (
        <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[12.5px] text-sky-800">
          결재 중인 청구서입니다. 최종 승인(대표) 전까지 품목·수량·단가 등을 고친 뒤 <b>수정 저장</b>하면 결재는 그대로 이어지고, 바뀐 내용은 진행 기록에 남습니다. 결재선은 바꿀 수 없고, 이미 발주된 줄은 잠겨 있습니다.
        </div>
      )}
      {d.status === 'pending' && preOrdered.length > 0 && (
        <div className="mb-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-[12.5px] text-violet-800">
          결재 중이지만 자재부가 먼저 발주(선발주)한 줄이 {preOrdered.length}개 있습니다: {[...new Set(preOrdered.map((p) => p.poNo))].join(', ')}
        </div>
      )}
      <div className="mb-4 grid gap-4 xl:grid-cols-[1fr_420px]">
        <div className="card grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
          <Field label="현장">
            <select
              className="input"
              value={d.siteId}
              disabled={!draftEditable || !!d.id}
              onChange={(e) => {
                const s = sites.data.find((x) => x.id === e.target.value);
                const def = defaultSteps(e.target.value);
                setD({ ...d, siteId: e.target.value, siteName: s?.name ?? '', approvalType: def.type, steps: def.steps });
              }}
            >
              {sites.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="결의번호" hint={dupDoc ? '⚠ 같은 현장에 같은 결의번호가 있습니다' : undefined}>
            <input className={`input ${dupDoc ? 'border-amber-brand bg-amber-soft' : ''}`} value={d.docNo} disabled={!editable} onChange={(e) => setD({ ...d, docNo: e.target.value })} />
          </Field>
          <Field label="청구일">
            <input className="input" type="date" value={d.requestDate} disabled={!editable} onChange={(e) => setD({ ...d, requestDate: e.target.value })} />
          </Field>
          <Field label="상태">
            <div className="flex h-8 items-center gap-2">
              <StatusChip s={d.status} />
              <span className="text-[12px] text-muted">합계 {won(total)}원</span>
            </div>
          </Field>
          <div className="col-span-2 md:col-span-4">
            <Field label="공정 (구역 · 공종)" hint={!d.zoneId ? '공정을 고르면 기본 청구서(내역)를 불러오고, 계약·실행·기반입·잔여를 이 공정 기준으로 계산합니다.' : undefined}>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="input w-36"
                  value={d.zoneId ?? ''}
                  disabled={!draftEditable}
                  onChange={(e) => setProcess({ zoneId: e.target.value || undefined, ...(e.target.value ? {} : { tradeId: undefined }) })}
                >
                  <option value="">(공정 없음)</option>
                  {sortedZones(pm.master)
                    .filter((z) => z.id === d.zoneId || pm.master.trades.some((t) => procCells.includes(cellKey(z.id, t.id))))
                    .map((z) => (
                      <option key={z.id} value={z.id}>
                        {z.name}
                      </option>
                    ))}
                </select>
                {d.zoneId && (
                  <select className="input w-24" value={d.tradeId ?? ''} disabled={!draftEditable} onChange={(e) => setProcess({ tradeId: e.target.value || undefined })}>
                    <option value="">공종 ▾</option>
                    {sortedTrades(pm.master)
                      .filter((t) => t.id === d.tradeId || procCells.includes(cellKey(d.zoneId!, t.id)))
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                  </select>
                )}
                {(pm.master.zones.find((z) => z.id === d.zoneId)?.subs?.length ?? 0) > 0 && (
                  <select className="input w-24" value={d.zoneSub ?? ''} disabled={!editable} onChange={(e) => setProcess({ zoneSub: e.target.value || undefined })}>
                    <option value="">위치 ▾</option>
                    {pm.master.zones
                      .find((z) => z.id === d.zoneId)!
                      .subs!.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                  </select>
                )}
                {d.zoneId && d.tradeId && (
                  <>
                    <span className="text-[12px] text-muted">
                      기본 청구서 {baseSheet ? `${baseSheet.lines.filter((b) => !b.off).length}품목` : '없음'}
                    </span>
                    {editable && (
                      <button className="btn-dark h-8 text-[12px]" onClick={loadBase}>
                        기본 청구서 불러오기
                      </button>
                    )}
                    <Link className="text-[12px] text-sky-700 hover:underline" to={`/process?site=${d.siteId}&tab=sheet&cell=${encodeURIComponent(cellKey(d.zoneId, d.tradeId))}`}>
                      공정 내역 보기
                    </Link>
                  </>
                )}
              </div>
            </Field>
          </div>
          <div className="col-span-2 md:col-span-4">
            <Field label="사용 목적">
              <input className="input" placeholder="예: 지하주차장 위생배관 / 1~9동" value={d.purpose ?? ''} disabled={!editable} onChange={(e) => setD({ ...d, purpose: e.target.value })} />
            </Field>
          </div>
          <div className="col-span-2 md:col-span-4">
            <Field label="사용 위치·공정">
              <input className="input" placeholder="예: 101~102동 PIT" value={usePurposeOf(d)} disabled={!editable} onChange={(e) => setD({ ...d, usePurpose: e.target.value })} />
            </Field>
          </div>
        </div>

        <div className="card p-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="font-semibold">결재선</span>
            <select
              className="input h-7"
              value={d.approvalType}
              disabled={!draftEditable}
              onChange={(e) => {
                const type = e.target.value as Requisition['approvalType'];
                setD({ ...d, approvalType: type, steps: TEMPLATES[type].map((label) => ({ label })) });
              }}
            >
              <option value="2단계">{TYPE_LABEL['2단계']}</option>
              <option value="6칸">{TYPE_LABEL['6칸']}</option>
            </select>
            {draftEditable && (
              <button className="text-[12px] text-muted hover:text-ink" onClick={() => setD({ ...d, ...(({ type, steps }) => ({ approvalType: type, steps }))(defaultSteps(d.siteId)) })}>
                현장 기본값으로
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {d.steps.map((s, i) => (
              <div
                key={i}
                className={`rounded-lg border px-2 py-1.5 ${s.result === 'skipped' ? 'border-dashed border-line opacity-60' : s.result === 'approved' ? 'border-emerald-300 bg-emerald-50' : s.result === 'rejected' ? 'border-red-300 bg-red-50' : d.status === 'pending' && i === d.currentStep ? 'border-amber-brand bg-amber-soft' : 'border-line'}`}
              >
                <div className="text-[11px] text-muted">
                  {i + 1}. {s.label}
                  {s.result === 'skipped' ? ' · 미지정(건너뜀)' : s.result && ` · ${s.result === 'approved' ? '승인' : '반려'} ${s.at ? new Date(s.at).toLocaleDateString('ko-KR') : ''}`}
                </div>
                {draftEditable ? (
                  <select
                    className="input mt-0.5 h-7 w-full"
                    value={s.userId ?? ''}
                    onChange={(e) => {
                      const u = users.data.find((x) => x.id === e.target.value);
                      setD({ ...d, steps: d.steps.map((x, j) => (j === i ? { ...x, userId: u?.id, userName: u?.name } : x)) });
                    }}
                  >
                    <option value="">미지정 (건너뜀)</option>
                    {users.data
                      .filter((u) => u.active)
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name} ({ROLE_LABEL[u.role]})
                        </option>
                      ))}
                  </select>
                ) : (
                  <div className="font-medium">{s.userName ?? (s.result === 'skipped' || !s.userId ? '미지정' : '-')}</div>
                )}
                {s.comment && <div className="mt-0.5 text-[11.5px] text-muted">“{s.comment}”</div>}
              </div>
            ))}
          </div>
          {myTurn && (
            <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
              <input className="input" placeholder="의견·지시사항 (반려 시 필수, 길게 쓰려면 아래 칸)" value={comment} onChange={(e) => setComment(e.target.value)} />
              <div className="flex gap-2">
                <button className="btn-primary flex-1" disabled={busy} onClick={() => decide('approved')}>
                  {(() => {
                  const j = myDecideStep(d as Requisition, profile?.id, can('admin'));
                  if (j >= 0 && isCeo(d.steps[j].label)) return '최종 승인 (대표)';
                  if (j > d.currentStep) return `전결 승인 (${d.steps[j].label})`;
                  return nextActive(d.steps, j + 1) < 0 ? '최종 승인' : '승인';
                })()}
                </button>
                <button className="btn-danger flex-1" disabled={busy} onClick={() => decide('rejected')}>
                  반려
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="relative border-b border-line px-4 pb-2 pt-3">
          <div className="text-center text-[20px] font-bold tracking-[0.6em] text-navy-950 underline decoration-1 underline-offset-[6px]">구매청구서</div>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-2 text-[12.5px]">
            <span className="font-semibold">
              현장명 : {d.siteName || '-'} 현장{d.zoneId && <span className="ml-3 rounded bg-navy-950 px-2 py-0.5 text-[12px] text-white">{processLabel(pm.master, d)}</span>}
            </span>
            <span className="text-muted">
              결의번호 : 제 <b className="text-ink">{d.requestDate}</b> - <b className="text-ink">{d.docNo || '　'}</b> 호
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="font-semibold">품목 {d.lines.filter((l) => l.itemName).length}줄</span>
          {prices.error && <span className="text-[12px] text-red-600">단가표를 읽지 못했습니다</span>}
          {editable && (
            <div className="ml-auto flex gap-2">
              <button className="btn-ghost h-7 px-2 text-[12px]" disabled={!keeper.canUndo} title="되돌리기 (Ctrl+Z) — 잘못한 작업을 한 단계씩 취소" onClick={keeper.undo}>
                ↶ 되돌리기
              </button>
              <button className="btn-ghost h-7 px-2 text-[12px]" disabled={!keeper.canRedo} title="다시 하기 (Ctrl+Y)" onClick={keeper.redo}>
                ↷
              </button>
              {pickRows.size > 0 && (
                <span className="flex items-center gap-1 rounded-md bg-amber-soft px-2 py-0.5 text-[11.5px] text-amber-900">
                  {pickRows.size}줄 선택 — 고른 줄의 칸에 Ctrl+V 하면 모두에 들어갑니다
                  <button className="ml-1 underline" onClick={() => setPickRows(new Set())}>
                    해제
                  </button>
                </span>
              )}
              <select className="input h-7 w-28 text-[12px]" value="" title="줄 순서 정렬" onChange={(e) => sortLines(e.target.value)}>
                <option value="">줄 정렬 ▾</option>
                <option value="item">품명·규격순</option>
                <option value="cat">자재분류순</option>
                <option value="vendor">거래선순</option>
              </select>
              <button className="btn-ghost h-7 text-[12px]" onClick={() => setD({ ...d, lines: [...d.lines, newLine()] })}>
                + 줄 추가
              </button>
              <button className="btn-ghost h-7 text-[12px]" title="예전에 쓴 청구서의 품목 줄을 골라 아래에 추가" onClick={() => setImportOpen(true)}>
                기존 청구서 불러오기
              </button>
              <button className="btn-ghost h-7 text-[12px]" title="에어컨 매립 동관·멀티튜브, PB난방 롤관 등 세대수로 청구하는 품목의 세대당 수량" onClick={() => setHhOpen(true)}>
                세대당 수량
              </button>
              <button className="btn-ghost h-7 text-[12px]" title="품명·규격 목록에 없는 품목" onClick={() => setNewItem({ itemName: '', spec: '', unit: '', note: '' })}>
                {isOffice ? '+ 새 품목 등록' : '+ 새 품목 요청'}
              </button>
              {draftEditable && (isOffice || sites.data.find((s) => s.id === d.siteId)?.allowReqExcel) && (
                <>
                  <button className="btn-ghost h-7 text-[12px]" onClick={() => setPasteOpen(true)}>
                    엑셀 붙여넣기
                  </button>
                  <label className="btn-ghost h-7 cursor-pointer text-[12px]">
                    청구서 엑셀 불러오기
                    <input type="file" accept=".xlsx,.xls" hidden onChange={(e) => (onExcel(e.target.files?.[0]), (e.target.value = ''))} />
                  </label>
                </>
              )}
            </div>
          )}
        </div>
        {!d.lines.length ? (
          <Empty>품목이 없습니다.</Empty>
        ) : (
          <>
          {/* 폰: 품목 카드 */}
          {!phoneTable && (
            <div className="flex flex-col gap-2 bg-canvas p-2 md:hidden">
              {d.lines
                .filter((l) => l.itemName.trim())
                .map((l) => {
                  const pq = priorOf(l);
                  const remain = l.execQty ? l.execQty - pq - l.reqQty : null;
                  const over = remain != null && remain < 0;
                  return (
                    <div key={l.key} className={`flex flex-col gap-1.5 rounded-xl border bg-white p-3 ${over ? 'border-red-300' : 'border-line'}`}>
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-[14px] font-bold">{l.itemName}</span>
                        <span className="text-right text-[12.5px] text-muted">{l.spec}</span>
                      </div>
                      <div className="grid grid-cols-4 gap-1 text-[11.5px] text-muted">
                        <span>실행 {l.execQty ? l.execQty.toLocaleString() : '-'}</span>
                        <span>기반입 {pq ? pq.toLocaleString() : '-'}</span>
                        <span className="font-bold text-ink">
                          금회 {l.reqQty ? l.reqQty.toLocaleString() : '-'}
                          {l.unit}
                        </span>
                        <span className={over ? 'font-bold text-red-600' : ''}>잔여 {remain == null ? '-' : remain.toLocaleString()}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[12px]">
                        <span className="truncate text-muted">
                          {[l.vendorName, catName(l.siteCategoryId), l.remark].filter(Boolean).join(' · ')}
                          {d.zoneId && !baseByItem.has(itemKey(l.itemName, l.spec)) && <span className="ml-1 text-violet-700">내역 외</span>}
                        </span>
                        <span className="shrink-0 font-semibold">{lineAmount({ ...l, orderQty: l.orderQty || l.reqQty }) ? `${won(lineAmount({ ...l, orderQty: l.orderQty || l.reqQty }))}원` : ''}</span>
                      </div>
                    </div>
                  );
                })}
              <div className="flex items-center justify-between px-1 py-1 text-[13px]">
                <span className="text-muted">합계</span>
                <b>{won(d.lines.reduce((a, l) => a + lineAmount({ ...l, orderQty: l.orderQty || l.reqQty }), 0))}원</b>
              </div>
              <button className="btn-ghost h-10 border-dashed" onClick={() => setPhoneTable(true)}>
                {editable || orderEditable ? '표로 보기 · 수정 (가로로 밀기)' : '표로 보기 (가로로 밀기)'}
              </button>
            </div>
          )}
          {phoneTable && (
            <div className="border-b border-line px-3 py-2 md:hidden">
              <button className="btn-ghost h-9 w-full" onClick={() => setPhoneTable(false)}>
                카드로 보기
              </button>
            </div>
          )}
          <div className={`req-scroll ${phoneTable ? '' : 'hidden md:block'}`}>
            <table ref={reqTblRef} className="tbl req-tbl w-full table-fixed text-[12px]">
              <colgroup>
                <col style={{ width: 40 }} />
                <col style={{ width: '13%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '4.5%' }} />
                <col style={{ width: '4.5%' }} />
                <col style={{ width: '5%' }} />
                <col style={{ width: '4.5%' }} />
                <col style={{ width: '4.5%' }} />
                <col style={{ width: '5%' }} />
                <col style={{ width: '5%' }} />
                <col style={{ width: '4.5%' }} />
                <col style={{ width: '6.5%' }} />
                <col style={{ width: '6%' }} />
                <col style={{ width: '7%' }} />
                <col style={{ width: '13%' }} />
                <col style={{ width: '7%' }} />
                <col style={{ width: '4%' }} />
                {adminMemo.isAdmin && <col style={{ width: '9%' }} />}
                <col style={{ width: editable ? 46 : 36 }} />
              </colgroup>
              <thead className="text-center [&_th]:!text-center [&_th]:align-middle">
                <tr>
                  <th rowSpan={2}>#</th>
                  <th rowSpan={2} className="text-center">품 명</th>
                  <th rowSpan={2} className="text-center">규 격</th>
                  <th rowSpan={2} className="text-center">단위</th>
                  <th colSpan={2} className="text-center">계약내역량</th>
                  <th rowSpan={2} className="bg-red-50 text-center">실행량</th>
                  <th colSpan={2} className="bg-red-50 text-center">청구 및 반입 수량</th>
                  <th rowSpan={2} className="text-center">본/(비고)</th>
                  <th colSpan={3} className="bg-amber-soft text-center">발주 결의 (본사 작성분)</th>
                  <th rowSpan={2} className="bg-amber-soft text-center">거래선</th>
                  <th rowSpan={2} className="text-center">비 고</th>
                  <th rowSpan={2} className="bg-[#eef1f6] text-center">자재분류</th>
                  <th rowSpan={2} className="bg-[#eef1f6] text-center leading-tight">
                    실행
                    <br />
                    잔여
                  </th>
                  {adminMemo.isAdmin && (
                    <th rowSpan={2} className="bg-violet-50 text-center leading-tight text-violet-800" title="관리자만 보이는 메모 (인쇄·엑셀·다른 사용자에게 안 보임)">
                      관리자
                      <br />
                      메모
                    </th>
                  )}
                  <th rowSpan={2}></th>
                </tr>
                <tr>
                  <th className="text-center">수량</th>
                  <th className="text-center">단가</th>
                  <th className="bg-red-50 text-center">기반입</th>
                  <th className="bg-red-50 text-center">금회청구</th>
                  <th className="bg-amber-soft text-center">발주수량</th>
                  <th className="bg-amber-soft text-center">단 가</th>
                  <th className="bg-amber-soft text-center">금 액</th>
                </tr>
              </thead>
              <tbody onKeyDown={enterDown}>
                {d.lines.map((l, i) => {
                  const lump = lumpRows[i];
                  const pq = priorOf(l);
                  // 이미 발주(선발주)된 줄은 고칠 수 없음
                  const locked = !!d.id && d.status === 'pending' && !!ordered.get(`${d.id}|${l.key}`);
                  const rowEd = editable && !locked;
                  const rowOrderEd = orderEditable && !locked;
                  // 거래선: 단가와 달리 현장소장·현장담당도 작성·수정할 수 있을 때 고칠 수 있다
                  const rowVendorEd = rowOrderEd || rowEd;
                  const remain = l.execQty ? l.execQty - pq - l.reqQty : null;
                  return (
                    <tr
                      key={l.key}
                      className={`align-top ${drag?.from === l.key ? 'opacity-40' : ''} ${drag && drag.over === l.key && drag.from !== l.key ? 'outline outline-2 -outline-offset-2 outline-amber-brand' : ''}`}
                      onDragOver={(e) => {
                        if (!drag) return;
                        e.preventDefault();
                        if (drag.over !== l.key) setDrag({ ...drag, over: l.key });
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (drag) moveTo(drag.from, l.key);
                        setDrag(null);
                      }}
                    >
                      <td className="pt-1 text-muted">
                        {editable ? (
                          <div className="flex items-start gap-0.5">
                            <span
                              draggable
                              onDragStart={(e) => {
                                e.dataTransfer.effectAllowed = 'move';
                                e.dataTransfer.setData('text/plain', l.key);
                                setDrag({ from: l.key });
                              }}
                              onDragEnd={() => setDrag(null)}
                              className="cursor-grab select-none pt-1 text-[11px] leading-none active:cursor-grabbing"
                              title="끌어서 줄 순서 바꾸기"
                            >
                              ⋮⋮
                              <div
                                className={`mt-0.5 cursor-pointer rounded text-center ${pickRows.has(l.key) ? 'bg-amber-brand font-bold text-navy-950' : 'hover:bg-amber-soft'}`}
                                title="눌러서 줄 고르기 (Shift+클릭: 범위) — 고른 줄의 칸에 Ctrl+V 하면 고른 줄 모두에 붙여넣기"
                                onClick={(e) => {
                                  const n = new Set(pickRows);
                                  if (e.shiftKey && lastPick.current) {
                                    const a = d.lines.findIndex((x) => x.key === lastPick.current);
                                    const [lo, hi] = a < i ? [a, i] : [i, a];
                                    d.lines.slice(lo, hi + 1).forEach((x) => n.add(x.key));
                                  } else if (n.has(l.key)) n.delete(l.key);
                                  else n.add(l.key);
                                  lastPick.current = l.key;
                                  setPickRows(n);
                                }}
                              >
                                {i + 1}
                              </div>
                            </span>
                            <div className="flex flex-col">
                              <button className="h-4 px-0.5 text-[9px] leading-none hover:text-ink disabled:opacity-30" disabled={i === 0} title="위로" aria-label="위로" onClick={() => moveBy(l.key, -1)}>
                                ▲
                              </button>
                              <button className="h-4 px-0.5 text-[9px] leading-none hover:text-ink disabled:opacity-30" disabled={i === d.lines.length - 1} title="아래로" aria-label="아래로" onClick={() => moveBy(l.key, 1)}>
                                ▼
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="pt-1">{i + 1}</div>
                        )}
                      </td>
                      <td className="text-center [&_input]:text-center">
                        {rowEd ? (
                          <>
                          <PickInput
                            className="w-full"
                            value={l.itemName}
                            options={itemOptions}
                            invalid={!!l.itemName && !itemSet.has(normItem(l.itemName))}
                            placeholder="품명 선택 ▾"
                            onPick={(v) => pickItem(l.key, v)}
                            onPasteRows={(rows) => pasteDown(l.key, 'item', rows)}
                          />
                          {l.itemName && (
                            <button className="float-right -mt-1 text-[10px] leading-none text-sky-700 hover:underline" title="이 품명·규격을 아래 줄에 채우기" onClick={() => fillDown(l.key)}>
                              ↓채우기
                            </button>
                          )}
                          </>
                        ) : (
                          <span className="break-words">{l.itemName}</span>
                        )}
                        {l.itemName && lists.requested.has(itemKey(l.itemName, l.spec)) && <div className="text-[10.5px] text-amber-700" title="자재부 승인 전 품목 (사용은 가능)">품목 등록 요청 중</div>}
                        {d.zoneId && l.itemName && !baseByItem.has(itemKey(l.itemName, l.spec)) && (
                          <div className="text-[10.5px] text-violet-700" title="이 공정 기본 청구서(내역)에 없는 품목 — 추가·대체 자재">내역 외</div>
                        )}
                        {l.srcItem && (invalidLine(l) ? (
                          <div className="mt-0.5 text-[10.5px] leading-tight">
                            <div className="font-semibold text-red-600">내역·규격 수정 요함</div>
                            <div className="text-muted">엑셀: {l.srcItem} {l.srcSpec}</div>
                            {rowEd && (cands[l.key] ?? []).length > 0 && (
                              <div className="mt-0.5 flex flex-wrap gap-1">
                                {(cands[l.key] ?? []).map((c) => (
                                  <button
                                    key={`${c.i}|${c.s}`}
                                    className="rounded border border-navy-900/20 bg-white px-1 py-0.5 text-navy-900 hover:bg-amber-soft"
                                    title="이 품명·규격으로 바꾸기"
                                    onClick={() => {
                                      setLine(l.key, { itemName: c.i, spec: c.s, ...resetAuto(l) });
                                      autoPrice(l.key);
                                    }}
                                  >
                                    {c.i} {c.s}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : l.aliasHit ? (
                          <div className="mt-0.5 text-[10.5px] leading-tight text-sky-700" title={`엑셀: ${l.srcItem} ${l.srcSpec ?? ''}`}>
                            다른 표기 자동 인식 (엑셀: {l.srcItem} {l.srcSpec})
                          </div>
                        ) : (
                          <div className="mt-0.5 text-[10.5px] leading-tight text-emerald-700" title={`엑셀: ${l.srcItem} ${l.srcSpec ?? ''}`}>
                            수정됨 (엑셀: {l.srcItem} {l.srcSpec}){isOffice && editable ? ' · 저장하면 기억' : ''}
                          </div>
                        ))}
                      </td>
                      <td className="text-center [&_input]:text-center">
                        {rowEd ? (
                          <PickInput
                            className="w-full"
                            value={l.spec}
                            options={specOptions(l.itemName)}
                            invalid={!!l.spec && !specOk(l.itemName, l.spec)}
                            placeholder={l.itemName ? '규격 ▾' : '품명 먼저'}
                            onPick={(v) => pickSpec(l.key, l.itemName, v)}
                            onPasteRows={(rows) => pasteDown(l.key, 'spec', rows)}
                          />
                        ) : (
                          <span className="break-words">{l.spec}</span>
                        )}
                      </td>
                      <td>
                        {T(l.key, 'unit', l.unit, rowEd, 'w-full !px-1 text-center', { list: `unit-${l.key}` })}
                        {rowEd && (
                          <datalist id={`unit-${l.key}`}>
                            {unitOptions(l.itemName, l.spec).map((x) => (
                              <option key={x} value={x} />
                            ))}
                          </datalist>
                        )}
                      </td>
                      {lump ? (
                        <>
                        {lump.span > 0 && (
                          <>
                            <td rowSpan={lump.span} className="bg-sky-50/60 text-center align-middle font-semibold" title={`${lump.name}: 투입집계 변경예상금액(없으면 도급금액)`}>
                              1식
                            </td>
                            <td rowSpan={lump.span} className="num bg-sky-50/60 align-middle font-semibold">
                              {lump.amount ? <span className="fit-text">{lump.amount.toLocaleString()}</span> : <span className="text-[11px] font-normal text-amber-700">금액 없음</span>}
                            </td>
                          </>
                        )}
                        {/* 실행은 1식이어도 줄마다 따로 */}
                        <td className="num">{N(l.key, 'execQty', l.execQty, rowEd, 'w-full')}</td>
                        </>
                      ) : (
                        <>
                          <td className="num">{N(l.key, 'contractQty', l.contractQty, rowEd, 'w-full')}</td>
                          <td className="num">{N(l.key, 'contractPrice', l.contractPrice, rowEd, 'w-full')}</td>
                          <td className="num">{N(l.key, 'execQty', l.execQty, rowEd, 'w-full')}</td>
                        </>
                      )}
                      <td className="num pt-2 text-muted" title={l.priorQtyManual != null ? '엑셀에서 받은 값' : '이전 승인 청구 합계'}>
                        <span className="fit-text">{pq ? pq.toLocaleString() : ''}</span>
                      </td>
<td className="num font-semibold">
                        {(() => {
                          const rule = hhRuleFor(hh.data, l.itemName, l.spec);
                          if (rule && rowEd) {
                            const per = hhPerOf(rule, rule.byType ? l.hhType : undefined);
                            return (
                              <div className="flex flex-col items-stretch gap-0.5" title="세대수 × 세대당 수량">
                                {rule.byType && (
                                  <select className="input h-6 px-0.5 text-[11px]" value={l.hhType ?? ''} onChange={(e) => setHh(l.key, { hhType: e.target.value })}>
                                    <option value="">타입</option>
                                    {(hh.data?.types ?? []).map((t) => (
                                      <option key={t} value={t}>
                                        {t} ({rule.perType?.[t] ?? 0}
                                        {rule.unit})
                                      </option>
                                    ))}
                                  </select>
                                )}
                                <div className="flex items-center gap-0.5">
                                  <NumInput className="input h-6 w-full min-w-0 px-1 text-right" value={l.hhCount ?? 0} onChange={(n) => setHh(l.key, { hhCount: n })} />
                                  <span className="shrink-0 text-[10.5px] font-normal text-muted">세대</span>
                                </div>
                                <div className={`text-right text-[11px] ${l.hhCount && !l.hhPer ? 'text-red-600' : 'text-navy-900'}`}>
                                  {l.hhCount && !per ? '세대당 수량 미설정' : `${(l.reqQty || 0).toLocaleString()}${rule.unit}`}
                                </div>
                              </div>
                            );
                          }
                          if (isHhLine(l))
                            return (
                              <div className="leading-tight">
                                <div className="text-[11px] font-normal text-muted">{l.hhCount}세대{l.hhType ? `(${l.hhType})` : ''}</div>
                                <div className="fit-text">{(l.reqQty || 0).toLocaleString()}</div>
                              </div>
                            );
                          return N(l.key, 'reqQty', l.reqQty, rowEd, 'w-full');
                        })()}
                      </td>
                                            <td>
                        <BonCell l={l} edit={rowEd} onSet={(v) => setLine(l.key, { bonLen: v })} />
                        {rowEd || l.note ? T(l.key, 'note', l.note, rowEd, 'w-full', { placeholder: bonText(l) ? '(비고)' : '' }) : null}
                      </td>
<td className={`num ${overOrder(l) ? 'bg-red-50 font-semibold text-red-700' : 'bg-amber-soft/40'}`} title={overOrder(l) ? '발주수량이 금회청구보다 많습니다' : undefined}>
                        {N(l.key, 'orderQty', l.orderQty || l.reqQty, rowOrderEd && !adminAfterApproval, 'w-full', overOrder(l))}
                      </td>
                      <td className="num bg-amber-soft/40">
                        <div className="flex items-center justify-end gap-0.5">
                          {N(l.key, 'orderPrice', l.orderPrice, rowOrderEd, 'w-full min-w-0')}
                          {rowOrderEd && l.itemName && (
                            <button className="shrink-0 text-[11px] text-amber-700 hover:underline" onClick={() => setPriceFor(l.key)} title="단가 후보 보기">
                              ▾
                            </button>
                          )}
                        </div>
                        {l.priceSource && <div className={`text-right text-[10px] ${l.priceSource === '지정단가' ? 'font-semibold text-violet-700' : l.priceSource === '대리점' ? 'font-semibold text-teal-700' : 'text-muted'}`}>{l.priceSource}</div>}
                        {!l.orderPrice && l.itemName && l.vendorId && (
                          <button className="block w-full text-right text-[10px] font-semibold text-red-600 enabled:hover:underline" disabled={!rowOrderEd} onClick={() => setPriceFor(l.key)} title={rowOrderEd ? '다른 업체 단가 보기' : '자재부가 단가를 넣습니다'}>
                            이 거래선 단가 없음
                          </button>
                        )}
                      </td>
                      <td className="num bg-amber-soft/40 pt-2">
                        <span className="fit-text">{won(lineAmount({ ...l, orderQty: l.orderQty || l.reqQty }))}</span>
                      </td>
                      <td className="fit bg-amber-soft/40">
                        {rowVendorEd ? (
                          <PickInput
                            className="w-full"
                            value={l.vendorName ?? ''}
                            options={vendorLabels}
                            placeholder="거래선 ▾"
                            onPick={(label) => pickVendor(l.key, label)}
                            onPasteRows={(rows) => pasteDown(l.key, 'vendor', rows)}
                          />
                        ) : (
                          <span className="fit-text">{l.vendorName}</span>
                        )}
                      </td>
                                            <td>{TA(l.key, 'remark', l.remark, rowEd)}</td>
                      <td className="fit">
                        {rowEd ? (
                          <PickInput
                            className="w-full"
                            value={catName(l.siteCategoryId) ?? ''}
                            options={catLabels}
                            placeholder="분류 ▾"
                            onPick={(label) => pickCat(l.key, label)}
                            onPasteRows={(rows) => pasteDown(l.key, 'cat', rows)}
                          />
                        ) : (
                          <span className="fit-text">{catName(l.siteCategoryId)}</span>
                        )}
                      </td>
                      <td className={`num pt-2 ${remain != null && remain < 0 ? 'font-semibold text-red-600' : 'text-muted'}`}><span className="fit-text">{remain == null ? '' : remain.toLocaleString()}</span></td>
                      {adminMemo.isAdmin && (
                        <td>
                          {l.itemName && <AdminMemoInput reqId={d.id} lineKey={l.key} itemName={l.itemName} spec={l.spec} memos={adminMemo.map} />}
                        </td>
                      )}
                      <td className="pt-1.5">
                        {d.id && ordered.get(`${d.id}|${l.key}`) && (
                          <Link to={`/po/${ordered.get(`${d.id}|${l.key}`)!.id}`} className="block truncate text-[10.5px] text-emerald-700 hover:underline" title={ordered.get(`${d.id}|${l.key}`)!.poNo}>
                            {ordered.get(`${d.id}|${l.key}`)!.poNo.slice(-9)}
                          </Link>
                        )}
                        {editable && (
                          <div className="flex items-center gap-1">
                            <button className="text-[11px] text-muted hover:text-ink" title="아래에 빈 줄 넣기" aria-label="아래에 빈 줄 넣기" onClick={() => insertBelow(l.key, false)}>
                              ＋
                            </button>
                            <button className="text-[11px] text-muted hover:text-ink" title="이 줄 복사 (아래에, 수량은 비움)" aria-label="줄 복사" onClick={() => insertBelow(l.key, true)}>
                              ⧉
                            </button>
                            {rowEd && (
                              <button className="text-muted hover:text-red-600" onClick={() => setD({ ...d, lines: d.lines.filter((x) => x.key !== l.key) })} aria-label="줄 삭제" title="줄 삭제">
                                ✕
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                <tr className="req-total bg-[#f7f8fb] font-semibold">
                  <td colSpan={12} className="text-right">
                    합계
                  </td>
                  <td className="num">{won(d.lines.reduce((a, l) => a + lineAmount({ ...l, orderQty: l.orderQty || l.reqQty }), 0))}</td>
                  <td colSpan={adminMemo.isAdmin ? 7 : 6}></td>
                </tr>
              </tbody>
            </table>
            {/* 종이 양식과 같은 결재란 */}
            <div className="flex flex-wrap items-end justify-between gap-4 border-t border-line px-4 py-3">
              <div className="text-[12.5px]">
                <div>위와 같이 구매 의뢰 합니다.</div>
                <div className="mt-1 text-muted">
                  {d.requestDate} · 합계 <b className="text-ink">{won(d.lines.reduce((a, l) => a + lineAmount({ ...l, orderQty: l.orderQty || l.reqQty }), 0))}</b>원
                </div>
              </div>
              <div className="flex gap-3">
                {(
                  [
                    ['현장', d.steps.map((s, i) => ({ s, i })).filter(({ s }) => /현장/.test(s.label))],
                    ['본사', d.steps.map((s, i) => ({ s, i })).filter(({ s }) => !/현장/.test(s.label))],
                  ] as const
                ).map(([side, list]) =>
                  list.length ? (
                    <div key={side} className="flex border border-navy-900/30">
                      <div className="flex w-6 items-center justify-center border-r border-navy-900/30 bg-[#f7f8fb] text-[11.5px] font-semibold [writing-mode:vertical-rl]">{side}</div>
                      {list.map(({ s, i }) => (
                        <div key={i} className="w-[76px] border-r border-navy-900/30 text-center last:border-r-0">
                          <div className="border-b border-navy-900/30 bg-[#f7f8fb] py-0.5 text-[11px]">{s.label.replace(/^(현장|본사)\s*/, '') || s.label}</div>
                          <div className="flex h-12 flex-col items-center justify-center text-[11.5px]">
                            {s.result === 'skipped' || (!s.userId && s.result !== 'approved') ? (
                              <span className="text-muted">/</span>
                            ) : (
                              <>
                                {s.result === 'approved' && s.userId && signs.byId.get(s.userId) ? (
                                  <img src={signs.byId.get(s.userId)} alt={`${s.userName} 싸인`} title={s.userName} className="h-8 max-w-[70px] object-contain" />
                                ) : (
                                  <span className="font-medium">{s.userName}</span>
                                )}
                                {s.result === 'approved' && <span className="text-[10.5px] text-emerald-700">승인 {s.at ? new Date(s.at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) : ''}</span>}
                                {s.result === 'rejected' && <span className="text-[10.5px] text-red-600">반려</span>}
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null,
                )}
              </div>
            </div>
          </div>
          </>
        )}
      </div>

      {d.siteId && <SummaryPanel sum={summary} />}
      {preview && (
        <Modal
          open
          wide
          title="구매청구서 미리보기"
          onClose={() => setPreview(false)}
          footer={
            <>
              <span className="mr-auto self-center text-[12px] text-muted">{d.id ? '엑셀 양식과 같은 순서로 보여줍니다.' : '저장하면 엑셀로 내려받을 수 있습니다.'}</span>
              {d.id && (
                <button className="btn-ghost" disabled={busy} onClick={downloadForm}>
                  엑셀 다운로드
                </button>
              )}
              <button className="btn-dark" onClick={() => setPreview(false)}>
                닫기
              </button>
            </>
          }
        >
          <ReqPreview cats={siteCats} d={d} priorOf={priorOf} catName={catName} sum={summary} process={d.zoneId ? processLabel(pm.master, d) : ''} signs={signs.byId} />
        </Modal>
      )}
      {/* 폰: 결재 버튼을 화면 아래에 고정 */}
      {myTurn && (
        <>
          <div className="h-36 md:hidden" aria-hidden />
          <div className="no-print fixed inset-x-0 bottom-0 z-30 flex flex-col gap-2 border-t border-line bg-white px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2 shadow-[0_-4px_16px_rgba(10,18,32,0.08)] md:hidden">
            <input className="input h-10 w-full" placeholder="의견 (반려 시 필수)" value={comment} onChange={(e) => setComment(e.target.value)} />
            <div className="flex gap-2">
              <button className="btn-danger h-12 flex-1 text-[15px]" disabled={busy} onClick={() => decide('rejected')}>
                반려
              </button>
              <button className="btn-dark h-12 flex-[2] text-[15px] font-bold" disabled={busy} onClick={() => decide('approved')}>
                승인
              </button>
            </div>
          </div>
        </>
      )}

      {(() => {
        // 첨부: 작성중·반려 = 작성자 / 결재 중 = 작성자·결재선 / 자재부·관리자 = 항상 (휴지통 제외)
        const inLine = d.steps.some((s) => s.userId && s.userId === profile?.id);
        const mineReq = d.createdBy === profile?.id;
        const canAdd = !readOnly && !inTrash && (isOffice || ((d.status === 'draft' || d.status === 'rejected') && mineReq) || (d.status === 'pending' && (mineReq || inLine)));
        const live = (d.id && stored?.attachments) || d.attachments || [];
        return (
          <ReqAttachments
            reqId={d.id}
            list={live}
            canAdd={canAdd}
            canDelete={(a) => !inTrash && (isOffice || (a.by === profile?.id && d.status !== 'approved'))}
            me={{ id: profile?.id ?? '', name: profile?.name ?? '' }}
            onChange={(next) => setD((x) => x && { ...x, attachments: next })}
          />
        );
      })()}

      {(myTurn || (d.opinions?.length ?? 0) > 0) && (
        <div className="card mt-4 px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="font-semibold">결재자 의견 및 지시사항</span>
            <span className="text-[11.5px] text-muted">결재자가 자기 결재 차례에 씁니다. 사내 사용자 모두 볼 수 있고, 작성자·현장에 텔레그램으로 알립니다.</span>
          </div>
          {(d.opinions ?? []).length > 0 && (
            <div className="mb-2 divide-y divide-line rounded-md border border-line">
              {(d.opinions ?? []).map((o, i) => (
                <div key={i} className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-[12px]">
                    <span className="font-semibold text-ink">{o.by}</span>
                    <span className="text-muted">{o.label}</span>
                    <span className={`chip ${o.result === 'approved' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>{o.result === 'approved' ? '승인' : '반려'}</span>
                    <span className="ml-auto text-muted">{new Date(o.at).toLocaleString('ko-KR')}</span>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap text-[13px]">{o.text}</div>
                </div>
              ))}
            </div>
          )}
          {myTurn && (
            <div className="no-print">
              <textarea
                className="input min-h-[84px] w-full py-2 text-[13px]"
                placeholder="의견·지시사항을 적고 위(또는 아래)의 승인·반려를 누르세요. 반려할 때는 반려 사유를 꼭 적어 주세요."
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
              <div className="mt-2 hidden gap-2 md:flex">
                <button className="btn-primary" disabled={busy} onClick={() => decide('approved')}>
                  의견 남기고 승인
                </button>
                <button className="btn-danger" disabled={busy} onClick={() => decide('rejected')}>
                  의견 남기고 반려
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {d.history.length > 0 && (
        <div className="card mt-4 px-4 py-3">
          <div className="mb-1 font-semibold">진행 기록</div>
          {[...d.history].reverse().map((h, i) => (
            <div key={i} className="text-[12px] text-muted">
              {new Date(h.at).toLocaleString('ko-KR')} · {h.by} · {h.action}
              {h.comment && ` — ${h.comment}`}
            </div>
          ))}
        </div>
      )}

      {hhOpen && d.siteId && (
        <HhRatesEditor siteId={d.siteId} siteName={sites.data.find((s) => s.id === d.siteId)?.name ?? ''} rates={hh.data} canEdit={isOffice} itemOptions={itemOptions} hasItem={(i, sp) => itemSet.has(normItem(i)) && specOk(i, sp)} who={profile?.name ?? ''} onClose={() => setHhOpen(false)} />
      )}
      {importOpen && <ReqImportModal reqs={reqs.data} sites={sites.data} siteId={d.siteId} currentId={d.id} onAdd={addFromReq} onClose={() => setImportOpen(false)} />}
      <Modal
        open={pasteOpen}
        title="엑셀 붙여넣기"
        onClose={() => setPasteOpen(false)}
        wide
        footer={
          <>
            <button className="btn-ghost" onClick={() => setPasteOpen(false)}>
              취소
            </button>
            <button
              className="btn-primary"
              disabled={!pasteRows.length}
              onClick={() => {
                addFromRows(pasteRows);
                setPasteText('');
                setPasteOpen(false);
              }}
            >
              {pasteRows.length}줄 추가
            </button>
          </>
        }
      >
        <p className="mb-2 text-muted">엑셀에서 아래 순서로 열을 복사해 붙여넣으세요 (머리글 제외).</p>
        <div className="mb-2 rounded-md bg-canvas px-3 py-2 font-mono text-[12px]">품명 ⇥ 규격 ⇥ 단위 ⇥ 금회청구 ⇥ 비고 ⇥ 사용 위치·공정</div>
        <textarea className="input h-48 w-full py-2 font-mono text-[12px]" value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
      </Modal>

      <Modal open={!!priceFor} title="단가 후보" onClose={() => setPriceFor(null)} wide>
        {priceFor &&
          (() => {
            const l = d.lines.find((x) => x.key === priceFor)!;
            const cands = findPrices(prices.rows, l.itemName, l.spec);
            const last = lastOrderPrice(reqs.data, l.itemName, l.spec);
            const ik = itemKey(l.itemName, l.spec);
            const erpRows = priceList.data.filter((p) => itemKey(p.itemName, p.spec) === ik && (!p.siteId || p.siteId === d.siteId)).sort((a, b) => Number(!!b.fixed) - Number(!!a.fixed) || a.price - b.price);
            const ci = lists.cat.get(`${normItem(l.itemName)}|${normSpec(l.spec)}`);
            const invRows: { label: string; lp: LastPrice }[] = [];
            if (ci?.site[d.siteId]) invRows.push({ label: '이 현장 최신', lp: ci.site[d.siteId] });
            if (ci && (!ci.site[d.siteId] || ci.site[d.siteId].p !== ci.last.p || ci.site[d.siteId].m !== ci.last.m)) invRows.push({ label: '회사 전체 최신', lp: ci.last });
            const choose = (patch: Partial<ReqLine>) => {
              setLine(l.key, patch);
              setPriceFor(null);
            };
            return (
              <div>
                <div className="mb-2 font-medium">
                  {l.itemName} {l.spec}
                </div>
                {!cands.length && !last && !invRows.length && !erpRows.length && <Empty>계산서·단가표·직전 발주에 이 품목이 없습니다. 단가를 직접 입력하세요.</Empty>}
                {invRows.length > 0 && (
                  <table className="tbl mb-3">
                    <thead>
                      <tr>
                        <th>최신 계산서 단가</th>
                        <th>월</th>
                        <th>업체</th>
                        <th>제조사</th>
                        <th className="num">단가</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {invRows.map(({ label, lp }) => {
                        const v = vendors.data.find((x) => x.id === lp.vid);
                        return (
                          <tr key={label}>
                            <td>{label}</td>
                            <td className="text-muted">
                              {lp.m}
                              {lp.d ? ` (${lp.d})` : ''}
                            </td>
                            <td>{lp.v}</td>
                            <td className="text-muted">{lp.mk}</td>
                            <td className="num font-semibold">{won(lp.p)}</td>
                            <td className="text-right">
                              <button className="btn-dark h-7 text-[12px]" onClick={() => choose({ orderPrice: lp.p, priceSource: '계산서', ...(v ? { vendorId: v.id, vendorName: v.name } : {}) })}>
                                적용
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {erpRows.length > 0 && (
                  <table className="tbl mb-3">
                    <thead>
                      <tr>
                        <th>ERP 단가표 업체</th>
                        <th>제조사</th>
                        <th>현장</th>
                        <th className="num">협가</th>
                        <th className="num">네고율</th>
                        <th className="num">구매단가</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {erpRows.map((p) => (
                        <tr key={p.id} className={priceValid(p) ? '' : 'text-muted'}>
                          <td>
                            {p.vendorName}
                            <DealerChip vid={p.vendorId} catId={l.siteCategoryId} />
                          </td>
                          <td className="text-muted">{p.maker}</td>
                          <td>{p.fixed ? <span className="chip bg-violet-100 text-violet-800">현장 지정단가</span> : p.siteName ? <span className="chip bg-amber-soft text-amber-800">이 현장</span> : <span className="text-[12px] text-muted">공통</span>}</td>
                          <td className="num">{p.listPrice ? won(p.listPrice) : ''}</td>
                          <td className="num">{p.negoRate ? `${p.negoRate}%` : ''}</td>
                          <td className="num font-semibold">
                            {won(p.price)}
                            {!priceValid(p) && <span className="ml-1 text-[10.5px] text-red-600">기간 밖</span>}
                          </td>
                          <td className="text-right">
                            <button className="btn-dark h-7 text-[12px]" onClick={() => choose({ orderPrice: p.price, priceSource: p.fixed ? '지정단가' : 'ERP단가', vendorId: p.vendorId, vendorName: p.vendorName })}>
                              적용
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {cands.length > 0 && (
                  <table className="tbl mb-3">
                    <thead>
                      <tr>
                        <th>단가관리 업체</th>
                        <th>제조사</th>
                        <th className="num">협가</th>
                        <th className="num">네고율</th>
                        <th className="num">구매단가</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {cands.map((p, i) => {
                        const v = vendors.data.find((x) => priceVendorIs(p, x));
                        return (
                          <tr key={i}>
                            <td>
                              {p.vendorName}
                              {!v && <span className="ml-1 text-[11px] text-amber-700">(ERP 업체 없음)</span>}
                              <DealerChip vid={v?.id} catId={l.siteCategoryId} />
                            </td>
                            <td className="text-muted">{p.maker}</td>
                            <td className="num">{won(p.listPrice)}</td>
                            <td className="num">{p.negoRate ? `${p.negoRate}%` : '-'}</td>
                            <td className="num font-semibold">{won(p.buyPrice)}</td>
                            <td className="text-right">
                              <button className="btn-dark h-7 text-[12px]" onClick={() => choose({ orderPrice: p.buyPrice, priceSource: '단가표', ...(v ? { vendorId: v.id, vendorName: v.name } : {}) })}>
                                적용
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {last && (
                  <div className="flex items-center justify-between rounded-lg bg-canvas px-3 py-2">
                    <span>
                      직전 발주 {last.date} · {last.vendorName ?? '-'} · <b>{won(last.price)}원</b>
                    </span>
                    <button className="btn-ghost h-7 text-[12px]" onClick={() => choose({ orderPrice: last.price, priceSource: '직전발주', ...(last.vendorId ? { vendorId: last.vendorId, vendorName: last.vendorName } : {}) })}>
                      적용
                    </button>
                  </div>
                )}
              </div>
            );
          })()}
      </Modal>

      <Modal
        open={!!newItem}
        title={isOffice ? '새 품목 등록' : '새 품목 등록 요청'}
        onClose={() => setNewItem(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setNewItem(null)}>
              취소
            </button>
            <button className="btn-primary" onClick={saveNewItem}>
              {isOffice ? '등록' : '요청'}
            </button>
          </>
        }
      >
        {newItem && (
          <div className="space-y-3">
            <div className="rounded-md bg-canvas px-3 py-2 text-[12.5px] text-muted">
              {isOffice
                ? '등록하면 회사 전체 청구서 품명 목록에 바로 나옵니다.'
                : '요청한 품목은 바로 청구서에 쓸 수 있고, 자재부가 확인(승인·표기 수정·거절)합니다. 비슷한 품목이 목록에 있는지 먼저 확인해 주세요.'}
            </div>
            <Field label="품명 *">
              <input className="input" value={newItem.itemName} onChange={(e) => setNewItem({ ...newItem, itemName: e.target.value })} />
            </Field>
            {newItem.itemName.trim().length >= 2 && (() => {
              const k = nameKey(newItem.itemName);
              const sim = itemOptions.filter((x) => nameKey(x).includes(k) || k.includes(nameKey(x))).slice(0, 8);
              return sim.length ? <div className="text-[12px] text-amber-700">목록에 비슷한 품명: {sim.join(', ')}</div> : null;
            })()}
            <div className="grid grid-cols-2 gap-3">
              <Field label="규격">
                <input className="input" value={newItem.spec} onChange={(e) => setNewItem({ ...newItem, spec: e.target.value })} />
              </Field>
              <Field label="단위">
                <input className="input" value={newItem.unit} onChange={(e) => setNewItem({ ...newItem, unit: e.target.value })} />
              </Field>
            </div>
            <Field label="메모 (용도 등)">
              <input className="input" value={newItem.note} onChange={(e) => setNewItem({ ...newItem, note: e.target.value })} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}


/** 하단 요약: 자재분류별 계약·변경(예상)·실행·기반입·금회청구 + 업체별 금회청구 */
/** 구매청구서 미리보기: 회사 청구서 양식(엑셀)과 같은 칸 순서 */
function ReqPreview({ d, priorOf, catName, sum, process, signs, cats }: { d: Omit<Requisition, 'id'> & { id?: string }; priorOf: (l: ReqLine) => number; catName: (id?: string) => string | undefined; sum: ReqSummary; process: string; signs: Map<string, string>; cats: SiteCategory[] }) {
  const lines = d.lines.filter((l) => l.itemName.trim());
  const lumpPrev = lumpCells(lines, cats);
  const amt = (l: ReqLine) => lineAmount({ ...l, orderQty: l.orderQty || l.reqQty });
  const total = lines.reduce((a, l) => a + amt(l), 0);
  const nf = (v?: number) => (v ? v.toLocaleString() : '');
  const c = 'border border-[#9aa3b2] px-1 py-0.5';
  const h = `${c} bg-[#eef1f6] text-center font-semibold`;
  const site = d.steps.filter((s) => /^현장/.test(s.label.replace(/\s/g, '')) || /^소장/.test(s.label.replace(/\s/g, '')));
  const hq = d.steps.filter((s) => !site.includes(s));
  const box = (s: ApprovalStepState, i: number) => (
    <div key={i} className="w-[64px] border-r border-[#9aa3b2] text-center last:border-r-0">
      <div className="border-b border-[#9aa3b2] bg-[#eef1f6] text-[10px]">{s.label.replace(/^(현장|본사)\s*/, '') || s.label}</div>
      <div className="flex h-10 flex-col items-center justify-center text-[10px]">
        {s.result === 'approved' && s.userId && signs.get(s.userId) ? <img src={signs.get(s.userId)} alt="" className="h-6 max-w-[58px] object-contain" /> : <span>{s.userName}</span>}
        {s.result === 'approved' && <span className="text-[9px] text-emerald-700">{s.at ? new Date(s.at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) : ''} 승인</span>}
      </div>
    </div>
  );
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[980px] bg-white text-[11px] text-black">
        <div className="relative mb-2 text-center">
          <div className="text-[20px] font-bold tracking-[0.6em] underline underline-offset-4">구매청구서</div>
          <div className="absolute right-0 top-0 text-[13px] font-semibold">{d.siteName}</div>
        </div>
        <div className="mb-1 flex justify-between text-[12px]">
          <b>현장명 : {d.siteName} 현장</b>
          <span>
            결의번호 : 제 {d.requestDate} - {d.docNo || '　'} 호
          </span>
        </div>
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            {[13, 8, 4, 4.5, 5, 4.5, 4.5, 5, 5, 4.5, 6, 6.5, 8, 13].map((w, i) => (
              <col key={i} style={{ width: `${w}%` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className={h} rowSpan={2}>품 명</th>
              <th className={h} rowSpan={2}>규 격</th>
              <th className={h} rowSpan={2}>단위</th>
              <th className={h} colSpan={2}>계약내역량</th>
              <th className={`${h} bg-[#fde2e2]`} rowSpan={2}>실행량</th>
              <th className={`${h} bg-[#fde2e2]`} colSpan={2}>청구 및 반입 수량</th>
              <th className={h} rowSpan={2}>본/(비고)</th>
              <th className={h} colSpan={3}>발주 결의 (본사 작성분)</th>
              <th className={h} rowSpan={2}>거래선</th>
              <th className={h} rowSpan={2}>비 고</th>
            </tr>
            <tr>
              <th className={h}>수량</th>
              <th className={h}>단가</th>
              <th className={`${h} bg-[#fde2e2]`}>기반입</th>
              <th className={`${h} bg-[#fde2e2]`}>금회청구</th>
              <th className={h}>발주수량</th>
              <th className={h}>단 가</th>
              <th className={h}>금 액</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={`${c} font-semibold`} colSpan={12}>
                {[process, d.purpose].filter(Boolean).join(' - ')}
              </td>
              <td className={c}></td>
              <td className={`${c} whitespace-pre-wrap break-words text-center text-[10px] font-semibold`}>{usePurposeOf(d)}</td>
            </tr>
            {lines.map((l, li) => (
              <tr key={l.key} className="align-top">
                <td className={`${c} break-words text-center align-middle`}>{l.itemName}</td>
                <td className={`${c} break-words text-center align-middle`}>{l.spec}</td>
                <td className={`${c} text-center`}>{l.unit}</td>
                {(() => {
                  const lp = lumpPrev[li];
                  if (lp)
                    return lp.span > 0 ? (
                      <>
                        <td rowSpan={lp.span} className={`${c} text-center align-middle`}>1식</td>
                        <td rowSpan={lp.span} className={`${c} text-right align-middle`}>{nf(lp.amount)}</td>
                        <td className={c}></td>
                      </>
                    ) : (
                      <td className={c}></td>
                    );
                  return (
                    <>
                      <td className={`${c} text-right`}>{nf(l.contractQty)}</td>
                      <td className={`${c} text-right`}>{nf(l.contractPrice)}</td>
                      <td className={`${c} text-right`}>{nf(l.execQty)}</td>
                    </>
                  );
                })()}
                <td className={`${c} text-right`}>{nf(priorOf(l))}</td>
                <td className={`${c} text-right font-semibold`}>
                  {isHhLine(l) ? (
                    <>
                      <div className="font-normal">{l.hhCount}세대</div>
                      <div>{nf(l.reqQty)}</div>
                    </>
                  ) : (
                    nf(l.reqQty)
                  )}
                </td>
                <td className={`${c} text-center`}>{[bonText(l), l.note].filter(Boolean).join(' ')}</td>
                <td className={`${c} text-right`}>{nf(l.orderQty || l.reqQty)}</td>
                <td className={`${c} text-right`}>{nf(l.orderPrice)}</td>
                <td className={`${c} text-right`}>{nf(amt(l))}</td>
                <td className={`${c} break-words`}>{l.vendorName}</td>
                <td className={`${c} whitespace-pre-wrap break-words text-[10px]`}>
                  {[l.remark, catName(l.siteCategoryId)].filter(Boolean).join(' / ')}
                </td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className={`${c} text-center`} colSpan={11}>
                합 계
              </td>
              <td className={`${c} text-right`}>{nf(total)}</td>
              <td className={c} colSpan={2}></td>
            </tr>
          </tbody>
        </table>
        {sum.rows.some((r) => r.current) && (
          <table className="mt-2 w-[70%] border-collapse">
            <thead>
              <tr>
                {['자재분류', '계약내역', '변경내역(예상)', '실행금액', '기반입금액', '금회청구'].map((t) => (
                  <th key={t} className={h}>
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sum.rows
                .filter((r) => r.current)
                .map((r) => (
                  <tr key={r.id}>
                    <td className={c}>{r.name}</td>
                    <td className={`${c} text-right`}>{nf(r.contract)}</td>
                    <td className={`${c} text-right`}>{nf(r.change)}</td>
                    <td className={`${c} text-right`}>{nf(r.exec)}</td>
                    <td className={`${c} text-right`}>{nf(r.prior)}</td>
                    <td className={`${c} text-right font-semibold`}>{nf(r.current)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
        <div className="mt-3 flex items-end justify-between gap-3">
          <div className="text-[11.5px]">
            위와 같이 구매 의뢰 합니다.
            <div className="mt-1">
              {d.requestDate} · 합계 <b>{won(total)}원</b>
            </div>
          </div>
          <div className="flex gap-2">
            {[
              ['현장', site],
              ['본사', hq],
            ].map(([t, list]) =>
              (list as ApprovalStepState[]).length ? (
                <div key={t as string} className="flex border border-[#9aa3b2]">
                  <div className="flex w-5 items-center justify-center border-r border-[#9aa3b2] bg-[#eef1f6] text-[10px] font-semibold [writing-mode:vertical-rl]">{t as string}</div>
                  {(list as ApprovalStepState[]).map(box)}
                </div>
              ) : null,
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryPanel({ sum }: { sum: ReqSummary }) {
  const [all, setAll] = useState(false);
  // 자재분류가 지정된 금회청구 줄이 하나도 없으면 전체 분류를 보여준다
  const hasCatCur = sum.rows.some((r) => r.current && r.id !== NO_CAT);
  const onlyCur = !all && hasCatCur;
  const rows = onlyCur ? sum.rows.filter((r) => r.current) : sum.rows;
  const realCats = sum.rows.filter((r) => r.id !== NO_CAT).length;
  const f = (v: number) => (v ? won(v) : '');
  const remain = (r: { exec: number; change: number; prior: number; current: number }) => (r.exec ? r.exec - r.prior - r.current : 0);
  return (
    <div className="card mt-4 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="font-semibold text-navy-950">자재분류 · 금회청구 업체별 금액</span>
        <span className="text-[12px] text-muted">기반입금액 = 이 청구서보다 먼저 올린 이 현장 청구서의 발주 금액 (발주된 줄은 발주서 금액)</span>
        {hasCatCur ? (
          <button className="btn-ghost ml-auto h-7 text-[12px]" onClick={() => setAll(!all)}>
            {all ? '청구 분류만 보기' : `전체 보기 (${sum.rows.length}개 분류)`}
          </button>
        ) : (
          <span className="ml-auto text-[12px] text-amber-700">청구 줄에 자재분류가 아직 없어 전체 분류를 보여줍니다</span>
        )}
      </div>
      {!rows.length ? (
        <Empty>{realCats ? '표시할 분류가 없습니다.' : '이 현장에 등록된 투입집계 분류가 없습니다. 기준정보 › 분류에서 현장 분류를 등록하세요.'}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl text-[12px]">
            <thead>
              <tr>
                <th>자재분류</th>
                <th className="num">계약내역</th>
                <th className="num">변경내역(예상)</th>
                <th className="num">실행금액</th>
                <th className="num">기반입금액</th>
                <th className="min-w-[260px] bg-amber-soft text-center">금회청구</th>
                <th className="num" title="실행금액 − 기반입금액 − 금회청구">
                  실행 잔액
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const rm = remain(r);
                return (
                  <tr key={r.id} className={r.current ? 'bg-amber-soft/40 font-medium' : 'text-muted'}>
                    <td className="whitespace-nowrap">{r.name}</td>
                    <td className="num">{f(r.contract)}</td>
                    <td className="num">{f(r.change)}</td>
                    <td className="num">{f(r.exec)}</td>
                    <td className="num">{f(r.prior)}</td>
                    <td className="p-0">
                      <VendorCells byVendor={r.byVendor} />
                    </td>
                    <td className={`num ${rm < 0 ? 'font-semibold text-red-600' : ''}`}>{r.exec ? won(rm) : ''}</td>
                  </tr>
                );
              })}
              <tr className="bg-[#f7f8fb] font-semibold">
                <td>합 계</td>
                <td className="num">{won(sum.total.contract)}</td>
                <td className="num">{won(sum.total.change)}</td>
                <td className="num">{won(sum.total.exec)}</td>
                <td className="num">{won(sum.total.prior)}</td>
                <td className="num">{won(sum.total.current)}</td>
                <td className={`num ${remain(sum.total) < 0 ? 'text-red-600' : ''}`}>{sum.total.exec ? won(remain(sum.total)) : ''}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {sum.vendors.length > 0 && (
        <div className="border-t border-line px-4 py-3">
          <div className="mb-1 font-semibold">금회청구 업체별 합계</div>
          <table className="tbl w-auto min-w-[420px] text-[12px]">
            <thead>
              <tr>
                <th>업체</th>
                <th className="num">줄 수</th>
                <th className="num">금회청구 금액</th>
                <th className="num">비율</th>
              </tr>
            </thead>
            <tbody>
              {sum.vendors.map((v) => (
                <tr key={v.name}>
                  <td className={v.name === '거래선 미지정' ? 'text-amber-700' : ''}>{v.name}</td>
                  <td className="num">{v.lines}</td>
                  <td className="num font-semibold">{won(v.amount)}</td>
                  <td className="num text-muted">{sum.total.current ? `${((v.amount / sum.total.current) * 100).toFixed(1)}%` : ''}</td>
                </tr>
              ))}
              <tr className="bg-[#f7f8fb] font-semibold">
                <td>합 계</td>
                <td className="num">{sum.vendors.reduce((a, v) => a + v.lines, 0)}</td>
                <td className="num">{won(sum.total.current)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** 금회청구 칸: 업체명은 위(작게), 금액은 아래 — 종이 청구서와 같은 모양 */
function VendorCells({ byVendor }: { byVendor: Record<string, number> }) {
  const list = Object.entries(byVendor)
    .filter(([, v]) => v)
    .sort((a, b) => b[1] - a[1]);
  if (!list.length) return null;
  const total = list.reduce((a, [, v]) => a + v, 0);
  return (
    <div className="flex">
      {list.map(([name, v]) => (
        <div key={name} className="min-w-[86px] flex-1 border-r border-line text-center last:border-r-0">
          <div className={`truncate border-b border-dotted border-line px-1 text-[10.5px] ${name === '거래선 미지정' ? 'text-amber-700' : 'text-muted'}`} title={name}>
            {name}
          </div>
          <div className="px-1 py-0.5 text-right font-semibold text-ink">{won(v)}</div>
        </div>
      ))}
      {list.length > 1 && (
        <div className="min-w-[86px] bg-amber-soft/60 text-center">
          <div className="border-b border-dotted border-line px-1 text-[10.5px] text-muted">계</div>
          <div className="px-1 py-0.5 text-right font-bold text-ink">{won(total)}</div>
        </div>
      )}
    </div>
  );
}

/** 본/(비고) 칸의 본수: 누르면 이 줄만 1본 길이를 바꾼다 */
function BonCell({ l, edit, onSet }: { l: ReqLine; edit: boolean; onSet: (v: number | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const isM = /^M$/i.test((l.unit || '').trim());
  const auto = pipeLength(l.itemName);
  const cur = lineBonLen(l);
  const text = bonText(l);
  if (!isM || (!text && !edit) || (!edit && !text)) return null;
  if (!edit) return <div className="pt-1 text-center text-[11.5px] font-semibold text-navy-900" title={`금회청구 수량 ÷ 1본 ${cur}m`}>{text}</div>;
  if (!auto && l.bonLen === undefined && !open)
    return (
      <div className="pt-0.5 text-center">
        <button type="button" className="text-[10.5px] text-muted hover:text-navy-900 hover:underline" onClick={() => setOpen(true)} title="배관이면 1본 길이를 정해 본수를 표시합니다">
          + 본수
        </button>
      </div>
    );
  const pick = (v: number | undefined) => {
    onSet(v === auto ? undefined : v);
    setOpen(false);
    setCustom('');
  };
  return (
    <div className="relative pt-0.5 text-center">
      <button
        type="button"
        className={`rounded px-1 text-[11.5px] font-semibold ${l.bonLen !== undefined ? 'bg-amber-soft text-amber-900' : 'text-navy-900'} hover:bg-amber-soft`}
        onClick={() => setOpen((o) => !o)}
        title={l.bonLen !== undefined ? `이 줄만 1본 ${l.bonLen === 0 ? '표시 안 함' : l.bonLen + 'm'} (자동 ${auto ?? '-'}m)` : `자동: 1본 ${auto}m · 눌러서 이 줄만 바꾸기`}
      >
        {text || (l.bonLen === 0 ? '본수 끔' : '본수 ?')} ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-6 z-40 w-44 rounded-lg border border-line bg-white p-1.5 text-left text-[12px] shadow-lg">
            <div className="px-2 pb-1 text-[11px] text-muted">이 줄 1본 길이</div>
            {[3, 4, 5, 5.5, 6, 12, 15].map((v) => (
              <button key={v} type="button" className={`block w-full rounded px-2 py-1 text-left hover:bg-canvas ${cur === v ? 'bg-amber-soft font-semibold' : ''}`} onClick={() => pick(v)}>
                {v} m{v === auto ? ' (자동)' : ''}
              </button>
            ))}
            <div className="flex items-center gap-1 px-2 py-1">
              <input
                className="input h-6 w-16 px-1 text-[12px]"
                inputMode="decimal"
                placeholder="직접"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && +custom > 0) pick(+custom);
                }}
              />
              m
              <button type="button" className="btn-ghost ml-auto h-6 px-1.5 text-[11px]" disabled={!(+custom > 0)} onClick={() => pick(+custom)}>
                적용
              </button>
            </div>
            <div className="my-1 border-t border-line" />
            {auto && l.bonLen !== undefined && (
              <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-canvas" onClick={() => pick(undefined)}>
                자동으로 되돌리기 ({auto} m)
              </button>
            )}
            {!auto && l.bonLen !== undefined && (
              <button type="button" className="block w-full rounded px-2 py-1 text-left hover:bg-canvas" onClick={() => pick(undefined)}>
                지정 취소
              </button>
            )}
            {(auto || l.bonLen) ? (
              <button type="button" className="block w-full rounded px-2 py-1 text-left text-muted hover:bg-canvas" onClick={() => (onSet(0), setOpen(false))}>
                본수 표시 안 함
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
