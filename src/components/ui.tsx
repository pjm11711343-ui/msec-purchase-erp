import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

export function PageHeader({ title, desc, actions }: { title: string; desc?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[19px] font-bold tracking-tight text-navy-950">{title}</h1>
        {desc && <p className="mt-0.5 text-muted">{desc}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-navy-950/40 p-6" onMouseDown={onClose}>
      <div
        className={`card fade-up mt-10 w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} shadow-xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button className="text-muted hover:text-ink" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-muted">{children}</div>;
}

export function Stat({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: ReactNode; accent?: boolean }) {
  return (
    <div className={`card px-4 py-3 ${accent ? 'border-amber-brand/60 bg-amber-soft' : ''}`}>
      <div className="text-[12px] text-muted">{label}</div>
      <div className="mt-1 text-[20px] font-bold tabular-nums text-navy-950">{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-muted">{sub}</div>}
    </div>
  );
}

export function RateBar({ rate }: { rate: number }) {
  const w = Math.max(0, Math.min(100, rate * 100));
  const color = rate > 1 ? 'bg-red-500' : rate > 0.9 ? 'bg-amber-brand' : 'bg-navy-700';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
      <div className={`h-full ${color} transition-all duration-500`} style={{ width: `${w}%` }} />
    </div>
  );
}

/* 체크박스 일괄 선택 */
export function useSelection() {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toggle = useCallback(
    (id: string) =>
      setSel((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    [],
  );
  const setAll = useCallback((ids: string[], on: boolean) => setSel(on ? new Set(ids) : new Set()), []);
  const clear = useCallback(() => setSel(new Set()), []);
  return { sel, toggle, setAll, clear };
}

/* 알림 */
type Toast = { id: number; text: string; kind: 'ok' | 'err' };
const ToastCtx = createContext<(text: string, kind?: 'ok' | 'err') => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, text, kind }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), kind === 'err' ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-5 right-5 z-[60] flex flex-col gap-2">
        {list.map((t) => (
          <div
            key={t.id}
            className={`fade-up rounded-lg px-4 py-2.5 text-[13px] shadow-lg ${t.kind === 'ok' ? 'bg-navy-950 text-white' : 'bg-red-600 text-white'}`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

export function errMsg(e: unknown): string {
  const m = (e as { code?: string; message?: string })?.code ?? (e as Error)?.message ?? String(e);
  if (m.includes('permission-denied')) return '권한이 없습니다. 관리자에게 역할·담당 현장을 확인해 달라고 하세요.';
  if (m.includes('invalid-credential') || m.includes('wrong-password') || m.includes('user-not-found'))
    return '아이디(이메일) 또는 비밀번호가 맞지 않습니다.';
  if (m.includes('email-already-in-use')) return '이미 등록된 아이디(이메일)입니다.';
  if (m.includes('weak-password')) return '비밀번호는 6자 이상이어야 합니다.';
  return (e as Error)?.message ?? m;
}
