import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { nameKey } from '../lib/normalize';

/**
 * 목록에 있는 값만 고를 수 있는 입력칸.
 * 글자를 치면 목록이 좁혀지고, 목록에서 골라야만 값이 바뀐다. 목록에 없는 글자를 치고 나가면 원래 값으로 돌아간다.
 */
export default function PickInput({
  value,
  options,
  onPick,
  className = '',
  placeholder = '선택 ▾',
  invalid,
}: {
  value: string;
  options: string[];
  onPick: (v: string) => void;
  className?: string;
  placeholder?: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  const list = useMemo(() => {
    const k = nameKey(q);
    const hit = k ? options.filter((o) => nameKey(o).includes(k)) : options;
    // 앞부분이 같은 것을 먼저
    if (k) hit.sort((a, b) => Number(!nameKey(a).startsWith(k)) - Number(!nameKey(b).startsWith(k)));
    return hit.slice(0, 80);
  }, [q, options]);

  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 2, width: Math.max(r.width, 220) });
  };
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const pick = (v: string) => {
    onPick(v);
    setOpen(false);
    setQ('');
    ref.current?.blur();
  };

  return (
    <>
      <input
        ref={ref}
        className={`input h-7 px-1.5 ${invalid ? 'border-red-400 bg-red-50' : ''} ${className}`}
        value={open ? q : value}
        placeholder={open ? value || '검색' : placeholder}
        title={invalid ? '목록에 없는 값입니다. 목록에서 다시 고르세요.' : value}
        onFocus={() => {
          setQ('');
          setHi(0);
          place();
          setOpen(true);
        }}
        onChange={(e) => {
          setQ(e.target.value);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setHi((h) => Math.min(h + 1, list.length - 1)));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)));
          else if (e.key === 'Enter' && list[hi]) (e.preventDefault(), pick(list[hi]));
          else if (e.key === 'Escape') (setOpen(false), ref.current?.blur());
        }}
        onBlur={() => {
          // 친 글자가 목록 값과 정확히 같으면 그 값으로, 아니면 원래 값 유지
          const exact = q && options.find((o) => nameKey(o) === nameKey(q));
          if (exact && exact !== value) onPick(exact);
          setTimeout(() => setOpen(false), 120);
        }}
      />
      {open &&
        pos &&
        createPortal(
          <div
            className="fixed z-[60] max-h-64 overflow-y-auto rounded-md border border-line bg-white py-1 text-[12.5px] shadow-lg"
            style={{ left: pos.left, top: pos.top, width: pos.width }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {list.length === 0 ? (
              <div className="px-2.5 py-1.5 text-muted">{options.length ? '맞는 항목이 없습니다' : '고를 수 있는 항목이 없습니다'}</div>
            ) : (
              list.map((o, i) => (
                <div
                  key={o}
                  className={`cursor-pointer px-2.5 py-1 ${i === hi ? 'bg-amber-soft' : ''} ${o === value ? 'font-semibold' : ''}`}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => pick(o)}
                >
                  {o}
                </div>
              ))
            )}
            {options.length > list.length && list.length === 80 && <div className="px-2.5 py-1 text-[11px] text-muted">글자를 더 쳐서 좁히세요</div>}
          </div>,
          document.body,
        )}
    </>
  );
}
