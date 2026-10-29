import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { useAuth } from '../../auth/AuthContext';
import { audit, commitBatch } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSites, useVendors } from '../../lib/hooks';
import { notify } from '../../lib/notify';
import { elementToPdfBase64 } from '../../lib/poPdf';
import { won } from '../../lib/normalize';
import { preOrderState, usePurchaseOrders } from '../../lib/pos';
import { poLineKey, receivedMap, useReceipts } from '../../lib/receipts';
import { num } from '../../lib/normalize';
import { usePoPrices } from '../../lib/poPrices';
import { useRequisitions, useUsers } from '../../lib/reqs';
import { signMap } from '../../lib/sign';
import { commaText, errMsg, useToast } from '../../components/ui';
import { PoChip, PreChip } from './PoList';
import type { PoLine, PurchaseOrder, Site } from '../../types';

export const MIN_ROWS = 18;

function spaced(s: string) {
  return s.split('').join(' ');
}

/** 결재선(2단계/6칸)을 발주서 결재란 위치에 맞춘다 */
export function signBoxes(po: PurchaseOrder, signOf?: (re: RegExp) => string | undefined) {
  const find = (re: RegExp) => po.signNames.find((s) => re.test(s.label.replace(/\s/g, '')))?.name;
  const box = (label: string, re: RegExp) => ({ label, name: find(re), sign: signOf?.(re) });
  return {
    site: [box('담  당', /^현장담당/), box('소  장', /소장/)],
    hq: [box('담  당', /^본사담당|^자재부/), box('팀  장', /팀장/), box('임  원', /임원/), box('대  표', /대표/)],
  };
}

export default function PoDetail() {
  const { id } = useParams();
  const { profile, can } = useAuth();
  const nav = useNavigate();
  const isOffice = can('admin', 'material');
  const pos = usePurchaseOrders();
  const reqs = useRequisitions();
  const prices = usePoPrices();
  const users = useUsers();
  const signs = signMap(users.data);
  /** 결재란 싸인: 연결된 청구서에서 그 칸 결재자가 승인했으면 싸인 이미지 */
  const signOf = (re: RegExp) => {
    const r = reqs.data.find((x) => po?.reqIds.includes(x.id));
    const st = r?.steps.find((s) => re.test(s.label.replace(/\s/g, '')));
    return st?.result === 'approved' && st.userId ? signs.byId.get(st.userId) : undefined;
  };
  const sites = useSites();
  const vendors = useVendors();
  const pdfRef = useRef<HTMLDivElement>(null);
  const [pdfMode, setPdfMode] = useState(false);
  const [sending, setSending] = useState(false);
  const toast = useToast();
  const po = pos.data.find((p) => p.id === id);
  const site = sites.data.find((s) => s.id === po?.siteId);
  const [internal, setInternal] = useState(false);
  const [showPrice, setShowPrice] = useState(true);
  const [edit, setEdit] = useState<{ deliveryTerm: string; notice: string; memo: string } | null>(null);
  const receipts = useReceipts();
  const rec = receivedMap(receipts.data);
  // 발주 수정: 줄별 수량·단가·비고 / 지울 줄
  const [lineEdit, setLineEdit] = useState<{ rows: { l: PoLine; qty: string; price: string; remark: string; del: boolean }[] } | null>(null);

  useEffect(() => {
    if (po) document.title = `발주서 ${po.poNo} ${po.vendorName}`;
    return () => {
      document.title = '명신기공 구매관리 ERP';
    };
  }, [po]);

  if (!po) return <div className="text-muted">{pos.loading ? '불러오는 중…' : '발주서를 찾을 수 없습니다.'}</div>;

  const update = async (patch: Partial<PurchaseOrder>, action: string) => {
    try {
      await commitBatch([{ type: 'set', col: C.purchaseOrders, id: po.id, data: { ...patch, history: [...po.history, { at: Date.now(), by: profile?.name ?? '', action }] } }]);
      await audit(`발주서 ${action}`, po.poNo);
      toast(`${action} 처리했습니다.`);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  /** 발주서 발송: 업체 메일(PDF·포털 링크) + 현장 단톡방 텔레그램 */
  const sendPo = async () => {
    const v = vendors.data.find((x) => x.id === po.vendorId);
    const to = v?.email?.trim() ?? '';
    if (!to && !confirm(`${po.vendorName} 이메일이 등록되어 있지 않습니다. (기준정보 › 업체)\n메일 없이 현장 텔레그램 알림만 보내고 발송 완료로 표시할까요?`)) return;
    if (to && !confirm(`${po.vendorName} (${to})에 발주서 PDF를 메일로 보내고, 현장 단톡방에 알릴까요?`)) return;
    setSending(true);
    try {
      let pdfBase64 = '';
      if (to) {
        setPdfMode(true);
        await new Promise((r) => setTimeout(r, 300));
        if (pdfRef.current) pdfBase64 = await elementToPdfBase64(pdfRef.current);
      }
      const r = await notify('po_sent', { poId: po.id, ...(to ? { to, pdfBase64 } : {}) });
      if (!r.ok) {
        toast(`발송 실패: ${r.error}`, 'err');
        return;
      }
      const parts = [r.email === 'sent' ? `메일 ${r.to}` : '', r.telegram === 'sent' ? '텔레그램' : ''].filter(Boolean).join(' · ');
      await update({ status: 'sent', sentAt: Date.now() }, `발송 (${parts || '알림 없음'})`);
      if (r.telegram !== 'sent') toast('현장 단톡방이 지정되지 않아 텔레그램은 보내지 않았습니다. (기준정보 › 현장)', 'err');
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setPdfMode(false);
      setSending(false);
    }
  };

  /** 발주 수정 저장 */
  const saveLines = async () => {
    if (!lineEdit) return;
    const keep = lineEdit.rows.filter((r) => !r.del);
    if (!keep.length) return toast('줄을 모두 지우려면 발주 취소를 쓰세요.', 'err');
    for (const r of lineEdit.rows) {
      const got = rec.get(`${po.id}#${poLineKey(r.l)}`) ?? 0;
      if (r.del && got > 0) return toast(`${r.l.itemName} ${r.l.spec}: 입고된 줄은 지울 수 없습니다.`, 'err');
      if (!r.del && num(r.qty) <= 0) return toast(`${r.l.itemName} ${r.l.spec}: 발주수량을 입력하세요.`, 'err');
      if (!r.del && num(r.qty) < got) return toast(`${r.l.itemName} ${r.l.spec}: 이미 ${got.toLocaleString()} 입고되어 그보다 적게 할 수 없습니다.`, 'err');
    }
    const parts: string[] = [];
    const lines: PoLine[] = keep.map((r) => {
      const qty = num(r.qty);
      const price = num(r.price);
      const nm = `${r.l.itemName} ${r.l.spec}`.trim();
      if (qty !== r.l.qty) parts.push(`${nm} 수량 ${r.l.qty.toLocaleString()}→${qty.toLocaleString()}`);
      if (price !== (r.l.price || 0)) parts.push(`${nm} 단가 ${won(r.l.price || 0)}→${won(price)}`);
      const remark = r.remark.trim();
      const { remark: _old, ...rest } = r.l;
      void _old;
      return { ...rest, qty, price, amount: Math.round(qty * price), ...(remark ? { remark } : {}) };
    });
    lineEdit.rows.filter((r) => r.del).forEach((r) => parts.push(`${r.l.itemName} ${r.l.spec} 삭제`));
    const remarkChanged = keep.some((r) => (r.remark.trim() || '') !== (r.l.remark || ''));
    if (!parts.length && !remarkChanged) return setLineEdit(null);
    const reAck = !!po.ackAt && parts.length > 0;
    const action = `발주 수정: ${parts.slice(0, 6).join(', ')}${parts.length > 6 ? ` 외 ${parts.length - 6}건` : ''}${!parts.length ? '비고' : ''}`;
    await update({ lines, totalAmount: lines.reduce((a, l) => a + l.amount, 0), revisedAt: Date.now(), ...(reAck ? { ackAt: 0, ackBy: '' } : {}) }, action);
    setLineEdit(null);
    // 이미 업체에 보낸 발주서면 바뀐 내용을 메일로 알린다
    if (po.status === 'sent' && parts.length && confirm('업체에 발주 변경 내용을 메일로 알릴까요?')) {
      const r = await notify('po_changed', { poId: po.id, change: action.replace(/^발주 수정: /, '') });
      toast(r.ok ? (r.email === 'sent' ? `${r.to}로 변경 메일을 보냈습니다.` : '업체 이메일이 없어 메일은 보내지 못했습니다.') : `변경 메일 실패: ${r.error}`, r.ok && r.email === 'sent' ? undefined : 'err');
    }
  };

  const mailText = () => {
    const subject = `[명신기공 발주서] ${po.siteName} ${po.poNo} (${po.vendorName})`;
    const body = [
      `${po.vendorName} 담당자님 안녕하세요.`,
      `㈜명신기공 ${po.orderedByName}입니다.`,
      '',
      `${po.siteName} 현장 발주서(${po.poNo})를 첨부와 같이 보내드립니다.`,
      `품목 ${po.lines.length}건 · 합계 ${won(po.totalAmount)}원 (부가세 별도)`,
      `납품기간: ${po.deliveryTerm}`,
      site?.address ? `현장주소: ${site.address}` : '',
      site?.managerContact ? `현장 담당: ${site.managerContact}` : '',
      '',
      po.notice,
      '감사합니다.',
    ]
      .filter((x) => x !== '')
      .join('\n');
    return { subject, body };
  };

  const copyMail = async () => {
    const { subject, body } = mailText();
    try {
      await navigator.clipboard.writeText(`제목: ${subject}\n\n${body}`);
      toast(`메일 제목·본문을 복사했습니다.${po.vendorEmail ? ` 받는 사람: ${po.vendorEmail}` : ' (업체 이메일이 등록돼 있지 않습니다)'}`);
    } catch {
      toast('클립보드 복사에 실패했습니다.', 'err');
    }
  };

  const exportExcel = () => {
    const b = signBoxes(po, signOf);
    const aoa: (string | number | null)[][] = [
      [`${po.siteName} 현장\n발   주   서`, null, null, null, '결\n재', '담  당', '팀  장'],
      [null, null, null, null, null, b.hq[0].name ?? '', b.hq[1].name ?? ''],
      ['현             장', site?.orderDisplayName || `㈜명신기공 ${po.siteName}`, null, '구     입     처', `${po.vendorName}${po.vendorPhone ? ` : ${po.vendorPhone}` : ''}`],
      ['발  주   번  호', po.poNo, null, '발     주     처', '㈜ 명 신 기 공'],
      ['담당자 전화번호', site?.managerContact ?? '', null, '발 주 담 당 자', po.orderedByName],
      ['공무 전화번호', site?.officeContact ?? '', null, '결  의   번  호', po.reqDocNos.join(', ')],
      ['납  품   기  간', po.deliveryTerm, null, '현  장  주  소', site?.address ?? ''],
      [po.notice],
      ['자   재   명   칭', '규           격', '단 위', '수       량', '단    가', null, '비  고'],
      ...po.lines.map((l) => [l.itemName, l.spec, l.unit, l.qty, showPrice ? l.price : null, null, [l.location, l.remark, l.dueDate ? `납기 ${l.dueDate}` : ''].filter(Boolean).join(' / ')]),
    ];
    if (showPrice) aoa.push([null, null, null, '합   계', po.totalAmount]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 26 }, { wch: 21 }, { wch: 6 }, { wch: 18 }, { wch: 12 }, { wch: 11 }, { wch: 24 }];
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 1, c: 3 } },
      { s: { r: 0, c: 4 }, e: { r: 1, c: 4 } },
      ...[2, 3, 4, 5, 6].flatMap((r) => [
        { s: { r, c: 1 }, e: { r, c: 2 } },
        { s: { r, c: 4 }, e: { r, c: 6 } },
      ]),
      { s: { r: 7, c: 0 }, e: { r: 7, c: 6 } },
      { s: { r: 8, c: 4 }, e: { r: 8, c: 5 } },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '발주서');
    XLSX.writeFile(wb, `발주서_${po.siteName}_${po.vendorName}_${po.poNo}.xlsx`);
  };

  const b = signBoxes(po, signOf);
  const pad = Math.max(0, MIN_ROWS - po.lines.length);

  return (
    <div>
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <Link to="/po" className="btn-ghost">
          목록
        </Link>
        <span className="text-[17px] font-bold text-navy-950">{po.poNo}</span>
        <PoChip s={po.status} />
        <PreChip s={preOrderState(po, reqs.data)} />
        <span className="text-muted">
          {po.siteName} · {po.vendorName} · {won(po.totalAmount)}원
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-[12px]">
            <input type="checkbox" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} /> 단가 표시
          </label>
          <label className="flex items-center gap-1 text-[12px]">
            <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> 내부 결재란(6칸)
          </label>
          <button className="btn-dark" onClick={() => window.print()}>
            인쇄 / PDF 저장
          </button>
          <button className="btn-ghost" onClick={exportExcel}>
            엑셀
          </button>
          <button className="btn-ghost" onClick={copyMail}>
            메일 내용 복사
          </button>
          {isOffice && po.status === 'issued' && (
            <>
              <button className="btn-ghost" onClick={() => setEdit({ deliveryTerm: po.deliveryTerm, notice: po.notice, memo: po.memo ?? '' })}>
                내용 수정
              </button>
              <button className="btn-primary" disabled={sending} onClick={sendPo}>
                {sending ? '보내는 중…' : '메일·텔레그램 발송'}
              </button>
              <button className="btn-ghost" title="메일을 따로 보낸 경우" onClick={() => update({ status: 'sent', sentAt: Date.now() }, '발송 완료 (직접 발송)')}>
                발송 완료 표시만
              </button>
            </>
          )}
          {isOffice && po.status === 'sent' && (
            <button className="btn-ghost" disabled={sending} onClick={sendPo}>
              {sending ? '보내는 중…' : '다시 발송'}
            </button>
          )}
          {can('admin') && po.status === 'cancelled' && (
            <button
              className="btn-danger"
              onClick={async () => {
                if (!confirm('취소된 발주서를 완전히 삭제할까요?')) return;
                try {
                  await commitBatch([{ type: 'delete', col: C.purchaseOrders, id: po.id }]);
                  await audit('발주서 삭제', po.poNo);
                  toast('삭제했습니다.');
                  nav('/po');
                } catch (e) {
                  toast(errMsg(e), 'err');
                }
              }}
            >
              삭제
            </button>
          )}
          {isOffice && po.status !== 'cancelled' && (
            <button className="btn-ghost" onClick={() => setLineEdit({ rows: po.lines.map((l) => ({ l, qty: commaText(String(l.qty)), price: l.price ? commaText(String(l.price)) : '', remark: l.remark ?? '', del: false })) })}>
              발주 수정
            </button>
          )}
          {isOffice && po.status !== 'cancelled' && (
            <button
              className="btn-danger"
              onClick={() => {
                const got = po.lines.reduce((a, l) => a + (rec.get(`${po.id}#${poLineKey(l)}`) ?? 0), 0);
                if (got > 0) return toast('입고 기록이 있는 발주서는 취소할 수 없습니다. 입고 현황에서 입고를 먼저 취소하세요.', 'err');
                if (!confirm('발주를 취소할까요? 품목은 다시 발주 대기로 돌아갑니다.')) return;
                const wasSent = po.status === 'sent';
                void update({ status: 'cancelled', cancelledAt: Date.now() }, '취소').then(async () => {
                  if (wasSent && confirm('업체에 발주 취소를 메일로 알릴까요?')) {
                    const r = await notify('po_cancelled', { poId: po.id });
                    toast(r.ok ? (r.email === 'sent' ? `${r.to}로 취소 메일을 보냈습니다.` : '업체 이메일이 없어 메일은 보내지 못했습니다.') : `취소 메일 실패: ${r.error}`, r.ok && r.email === 'sent' ? undefined : 'err');
                  }
                });
              }}
            >
              발주 취소
            </button>
          )}
        </div>
      </div>

      {lineEdit && (
        <div className="no-print card mb-4 overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
            <span className="font-semibold">발주 수정</span>
            <span className="text-[12px] text-muted">수량은 입고된 수량보다 적게 할 수 없습니다. 지운 줄은 발주 대기로 돌아갑니다. 업체가 발주 확인을 했다면 다시 확인받습니다.</span>
            <div className="ml-auto flex gap-2">
              <button className="btn-ghost" onClick={() => setLineEdit(null)}>
                닫기
              </button>
              <button className="btn-primary" onClick={saveLines}>
                수정 저장
              </button>
            </div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>품명</th>
                <th>규격</th>
                <th>단위</th>
                <th className="num">입고</th>
                <th className="num w-28">발주수량</th>
                <th className="num w-32">단가</th>
                <th className="num">금액</th>
                <th>비고</th>
                <th className="w-16 text-center">줄 삭제</th>
              </tr>
            </thead>
            <tbody>
              {lineEdit.rows.map((r, i) => {
                const got = rec.get(`${po.id}#${poLineKey(r.l)}`) ?? 0;
                const set = (patch: Partial<(typeof lineEdit.rows)[number]>) => setLineEdit({ rows: lineEdit.rows.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <tr key={poLineKey(r.l)} className={r.del ? 'text-muted line-through' : ''}>
                    <td>{r.l.itemName}</td>
                    <td>{r.l.spec}</td>
                    <td>{r.l.unit}</td>
                    <td className="num">{got ? got.toLocaleString() : ''}</td>
                    <td className="num">
                      <input className={`input h-7 w-24 px-1.5 text-right ${num(r.qty) < got ? 'border-red-400 bg-red-50' : ''}`} disabled={r.del} value={r.qty} onChange={(e) => set({ qty: commaText(e.target.value) })} />
                    </td>
                    <td className="num">
                      <input className="input h-7 w-28 px-1.5 text-right" disabled={r.del} value={r.price} onChange={(e) => set({ price: commaText(e.target.value) })} />
                    </td>
                    <td className="num">{won(Math.round(num(r.qty) * num(r.price)))}</td>
                    <td>
                      <input className="input h-7 w-full px-1.5" disabled={r.del} value={r.remark} onChange={(e) => set({ remark: e.target.value })} />
                    </td>
                    <td className="text-center">
                      <input type="checkbox" checked={r.del} disabled={got > 0} title={got > 0 ? '입고된 줄은 지울 수 없습니다' : ''} onChange={(e) => set({ del: e.target.checked })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {edit && (
        <div className="no-print card mb-4 grid gap-3 p-4 md:grid-cols-[200px_1fr_1fr_auto]">
          <input className="input" placeholder="납품기간" value={edit.deliveryTerm} onChange={(e) => setEdit({ ...edit, deliveryTerm: e.target.value })} />
          <input className="input" placeholder="안내 문구" value={edit.notice} onChange={(e) => setEdit({ ...edit, notice: e.target.value })} />
          <input className="input" placeholder="내부 메모 (인쇄 안 됨)" value={edit.memo} onChange={(e) => setEdit({ ...edit, memo: e.target.value })} />
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => setEdit(null)}>
              취소
            </button>
            <button
              className="btn-primary"
              onClick={() => {
                update({ deliveryTerm: edit.deliveryTerm, notice: edit.notice, memo: edit.memo || undefined }, '내용 수정');
                setEdit(null);
              }}
            >
              저장
            </button>
          </div>
        </div>
      )}

      {isOffice && (() => {
        const pend = prices.data.filter((p) => p.poId === po.id && p.kind === 'change' && p.status === 'pending');
        const byVendor = po.lines.filter((l) => l.priceBy === 'vendor');
        if (!pend.length && !byVendor.length) return null;
        return (
          <div className="no-print mb-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-[12.5px] text-violet-800">
            {pend.length > 0 && (
              <div>
                업체가 단가 변경을 요청했습니다 ({pend.length}건): {pend.map((p) => `${p.itemName} ${p.spec} ${won(p.oldPrice)}→${won(p.price)}원`).join(', ')}{' '}
                <Link to="/po" className="font-semibold underline">
                  발주 › 업체 단가 요청에서 처리
                </Link>
              </div>
            )}
            {byVendor.length > 0 && <div>업체가 기입·변경한 단가: {byVendor.map((l) => `${l.itemName} ${l.spec} ${won(l.price)}원${l.priceOld ? ` (전 ${won(l.priceOld)})` : ''}`).join(', ')}</div>}
          </div>
        );
      })()}

      <PoSheet po={po} site={site} boxes={b} internal={internal} showPrice={showPrice} pad={pad} />
      {pdfMode && (
        // 메일 첨부용 발주서 (업체용: 결재란 2칸, 단가 표시) — 화면 밖에 그려서 PDF로
        <div style={{ position: 'fixed', left: -10000, top: 0, width: 800, background: '#fff' }} aria-hidden>
          <div ref={pdfRef} className="bg-white p-4">
            <PoSheet po={po} site={site} boxes={b} internal={false} showPrice pad={pad} />
          </div>
        </div>
      )}

      <div className="no-print mt-4 grid gap-4 md:grid-cols-2">
        <div className="card px-4 py-3">
          <div className="mb-1 font-semibold">메일 미리보기</div>
          <div className="text-[12px] text-muted">받는 사람: {po.vendorEmail ?? '업체 이메일 미등록 (기준정보 > 업체)'}</div>
          <div className="mt-1 text-[12.5px] font-medium">{mailText().subject}</div>
          <pre className="mt-1 whitespace-pre-wrap font-sans text-[12.5px] text-ink">{mailText().body}</pre>
        </div>
        <div className="card px-4 py-3">
          <div className="mb-1 font-semibold">진행 기록</div>
          {po.memo && <div className="mb-1 rounded bg-amber-soft px-2 py-1 text-[12px]">메모: {po.memo}</div>}
          {[...po.history].reverse().map((h, i) => (
            <div key={i} className="text-[12px] text-muted">
              {new Date(h.at).toLocaleString('ko-KR')} · {h.by} · {h.action}
            </div>
          ))}
          <div className="mt-2 text-[12px]">
            청구서:{' '}
            {po.reqIds.map((rid, i) => (
              <Link key={rid} to={`/req/${rid}`} className="mr-2 text-navy-900 hover:underline">
                {po.reqDocNos[i] ?? '보기'}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 원 발주서 양식 (A4 세로) */
export function PoSheet({
  po,
  site,
  boxes,
  internal,
  showPrice,
  pad,
}: {
  po: PurchaseOrder;
  site?: Site;
  boxes: ReturnType<typeof signBoxes>;
  internal: boolean;
  showPrice: boolean;
  pad: number;
}) {
  const cell = 'border border-black px-2 py-1';
  const head = `${cell} bg-[#f2f2f2] text-center font-semibold whitespace-nowrap`;
  return (
    <div className="po-sheet mx-auto w-[794px] bg-white p-8 text-[12px] text-black shadow-sm print:w-auto print:p-0 print:shadow-none">
      <table className="w-full border-collapse">
        <tbody>
          <tr>
            <td className={`${cell} text-center`} colSpan={4} rowSpan={2}>
              <div className="text-[14px] font-semibold">{po.siteName} 현장</div>
              <div className="mt-1 text-[24px] font-bold tracking-[0.6em]">발주서</div>
            </td>
            <td className={`${head} w-7 leading-tight`} rowSpan={2}>
              결<br />
              <br />재
            </td>
            {(internal ? [...boxes.site, ...boxes.hq] : boxes.hq.slice(0, 2)).map((s, i) => (
              <td key={i} className={`${head} w-14 py-0.5 text-[11px]`}>
                {internal && i === 0 && <span className="mr-0.5 text-[9px] text-gray-500">현</span>}
                {internal && i === 2 && <span className="mr-0.5 text-[9px] text-gray-500">본</span>}
                {s.label}
              </td>
            ))}
          </tr>
          <tr>
            {(internal ? [...boxes.site, ...boxes.hq] : boxes.hq.slice(0, 2)).map((s, i) => (
              <td key={i} className={`${cell} h-12 text-center text-[11px]`}>
                {s.sign ? <img src={s.sign} alt={`${s.name ?? ''} 싸인`} title={s.name} className="mx-auto h-9 max-w-[52px] object-contain" /> : (s.name ?? '')}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <table className="mt-[-1px] w-full border-collapse">
        <colgroup>
          <col className="w-[110px]" />
          <col />
          <col className="w-[100px]" />
          <col />
        </colgroup>
        <tbody>
          {[
            ['현             장', site?.orderDisplayName || `㈜명신기공 ${po.siteName}`, '구     입     처', `${po.vendorName}${po.vendorPhone ? ` : ${po.vendorPhone}` : ''}`],
            ['발  주   번  호', po.poNo, '발     주     처', '㈜ 명 신 기 공'],
            ['담당자 전화번호', site?.managerContact ?? '', '발 주 담 당 자', po.orderedByName],
            ['공무 전화번호', site?.officeContact ?? '', '결  의   번  호', po.reqDocNos.join(', ')],
            ['납  품   기  간', po.deliveryTerm, '현  장  주  소', site?.address ?? ''],
            ['발    주    일', po.orderDate, '합  계  금  액', showPrice ? `${won(po.totalAmount)}원 (VAT 별도)` : ''],
          ].map((r, i) => (
            <tr key={i}>
              <td className={head}>{r[0]}</td>
              <td className={cell}>{r[1]}</td>
              <td className={head}>{r[2]}</td>
              <td className={cell}>{r[3]}</td>
            </tr>
          ))}
          <tr>
            <td className={`${cell} py-2 text-center font-semibold`} colSpan={4}>
              {po.notice}
            </td>
          </tr>
        </tbody>
      </table>
      <table className="mt-[-1px] w-full border-collapse">
        <thead>
          <tr>
            <th className={`${head} w-8`}>No</th>
            <th className={head}>{spaced('자재명칭')}</th>
            <th className={head}>{spaced('규격')}</th>
            <th className={`${head} w-12`}>단 위</th>
            <th className={`${head} w-16`}>수 량</th>
            {showPrice && <th className={`${head} w-20`}>단 가</th>}
            {showPrice && <th className={`${head} w-24`}>금 액</th>}
            <th className={head}>비 고</th>
          </tr>
        </thead>
        <tbody>
          {po.lines.map((l, i) => (
            <tr key={i}>
              <td className={`${cell} text-center`}>{i + 1}</td>
              <td className={cell}>{l.itemName}</td>
              <td className={cell}>{l.spec}</td>
              <td className={`${cell} text-center`}>{l.unit}</td>
              <td className={`${cell} text-right tabular-nums`}>{l.qty.toLocaleString()}</td>
              {showPrice && <td className={`${cell} text-right tabular-nums`}>{l.price ? won(l.price) : ''}</td>}
              {showPrice && <td className={`${cell} text-right tabular-nums`}>{l.amount ? won(l.amount) : ''}</td>}
              <td className={`${cell} text-[11px]`}>{[l.location, l.remark, l.dueDate ? `납기 ${l.dueDate}` : ''].filter(Boolean).join(' / ')}</td>
            </tr>
          ))}
          {Array.from({ length: pad }, (_, i) => (
            <tr key={`p${i}`}>
              {Array.from({ length: showPrice ? 8 : 6 }, (_, j) => (
                <td key={j} className={`${cell} h-[22px]`} />
              ))}
            </tr>
          ))}
          {showPrice && (
            <tr>
              <td className={`${head}`} colSpan={6}>
                합 계
              </td>
              <td className={`${cell} text-right font-semibold tabular-nums`}>{won(po.totalAmount)}</td>
              <td className={cell} />
            </tr>
          )}
        </tbody>
      </table>
      <div className="mt-3 text-right text-[11px] text-gray-600">㈜명신기공 · {po.orderDate}</div>
    </div>
  );
}
