// 거래명세서 미리보기·출력 (업체 포털 · 현장 · 자재부 공용)
//  - 출력은 새 창에 명세서만 띄워 인쇄 (PDF 저장도 인쇄 창에서)
import { useRef } from 'react';
import { won } from '../lib/normalize';
import type { Invoice } from '../types';
import { Modal } from './ui';

const cell: React.CSSProperties = { border: '1px solid #333', padding: '3px 5px', fontSize: 11 };
const head: React.CSSProperties = { ...cell, background: '#f0f0f0', fontWeight: 700, textAlign: 'center', whiteSpace: 'nowrap' };
const num: React.CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

/** 명세서 본문 (인라인 스타일이라 새 창 인쇄에서도 그대로) */
export function StatementSheet({ inv, siteName }: { inv: Invoice; siteName: string }) {
  const lines = [...inv.lines].sort((a, b) => (a.receivedDate ?? '').localeCompare(b.receivedDate ?? ''));
  const supply = lines.reduce((a, l) => a + (l.finalAmount || 0), 0);
  const vat = Math.round(supply * 0.1);
  return (
    <div style={{ width: 760, margin: '0 auto', padding: 16, background: '#fff', color: '#000', fontFamily: "'Malgun Gothic', sans-serif" }}>
      <div style={{ textAlign: 'center', fontSize: 22, fontWeight: 700, letterSpacing: '0.5em', textDecoration: 'underline', textUnderlineOffset: 6, marginBottom: 12 }}>거래명세서</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
        <tbody>
          <tr>
            <td style={head}>공 급 자</td>
            <td style={{ ...cell, fontWeight: 700 }}>{inv.vendorName}</td>
            <td style={head}>공급받는자</td>
            <td style={{ ...cell, fontWeight: 700 }}>㈜ 명 신 기 공</td>
          </tr>
          <tr>
            <td style={head}>현 장</td>
            <td style={cell}>{siteName}</td>
            <td style={head}>거 래 월</td>
            <td style={cell}>{inv.month}</td>
          </tr>
          <tr>
            <td style={head}>합계금액</td>
            <td style={{ ...cell, fontWeight: 700 }} colSpan={3}>
              {won(supply + vat)}원 (공급가액 {won(supply)}원 + 부가세 {won(vat)}원)
            </td>
          </tr>
        </tbody>
      </table>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['No', '입고일', '품 명', '규 격', '단위', '수 량', '단 가', '공급가액', '비 고'].map((t) => (
              <th key={t} style={head}>
                {t}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td style={{ ...cell, textAlign: 'center' }}>{i + 1}</td>
              <td style={{ ...cell, whiteSpace: 'nowrap' }}>{l.receivedDate ?? ''}</td>
              <td style={cell}>{l.itemName}</td>
              <td style={cell}>{l.spec}</td>
              <td style={{ ...cell, textAlign: 'center' }}>{l.unit}</td>
              <td style={num}>{(l.changedQty ?? l.qty)?.toLocaleString()}</td>
              <td style={num}>{won(l.changedPrice ?? l.unitPrice)}</td>
              <td style={num}>{won(l.finalAmount)}</td>
              <td style={{ ...cell, fontSize: 10 }}>{[l.note, l.process].filter(Boolean).join(' / ')}</td>
            </tr>
          ))}
          <tr>
            <td style={head} colSpan={7}>
              공급가액 합계
            </td>
            <td style={{ ...num, fontWeight: 700 }}>{won(supply)}</td>
            <td style={cell}></td>
          </tr>
          <tr>
            <td style={head} colSpan={7}>
              부가세 (10%)
            </td>
            <td style={num}>{won(vat)}</td>
            <td style={cell}></td>
          </tr>
          <tr>
            <td style={head} colSpan={7}>
              합 계
            </td>
            <td style={{ ...num, fontWeight: 700 }}>{won(supply + vat)}</td>
            <td style={cell}></td>
          </tr>
        </tbody>
      </table>
      <div style={{ marginTop: 10, fontSize: 10, color: '#555', textAlign: 'right' }}>
        {inv.source === 'portal' ? `업체 포털 제출 ${inv.submittedAt ? new Date(inv.submittedAt).toLocaleDateString('ko-KR') : ''}` : `계산서정리 ${inv.fileName ?? ''}`} · {lines.length}줄
      </div>
    </div>
  );
}

/** 미리보기 창 + 출력 */
export default function StatementModal({ inv, siteName, onClose }: { inv: Invoice; siteName: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const print = () => {
    const w = window.open('', '_blank', 'width=900,height=1000');
    if (!w || !ref.current) return;
    w.document.write(
      `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>거래명세서 ${inv.vendorName} ${siteName} ${inv.month}</title><style>@page{size:A4 portrait;margin:10mm}body{margin:0}</style></head><body>${ref.current.innerHTML}</body></html>`,
    );
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  };
  return (
    <Modal
      open
      wide
      title={`거래명세서 · ${inv.vendorName} · ${siteName} · ${inv.month}`}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto self-center text-[12px] text-muted">출력 창에서 프린터 대신 'PDF로 저장'을 고르면 PDF 파일로 받을 수 있습니다.</span>
          <button className="btn-ghost" onClick={onClose}>
            닫기
          </button>
          <button className="btn-dark" onClick={print}>
            출력
          </button>
        </>
      }
    >
      <div className="overflow-x-auto">
        <div ref={ref}>
          <StatementSheet inv={inv} siteName={siteName} />
        </div>
      </div>
    </Modal>
  );
}
