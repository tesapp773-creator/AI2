// netlify/functions/_documents.js
//
// Generates real documents — PDF, Word, Excel, PowerPoint — and stores them
// in Supabase Storage (same "mkdai-files" bucket as downloads), returning
// a force-download URL. All four libraries are pure JS, no native
// binaries, so they're safe to run in a serverless function.

async function uploadDocument(supabase, buffer, fileName, contentType) {
  const storagePath = `documents/${Date.now()}-${fileName}`;
  const { error } = await supabase.storage
    .from("mkdai-files")
    .upload(storagePath, buffer, { contentType });
  if (error) throw new Error(`Generated the document but could not save it: ${error.message}`);
  const { data } = supabase.storage.from("mkdai-files").getPublicUrl(storagePath, { download: fileName });
  return data.publicUrl;
}

// content: array of paragraph strings (plain text, one per paragraph)
async function generatePdf(supabase, { title, content, fileName }) {
  const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 50;
  const maxWidth = pageWidth - margin * 2;

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  function wrapText(text, useFont, size) {
    const words = text.split(/\s+/);
    const lines = [];
    let line = "";
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (useFont.widthOfTextAtSize(test, size) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function ensureSpace(needed) {
    if (y - needed < margin) {
      page = doc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  }

  if (title) {
    const lines = wrapText(title, boldFont, 20);
    for (const line of lines) {
      ensureSpace(26);
      page.drawText(line, { x: margin, y, size: 20, font: boldFont, color: rgb(0.1, 0.1, 0.15) });
      y -= 26;
    }
    y -= 10;
  }

  for (const para of content || []) {
    const lines = wrapText(String(para), font, 12);
    for (const line of lines) {
      ensureSpace(18);
      page.drawText(line, { x: margin, y, size: 12, font, color: rgb(0.15, 0.15, 0.2) });
      y -= 18;
    }
    y -= 8;
  }

  const bytes = await doc.save();
  const name = fileName || "document.pdf";
  const url = await uploadDocument(supabase, Buffer.from(bytes), name, "application/pdf");
  return { fileUrl: url, fileName: name };
}

// content: array of { text, heading? } — heading: 1-3 or omitted for body text
async function generateDocx(supabase, { title, content, fileName }) {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require("docx");
  const children = [];

  if (title) {
    children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  }

  const headingMap = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 };

  for (const item of content || []) {
    if (typeof item === "string") {
      children.push(new Paragraph({ children: [new TextRun(item)] }));
    } else if (item.heading && headingMap[item.heading]) {
      children.push(new Paragraph({ text: item.text, heading: headingMap[item.heading] }));
    } else {
      children.push(new Paragraph({ children: [new TextRun(item.text || "")] }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  const name = fileName || "document.docx";
  const url = await uploadDocument(
    supabase,
    buffer,
    name,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  return { fileUrl: url, fileName: name };
}

// headers: array of column names. rows: array of arrays (values per row).
async function generateXlsx(supabase, { sheetName, headers, rows, fileName }) {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName || "Sheet1");

  if (headers && headers.length) {
    sheet.addRow(headers);
    sheet.getRow(1).font = { bold: true };
  }
  for (const row of rows || []) {
    sheet.addRow(row);
  }
  sheet.columns.forEach((col) => {
    let maxLen = 10;
    col.eachCell({ includeEmpty: true }, (cell) => {
      const len = cell.value ? String(cell.value).length : 0;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(maxLen + 2, 40);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const name = fileName || "spreadsheet.xlsx";
  const url = await uploadDocument(
    supabase,
    Buffer.from(buffer),
    name,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  return { fileUrl: url, fileName: name };
}

// slides: array of { title, bullets: [string, ...] }
async function generatePptx(supabase, { slides, fileName }) {
  const PptxGenJS = require("pptxgenjs");
  const pres = new PptxGenJS();

  for (const slideSpec of slides || []) {
    const slide = pres.addSlide();
    if (slideSpec.title) {
      slide.addText(slideSpec.title, {
        x: 0.5, y: 0.4, w: 9, h: 1,
        fontSize: 28, bold: true, color: "1a1a2e",
      });
    }
    if (slideSpec.bullets && slideSpec.bullets.length) {
      slide.addText(
        slideSpec.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.5, y: 1.6, w: 9, h: 4.5, fontSize: 18, color: "333333" }
      );
    }
  }

  const buffer = await pres.write({ outputType: "nodebuffer" });
  const name = fileName || "presentation.pptx";
  const url = await uploadDocument(
    supabase,
    buffer,
    name,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  );
  return { fileUrl: url, fileName: name };
}

module.exports = { generatePdf, generateDocx, generateXlsx, generatePptx };
