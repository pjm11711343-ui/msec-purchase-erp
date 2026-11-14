// 구매청구 첨부파일: Firebase Storage에 올리고, 청구서 문서에는 목록만 저장
import { deleteObject, getDownloadURL, ref, uploadBytesResumable } from 'firebase/storage';
import { storage } from './firebase';
import type { ReqAttachment } from '../types';

export const ATTACH_MAX = 50 * 1024 * 1024; // 파일당 50MB
export const ATTACH_ACCEPT = '.xlsx,.xls,.xlsm,.csv,.pdf,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif,image/*,application/pdf';
const OK_EXT = /\.(xlsx|xls|xlsm|csv|pdf|jpe?g|png|gif|webp|heic|heif)$/i;

export function attachKind(name: string): 'excel' | 'pdf' | 'image' | 'other' {
  if (/\.(xlsx|xls|xlsm|csv)$/i.test(name)) return 'excel';
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (/\.(jpe?g|png|gif|webp|heic|heif)$/i.test(name)) return 'image';
  return 'other';
}
export const fmtSize = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`);

export function checkFile(f: File): string {
  if (!OK_EXT.test(f.name)) return `${f.name}: 엑셀·그림·PDF 파일만 올릴 수 있습니다.`;
  if (f.size > ATTACH_MAX) return `${f.name}: ${fmtSize(f.size)} — 파일 하나는 50MB까지입니다.`;
  return '';
}

/** 휴대폰 사진처럼 큰 그림은 긴 쪽 2000px, JPEG로 줄인다 (줄인 게 더 클 때·실패하면 원본) */
async function shrinkImage(f: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(f.type) || f.size < 700 * 1024) return f;
  try {
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d');
    if (!g) return f;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const out = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.82));
    return out && out.size < f.size ? out : f;
  } catch {
    return f;
  }
}

export async function uploadAttachment(reqId: string, f: File, who: { id: string; name: string }, onProgress?: (p: number) => void): Promise<ReqAttachment> {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const blob = await shrinkImage(f);
  const shrunk = blob !== f;
  const name = shrunk ? f.name.replace(/\.(png|webp|jpe?g)$/i, '') + '.jpg' : f.name;
  const safe = name.replace(/[\\/#?[\]*]/g, '_');
  const path = `erp_req/${reqId}/${id}_${safe}`;
  const type = shrunk ? 'image/jpeg' : f.type || 'application/octet-stream';
  await new Promise<void>((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, path), blob, { contentType: type, customMetadata: { reqId, by: who.id } });
    task.on('state_changed', (s) => onProgress?.(s.totalBytes ? s.bytesTransferred / s.totalBytes : 0), reject, () => resolve());
  });
  return { id, name, size: blob.size, type, path, by: who.id, byName: who.name, at: Date.now() };
}

export async function openAttachment(a: ReqAttachment) {
  const w = window.open('', '_blank');
  try {
    const url = await getDownloadURL(ref(storage, a.path));
    if (w) w.location.href = url;
    else window.location.href = url;
  } catch (e) {
    w?.close();
    throw e;
  }
}

export async function removeAttachmentFile(path: string) {
  try {
    await deleteObject(ref(storage, path));
  } catch (e) {
    // 이미 없는 파일이면 그냥 넘어간다
    if (!String((e as { code?: string }).code ?? '').includes('object-not-found')) throw e;
  }
}
