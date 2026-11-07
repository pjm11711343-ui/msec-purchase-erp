// 표 칸 글씨 자동 맞춤: 칸보다 긴 숫자·이름은 글씨를 줄여서 칸 안에 보이게 (최소 8px)
//  - 대상: data 칸 안의 input (td.num input, td.fit input) 과 .fit-text 글자
import { useEffect, useLayoutEffect } from 'react';

const SEL = 'tbody td.num input, tbody td.fit input, tbody .fit-text';
const MIN = 8;
let canvas: HTMLCanvasElement | null = null;

function textWidth(text: string, font: string) {
  canvas ??= document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  return ctx.measureText(text).width;
}

export function fit(el: HTMLElement) {
  const base = Number(el.dataset.fitBase) || parseFloat(getComputedStyle(el).fontSize);
  el.dataset.fitBase = String(base);
  if (el instanceof HTMLInputElement) {
    const cs = getComputedStyle(el);
    const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
    const text = el.value || el.placeholder || '';
    if (room <= 0 || !text) return void (el.style.fontSize = '');
    let size = base;
    const font = (s: number) => `${cs.fontStyle} ${cs.fontWeight} ${s}px ${cs.fontFamily}`;
    while (size > MIN && textWidth(text, font(size)) > room) size -= 0.5;
    el.style.fontSize = size < base ? `${size}px` : '';
    return;
  }
  el.style.fontSize = '';
  let size = base;
  while (size > MIN && el.scrollWidth > el.clientWidth + 1) {
    size -= 0.5;
    el.style.fontSize = `${size}px`;
  }
}

/** root 표 안의 칸 글씨를 매번 그린 뒤·칸 너비가 바뀔 때·입력할 때 맞춘다 */
export function useAutoFit(root: React.RefObject<HTMLElement | null>, ready = true) {
  useLayoutEffect(() => {
    const r = root.current;
    if (r) r.querySelectorAll<HTMLElement>(SEL).forEach(fit);
  });
  useEffect(() => {
    const r = root.current;
    if (!r) return;
    let raf = 0;
    const all = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => r.querySelectorAll<HTMLElement>(SEL).forEach(fit));
    };
    const onInput = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.matches?.(SEL)) fit(t);
    };
    const ro = new ResizeObserver(all);
    ro.observe(r);
    r.addEventListener('input', onInput);
    r.addEventListener('focusout', all);
    return () => {
      ro.disconnect();
      r.removeEventListener('input', onInput);
      r.removeEventListener('focusout', all);
      cancelAnimationFrame(raf);
    };
  }, [root, ready]);
}
