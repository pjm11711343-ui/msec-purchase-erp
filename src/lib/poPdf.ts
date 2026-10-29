// 화면의 발주서(인쇄 모양)를 PDF로 → base64 (메일 첨부용)
export async function elementToPdfBase64(el: HTMLElement): Promise<string> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);
  const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = 210;
  const pageH = 297;
  const margin = 8;
  const w = pageW - margin * 2;
  const h = (canvas.height * w) / canvas.width;
  const img = canvas.toDataURL('image/jpeg', 0.92);
  if (h <= pageH - margin * 2) pdf.addImage(img, 'JPEG', margin, margin, w, h);
  else {
    // 길면 여러 쪽으로 나눈다
    const pagePx = ((pageH - margin * 2) * canvas.width) / w;
    for (let y = 0, page = 0; y < canvas.height; y += pagePx, page++) {
      const part = document.createElement('canvas');
      part.width = canvas.width;
      part.height = Math.min(pagePx, canvas.height - y);
      part.getContext('2d')!.drawImage(canvas, 0, y, canvas.width, part.height, 0, 0, canvas.width, part.height);
      if (page) pdf.addPage();
      pdf.addImage(part.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, w, (part.height * w) / canvas.width);
    }
  }
  return pdf.output('datauristring').split(',')[1];
}
