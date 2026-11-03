// 업체 공지사항: 자재부가 쓰고 업체 포털에서 본다
import { useMemo } from 'react';
import { orderBy, where } from 'firebase/firestore';
import { useCollection } from './db';
import { C } from './firebase';
import type { Notice, NoticeRead } from '../types';

const sortNotices = (a: Notice, b: Notice) => Number(!!b.pinned) - Number(!!a.pinned) || b.createdAt - a.createdAt;

/** 자재부: 전체 공지 + 읽음 기록 */
export function useNoticesOffice() {
  const notices = useCollection<Notice>(C.notices, [orderBy('createdAt', 'desc')]);
  const reads = useCollection<NoticeRead>(C.noticeReads);
  return { notices: { ...notices, data: [...notices.data].sort(sortNotices) }, reads };
}

/** 업체: 나에게 온 공지 (전체 공지 + 우리 업체 지정 공지) + 내 읽음 기록 */
export function useVendorNotices(vendorId?: string) {
  const on = !!vendorId;
  const all = useCollection<Notice>(C.notices, [where('toAll', '==', true)], 'all', on);
  const mine = useCollection<Notice>(C.notices, [where('vendorIds', 'array-contains', vendorId ?? '-')], vendorId ?? '', on);
  const reads = useCollection<NoticeRead>(C.noticeReads, [where('vendorId', '==', vendorId ?? '-')], vendorId ?? '', on);
  const list = useMemo(() => {
    const m = new Map<string, Notice>();
    for (const n of [...all.data, ...mine.data]) m.set(n.id, n);
    return [...m.values()].sort(sortNotices);
  }, [all.data, mine.data]);
  const readSet = useMemo(() => new Set(reads.data.map((r) => r.noticeId)), [reads.data]);
  return { list, readSet, loading: all.loading || mine.loading };
}
