import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { audit, commitBatch, newId, stripUndefined } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSiteCategories, useSites, useVendors } from '../../lib/hooks';
import { nameKey, num, won } from '../../lib/normalize';
import { readWorkbook } from '../../lib/parsers';
import { findPrices, priceKey, sameVendor, usePrices, type PriceRow } from '../../lib/prices';
import { lastOrderPrice, lineAmount, newLine, priorQtyMap, useApprovalLines, useRequisitions, useUsers } from '../../lib/reqs';
import { exportReq, parseReqSheet } from '../../lib/reqExcel';
import { orderedKeys, usePurchaseOrders } from '../../lib/pos';
import { Empty, errMsg, Field, Modal, PageHeader, useToast } from '../../components/ui';
import { isCeo, isMyTurn, myDecideStep, nextActive, StatusChip } from './ReqList';
import PickInput from '../../components/PickInput';
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
  const itemOptions = useMemo(() => {
    const s = new Set<string>();
    prices.rows.forEach((p) => s.add(p.itemName));
    reqs.data.forEach((r) => r.lines.forEach((l) => l.itemName && s.add(l.itemName)));
    return [...s].sort((a, b) => a.localeCompare(b, 'ko'));
  }, [prices.rows, reqs.data]);
  const itemSet = useMemo(() => new Set(itemOptions.map(nameKey)), [itemOptions]);
  // 품명별 규격 / 품명·규격별 단위 목록 (단가표 + 지난 청구서)
  const specUnit = useMemo(() => {
    const specs = new Map<string, Set<string>>();
    const units = new Map<string, Set<string>>();
    const unitsItem = new Map<string, Set<string>>();
    const add = (m: Map<string, Set<string>>, k: string, v: string) => {
      if (!v) return;
      const set = m.get(k) ?? new Set<string>();
      set.add(v);
      m.set(k, set);
    };
    const put = (item: string, spec: string, unit: string) => {
      const ik = nameKey(item);
      if (!ik) return;
      add(specs, ik, (spec ?? '').trim());
      add(units, `${ik}|${nameKey(spec)}`, (unit ?? '').trim());
      add(unitsItem, ik, (unit ?? '').trim());
    };
    prices.rows.forEach((p) => put(p.itemName, p.spec, p.unit));
    reqs.data.forEach((r) => r.lines.forEach((l) => put(l.itemName, l.spec, l.unit)));
    return { specs, units, unitsItem };
  }, [prices.rows, reqs.data]);
  const sizeOf = (s: string) => {
    const m = s.match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  const specOptions = (item: string) => [...(specUnit.specs.get(nameKey(item)) ?? [])].sort((a, b) => sizeOf(a) - sizeOf(b) || a.localeCompare(b, 'ko'));
  const unitOptions = (item: string, spec: string) => {
    const exact = [...(specUnit.units.get(`${nameKey(item)}|${nameKey(spec)}`) ?? [])];
    const byItem = [...(specUnit.unitsItem.get(nameKey(item)) ?? [])];
    return [...new Set([...exact, ...byItem, ...COMMON_UNITS])].filter((u) => !HIDDEN_UNITS.has(u));
  };

  if (!d) return <div className="text-muted">{reqs.loading || sites.loading ? '불러오는 중…' : '청구서를 찾을 수 없습니다.'}</div>;

  const editable = !readOnly && (d.status === 'draft' || d.status === 'rejected') && (d.createdBy === profile?.id || isOffice);
  const myTurn = !!d.id && isMyTurn(d as Requisition, profile?.id, can('admin'));
  const orderEditable = editable ? isOffice : myTurn && isOffice;
  const dupDoc =
    d.docNo.trim() && reqs.data.some((r) => r.id !== d.id && r.siteId === d.siteId && nameKey(r.docNo) === nameKey(d.docNo));

  const priorOf = (l: ReqLine) => l.priorQtyManual ?? prior.get(priceKey(l.itemName, l.spec)) ?? 0;

  const setLine = (key: string, patch: Partial<ReqLine>) => setD((x) => x && { ...x, lines: x.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });

  /** 단가 자동: 거래선 단가 → 최저 단가 → 직전 발주단가 */
  const suggest = (l: ReqLine): Partial<ReqLine> => {
    if (!l.itemName) return {};
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
  const resetAuto = (l: ReqLine): Partial<ReqLine> => (l.priceSource === '단가표' || l.priceSource === '직전발주' ? { orderPrice: 0, priceSource: undefined } : {});
  const pickItem = (key: string, v: string) => {
    const l = d.lines.find((x) => x.key === key);
    if (!l || v === l.itemName) return;
    const keepSpec = specOptions(v).some((x) => nameKey(x) === nameKey(l.spec));
    setLine(key, { itemName: v, ...(keepSpec ? {} : { spec: '' }), ...resetAuto(l) });
    autoPrice(key);
  };
  const pickSpec = (key: string, item: string, v: string) => {
    const l = d.lines.find((x) => x.key === key);
    if (!l || v === l.spec) return;
    const us = specUnit.units.get(`${nameKey(item)}|${nameKey(v)}`);
    setLine(key, { spec: v, ...(us?.size === 1 ? { unit: [...us][0] } : {}), ...resetAuto(l) });
    autoPrice(key);
  };
  /** 목록에 없는 품명·규격 줄 (엑셀·붙여넣기로 들어온 줄) */
  const invalidLine = (l: ReqLine) =>
    !!l.itemName.trim() && (!itemSet.has(nameKey(l.itemName)) || (!!l.spec.trim() && !specOptions(l.itemName).some((x) => nameKey(x) === nameKey(l.spec))));

  const total = d.lines.reduce((a, l) => a + lineAmount(l), 0);

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
    const bad = d.lines.find((l) => l.itemName.trim() && !l.reqQty);
    if (bad) return toast(`"${bad.itemName}"의 금회청구 수량을 입력하세요.`, 'err');
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

  const reopen = () =>
    save({ status: 'draft', currentStep: 0, currentApproverId: undefined, steps: d.steps.map((s) => ({ label: s.label, userId: s.userId, userName: s.userName })) }, '다시 작성', '작성중으로 돌렸습니다.');

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

  const onExcel = async (file?: File) => {
    if (!file) return;
    try {
      const p = parseReqSheet(readWorkbook(await file.arrayBuffer()));
      if (!p.lines.length) return toast('청구서 시트에 품목이 없습니다.', 'err');
      addFromRows(p.lines);
      setD((x) => x && { ...x, purpose: x.purpose || p.purpose, requestDate: x.requestDate || p.docDate || today() });
      toast(`${p.lines.length}줄을 가져왔습니다. 단가가 빈 줄은 단가표·직전 발주에서 채웠습니다.`);
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
  const catName = (cid?: string) => cats.data.find((c) => c.id === cid)?.name;
  const N = (key: string, field: keyof ReqLine, v: number, on: boolean | undefined, w = 'w-20') =>
    on ? (
      <input className={`input h-7 ${w} px-1.5 text-right`} value={v || ''} onChange={(e) => setLine(key, { [field]: num(e.target.value) } as Partial<ReqLine>)} />
    ) : (
      <span className="tabular-nums">{v ? v.toLocaleString() : ''}</span>
    );
  const T = (key: string, field: keyof ReqLine, v: string | undefined, on: boolean | undefined, w = 'w-28', extra: object = {}) =>
    on ? <input className={`input h-7 ${w} px-1.5`} value={v ?? ''} onChange={(e) => setLine(key, { [field]: e.target.value } as Partial<ReqLine>)} {...extra} /> : <span>{v}</span>;

  return (
    <div>
      <PageHeader
        title={isNew ? '구매청구서 작성' : `구매청구서 ${d.docNo || ''}`}
        desc={d.id ? `${d.siteName} · 작성 ${d.createdByName}` : '품목을 입력하고 결재를 올리세요. 단가는 단가표 → 직전 발주 순으로 자동으로 채웁니다.'}
        actions={
          <>
            <Link to="/req" className="btn-ghost">
              목록
            </Link>
            {d.id && (
              <button className="btn-ghost" onClick={() => exportReq({ ...(build({}) as Requisition), id: d.id! }, catName)}>
                엑셀 다운로드
              </button>
            )}
            {(editable || can('admin')) && d.id && (
              <button className="btn-danger" onClick={remove}>
                삭제
              </button>
            )}
            {editable && (
              <>
                <button className="btn-ghost" disabled={busy} onClick={() => save({}, '임시 저장', '저장했습니다.')}>
                  임시 저장
                </button>
                <button className="btn-primary" disabled={busy} onClick={submit}>
                  결재 올리기
                </button>
              </>
            )}
            {myTurn && orderEditable && (
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

      <div className="mb-4 grid gap-4 xl:grid-cols-[1fr_420px]">
        <div className="card grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
          <Field label="현장">
            <select
              className="input"
              value={d.siteId}
              disabled={!editable || !!d.id}
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
              disabled={!editable}
              onChange={(e) => {
                const type = e.target.value as Requisition['approvalType'];
                setD({ ...d, approvalType: type, steps: TEMPLATES[type].map((label) => ({ label })) });
              }}
            >
              <option>2단계</option>
              <option>6칸</option>
            </select>
            {editable && (
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
                {editable ? (
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
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="font-semibold">품목 {d.lines.filter((l) => l.itemName).length}줄</span>
          {prices.error && <span className="text-[12px] text-red-600">단가표를 읽지 못했습니다</span>}
          {editable && (
            <div className="ml-auto flex gap-2">
              <button className="btn-ghost h-7 text-[12px]" onClick={() => setD({ ...d, lines: [...d.lines, newLine()] })}>
                + 줄 추가
              </button>
              <button className="btn-ghost h-7 text-[12px]" onClick={() => setPasteOpen(true)}>
                엑셀 붙여넣기
              </button>
              <label className="btn-ghost h-7 cursor-pointer text-[12px]">
                청구서 엑셀 불러오기
                <input type="file" accept=".xlsx,.xls" hidden onChange={(e) => (onExcel(e.target.files?.[0]), (e.target.value = ''))} />
              </label>
            </div>
          )}
        </div>
        {!d.lines.length ? (
          <Empty>품목이 없습니다.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-6">#</th>
                  <th>품명</th>
                  <th>규격</th>
                  <th>단위</th>
                  <th className="num">계약수량</th>
                  <th className="num">계약단가</th>
                  <th className="num">실행량</th>
                  <th className="num">기반입</th>
                  <th className="num">금회청구</th>
                  <th className="num">실행잔여</th>
                  <th>본/비고</th>
                  <th>희망납기</th>
                  <th>사용 위치·공정</th>
                  <th>자재분류</th>
                  <th>비고</th>
                  <th className="bg-amber-soft">거래선</th>
                  <th className="num bg-amber-soft">발주수량</th>
                  <th className="num bg-amber-soft">단가</th>
                  <th className="num bg-amber-soft">금액</th>
                  <th>발주</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l, i) => {
                  const pq = priorOf(l);
                  const remain = l.execQty ? l.execQty - pq - l.reqQty : null;
                  return (
                    <tr key={l.key}>
                      <td className="text-muted">{i + 1}</td>
                      <td>
                        {editable ? (
                          <PickInput
                            className="w-44"
                            value={l.itemName}
                            options={itemOptions}
                            invalid={!!l.itemName && !itemSet.has(nameKey(l.itemName))}
                            placeholder="품명 선택 ▾"
                            onPick={(v) => pickItem(l.key, v)}
                          />
                        ) : (
                          <span>{l.itemName}</span>
                        )}
                      </td>
                      <td>
                        {editable ? (
                          <PickInput
                            className="w-28"
                            value={l.spec}
                            options={specOptions(l.itemName)}
                            invalid={!!l.spec && !specOptions(l.itemName).some((x) => nameKey(x) === nameKey(l.spec))}
                            placeholder={l.itemName ? '규격 선택 ▾' : '품명 먼저'}
                            onPick={(v) => pickSpec(l.key, l.itemName, v)}
                          />
                        ) : (
                          <span>{l.spec}</span>
                        )}
                      </td>
                      <td>
                        {T(l.key, 'unit', l.unit, editable, 'w-16', { list: `unit-${l.key}` })}
                        {editable && (
                          <datalist id={`unit-${l.key}`}>
                            {unitOptions(l.itemName, l.spec).map((x) => (
                              <option key={x} value={x} />
                            ))}
                          </datalist>
                        )}
                      </td>
                      <td className="num">{N(l.key, 'contractQty', l.contractQty, editable, 'w-16')}</td>
                      <td className="num">{N(l.key, 'contractPrice', l.contractPrice, editable)}</td>
                      <td className="num">{N(l.key, 'execQty', l.execQty, editable, 'w-16')}</td>
                      <td className="num text-muted" title={l.priorQtyManual != null ? '엑셀에서 받은 값' : '이전 승인 청구 합계'}>
                        {pq ? pq.toLocaleString() : ''}
                      </td>
                      <td className="num font-semibold">{N(l.key, 'reqQty', l.reqQty, editable, 'w-16')}</td>
                      <td className={`num ${remain != null && remain < 0 ? 'font-semibold text-red-600' : 'text-muted'}`}>{remain == null ? '' : remain.toLocaleString()}</td>
                      <td>{T(l.key, 'note', l.note, editable, 'w-16')}</td>
                      <td>{editable ? <input type="date" className="input h-7 w-32 px-1" value={l.dueDate ?? ''} onChange={(e) => setLine(l.key, { dueDate: e.target.value || undefined })} /> : l.dueDate}</td>
                      <td>{T(l.key, 'location', l.location, editable, 'w-28')}</td>
                      <td>
                        {editable ? (
                          <select className="input h-7 w-32 px-1" value={l.siteCategoryId ?? ''} onChange={(e) => setLine(l.key, { siteCategoryId: e.target.value || undefined })}>
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
                      <td>{T(l.key, 'remark', l.remark, editable, 'w-32')}</td>
                      <td className="bg-amber-soft/40">
                        {orderEditable ? (
                          <select
                            className="input h-7 w-32 px-1"
                            value={l.vendorId ?? ''}
                            onChange={(e) => {
                              const v = vendorOf(e.target.value);
                              setLine(l.key, { vendorId: v?.id, vendorName: v?.name });
                            }}
                          >
                            <option value="">-</option>
                            {vendors.data
                              .filter((v) => v.active)
                              .map((v) => (
                                <option key={v.id} value={v.id}>
                                  {v.name}
                                </option>
                              ))}
                          </select>
                        ) : (
                          l.vendorName
                        )}
                      </td>
                      <td className="num bg-amber-soft/40">{N(l.key, 'orderQty', l.orderQty || l.reqQty, orderEditable, 'w-16')}</td>
                      <td className="num bg-amber-soft/40">
                        <div className="flex items-center justify-end gap-1">
                          {N(l.key, 'orderPrice', l.orderPrice, orderEditable)}
                          {l.priceSource && <span className="text-[10px] text-muted">{l.priceSource}</span>}
                          {orderEditable && l.itemName && (
                            <button className="text-[11px] text-amber-700 hover:underline" onClick={() => setPriceFor(l.key)} title="단가 후보 보기">
                              ▾
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="num bg-amber-soft/40">{won(lineAmount({ ...l, orderQty: l.orderQty || l.reqQty }))}</td>
                      <td className="whitespace-nowrap">
                        {d.id && ordered.get(`${d.id}|${l.key}`) && (
                          <Link to={`/po/${ordered.get(`${d.id}|${l.key}`)!.id}`} className="chip bg-emerald-50 text-emerald-700 hover:underline">
                            {ordered.get(`${d.id}|${l.key}`)!.poNo}
                          </Link>
                        )}
                        {editable && (
                          <button className="text-muted hover:text-red-600" onClick={() => setD({ ...d, lines: d.lines.filter((x) => x.key !== l.key) })} aria-label="줄 삭제">
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                <tr className="bg-[#f7f8fb] font-semibold">
                  <td colSpan={18} className="text-right">
                    합계
                  </td>
                  <td className="num">{won(d.lines.reduce((a, l) => a + lineAmount({ ...l, orderQty: l.orderQty || l.reqQty }), 0))}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

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
            const choose = (patch: Partial<ReqLine>) => {
              setLine(l.key, patch);
              setPriceFor(null);
            };
            return (
              <div>
                <div className="mb-2 font-medium">
                  {l.itemName} {l.spec}
                </div>
                {!cands.length && !last && <Empty>단가표와 직전 발주에 이 품목이 없습니다. 단가를 직접 입력하세요.</Empty>}
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

