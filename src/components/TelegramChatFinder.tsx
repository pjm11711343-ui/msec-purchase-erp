import { useState } from 'react';
import { telegramChats } from '../lib/notify';
import { Modal, useToast } from './ui';

/** 봇이 들어가 있는 텔레그램 대화방 목록 → Chat ID 복사 */
export default function TelegramChatFinder() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [chats, setChats] = useState<{ id: number; title: string; type: string }[]>([]);
  const [error, setError] = useState('');
  const load = async () => {
    setOpen(true);
    setBusy(true);
    const r = await telegramChats();
    setChats(r.chats);
    setError(r.error ?? '');
    setBusy(false);
  };
  const copy = (id: number) => navigator.clipboard?.writeText(String(id)).then(() => toast(`Chat ID ${id} 복사했습니다.`));
  return (
    <>
      <button className="btn-ghost" onClick={load}>
        텔레그램 대화방 찾기
      </button>
      <Modal open={open} title="텔레그램 대화방 (Chat ID)" onClose={() => setOpen(false)} wide>
        <div className="mb-2 text-[12.5px] text-muted">
          현장 단톡방에 ERP 알림 봇을 초대하고 방에서 아무 말이나 한 번 보내면 여기에 나타납니다. 개인은 봇에게 1:1로 아무 말이나 보내면 됩니다. Chat ID를 복사해 현장(단톡방) 또는 사용자(개인) 정보의 "텔레그램 Chat ID"에 붙여 넣으세요.
          <br />
          (최근 며칠 안에 봇에게 온 대화만 보입니다. 안 보이면 방에서 다시 말을 보내고 새로고침하세요.)
        </div>
        {busy ? (
          <div className="py-6 text-center text-muted">불러오는 중…</div>
        ) : error ? (
          <div className="rounded-md bg-red-50 px-3 py-2 text-[12.5px] text-red-700">{error}</div>
        ) : !chats.length ? (
          <div className="py-6 text-center text-muted">아직 봇에게 온 대화가 없습니다.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>대화방</th>
                <th>종류</th>
                <th>Chat ID</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {chats.map((c) => (
                <tr key={c.id}>
                  <td className="font-medium">{c.title}</td>
                  <td className="text-muted">{c.type === 'private' ? '개인' : c.type === 'group' || c.type === 'supergroup' ? '단톡방' : c.type}</td>
                  <td className="font-mono text-[12px]">{c.id}</td>
                  <td className="text-right">
                    <button className="btn-ghost h-7 text-[12px]" onClick={() => copy(c.id)}>
                      복사
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-3 text-right">
          <button className="btn-ghost h-8 text-[12px]" disabled={busy} onClick={load}>
            새로고침
          </button>
        </div>
      </Modal>
    </>
  );
}
