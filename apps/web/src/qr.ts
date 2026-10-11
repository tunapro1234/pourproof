// QR code for a pour's passport URL (qrcode-generator, MIT). Printed on the delivery ticket, it opens /pour/:id.
import qrcode from "qrcode-generator";

export function qrSvg(url: string): string {
  const q = qrcode(0, "M");
  q.addData(url);
  q.make();
  return q.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
}
