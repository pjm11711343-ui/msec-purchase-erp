// 업체 포털 › 공지: 명신기공 자재부 공지 보기 (열면 읽음으로 기록)
import { useState } from 'react';
import { commitBatch } from '../../lib/db';
import { C } from '../../lib/firebase';
import type { Notice } from '../../types';
import { Empty } from '../../components/ui';

export async function markNoticeRead(n: Notice, vendorId: string, vendorName: string) {
  try {
    await commitBatch([{ type: 'set', col: C.noticeReads, id: `${n.id}_${vendorId}`, data: { noticeId: n.id, vendorId, vendorName, at: Date.now() }, merge: false }]);
  } catch {
    /* 읽음 기록 실패는 화면 사용에 지장 없음 */
  }
}

const fmt = (t: number) => new Date(t).toLocaleDateString('ko-KR');

/** 읽지 않은 중요 공지 배너 (포털 맨 위) */
export function NoticeBanner({ list, readSet, onOpen }: { list: Notice[]; readSet: Set<string>; onOpen: (n: Notice) => void }) {
  const un = list.filter((n) => n.important && !readSet.has(n.id));
  if (!un.length) return null;
  return (
    <div className="no-print mb-3 space-y-1.5">
      {un.slice(0, 3).map((n) => (
        <button key={n.id} className="flex w-full items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-left text-[13px] text-red-800 hover:bg-red-100" onClick={() => onOpen(n)}>
          <span className="chip bg-red-600 text-white">중요 공지</span>
          <span className="font-semibold">{n.title}</span>
          <span className="ml-auto text-[12px]">눌러서 읽기 ›</span>
        </button>
      ))}
    </div>
  );
}

export default function VendorNotices({ list, readSet, vendorId, vendorName, openId }: { list: Notice[]; readSet: Set<string>; vendorId: string; vendorName: string; openId?: string | null }) {
  const [open, setOpen] = useState<string | null>(openId ?? null);
  const toggle = (n: Notice) => {
    setOpen(open === n.id ? null : n.id);
    if (!readSet.has(n.id)) void markNoticeRead(n, vendorId, vendorName);
  };
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-line px-4 py-2.5 font-semibold">명신기공 공지</div>
      {!list.length ? (
        <Empty>공지가 없습니다.</Empty>
      ) : (
        <div className="divide-y divide-line">
          {list.map((n) => {
            const unread = !readSet.has(n.id);
            return (
              <div key={n.id}>
                <button className="flex w-full flex-wrap items-center gap-2 px-4 py-2.5 text-left hover:bg-canvas" onClick={() => toggle(n)}>
                  {n.pinned && <span className="chip bg-navy-950 text-white">고정</span>}
                  {n.important && <span className="chip bg-red-50 text-red-700">중요</span>}
                  <span className={unread ? 'font-bold' : ''}>{n.title}</span>
                  {unread && <span className="h-2 w-2 rounded-full bg-red-500" title="안 읽음" />}
                  <span className="ml-auto text-[12px] text-muted">{fmt(n.createdAt)}</span>
                </button>
                {open === n.id && <div className="whitespace-pre-wrap bg-canvas px-4 py-3 text-[13px] leading-relaxed">{n.body}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
