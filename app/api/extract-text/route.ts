export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { extractTextFromPDFBuffer } from '../../../lib/pdfParser';
import fs from 'fs';
import path from 'path';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// Simple in-memory cache for extracted text keyed by full URL
type CacheEntry = { text: string; expiresAt: number };
const extractCache: Map<string, CacheEntry> = new Map();

function isValidUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const url: string | undefined = body?.url || body?.pdfUrl || body?.documents;

    if (!url) {
      return NextResponse.json({ error: 'Missing URL. Provide `url`, `pdfUrl`, or `documents`.' }, { status: 400 });
    }

    if (!isValidUrl(url)) {
      return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
    }

    // Cache fast-path
    const cached = getCachedText(url);
    if (cached) {
      return NextResponse.json({ text: cached });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        cache: 'no-store',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return NextResponse.json({ error: `Failed to download PDF: ${response.status} ${response.statusText}` }, { status: 502 });
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = Number(contentLengthHeader);
      if (!Number.isNaN(contentLength) && contentLength > MAX_FILE_SIZE) {
        return NextResponse.json({ error: 'File size exceeds limit' }, { status: 413 });
      }
    }

    const arrayBuf = await response.arrayBuffer();
    if (arrayBuf.byteLength > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File size exceeds limit' }, { status: 413 });
    }

    const pdfBuffer = Buffer.from(arrayBuf);

    // Tier 2: Adobe PDF Services Extract (preferred)
    const extractedText = await tryAdobeExtract(pdfBuffer).catch((e) => {
      console.warn('Adobe fallback failed:', e);
      return '';
    });

    if (extractedText && extractedText.trim().length > 0) {
      setCachedText(url, extractedText);
      return NextResponse.json({ text: extractedText });
    }

    // Tier 3: OCR with Adobe, then parse again via pdf.js
    const ocredBuffer = await tryAdobeOCR(pdfBuffer).catch((e) => {
      console.warn('Adobe OCR failed:', e);
      return Buffer.alloc(0);
    });
    if (ocredBuffer && ocredBuffer.length > 0) {
      const ocrText = await parseWithTimeout(ocredBuffer, 20000);
      if (ocrText && ocrText.trim().length > 0) {
        setCachedText(url, ocrText);
      }
      return NextResponse.json({ text: ocrText || '', warning: ocrText ? undefined : 'No text extracted after OCR' });
    }

    return NextResponse.json({ text: '', warning: 'No text extracted' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: 'Request failed', details: message }, { status: 500 });
  }
}

async function parseWithTimeout(pdfBuffer: Buffer, timeoutMs: number): Promise<string> {
  return new Promise(async (resolve) => {
    const timer = setTimeout(() => resolve(''), timeoutMs);
    try {
      const text = await extractTextFromPDFBuffer(pdfBuffer);
      clearTimeout(timer);
      resolve(text || '');
    } catch (e) {
      clearTimeout(timer);
      console.warn('pdfjs re-parse after OCR failed:', e);
      resolve('');
    }
  });
}

async function tryAdobeExtract(pdfBuffer: Buffer): Promise<string> {
  let PDFServicesSDK: any;
  try {
    PDFServicesSDK = (await import('@adobe/pdfservices-node-sdk')).default || (await import('@adobe/pdfservices-node-sdk'));
  } catch {
    return '';
  }

  // Resolve credentials from env or JSON file
  const creds = resolveAdobeCredentials();
  if (!creds) return '';

  try {
    const credentials = new PDFServicesSDK.ServicePrincipalCredentials({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    });
    const pdfServices = new PDFServicesSDK.PDFServices({ credentials });

    // Persist buffer to a temp file and upload via fs.createReadStream per SDK samples
    const tempDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tempPdfPath = path.join(tempDir, `adobe_fallback_${Date.now()}.pdf`);
    fs.writeFileSync(tempPdfPath, pdfBuffer);
    const readStream = fs.createReadStream(tempPdfPath);
    const { MimeType } = PDFServicesSDK;
    const inputAsset = await pdfServices.upload({ readStream, mimeType: MimeType.PDF });

    const { ExtractPDFParams, ExtractElementType, ExtractPDFJob, ExtractPDFResult } = PDFServicesSDK;
    const params = new ExtractPDFParams({ elementsToExtract: [ExtractElementType.TEXT] });
    const job = new ExtractPDFJob({ inputAsset, params });

    const pollingURL = await pdfServices.submit({ job });
    const resultResponse = await pdfServices.getJobResult({ pollingURL, resultType: ExtractPDFResult });
    const resultAsset = resultResponse.result.resource;
    const streamAsset = await pdfServices.getContent({ asset: resultAsset });

    // The result is a zip stream; collect and read JSON inside
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const rs = streamAsset.readStream;
      rs.on('data', (c: Buffer) => chunks.push(c));
      rs.on('end', () => resolve());
      rs.on('error', reject);
    });
    const zipBuffer = Buffer.concat(chunks);
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.entryName.endsWith('.json')) {
        const jsonStr = zip.readAsText(entry);
        const jsonData = JSON.parse(jsonStr);
        const elements = jsonData.elements || [];
        const text = elements.filter((el: any) => el.Text).map((el: any) => el.Text).join(' ');
        return text || '';
      }
    }
    return '';
  } catch (e) {
    console.warn('Adobe extraction error:', e);
    return '';
  }
}

async function tryAdobeOCR(pdfBuffer: Buffer): Promise<Buffer> {
  let PDFServicesSDK: any;
  try {
    PDFServicesSDK = (await import('@adobe/pdfservices-node-sdk')).default || (await import('@adobe/pdfservices-node-sdk'));
  } catch {
    return Buffer.alloc(0);
  }

  const creds = resolveAdobeCredentials();
  if (!creds) return Buffer.alloc(0);

  try {
    const credentials = new PDFServicesSDK.ServicePrincipalCredentials({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    });
    const pdfServices = new PDFServicesSDK.PDFServices({ credentials });

    const tempDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tempPdfPath = path.join(tempDir, `adobe_ocr_${Date.now()}.pdf`);
    fs.writeFileSync(tempPdfPath, pdfBuffer);
    const readStream = fs.createReadStream(tempPdfPath);
    const { MimeType, OCRJob, OCRResult } = PDFServicesSDK;
    const inputAsset = await pdfServices.upload({ readStream, mimeType: MimeType.PDF });

    const job = new OCRJob({ inputAsset });
    const pollingURL = await pdfServices.submit({ job });
    const resultResponse = await pdfServices.getJobResult({ pollingURL, resultType: OCRResult });
    const resultAsset = resultResponse.result.asset;
    const streamAsset = await pdfServices.getContent({ asset: resultAsset });

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const rs = streamAsset.readStream;
      rs.on('data', (c: Buffer) => chunks.push(c));
      rs.on('end', () => resolve());
      rs.on('error', reject);
    });
    return Buffer.concat(chunks);
  } catch (e) {
    console.warn('Adobe OCR error:', e);
    return Buffer.alloc(0);
  }
}

function resolveAdobeCredentials(): { clientId: string; clientSecret: string } | null {
  const envClientId = process.env.PDF_SERVICES_CLIENT_ID;
  const envClientSecret = process.env.PDF_SERVICES_CLIENT_SECRET;
  if (envClientId && envClientSecret) {
    return { clientId: envClientId, clientSecret: envClientSecret };
  }

  const credentialsPath = path.join(process.cwd(), 'pdfservices-api-credentials.json');
  if (fs.existsSync(credentialsPath)) {
    try {
      const credentialsData = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
      const fileClientId = credentialsData?.client_credentials?.client_id;
      const fileClientSecret = credentialsData?.client_credentials?.client_secret;
      if (fileClientId && fileClientSecret) {
        return { clientId: fileClientId, clientSecret: fileClientSecret };
      }
    } catch {
      // ignore
    }
  }

  console.warn('Adobe credentials not configured. Set PDF_SERVICES_CLIENT_ID and PDF_SERVICES_CLIENT_SECRET in .env or provide pdfservices-api-credentials.json');
  return null;
}

function getCachedText(url: string): string | null {
  const entry = extractCache.get(url);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    extractCache.delete(url);
    return null;
  }
  return entry.text;
}

function setCachedText(url: string, text: string): void {
  const ttlMs = computeTTL(url);
  extractCache.set(url, { text, expiresAt: Date.now() + ttlMs });
}

function computeTTL(urlString: string): number {
  // If SAS URL with 'se' expiry, use time until expiry, capped to 7 days; otherwise 24 hours
  try {
    const u = new URL(urlString);
    const se = u.searchParams.get('se');
    if (se) {
      const expiry = Date.parse(se);
      if (!Number.isNaN(expiry)) {
        const ms = Math.max(0, expiry - Date.now());
        return Math.min(ms, 7 * 24 * 60 * 60 * 1000);
      }
    }
  } catch {}
  return 24 * 60 * 60 * 1000;
}
