import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { memoId, saveAdminMemo, type AdminMemo } from '../lib/adminMemo';
import { errMsg, useToast } from './ui';

/** 관리자 메모 칸: 입력 후 칸을 벗어나면(또는 Enter) 바로 저장 */
export default function AdminMemoInput({ reqId, lineKey, itemName, spec, memos, className = '' }: { reqId?: string; lineKey: string; itemName?: string; spec?: string; memos: Map<string, AdminMemo>; className?: string }) {
  const { profile } = useAuth();
  const toast = useToast();
  const cur = reqId ? memos.get(memoId(reqId, lineKey)) : undefined;
  const [v, setV] = useState(cur?.text ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setV(cur?.text ?? ''), [cur?.text]);
  if (!reqId) return <span className="text-[10.5px] text-muted">저장 후 메모</span>;
  const save = async () => {
    if (v.trim() === (cur?.text ?? '')) return;
    setBusy(true);
    try {
      await saveAdminMemo({ reqId, lineKey, text: v, itemName, spec, byName: profile?.name ?? '' });
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  return (
    <input
      className={`input h-7 w-full border-violet-200 bg-violet-50/60 px-1.5 text-[11.5px] ${busy ? 'opacity-60' : ''} ${className}`}
      placeholder="관리자 메모"
      title={cur ? `${cur.byName} · ${new Date(cur.at).toLocaleString('ko-KR')}` : '관리자만 보이는 메모 (칸을 벗어나면 저장)'}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}
