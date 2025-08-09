// lib/pdfParser.ts
// Use pdfjs-dist directly to avoid pdf-parse test file access issues
export async function extractTextFromPDFBuffer(pdfBuffer: Buffer): Promise<string> {
  // Use legacy ESM build for Node compatibility
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (pdfjs && pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = undefined as any;
  }

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    isEvalSupported: false,
    useWorkerFetch: false,
  });
  const pdf = await loadingTask.promise;

  let fullText = '';
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const strings = content.items.map((item: any) => item.str);
    fullText += strings.join(' ') + '\n';
  }
  return fullText.trim();
}
