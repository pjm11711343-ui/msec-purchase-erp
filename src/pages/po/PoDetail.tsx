import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { useAuth } from '../../auth/AuthContext';
import { audit, commitBatch } from '../../lib/db';
import { C } from '../../lib/firebase';
import { useSites } from '../../lib/hooks';
import { won } from '../../lib/normalize';
import { usePurchaseOrders } from '../../lib/pos';
import { errMsg, useToast } from '../../components/ui';
import { PoChip } from './PoList';
import type { PurchaseOrder, Site } from '../../types';

export const MIN_ROWS = 18;

function spaced(s: string) {
  return s.split('').join(' ');
}

/** 결재선(2단계/6칸)을 발주서 결재란 위치에 맞춘다 */
export function signBoxes(po: PurchaseOrder) {
  const find = (re: RegExp) => po.signNames.find((s) => re.test(s.label.replace(/\s/g, '')))?.name;
  return {
    site: [
      { label: '담  당', name: find(/^현장담당/) },
      { label: '소  장', name: find(/소장/) },
    ],
    hq: [
      { label: '담  당', name: find(/^본사담당|^자재부/) },
      { label: '팀  장', name: find(/팀장/) },
      { label: '임  원', name: find(/임원/) },
      { label: '대  표', name: find(/대표/) },
    ],
  };
}

export default function PoDetail() {
  const { id } = useParams();
  const { profile, can } = useAuth();
  const nav = useNavigate();
  const isOffice = can('admin', 'material');
  const pos = usePurchaseOrders();
  const sites = useSites();
  const toast = useToast();
  const po = pos.data.find((p) => p.id === id);
  const site = sites.data.find((s) => s.id === po?.siteId);
  const [internal, setInternal] = useState(false);
  const [showPrice, setShowPrice] = useState(true);
  const [edit, setEdit] = useState<{ deliveryTerm: string; notice: string; memo: string } | null>(null);

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
    const b = signBoxes(po);
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

  const b = signBoxes(po);
  const pad = Math.max(0, MIN_ROWS - po.lines.length);

  return (
    <div>
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <Link to="/po" className="btn-ghost">
          목록
        </Link>
        <span className="text-[17px] font-bold text-navy-950">{po.poNo}</span>
        <PoChip s={po.status} />
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
              <button className="btn-primary" onClick={() => update({ status: 'sent', sentAt: Date.now() }, '발송 완료')}>
                발송 완료 표시
              </button>
            </>
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
            <button
              className="btn-danger"
              onClick={() => {
                if (confirm('발주를 취소할까요? 품목은 다시 발주 대기로 돌아갑니다.')) update({ status: 'cancelled', cancelledAt: Date.now() }, '취소');
              }}
            >
              발주 취소
            </button>
          )}
        </div>
      </div>

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

      <PoSheet po={po} site={site} boxes={b} internal={internal} showPrice={showPrice} pad={pad} />

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
                {s.name ?? ''}
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
