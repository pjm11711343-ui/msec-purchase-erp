// 구매청구서 작성: 기존 청구서 불러오기 (품목 줄을 골라 지금 청구서 아래에 추가)
import { useMemo, useState } from 'react';
import { Empty, Modal } from '../../components/ui';
import { StatusChip } from './ReqList';
import type { ReqLine, Requisition, Site } from '../../types';

export default function ReqImportModal({
  reqs,
  sites,
  siteId,
  currentId,
  onAdd,
  onClose,
}: {
  reqs: Requisition[];
  sites: Site[];
  siteId: string;
  currentId?: string;
  onAdd: (lines: ReqLine[], src: Requisition) => void;
  onClose: () => void;
}) {
  const [siteF, setSiteF] = useState(siteId);
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<Requisition | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());

  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    return reqs
      .filter((r) => r.id !== currentId && (!siteF || r.siteId === siteF) && r.lines.some((l) => l.itemName))
      .filter((r) => !k || [r.docNo, r.processName, r.purpose, r.usePurpose, r.createdByName, ...r.lines.map((l) => `${l.itemName} ${l.spec}`)].join(' ').toLowerCase().includes(k))
      .sort((a, b) => b.requestDate.localeCompare(a.requestDate) || b.createdAt - a.createdAt)
      .slice(0, 200);
  }, [reqs, currentId, siteF, q]);
  const lines = pick ? pick.lines.filter((l) => l.itemName) : [];
  const chosen = lines.filter((l) => !off.has(l.key));
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? '';

  return (
    <Modal
      open
      wide
      title={pick ? `불러올 줄 고르기 · ${pick.siteName} ${pick.docNo || pick.requestDate}` : '기존 청구서 불러오기'}
      onClose={onClose}
      footer={
        pick ? (
          <>
            <span className="mr-auto self-center text-[12px] text-muted">품명·규격·단위·비고·거래선·자재분류를 가져오고, 수량은 비웁니다. 지금 줄 아래에 추가됩니다.</span>
            <button className="btn-ghost" onClick={() => (setPick(null), setOff(new Set()))}>
              ← 다른 청구서
            </button>
            <button className="btn-primary" disabled={!chosen.length} onClick={() => onAdd(chosen, pick)}>
              {chosen.length}줄 추가
            </button>
          </>
        ) : (
          <button className="btn-ghost" onClick={onClose}>
            닫기
          </button>
        )
      }
    >
      {!pick ? (
        <div>
          <div className="mb-2 flex flex-wrap gap-2">
            <select className="input h-8 w-52" value={siteF} onChange={(e) => setSiteF(e.target.value)}>
              <option value="">전체 현장</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.id === siteId ? ' (지금 현장)' : ''}
                </option>
              ))}
            </select>
            <input className="input h-8 flex-1" placeholder="결의번호·공정·품명·작성자로 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {!list.length ? (
            <Empty>불러올 청구서가 없습니다.</Empty>
          ) : (
            <div className="max-h-[55vh] overflow-y-auto rounded-md border border-line">
              <table className="tbl text-[12.5px]">
                <thead>
                  <tr>
                    <th>청구일</th>
                    <th>현장</th>
                    <th>결의번호</th>
                    <th>공정·사용 목적</th>
                    <th className="num">줄</th>
                    <th>작성</th>
                    <th>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id} className="cursor-pointer" onClick={() => (setPick(r), setOff(new Set()))}>
                      <td className="whitespace-nowrap">{r.requestDate}</td>
                      <td className="whitespace-nowrap">{r.siteName || siteName(r.siteId)}</td>
                      <td>{r.docNo}</td>
                      <td className="text-[12px]">{[r.processName, r.purpose].filter(Boolean).join(' - ')}</td>
                      <td className="num">{r.lines.filter((l) => l.itemName).length}</td>
                      <td className="text-muted">{r.createdByName}</td>
                      <td>
                        <StatusChip s={r.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto rounded-md border border-line">
          <table className="tbl text-[12.5px]">
            <thead>
              <tr>
                <th className="w-8">
                  <input type="checkbox" checked={!off.size} onChange={() => setOff(off.size ? new Set() : new Set(lines.map((l) => l.key)))} />
                </th>
                <th>품명</th>
                <th>규격</th>
                <th>단위</th>
                <th className="num">그때 금회청구</th>
                <th>거래선</th>
                <th>비고</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key} className="cursor-pointer" onClick={() => setOff((s) => (s.has(l.key) ? (s.delete(l.key), new Set(s)) : new Set(s).add(l.key)))}>
                  <td>
                    <input type="checkbox" readOnly checked={!off.has(l.key)} />
                  </td>
                  <td>{l.itemName}</td>
                  <td>{l.spec}</td>
                  <td>{l.unit}</td>
                  <td className="num text-muted">{l.reqQty ? l.reqQty.toLocaleString() : ''}</td>
                  <td>{l.vendorName}</td>
                  <td className="text-[12px] text-muted">{[l.note, l.remark].filter(Boolean).join(' / ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
