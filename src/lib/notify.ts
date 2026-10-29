// 알림 보내기 (서버 /api/notify): 업체 메일(발주서 PDF) · 텔레그램
import { auth } from './firebase';

export type NotifyEvent = 'po_sent' | 'po_changed' | 'po_cancelled' | 'po_ack' | 'receipt' | 'approval_turn';
export interface NotifyResult {
  ok: boolean;
  error?: string;
  email?: 'sent' | 'no-email';
  to?: string;
  telegram?: 'sent' | 'skipped';
}

export async function notify(event: NotifyEvent, data: Record<string, unknown>): Promise<NotifyResult> {
  const u = auth.currentUser;
  if (!u) return { ok: false, error: '로그인이 필요합니다.' };
  try {
    const r = await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await u.getIdToken()}` },
      body: JSON.stringify({ event, ...data }),
    });
    const j = (await r.json().catch(() => ({ ok: false, error: `알림 서버 응답 오류 (${r.status})` }))) as NotifyResult;
    return r.ok ? j : { ...j, ok: false };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 알림을 보내되 실패해도 하던 일은 막지 않는다 (텔레그램용) */
export function notifyQuiet(event: NotifyEvent, data: Record<string, unknown>) {
  void notify(event, data);
}

export async function telegramChats(): Promise<{ chats: { id: number; title: string; type: string }[]; error?: string }> {
  const u = auth.currentUser;
  if (!u) return { chats: [], error: '로그인이 필요합니다.' };
  try {
    const r = await fetch('/api/telegram-chats', { headers: { Authorization: `Bearer ${await u.getIdToken()}` } });
    const j = (await r.json()) as { ok: boolean; chats?: { id: number; title: string; type: string }[]; error?: string };
    return { chats: j.chats ?? [], error: j.ok ? undefined : j.error };
  } catch (e) {
    return { chats: [], error: (e as Error).message };
  }
}
