// 구매청구서 첨부파일 (엑셀·그림·PDF) — 파일은 Storage, 목록은 청구서 문서에 바로 저장
import { useRef, useState } from 'react';
import { arrayRemove, arrayUnion, doc, updateDoc } from 'firebase/firestore';
import { C, db } from '../../lib/firebase';
import { ATTACH_ACCEPT, attachKind, checkFile, fmtSize, openAttachment, removeAttachmentFile, uploadAttachment } from '../../lib/attachments';
import { errMsg, useToast } from '../../components/ui';
import type { ReqAttachment } from '../../types';

const ICON = { excel: '📊', pdf: '📕', image: '🖼️', other: '📎' } as const;

export default function ReqAttachments({
  reqId,
  list,
  canAdd,
  canDelete,
  me,
  onChange,
}: {
  reqId?: string;
  list: ReqAttachment[];
  canAdd: boolean;
  canDelete: (a: ReqAttachment) => boolean;
  me: { id: string; name: string };
  onChange?: (next: ReqAttachment[]) => void;
}) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [up, setUp] = useState<{ name: string; p: number }[]>([]);
  const [drag, setDrag] = useState(false);
  const [busyDel, setBusyDel] = useState('');

  const addFiles = async (files: File[]) => {
    if (!reqId || !files.length) return;
    const bad = files.map(checkFile).filter(Boolean);
    if (bad.length) toast(bad.join('\n'), 'err');
    const ok = files.filter((f) => !checkFile(f));
    let cur = list;
    for (const f of ok) {
      setUp((u) => [...u, { name: f.name, p: 0 }]);
      try {
        const a = await uploadAttachment(reqId, f, me, (p) => setUp((u) => u.map((x) => (x.name === f.name ? { ...x, p } : x))));
        await updateDoc(doc(db, C.requisitions, reqId), { attachments: arrayUnion(a) });
        cur = [...cur, a];
        onChange?.(cur);
      } catch (e) {
        toast(`${f.name} 올리기 실패: ${errMsg(e)}`, 'err');
      } finally {
        setUp((u) => u.filter((x) => x.name !== f.name));
      }
    }
    if (ok.length) toast(`첨부 ${ok.length}개를 올렸습니다.`);
  };

  const del = async (a: ReqAttachment) => {
    if (!reqId || !confirm(`첨부파일 "${a.name}"을 삭제할까요?`)) return;
    setBusyDel(a.id);
    try {
      await updateDoc(doc(db, C.requisitions, reqId), { attachments: arrayRemove(a) });
      await removeAttachmentFile(a.path);
      onChange?.(list.filter((x) => x.id !== a.id));
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusyDel('');
    }
  };

  const open = (a: ReqAttachment) => openAttachment(a).catch((e) => toast(`열 수 없습니다: ${errMsg(e)}`, 'err'));

  if (!list.length && !canAdd) return null;
  return (
    <div
      className={`card no-print mt-3 overflow-hidden ${drag ? 'ring-2 ring-amber-brand' : ''}`}
      onDragOver={(e) => {
        if (!canAdd || !reqId) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        if (!canAdd || !reqId) return;
        e.preventDefault();
        setDrag(false);
        addFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-[#f7f8fb] px-4 py-2.5">
        <span className="font-semibold text-navy-950">📎 첨부파일</span>
        <span className="text-[12px] text-muted">{list.length}개</span>
        <span className="flex-1" />
        {canAdd &&
          (reqId ? (
            <>
              <span className="hidden text-[11.5px] text-muted sm:inline">엑셀·그림·PDF (파일당 50MB) · 여기로 끌어다 놓아도 됩니다</span>
              <button className="btn-primary h-8 text-[12px]" onClick={() => input.current?.click()}>
                + 파일 첨부
              </button>
              <input
                ref={input}
                type="file"
                multiple
                accept={ATTACH_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  addFiles([...(e.target.files ?? [])]);
                  e.target.value = '';
                }}
              />
            </>
          ) : (
            <span className="text-[12px] text-muted">청구서를 한 번 저장(임시저장)하면 파일을 첨부할 수 있습니다.</span>
          ))}
      </div>
      {list.length + up.length === 0 ? (
        <div className="px-4 py-3 text-[12.5px] text-muted">첨부한 파일이 없습니다.</div>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((a) => (
            <li key={a.id} className="flex items-center gap-2 px-4 py-2 text-[13px]">
              <span>{ICON[attachKind(a.name)]}</span>
              <button className="min-w-0 flex-1 truncate text-left font-medium text-navy-900 hover:text-amber-700 hover:underline" onClick={() => open(a)} title="새 창에서 열기·내려받기">
                {a.name}
              </button>
              <span className="whitespace-nowrap text-[11.5px] text-muted">
                {fmtSize(a.size)} · {a.byName} · {new Date(a.at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}
              </span>
              {canDelete(a) && (
                <button className="btn-ghost h-7 px-2 text-[12px] text-red-600" disabled={busyDel === a.id} onClick={() => del(a)}>
                  {busyDel === a.id ? '…' : '삭제'}
                </button>
              )}
            </li>
          ))}
          {up.map((u) => (
            <li key={'u' + u.name} className="flex items-center gap-2 px-4 py-2 text-[13px] text-muted">
              <span>⏳</span>
              <span className="min-w-0 flex-1 truncate">{u.name}</span>
              <span className="h-1.5 w-28 overflow-hidden rounded bg-line">
                <span className="block h-full bg-amber-brand" style={{ width: `${Math.round(u.p * 100)}%` }} />
              </span>
              <span className="w-9 text-right text-[11.5px]">{Math.round(u.p * 100)}%</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
