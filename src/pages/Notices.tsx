// 구매 흐름 › 업체 공지: 자재부가 업체에게 공지를 쓰고, 업체별로 읽었는지 본다
import { useState } from 'react';
import { audit, commitBatch, newId } from '../lib/db';
import { C } from '../lib/firebase';
import { useVendors } from '../lib/hooks';
import { useNoticesOffice } from '../lib/notices';
import { useAuth } from '../auth/AuthContext';
import { Empty, errMsg, Field, Modal, PageHeader, useToast } from '../components/ui';
import type { Notice } from '../types';

const fmt = (t: number) => new Date(t).toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' });

export default function Notices() {
  const { notices, reads } = useNoticesOffice();
  const vendors = useVendors();
  const [edit, setEdit] = useState<Notice | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const toast = useToast();
  const activeVendors = vendors.data.filter((v) => (v as { active?: boolean }).active !== false);
  const targets = (n: Notice) => (n.toAll ? activeVendors : activeVendors.filter((v) => n.vendorIds.includes(v.id)));
  const readBy = (n: Notice) => reads.data.filter((r) => r.noticeId === n.id);
  const del = async (n: Notice) => {
    if (!confirm(`"${n.title}" 공지를 지울까요? 업체 포털에서도 사라집니다.`)) return;
    try {
      await commitBatch([{ type: 'delete', col: C.notices, id: n.id }, ...readBy(n).map((r) => ({ type: 'delete' as const, col: C.noticeReads, id: r.id }))]);
      await audit('업체 공지 삭제', n.title);
      toast('지웠습니다.');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  return (
    <div>
      <PageHeader
        title="업체 공지"
        desc="업체 포털에 공지를 올립니다. 전체 업체 또는 고른 업체에게만 보낼 수 있고, 업체가 읽었는지 확인할 수 있습니다. 예: 연휴 납품 일정, 현장 출입 규칙, 거래명세서 마감일."
        actions={
          <button className="btn-primary" onClick={() => setEdit('new')}>
            + 공지 쓰기
          </button>
        }
      />
      <div className="card overflow-hidden">
        {!notices.data.length ? (
          <Empty>{notices.loading ? '불러오는 중…' : '아직 공지가 없습니다.'}</Empty>
        ) : (
          <div className="divide-y divide-line">
            {notices.data.map((n) => {
              const tg = targets(n);
              const rd = readBy(n);
              const readIds = new Set(rd.map((r) => r.vendorId));
              return (
                <div key={n.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {n.pinned && <span className="chip bg-navy-950 text-white">고정</span>}
                    {n.important && <span className="chip bg-red-50 text-red-700">중요</span>}
                    <button className="text-left font-semibold hover:underline" onClick={() => setOpen(open === n.id ? null : n.id)}>
                      {n.title}
                    </button>
                    <span className="text-[12px] text-muted">
                      {fmt(n.createdAt)} · {n.byName} · {n.toAll ? '전체 업체' : `${n.vendorIds.length}개 업체`}
                    </span>
                    <span className={`chip ${rd.length >= tg.length && tg.length ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-soft text-amber-800'}`}>
                      읽음 {tg.filter((v) => readIds.has(v.id)).length}/{tg.length}
                    </span>
                    <span className="ml-auto flex gap-2">
                      <button className="btn-ghost h-7 text-[12px]" onClick={() => setEdit(n)}>
                        수정
                      </button>
                      <button className="btn-ghost h-7 text-[12px] hover:text-red-600" onClick={() => del(n)}>
                        삭제
                      </button>
                    </span>
                  </div>
                  {open === n.id && (
                    <div className="mt-2 grid gap-3 lg:grid-cols-[1fr_320px]">
                      <div className="whitespace-pre-wrap rounded-md bg-canvas p-3 text-[13px]">{n.body}</div>
                      <div className="rounded-md border border-line p-2 text-[12px]">
                        <div className="mb-1 font-semibold">업체별 읽음</div>
                        <div className="max-h-60 space-y-0.5 overflow-y-auto">
                          {tg.map((v) => {
                            const r = rd.find((x) => x.vendorId === v.id);
                            return (
                              <div key={v.id} className="flex justify-between">
                                <span>{v.name}</span>
                                {r ? <span className="text-emerald-700">✔ {fmt(r.at)}</span> : <span className="text-muted">안 읽음</span>}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {edit && <NoticeEditor notice={edit === 'new' ? undefined : edit} vendors={activeVendors} onClose={() => setEdit(null)} />}
    </div>
  );
}

function NoticeEditor({ notice, vendors, onClose }: { notice?: Notice; vendors: { id: string; name: string }[]; onClose: () => void }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({
    title: notice?.title ?? '',
    body: notice?.body ?? '',
    toAll: notice?.toAll ?? true,
    vendorIds: notice?.vendorIds ?? ([] as string[]),
    pinned: notice?.pinned ?? false,
    important: notice?.important ?? false,
  });
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!f.title.trim() || !f.body.trim()) return toast('제목과 내용을 입력하세요.', 'err');
    if (!f.toAll && !f.vendorIds.length) return toast('받을 업체를 고르세요.', 'err');
    setBusy(true);
    try {
      const data = { ...f, title: f.title.trim(), vendorIds: f.toAll ? [] : f.vendorIds, ...(notice ? { updatedAt: Date.now() } : { createdAt: Date.now(), byName: profile?.name ?? '' }) };
      await commitBatch([{ type: 'set', col: C.notices, id: notice?.id ?? newId(C.notices), data }]);
      await audit(notice ? '업체 공지 수정' : '업체 공지 등록', f.title);
      toast(notice ? '수정했습니다.' : '공지를 올렸습니다. 업체 포털에 바로 보입니다.');
      onClose();
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  const shown = vendors.filter((v) => !q.trim() || v.name.includes(q.trim())).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return (
    <Modal
      open
      wide
      title={notice ? '공지 수정' : '공지 쓰기'}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            취소
          </button>
          <button className="btn-primary" disabled={busy} onClick={save}>
            {notice ? '저장' : '올리기'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="제목 *">
          <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="내용 *">
          <textarea className="input min-h-[180px] py-2" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        </Field>
        <div className="flex flex-wrap gap-4 text-[13px]">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> 위에 고정
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={f.important} onChange={(e) => setF({ ...f, important: e.target.checked })} /> 중요 (업체 포털 맨 위에 읽을 때까지 표시)
          </label>
        </div>
        <Field label="받는 업체">
          <div className="flex gap-4 text-[13px]">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={f.toAll} onChange={() => setF({ ...f, toAll: true })} /> 전체 업체
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={!f.toAll} onChange={() => setF({ ...f, toAll: false })} /> 고른 업체만 ({f.vendorIds.length})
            </label>
          </div>
        </Field>
        {!f.toAll && (
          <div className="rounded-md border border-line p-2">
            <input className="input mb-2 h-8" placeholder="업체 이름 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="grid max-h-56 grid-cols-2 gap-x-3 gap-y-1 overflow-y-auto text-[12.5px] sm:grid-cols-3">
              {shown.map((v) => (
                <label key={v.id} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={f.vendorIds.includes(v.id)}
                    onChange={(e) => setF({ ...f, vendorIds: e.target.checked ? [...f.vendorIds, v.id] : f.vendorIds.filter((x) => x !== v.id) })}
                  />
                  {v.name}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
