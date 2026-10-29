// 싸인 이미지: 사진·스캔을 결재란용으로 다듬는다
//  - 흰 바탕을 투명하게, 글씨 부분만 잘라내고, 최대 360×140으로 줄여 PNG 데이터로 저장 (사용자 문서에 함께 저장)
//  - 사진처럼 바탕이 회색이어도 밝은 부분은 지운다 (임계값: 밝기 200)

const MAX_W = 360;
const MAX_H = 140;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('이미지를 열 수 없습니다. JPG·PNG 파일로 올려주세요. (아이폰 HEIC 사진은 JPG로 바꿔서)'));
    };
    img.src = url;
  });
}

/** 싸인 이미지 파일 → 결재란용 PNG data URL */
export async function prepareSign(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('이미지 파일(JPG·PNG)을 골라주세요.');
  const img = await loadImage(file);
  // 너무 큰 사진은 먼저 줄여서 처리
  const pre = Math.min(1, 1200 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * pre));
  const h = Math.max(1, Math.round(img.height * pre));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      if (px[i + 3] < 20 || lum > 200) {
        px[i + 3] = 0; // 바탕 → 투명
      } else {
        // 옅은 획은 반투명하게 남겨 가장자리를 부드럽게
        px[i + 3] = Math.min(px[i + 3], Math.round(255 * Math.min(1, (200 - lum) / 80)));
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('싸인을 찾지 못했습니다. 흰 종이에 진하게 쓴 싸인 사진을 올려주세요.');
  ctx.putImageData(data, 0, 0);
  const pad = 4;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const s = Math.min(1, MAX_W / cw, MAX_H / ch);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(cw * s));
  out.height = Math.max(1, Math.round(ch * s));
  out.getContext('2d')!.drawImage(c, x0, y0, cw, ch, 0, 0, out.width, out.height);
  const url = out.toDataURL('image/png');
  if (url.length > 250_000) throw new Error('싸인 이미지가 너무 복잡합니다. 흰 바탕에 싸인만 찍어서 다시 올려주세요.');
  return url;
}

/** 이름·아이디 → 싸인 이미지 찾기용 표 */
export function signMap(users: { id: string; name: string; signImage?: string }[]) {
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const u of users) {
    if (!u.signImage) continue;
    byId.set(u.id, u.signImage);
    if (!byName.has(u.name)) byName.set(u.name, u.signImage);
  }
  return { byId, byName };
}
