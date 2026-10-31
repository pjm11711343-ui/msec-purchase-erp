import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { audit, commitBatch, newId, stripUndefined } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSiteCategories, useSites, useStandardCategories, useVendors } from '../../lib/hooks';
import { fillReqForm } from '../../lib/reqForm';
import { looselyEqual, nameKey, num, won } from '../../lib/normalize';
import { readWorkbook } from '../../lib/parsers';
import { findPrices, priceKey, sameVendor, usePrices, type PriceRow } from '../../lib/prices';
import { bonText, lastOrderPrice, lineAmount, restoreReq, newLine, priorQtyMap, useApprovalLines, useRequisitions, useUsers } from '../../lib/reqs';
import { parseReqSheet } from '../../lib/reqExcel';
import { orderedKeys, usePurchaseOrders } from '../../lib/pos';
import { Empty, errMsg, Field, Modal, NumInput, PageHeader, useToast } from '../../components/ui';
import { isCeo, isMyTurn, myDecideStep, nextActive, StatusChip } from './ReqList';
import PickInput from '../../components/PickInput';
import { useItemCatalog, type CatItem, type LastPrice } from '../../lib/itemCatalog';
import { itemKey, makeItemStd, pickListPrice, priceValid, siteCatOfStd, useItemCats, useItemEntries, usePriceList } from '../../lib/itemMaster';
import { normItem, normSpec } from '../../lib/itemNorm';
import { NO_CAT, reqSummary, type ReqSummary } from '../../lib/reqSummary';
import { cellKey, defaultCells, processLabel, processPriorMap, sortedTrades, sortedZones, useBaseSheets, useProcessMaster, useSiteProcess, type BaseLine } from '../../lib/process';
import { signMap } from '../../lib/sign';
import { useAdminMemos } from '../../lib/adminMemo';
import AdminMemoInput from '../../components/AdminMemoInput';
import { notifyQuiet } from '../../lib/notify';
import { aliasKey, saveReqAliases, useReqAliases } from '../../lib/reqAlias';
import { similarity } from '../../lib/catMatch';
import { ROLE_LABEL, type ApprovalStepState, type ReqLine, type Requisition, type Vendor } from '../../types';

const TEMPLATES: Record<Requisition['approvalType'], string[]> = {
  '2단계': ['현장소장', '자재부'],
  '6칸': ['현장 담당', '현장 소장', '본사 담당', '본사 팀장', '본사 임원', '본사 대표'],
};
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
  const [pasteText, setPasteText] = useState('');
  const [phoneTable, setPhoneTable] = useState(false); // 폰: 기본은 카드, 수정할 때 표
  const [priceFor, setPriceFor] = useState<string | null>(null); // 단가 후보 보기 (line key)
  const [newItem, setNewItem] = useState<{ itemName: string; spec: string; unit: string; note: string } | null>(null); // 새 품목 등록·요청

  const isNew = !id || id === 'new';
  const stored = reqs.data.find((r) => r.id === id) ?? reqs.trash.find((r) => r.id === id);
  const inTrash = !!stored?.deletedAt;
  const isOffice = can('admin', 'material');

  // 처음 불러오기
  useEffect(() => {
    if (d) return;
    if (isNew) {
      if (!profile || sites.loading) return;
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
    } else if (stored) setD(structuredClone(stored));
  }, [isNew, stored, profile, sites.loading, sites.data, d]);

  // 새 청구서: 현장 결재선 기본값
  const defaultSteps = (siteId: string): { type: Requisition['approvalType']; steps: ApprovalStepState[] } => {
    const l = lines.data.find((x) => x.id === siteId) ?? lines.data.find((x) => x.id === '_default');
    const type = l?.type ?? '2단계';
    const steps = (l?.steps ?? TEMPLATES[type].map((label) => ({ label, userId: undefined as string | undefined }))).map((s) => ({
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
  const baseSheets = useBaseSheets(d?.siteId);
  const procCells = sproc.data?.cells ?? defaultCells(pm.master);
  const baseSheet = d?.zoneId ? baseSheets.data.find((s) => s.zoneId === d.zoneId && s.tradeId === d.tradeId) : undefined;
  const baseByItem = useMemo(() => new Map((baseSheet?.lines ?? []).map((b) => [itemKey(b.itemName, b.spec), b])), [baseSheet]);
  const procPrior = useMemo(() => (d?.zoneId && d.tradeId ? processPriorMap(reqs.data, d.siteId, d.zoneId, d.tradeId, d.id) : null), [reqs.data, d?.siteId, d?.zoneId, d?.tradeId, d?.id]);
  const siteCats = cats.data.filter((c) => c.siteId === d?.siteId).sort((a, b) => a.order - b.order);
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

  if (!d) return <div className="text-muted">{reqs.loading || sites.loading ? '불러오는 중…' : '청구서를 찾을 수 없습니다.'}</div>;

  // 작성중·반려: 작성자·자재부 / 결재 중(최종 승인 전): 작성자·자재부·결재선에 있는 사람도 내용 수정 가능
  const draftEditable = !readOnly && !inTrash && (d.status === 'draft' || d.status === 'rejected') && (d.createdBy === profile?.id || isOffice);
  const pendEditable = !readOnly && !inTrash && d.status === 'pending' && (d.createdBy === profile?.id || isOffice || d.steps.some((s) => s.userId && s.userId === profile?.id));
  const editable = draftEditable || pendEditable;
  const myTurn = !!d.id && isMyTurn(d as Requisition, profile?.id, can('admin'));
  const orderEditable = editable ? isOffice : myTurn && isOffice;
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
    setD({ ...d, lines: [...d.lines.filter((l) => l.itemName.trim()), ...add.map((l) => ({ ...l, ...(!l.orderPrice ? suggest(l) : {}), ...autoCat(l) }))] });
    toast(`기본 청구서 품목 ${add.length}줄을 불러왔습니다. 금회청구 수량을 넣으세요. (수량이 빈 내역 줄은 결재 올릴 때 빠집니다)`);
  };
  const setProcess = (p: { zoneId?: string; tradeId?: string; zoneSub?: string }) => {
    const n = { ...d, ...p };
    if (p.zoneId !== undefined && !pm.master.zones.find((z) => z.id === p.zoneId)?.subs?.length) n.zoneSub = undefined;
    setD(n);
  };

  const setLine = (key: string, patch: Partial<ReqLine>) => setD((x) => x && { ...x, lines: x.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });

  /** 단가 자동: 최신 계산서 단가(같은 현장 → 전체) → ERP 단가표(현장 예외 → 거래선 → 최저) → 단가관리 단가표 → 직전 발주단가 */
  const suggest = (l: ReqLine): Partial<ReqLine> => {
    if (!l.itemName) return {};
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
    const forVendor = v ? cands.find((p) => sameVendor(p.vendorName, v.name, v.aliases)) : undefined;
    const pick: PriceRow | undefined = forVendor ?? cands[0];
    if (pick) {
      const erpV = v ?? vendors.data.find((x) => sameVendor(pick.vendorName, x.name, x.aliases));
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
      return { ...x, lines: x.lines.map((l) => (l.key === key ? (((y) => ({ ...y, ...baseFill(y) }))({ ...l, ...(!l.orderPrice ? suggest(l) : {}), ...autoCat(l) })) : l)) };
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
  const resetAuto = (l: ReqLine): Partial<ReqLine> => (l.priceSource === '계산서' || l.priceSource === 'ERP단가' || l.priceSource === '단가표' || l.priceSource === '직전발주' ? { orderPrice: 0, priceSource: undefined } : {});
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
      await commitBatch([{ type: 'set', col: C.requisitions, id: rid, data, merge: false }]);
      await audit(`구매청구 ${action}`, rid, { docNo: data.docNo, site: data.siteName });
      toast(okMsg);
      setComment('');
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
    // 결재자 미지정 칸은 건너뜀
    const steps: ApprovalStepState[] = d.steps.map((s) => (s.userId ? { label: s.label, userId: s.userId, userName: s.userName } : { label: s.label, result: 'skipped' }));
    const first = nextActive(steps, 0);
    if (first < 0) return toast('결재선에 결재자를 한 명 이상 지정하세요.', 'err');
    // 결재 차례가 된 결재자에게 텔레그램 (개인 Chat ID가 있으면)
    void save({ status: 'pending', steps, currentStep: first, currentApproverId: steps[first].userId, approverIds: steps.filter((s) => s.userId).map((s) => s.userId!), submittedAt: Date.now() }, '결재 요청', '결재를 올렸습니다.').then(
      (rid) => rid && notifyQuiet('approval_turn', { reqId: rid }),
    );
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
    if (result === 'rejected') return save({ status: 'rejected', steps, currentApproverId: undefined }, '반려', '반려했습니다.');
    const next = ceo ? -1 : nextActive(steps, j + 1);
    if (next < 0) return save({ status: 'approved', steps, currentStep: steps.length - 1, currentApproverId: undefined, approvedAt: now }, ceo ? `${me.label} 승인(최종)` : '최종 승인', '최종 승인했습니다. 3단계 발주 대기로 넘어갑니다.');
    void save({ steps, currentStep: next, currentApproverId: steps[next].userId }, j > d.currentStep ? `${me.label} 전결 승인` : `${me.label} 승인`, '승인했습니다.').then(
      (rid) => rid && notifyQuiet('approval_turn', { reqId: rid }),
    );
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
      setD((x) => x && { ...x, purpose: x.purpose || p.purpose, requestDate: x.requestDate || p.docDate || today() });
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
  const isLocked = (l: ReqLine) => !!d.id && d.status === 'pending' && !!ordered.get(`${d.id}|${l.key}`);
  const pickVendor = (key: string, label: string) => {
    const v = label === NONE ? undefined : vendorOptions.find((x) => vLabel(x) === label);
    setD((x) => {
      if (!x) return x;
      const idx = x.lines.findIndex((l) => l.key === key);
      if (idx < 0) return x;
      const patch = { vendorId: v?.id, vendorName: v?.name };
      let lines = x.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l));
      if (v) lines = fillBetween(lines, idx, (l) => l.vendorId ?? '', patch, (l) => !isLocked(l));
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
      return { ...x, lines };
    });
  };
  const catName = (cid?: string) => cats.data.find((c) => c.id === cid)?.name;

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
      const { truncated } = fillReqForm(wb, req, sumX, logo, signs.byId);
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
  const N = (key: string, field: keyof ReqLine, v: number, on: boolean | undefined, w = 'w-20') =>
    on ? (
      <NumInput className={`input h-7 ${w} px-1.5 text-right`} value={v} onChange={(n) => setLine(key, { [field]: n } as Partial<ReqLine>)} />
    ) : (
      <span className="tabular-nums">{v ? v.toLocaleString() : ''}</span>
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
              <button className="btn-primary" disabled={busy} onClick={savePending}>
                수정 저장
              </button>
            )}
            {draftEditable && (
              <>
                <button className="btn-ghost" disabled={busy} onClick={() => save({}, '임시 저장', '저장했습니다.')}>
                  임시 저장
                </button>
                <button className="btn-primary" disabled={busy} onClick={submit}>
                  결재 올리기
                </button>
              </>
            )}
            {myTurn && orderEditable && !pendEditable && (
              <button className="btn-ghost" disabled={busy} onClick={() => save({}, '발주 결의 수정', '저장했습니다.')}>
                발주 결의 저장
              </button>
            )}
            {d.status === 'pending' && d.createdBy === profile?.id && !d.steps.some((s) => s.result === 'approved' || s.result === 'rejected') && (
              <button className="btn-ghost" disabled={busy} onClick={reopen}>
                결재 회수
              </button>
            )}
          </>
        }
      />

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
              <input className="input" value={d.purpose ?? ''} disabled={!editable} onChange={(e) => setD({ ...d, purpose: e.target.value })} />
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
              <option>2단계</option>
              <option>6칸</option>
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
              <input className="input" placeholder="의견 (반려 시 필수)" value={comment} onChange={(e) => setComment(e.target.value)} />
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
              <button className="btn-ghost h-7 text-[12px]" onClick={() => setD({ ...d, lines: [...d.lines, newLine()] })}>
                + 줄 추가
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
            <table className="tbl req-tbl w-full table-fixed text-[12px]">
              <colgroup>
                <col style={{ width: 24 }} />
                <col style={{ width: '13%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '4%' }} />
                <col style={{ width: '4.5%' }} />
                <col style={{ width: '5%' }} />
                <col style={{ width: '4.5%' }} />
                <col style={{ width: '4.5%' }} />
                <col style={{ width: '5%' }} />
                <col style={{ width: '5%' }} />
                <col style={{ width: '4.5%' }} />
                <col style={{ width: '6.5%' }} />
                <col style={{ width: '6%' }} />
                <col style={{ width: '7.5%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '7%' }} />
                <col style={{ width: '4%' }} />
                {adminMemo.isAdmin && <col style={{ width: '9%' }} />}
                <col style={{ width: 36 }} />
              </colgroup>
              <thead className="text-center">
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
                  <th rowSpan={2} className="bg-[#eef1f6] text-center leading-tight">사용 위치·공정</th>
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
              <tbody>
                {d.lines.map((l, i) => {
                  const pq = priorOf(l);
                  // 이미 발주(선발주)된 줄은 고칠 수 없음
                  const locked = !!d.id && d.status === 'pending' && !!ordered.get(`${d.id}|${l.key}`);
                  const rowEd = editable && !locked;
                  const rowOrderEd = orderEditable && !locked;
                  const remain = l.execQty ? l.execQty - pq - l.reqQty : null;
                  return (
                    <tr key={l.key} className="align-top">
<td className="pt-2 text-muted">{i + 1}</td>
                      <td>
                        {rowEd ? (
                          <PickInput
                            className="w-full"
                            value={l.itemName}
                            options={itemOptions}
                            invalid={!!l.itemName && !itemSet.has(normItem(l.itemName))}
                            placeholder="품명 선택 ▾"
                            onPick={(v) => pickItem(l.key, v)}
                          />
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
                      <td>
                        {rowEd ? (
                          <PickInput
                            className="w-full"
                            value={l.spec}
                            options={specOptions(l.itemName)}
                            invalid={!!l.spec && !specOk(l.itemName, l.spec)}
                            placeholder={l.itemName ? '규격 ▾' : '품명 먼저'}
                            onPick={(v) => pickSpec(l.key, l.itemName, v)}
                          />
                        ) : (
                          <span className="break-words">{l.spec}</span>
                        )}
                      </td>
                      <td>
                        {T(l.key, 'unit', l.unit, rowEd, 'w-full', { list: `unit-${l.key}` })}
                        {rowEd && (
                          <datalist id={`unit-${l.key}`}>
                            {unitOptions(l.itemName, l.spec).map((x) => (
                              <option key={x} value={x} />
                            ))}
                          </datalist>
                        )}
                      </td>
                                            <td className="num">{N(l.key, 'contractQty', l.contractQty, rowEd, 'w-full')}</td>
                      <td className="num">{N(l.key, 'contractPrice', l.contractPrice, rowEd, 'w-full')}</td>
                      <td className="num">{N(l.key, 'execQty', l.execQty, rowEd, 'w-full')}</td>
                      <td className="num pt-2 text-muted" title={l.priorQtyManual != null ? '엑셀에서 받은 값' : '이전 승인 청구 합계'}>
                        {pq ? pq.toLocaleString() : ''}
                      </td>
<td className="num font-semibold">{N(l.key, 'reqQty', l.reqQty, rowEd, 'w-full')}</td>
                                            <td>
                        {bonText(l) && <div className="pt-1 text-center text-[11.5px] font-semibold text-navy-900" title="금회청구 수량 ÷ 배관 1본 길이">{bonText(l)}</div>}
                        {rowEd || l.note ? T(l.key, 'note', l.note, rowEd, 'w-full', { placeholder: bonText(l) ? '(비고)' : '' }) : null}
                      </td>
<td className="num bg-amber-soft/40">{N(l.key, 'orderQty', l.orderQty || l.reqQty, rowOrderEd, 'w-full')}</td>
                      <td className="num bg-amber-soft/40">
                        <div className="flex items-center justify-end gap-0.5">
                          {N(l.key, 'orderPrice', l.orderPrice, rowOrderEd, 'w-full min-w-0')}
                          {rowOrderEd && l.itemName && (
                            <button className="shrink-0 text-[11px] text-amber-700 hover:underline" onClick={() => setPriceFor(l.key)} title="단가 후보 보기">
                              ▾
                            </button>
                          )}
                        </div>
                        {l.priceSource && <div className="text-right text-[10px] text-muted">{l.priceSource}</div>}
                      </td>
                      <td className="num bg-amber-soft/40 pt-2">{won(lineAmount({ ...l, orderQty: l.orderQty || l.reqQty }))}</td>
                      <td className="bg-amber-soft/40">
                        {rowOrderEd ? (
                          <PickInput
                            className="w-full"
                            value={l.vendorName ?? ''}
                            options={vendorLabels}
                            placeholder="거래선 ▾"
                            onPick={(label) => pickVendor(l.key, label)}
                          />
                        ) : (
                          <span className="break-words">{l.vendorName}</span>
                        )}
                      </td>
                                            <td>{T(l.key, 'remark', l.remark, rowEd, 'w-full')}</td>
<td>
                        {T(l.key, 'location', l.location, rowEd, 'w-full', { placeholder: '사용 위치·공정' })}
                      </td>
                      <td>
                        {rowEd ? (
                          <PickInput
                            className="w-full"
                            value={catName(l.siteCategoryId) ?? ''}
                            options={catLabels}
                            placeholder="분류 ▾"
                            onPick={(label) => pickCat(l.key, label)}
                          />
                        ) : (
                          catName(l.siteCategoryId)
                        )}
                      </td>
                      <td className={`num pt-2 ${remain != null && remain < 0 ? 'font-semibold text-red-600' : 'text-muted'}`}>{remain == null ? '' : remain.toLocaleString()}</td>
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
                        {rowEd && (
                          <button className="text-muted hover:text-red-600" onClick={() => setD({ ...d, lines: d.lines.filter((x) => x.key !== l.key) })} aria-label="줄 삭제">
                            ✕
                          </button>
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
                            {s.result === 'skipped' || !s.userId ? (
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
            const erpRows = priceList.data.filter((p) => itemKey(p.itemName, p.spec) === ik && (!p.siteId || p.siteId === d.siteId)).sort((a, b) => a.price - b.price);
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
                          <td>{p.vendorName}</td>
                          <td className="text-muted">{p.maker}</td>
                          <td>{p.siteName ? <span className="chip bg-amber-soft text-amber-800">이 현장</span> : <span className="text-[12px] text-muted">공통</span>}</td>
                          <td className="num">{p.listPrice ? won(p.listPrice) : ''}</td>
                          <td className="num">{p.negoRate ? `${p.negoRate}%` : ''}</td>
                          <td className="num font-semibold">
                            {won(p.price)}
                            {!priceValid(p) && <span className="ml-1 text-[10.5px] text-red-600">기간 밖</span>}
                          </td>
                          <td className="text-right">
                            <button className="btn-dark h-7 text-[12px]" onClick={() => choose({ orderPrice: p.price, priceSource: 'ERP단가', vendorId: p.vendorId, vendorName: p.vendorName })}>
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
                        const v = vendors.data.find((x) => sameVendor(p.vendorName, x.name, x.aliases));
                        return (
                          <tr key={i}>
                            <td>
                              {p.vendorName}
                              {!v && <span className="ml-1 text-[11px] text-amber-700">(ERP 업체 없음)</span>}
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
