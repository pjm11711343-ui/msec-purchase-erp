import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { audit, commitBatch, newId, stripUndefined } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSiteCategories, useSites, useVendors } from '../../lib/hooks';
import { fillReqForm } from '../../lib/reqForm';
import { looselyEqual, nameKey, num, won } from '../../lib/normalize';
import { readWorkbook } from '../../lib/parsers';
import { findPrices, priceKey, sameVendor, usePrices, type PriceRow } from '../../lib/prices';
import { bonText, lastOrderPrice, lineAmount, newLine, priorQtyMap, useApprovalLines, useRequisitions, useUsers } from '../../lib/reqs';
import { parseReqSheet } from '../../lib/reqExcel';
import { orderedKeys, usePurchaseOrders } from '../../lib/pos';
import { Empty, errMsg, Field, Modal, NumInput, PageHeader, useToast } from '../../components/ui';
import { isCeo, isMyTurn, myDecideStep, nextActive, StatusChip } from './ReqList';
import PickInput from '../../components/PickInput';
import { useItemCatalog, type CatItem, type LastPrice } from '../../lib/itemCatalog';
import { normItem, normSpec } from '../../lib/itemNorm';
import { reqSummary, type ReqSummary } from '../../lib/reqSummary';
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
  const nav = useNavigate();
  const { profile, can, readOnly } = useAuth();
  const toast = useToast();
  const sites = useSites();
  const vendors = useVendors();
  const cats = useSiteCategories();
  const reqs = useRequisitions();
  const lines = useApprovalLines();
  const users = useUsers();
  const prices = usePrices();
  const pos = usePurchaseOrders();
  const ordered = useMemo(() => orderedKeys(pos.data), [pos.data]);
  const [d, setD] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [priceFor, setPriceFor] = useState<string | null>(null); // 단가 후보 보기 (line key)

  const isNew = !id || id === 'new';
  const stored = reqs.data.find((r) => r.id === id);
  const isOffice = can('admin', 'material');

  // 처음 불러오기
  useEffect(() => {
    if (d) return;
    if (isNew) {
      if (!profile || sites.loading) return;
      const siteId = sites.data[0]?.id ?? '';
      setD({
        siteId,
        siteName: sites.data[0]?.name ?? '',
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
  const siteCats = cats.data.filter((c) => c.siteId === d?.siteId).sort((a, b) => a.order - b.order);
  // 품명·규격 목록: 월별 품목명세(계산서) + 단가표 + 지난 청구서. 같은 품목(표기 차이)은 한 줄, 계산서 표기를 먼저 씀
  const catalog = useItemCatalog();
  const lists = useMemo(() => {
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
      put(c.i, c.s, c.u);
      cat.set(`${normItem(c.i)}|${normSpec(c.s)}`, c);
    }
    prices.rows.forEach((p) => put(p.itemName, p.spec, p.unit));
    reqs.data.forEach((r) => r.lines.forEach((l) => put(l.itemName, l.spec, l.unit)));
    return { items, specs, units, unitsItem, cat };
  }, [catalog.items, prices.rows, reqs.data]);
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
  const draftEditable = !readOnly && (d.status === 'draft' || d.status === 'rejected') && (d.createdBy === profile?.id || isOffice);
  const pendEditable = !readOnly && d.status === 'pending' && (d.createdBy === profile?.id || isOffice || d.steps.some((s) => s.userId && s.userId === profile?.id));
  const editable = draftEditable || pendEditable;
  const myTurn = !!d.id && isMyTurn(d as Requisition, profile?.id, can('admin'));
  const orderEditable = editable ? isOffice : myTurn && isOffice;
  const dupDoc =
    d.docNo.trim() && reqs.data.some((r) => r.id !== d.id && r.siteId === d.siteId && nameKey(r.docNo) === nameKey(d.docNo));

  const priorOf = (l: ReqLine) => l.priorQtyManual ?? prior.get(priceKey(l.itemName, l.spec)) ?? 0;

  const setLine = (key: string, patch: Partial<ReqLine>) => setD((x) => x && { ...x, lines: x.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });

  /** 단가 자동: 최신 계산서 단가(같은 현장 → 전체) → 단가표(거래선 → 최저) → 직전 발주단가 */
  const suggest = (l: ReqLine): Partial<ReqLine> => {
    if (!l.itemName) return {};
    const ip = invoicePrice(l.itemName, l.spec, d.siteId);
    if (ip) {
      const u = lists.cat.get(`${normItem(l.itemName)}|${normSpec(l.spec)}`)?.u;
      const iv = !l.vendorId ? vendors.data.find((x) => x.id === ip.vid) : undefined;
      return { orderPrice: ip.p, priceSource: '계산서', ...(u && !l.unit ? { unit: u } : {}), ...(iv ? { vendorId: iv.id, vendorName: iv.name } : {}) };
    }
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
  const autoPrice = (key: string) =>
    setD((x) => {
      if (!x) return x;
      return { ...x, lines: x.lines.map((l) => (l.key === key && !l.orderPrice ? { ...l, ...suggest(l) } : l)) };
    });

  /** 품명·규격은 목록에서 고른 값만. 바꾸면 자동 단가는 다시 찾는다 */
  const resetAuto = (l: ReqLine): Partial<ReqLine> => (l.priceSource === '계산서' || l.priceSource === '단가표' || l.priceSource === '직전발주' ? { orderPrice: 0, priceSource: undefined } : {});
  const pickItem = (key: string, v: string) => {
    const l = d.lines.find((x) => x.key === key);
    if (!l || v === l.itemName) return;
    const keepSpec = !!l.spec && specOk(v, l.spec);
    setLine(key, { itemName: v, ...(keepSpec ? {} : { spec: '' }), ...resetAuto(l) });
    autoPrice(key);
  };
  const pickSpec = (key: string, item: string, v: string) => {
    const l = d.lines.find((x) => x.key === key);
    if (!l || v === l.spec) return;
    const us = unitsOf(item, v);
    setLine(key, { spec: v, ...(us?.size === 1 ? { unit: [...us][0] } : {}), ...resetAuto(l) });
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
    const ls = d.lines
      .filter((l) => l.itemName.trim())
      .map((l) => ({ ...l, itemName: l.itemName.trim(), spec: l.spec.trim(), priorQty: priorOf(l), orderQty: l.orderQty || l.reqQty }));
    const site = sites.data.find((s) => s.id === d.siteId);
    const { id: _ignore, ...rest } = d;
    void _ignore;
    return stripUndefined({
      ...rest,
      siteName: site?.name ?? d.siteName,
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
      const data = build({ ...patch, history: [...d.history, { at: Date.now(), by: profile?.name ?? '', action, ...(comment ? { comment } : {}) }] });
      await commitBatch([{ type: 'set', col: C.requisitions, id: rid, data, merge: false }]);
      await audit(`구매청구 ${action}`, rid, { docNo: data.docNo, site: data.siteName });
      toast(okMsg);
      setComment('');
      setD({ ...data, id: rid });
      if (!d.id) nav(`/req/${rid}`, { replace: true });
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (!d.lines.some((l) => l.itemName.trim())) return toast('품목을 한 줄 이상 입력하세요.', 'err');
    // 금회청구 수량이 비어 있어도 결재를 올릴 수 있다 (수량은 결재 중 자재부가 발주수량으로 정함)
    const wrong = d.lines.filter(invalidLine);
    if (wrong.length) return toast(`목록에 없는 품명·규격이 ${wrong.length}줄 있습니다 (빨간 칸). 목록에서 다시 고르세요: ${wrong.slice(0, 3).map((l) => `${l.itemName} ${l.spec}`).join(', ')}`, 'err');
    // 결재자 미지정 칸은 건너뜀
    const steps: ApprovalStepState[] = d.steps.map((s) => (s.userId ? { label: s.label, userId: s.userId, userName: s.userName } : { label: s.label, result: 'skipped' }));
    const first = nextActive(steps, 0);
    if (first < 0) return toast('결재선에 결재자를 한 명 이상 지정하세요.', 'err');
    save({ status: 'pending', steps, currentStep: first, currentApproverId: steps[first].userId, approverIds: steps.filter((s) => s.userId).map((s) => s.userId!), submittedAt: Date.now() }, '결재 요청', '결재를 올렸습니다.');
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
    save({ steps, currentStep: next, currentApproverId: steps[next].userId }, j > d.currentStep ? `${me.label} 전결 승인` : `${me.label} 승인`, '승인했습니다.');
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

  const remove = async () => {
    if (!d.id || !confirm('이 청구서를 삭제할까요?')) return;
    try {
      await commitBatch([{ type: 'delete', col: C.requisitions, id: d.id }]);
      await audit('구매청구 삭제', d.id, { docNo: d.docNo });
      toast('삭제했습니다.');
      nav('/req');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const addFromRows = (rows: Partial<ReqLine>[]) => {
    const added = rows.map((r) => {
      const l = { ...newLine(), ...r } as ReqLine;
      if (l.vendorName && !l.vendorId) {
        const v = vendors.data.find((x) => sameVendor(l.vendorName!, x.name, x.aliases));
        if (v) Object.assign(l, { vendorId: v.id, vendorName: v.name });
      }
      if (!l.orderPrice) Object.assign(l, suggest(l));
      return l;
    });
    setD((x) => x && { ...x, lines: [...x.lines.filter((l) => l.itemName.trim()), ...added] });
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
      addFromRows(p.lines);
      setD((x) => x && { ...x, purpose: x.purpose || p.purpose, requestDate: x.requestDate || p.docDate || today() });
      toast(`${p.lines.length}줄을 가져왔습니다.${siteMsg}`, !site && p.siteLabel ? 'err' : undefined);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  const pasteRows = pasteText
    .split(/\r?\n/)
    .map((x) => x.split('\t'))
    .filter((c) => c[0]?.trim())
    .map((c) => ({ itemName: c[0].trim(), spec: (c[1] ?? '').trim(), unit: (c[2] ?? '').trim(), reqQty: num(c[3]), remark: (c[4] ?? '').trim() || undefined, location: (c[5] ?? '').trim() || undefined }));

  const vendorOf = (vid?: string): Vendor | undefined => vendors.data.find((v) => v.id === vid);
  /** 거래선 목록: 등록된 업체 전부 (사용 중인 업체 먼저) */
  const vendorOptions = [...vendors.data].sort((a, b) => Number(a.active === false) - Number(b.active === false) || a.name.localeCompare(b.name, 'ko'));
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
      const { truncated } = fillReqForm(wb, req, sumX, logo);
      const blob = new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `구매청구서_${req.siteName}_${req.docNo || req.requestDate}.xlsx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      if (truncated) toast(`양식은 168줄까지라 ${truncated}줄은 빠졌습니다.`, 'err');
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
            <span className="font-semibold">현장명 : {d.siteName || '-'} 현장</span>
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
          <div>
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
                  <th rowSpan={2} className="bg-[#eef1f6] text-center leading-tight">
                    희망납기
                    <br />
                    사용 위치·공정
                  </th>
                  <th rowSpan={2} className="bg-[#eef1f6] text-center">자재분류</th>
                  <th rowSpan={2} className="bg-[#eef1f6] text-center leading-tight">
                    실행
                    <br />
                    잔여
                  </th>
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
                          <select
                            className="input h-7 w-full px-1"
                            value={l.vendorId ?? ''}
                            onChange={(e) => {
                              const v = vendorOf(e.target.value);
                              setLine(l.key, { vendorId: v?.id, vendorName: v?.name });
                            }}
                          >
                            <option value="">-</option>
                            {vendorOptions.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.name}
                                {v.active === false ? ' (사용 중지)' : ''}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="break-words">{l.vendorName}</span>
                        )}
                      </td>
                                            <td>{T(l.key, 'remark', l.remark, rowEd, 'w-full')}</td>
<td>
                        <div className="flex flex-col gap-0.5">
                          {rowEd ? (
                            <input type="date" className="input h-7 w-full px-1 text-[11.5px]" value={l.dueDate ?? ''} onChange={(e) => setLine(l.key, { dueDate: e.target.value || undefined })} />
                          ) : (
                            <span>{l.dueDate}</span>
                          )}
                          {T(l.key, 'location', l.location, rowEd, 'w-full', { placeholder: '사용 위치·공정' })}
                        </div>
                      </td>
                      <td>
                        {rowEd ? (
                          <select className="input h-7 w-full px-1" value={l.siteCategoryId ?? ''} onChange={(e) => setLine(l.key, { siteCategoryId: e.target.value || undefined })}>
                            <option value="">-</option>
                            {siteCats.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          catName(l.siteCategoryId)
                        )}
                      </td>
                      <td className={`num pt-2 ${remain != null && remain < 0 ? 'font-semibold text-red-600' : 'text-muted'}`}>{remain == null ? '' : remain.toLocaleString()}</td>
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
                <tr className="bg-[#f7f8fb] font-semibold">
                  <td colSpan={12} className="text-right">
                    합계
                  </td>
                  <td className="num">{won(d.lines.reduce((a, l) => a + lineAmount({ ...l, orderQty: l.orderQty || l.reqQty }), 0))}</td>
                  <td colSpan={6}></td>
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
                                <span className="font-medium">{s.userName}</span>
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
        )}
      </div>

      {d.siteId && <SummaryPanel sum={summary} />}

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
                {!cands.length && !last && !invRows.length && <Empty>계산서·단가표·직전 발주에 이 품목이 없습니다. 단가를 직접 입력하세요.</Empty>}
                {invRows.length > 0 && (
                  <table className="tbl mb-3">
                    <thead>
                      <tr>
                        <th>최신 계산서 단가</th>
                        <th>월</th>
                        <th>업체</th>
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
    </div>
  );
}


/** 하단 요약: 자재분류별 계약·변경(예상)·실행·기반입·금회청구 + 업체별 금회청구 */
function SummaryPanel({ sum }: { sum: ReqSummary }) {
  const [all, setAll] = useState(false);
  const onlyCur = !all;
  const rows = onlyCur ? sum.rows.filter((r) => r.current) : sum.rows;
  const f = (v: number) => (v ? won(v) : '');
  const remain = (r: { exec: number; change: number; prior: number; current: number }) => (r.exec ? r.exec - r.prior - r.current : 0);
  return (
    <div className="card mt-4 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="font-semibold text-navy-950">자재분류 · 금회청구 업체별 금액</span>
        <span className="text-[12px] text-muted">기반입금액 = 이 청구서보다 먼저 올린 이 현장 청구서의 발주 금액 (발주된 줄은 발주서 금액)</span>
        <button className="btn-ghost ml-auto h-7 text-[12px]" onClick={() => setAll(!all)}>
          {all ? '청구 분류만 보기' : `전체 보기 (${sum.rows.length}개 분류)`}
        </button>
      </div>
      {!rows.length ? (
        <Empty>현장 투입집계 분류가 없습니다. 기준정보 › 분류에서 현장 분류를 등록하세요.</Empty>
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
