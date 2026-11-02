"use client";

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * Builds a small demonstration document in memory, so people can try the
 * editor (and the OCR pipeline) without uploading anything.
 */
export async function makeSamplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const ink = rgb(0.1, 0.12, 0.16);
  const accent = rgb(0.31, 0.27, 0.9);

  // ---- page 1: invoice -----------------------------------------------------
  const p1 = doc.addPage([595.28, 841.89]);
  p1.drawText("INVOICE", { x: 48, y: 770, size: 32, font: bold, color: ink });
  p1.drawText("Prairie Supply Co.  -  12 Marina Road, Lagos", { x: 48, y: 744, size: 10, font, color: ink });
  p1.drawLine({ start: { x: 48, y: 730 }, end: { x: 547, y: 730 }, thickness: 1.5, color: accent });

  const rows: [string, string, string][] = [
    ["Description", "Qty", "Amount"],
    ["A4 copy paper, 80 gsm", "12", "NGN 48,000"],
    ["Toner cartridge HP-26A", "2", "NGN 96,000"],
    ["Document scanner service", "1", "NGN 25,000"],
  ];
  rows.forEach((r, i) => {
    const y = 690 - i * 26;
    p1.drawText(r[0], { x: 48, y, size: 11, font: i === 0 ? bold : font, color: ink });
    p1.drawText(r[1], { x: 420, y, size: 11, font: i === 0 ? bold : font, color: ink });
    p1.drawText(r[2], { x: 480, y, size: 11, font: i === 0 ? bold : font, color: ink });
  });
  p1.drawLine({ start: { x: 48, y: 596 }, end: { x: 547, y: 596 }, thickness: 0.8, color: rgb(0.8, 0.82, 0.86) });
  p1.drawText("Total due", { x: 380, y: 566, size: 13, font: bold, color: ink });
  p1.drawText("NGN 169,000", { x: 470, y: 566, size: 13, font: bold, color: accent });

  p1.drawText("Payment is due within 14 days. Thank you for your business.", {
    x: 48,
    y: 140,
    size: 10,
    font: serif,
    color: rgb(0.35, 0.37, 0.42),
  });
  p1.drawRectangle({ x: 48, y: 90, width: 180, height: 34, borderColor: rgb(0.75, 0.77, 0.82), borderWidth: 1 });

  // ---- page 2: letter ------------------------------------------------------
  const p2 = doc.addPage([595.28, 841.89]);
  p2.drawText("Memorandum", { x: 48, y: 770, size: 24, font: bold, color: ink });
  const para = [
    "This sample page exists so you can test search, OCR and annotation.",
    "Try the Text tool to type over this paragraph, the pen tools to sign,",
    "or the eraser to remove a sentence. Run OCR to make the text layer",
    "selectable, then export and open the file in any PDF reader.",
    "",
    "Everything in PDF Scan Lite runs locally in your browser. No file ever",
    "leaves this device, which makes it safe for contracts, receipts and",
    "identity papers.",
  ];
  para.forEach((line, i) => {
    p2.drawText(line, { x: 48, y: 720 - i * 22, size: 11.5, font: serif, color: ink });
  });
  p2.drawLine({ start: { x: 48, y: 470 }, end: { x: 300, y: 470 }, thickness: 0.8, color: rgb(0.8, 0.82, 0.86) });
  p2.drawText("Signature", { x: 48, y: 454, size: 9, font, color: rgb(0.45, 0.47, 0.52) });

  doc.setTitle("Sample invoice");
  doc.setProducer("PDF Scan Lite");
  return doc.save();
}
