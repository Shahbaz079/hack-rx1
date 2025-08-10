export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PDFDocument } from 'pdf-lib';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // Increased to 100MB
const ADOBE_PAGE_LIMIT = 300; // Adobe's typical page limit
const CHUNK_SIZE_LIMIT = 50 * 1024 * 1024; // 50MB chunks for splitting
const PAGES_PER_SPLIT_TEXT = 200; // Pages per split for text-based PDFs
const PAGES_PER_SPLIT_SCANNED = 50; // Pages per split for scanned PDFs (much lower due to OCR complexity)

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
    const timeout = setTimeout(() => controller.abort(), 300000); // 5 minutes timeout for large files
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
        return NextResponse.json({ 
          error: `File size (${Math.round(contentLength / 1024 / 1024)}MB) exceeds limit (${MAX_FILE_SIZE / 1024 / 1024}MB). Consider using a smaller PDF or splitting the document.` 
        }, { status: 413 });
      }
    }

    const arrayBuf = await response.arrayBuffer();
    if (arrayBuf.byteLength > MAX_FILE_SIZE) {
      return NextResponse.json({ 
        error: `File size (${Math.round(arrayBuf.byteLength / 1024 / 1024)}MB) exceeds limit (${MAX_FILE_SIZE / 1024 / 1024}MB). Consider using a smaller PDF or splitting the document.` 
      }, { status: 413 });
    }

    const pdfBuffer = Buffer.from(arrayBuf);

    // 🎯 NEW PARSING FLOW: Detect size limit and choose appropriate strategy
    console.log(`📄 PDF size: ${Math.round(pdfBuffer.length / 1024 / 1024)}MB`);
    
    let extractedText = '';
    
    if (pdfBuffer.length > CHUNK_SIZE_LIMIT) {
      console.log('📄 Large PDF detected (>50MB), using PDF splitting approach...');
      extractedText = await processLargePDFWithSplitting(pdfBuffer);
    } else {
      console.log('📄 Normal PDF size, using direct Adobe extraction...');
      extractedText = await processNormalPDF(pdfBuffer);
    }

    // If all approaches fail, return empty document
    if (!extractedText || extractedText.trim().length === 0) {
      console.warn('❌ All PDF processing strategies failed, returning empty document');
      return NextResponse.json({ 
        text: '',
        warning: 'All PDF processing strategies failed. The document may be corrupted, password-protected, or in an unsupported format.'
      });
    }

    setCachedText(url, extractedText);
    return NextResponse.json({ text: extractedText });

  } catch (error) {
    console.error('PDF extraction error:', error);
    return NextResponse.json({ 
      error: 'Failed to process PDF',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}

async function processLargePDFWithSplitting(pdfBuffer: Buffer): Promise<string> {
  try {
    console.log('📄 Starting PDF splitting workflow...');
    
    // Step 1: Get PDF info and calculate splitting strategy
    const pdfInfo = await getPDFInfo(pdfBuffer);
    if (!pdfInfo) {
      console.warn('❌ Failed to get PDF info');
      return '';
    }
    
    console.log(`📄 PDF has ${pdfInfo.pageCount} pages`);
    
    // Step 2: Calculate optimal splitting strategy
    const splittingStrategy = calculateSplittingStrategy(pdfInfo.pageCount);
    console.log(`📄 Splitting strategy: ${splittingStrategy.partsNeeded} parts, ${splittingStrategy.pagesPerPart} pages per part`);
    
    // Step 3: Process only the parts we need (lazy splitting)
    let combinedText = '';
    const maxPartsToProcess = Math.min(3, splittingStrategy.partsNeeded); // Process first 3 parts for performance
    
    console.log(`📄 Processing ${maxPartsToProcess} parts with lazy splitting...`);
    
    // Process parts one by one, creating them only when needed
    const processingPromises = [];
    for (let i = 0; i < maxPartsToProcess; i++) {
      processingPromises.push(processPDFPartLazy(pdfBuffer, i, splittingStrategy));
    }
    
    // Wait for all parts to complete processing
    const results = await Promise.allSettled(processingPromises);
    
    // Check if we got any successful results
    let successCount = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value && result.value.trim().length > 0) {
        combinedText += result.value;
        successCount++;
        console.log(`✅ Part ${i + 1} processed successfully`);
      } else {
        console.warn(`❌ Part ${i + 1} failed: ${result.status === 'rejected' ? result.reason : 'No text extracted'}`);
      }
    }
    
    // If no parts succeeded, try with smaller page limits (for scanned documents)
    if (successCount === 0) {
      console.log('📄 All parts failed, trying with smaller page limits for scanned documents...');
      const smallerStrategy = calculateSplittingStrategy(pdfInfo.pageCount, true); // Force smaller splits
      console.log(`📄 Smaller strategy: ${smallerStrategy.partsNeeded} parts, ${smallerStrategy.pagesPerPart} pages per part`);
      
      // Process smaller parts
      const smallerProcessingPromises = [];
      const maxSmallerParts = Math.min(5, smallerStrategy.partsNeeded); // Process more smaller parts
      for (let i = 0; i < maxSmallerParts; i++) {
        smallerProcessingPromises.push(processPDFPartLazy(pdfBuffer, i, smallerStrategy));
      }
      
      const smallerResults = await Promise.allSettled(smallerProcessingPromises);
      
      for (let i = 0; i < smallerResults.length; i++) {
        const result = smallerResults[i];
        if (result.status === 'fulfilled' && result.value && result.value.trim().length > 0) {
          combinedText += result.value;
          console.log(`✅ Smaller part ${i + 1} processed successfully`);
        }
      }
    }
    
    if (combinedText.trim().length > 0) {
      const note = splittingStrategy.partsNeeded > maxPartsToProcess 
        ? `\n\n[Note: This is text from the first ${maxPartsToProcess} parts of a large PDF split into ${splittingStrategy.partsNeeded} total parts.]`
        : `\n\n[Note: This is text from a large PDF that was split into ${splittingStrategy.partsNeeded} parts for processing.]`;
      
      console.log(`✅ PDF splitting workflow completed. Extracted ${combinedText.length} characters.`);
      return combinedText + note;
    }
    
  } catch (e) {
    console.warn('PDF splitting workflow failed:', e);
  }
  
  return '';
}

async function processNormalPDF(pdfBuffer: Buffer): Promise<string> {
  try {
    // Try Adobe Extract first (best quality)
    console.log('📄 Trying Adobe Extract...');
    const extractedText = await tryAdobeExtract(pdfBuffer);
    if (extractedText && extractedText.trim().length > 0) {
      console.log('✅ Adobe Extract successful');
      return extractedText;
    }
    
    // Try Adobe OCR if Extract fails
    console.log('📄 Trying Adobe OCR...');
    const ocredBuffer = await tryAdobeOCR(pdfBuffer);
    if (ocredBuffer && ocredBuffer.length > 0) {
      const ocrText = await tryTextBasedExtraction(ocredBuffer);
      if (ocrText && ocrText.trim().length > 0) {
        console.log('✅ Adobe OCR successful');
        return ocrText;
      }
    }
    
    // Try external services as fallback
    console.log('📄 Trying external PDF services...');
    // Note: External services typically work with URLs, not buffers
    // For now, we'll skip this step since we don't have the original URL here
    // const externalText = await tryExternalPDFService(url);
    // if (externalText && externalText.trim().length > 0) {
    //   console.log('✅ External PDF service successful');
    //   return externalText;
    // }
    
    // Try raw text extraction as last resort
    console.log('📄 Trying raw PDF text extraction...');
    const rawText = await tryRawPDFExtraction(pdfBuffer);
    if (rawText && rawText.trim().length > 0) {
      console.log('✅ Raw PDF text extraction successful');
      return rawText;
    }
    
  } catch (e) {
    console.warn('Normal PDF processing failed:', e);
  }
  
  return '';
}



async function createPDFSplit(pdfDoc: PDFDocument, startPage: number, endPage: number, partNumber: number): Promise<Buffer> {
  // Create a new PDF document for this split
  const newPdfDoc = await PDFDocument.create();
  
  // Copy pages from the original document
  const pageIndices = [];
  for (let j = startPage; j <= endPage; j++) {
    pageIndices.push(j);
  }
  
  const copiedPages = await newPdfDoc.copyPages(pdfDoc, pageIndices);
  copiedPages.forEach((page) => newPdfDoc.addPage(page));
  
  // Save the split part as a buffer
  const pdfBytes = await newPdfDoc.save();
  const partBuffer = Buffer.from(pdfBytes);
  
  console.log(`📄 Created split part ${partNumber}: ${Math.round(partBuffer.length / 1024 / 1024)}MB`);
  return partBuffer;
}

async function processPDFPart(partBuffer: Buffer, partNumber: number): Promise<string> {
  try {
    console.log(`📄 Processing part ${partNumber} (${Math.round(partBuffer.length / 1024 / 1024)}MB)...`);
    
    // Add timeout to prevent hanging
    const processingPromise = processPDFPartWithTimeout(partBuffer, partNumber);
    const timeoutPromise = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error(`Part ${partNumber} processing timeout`)), 120000) // 2 minutes per part
    );
    
    return await Promise.race([processingPromise, timeoutPromise]);
    
  } catch (e) {
    console.warn(`Error processing part ${partNumber}:`, e);
    return '';
  }
}

async function processPDFPartWithTimeout(partBuffer: Buffer, partNumber: number): Promise<string> {
  // Try Adobe Extract on this part
  const extractText = await tryAdobeExtract(partBuffer);
  if (extractText && extractText.trim().length > 0) {
    console.log(`✅ Successfully extracted text from part ${partNumber}`);
    return `\n\n--- Part ${partNumber} ---\n\n${extractText}`;
  }
  
  // Try Adobe OCR on this part
  console.log(`📄 Trying Adobe OCR on part ${partNumber}...`);
  const ocredBuffer = await tryAdobeOCR(partBuffer);
  if (ocredBuffer && ocredBuffer.length > 0) {
    const ocrText = await tryTextBasedExtraction(ocredBuffer);
    if (ocrText && ocrText.trim().length > 0) {
      console.log(`✅ Successfully OCR'd text from part ${partNumber}`);
      return `\n\n--- Part ${partNumber} (OCR) ---\n\n${ocrText}`;
    }
  }
  
  console.warn(`❌ Failed to extract text from part ${partNumber}`);
  return '';
}

// Helper function to detect if error is due to page limits
function isPageLimitError(error: any): boolean {
  return error && (
    error._errorCode === 'DISQUALIFIED_SCAN_PAGE_LIMIT' ||
    error.message?.includes('page limit') ||
    error.message?.includes('DISQUALIFIED')
  );
}

// Get PDF info without loading the entire document
async function getPDFInfo(pdfBuffer: Buffer): Promise<{ pageCount: number } | null> {
  try {
    console.log('📄 Getting PDF info...');
    
    // Load the PDF document with timeout
    const pdfDoc = await Promise.race([
      PDFDocument.load(pdfBuffer),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('PDF loading timeout')), 30000)
      )
    ]);
    
    const pageCount = pdfDoc.getPageCount();
    return { pageCount };
    
  } catch (e) {
    console.warn('Failed to get PDF info:', e);
    return null;
  }
}

// Calculate optimal splitting strategy
function calculateSplittingStrategy(pageCount: number, forceSmaller: boolean = false): { 
  partsNeeded: number; 
  pagesPerPart: number; 
} {
  let pagesPerPart = pageCount > ADOBE_PAGE_LIMIT ? PAGES_PER_SPLIT_SCANNED : PAGES_PER_SPLIT_TEXT;
  
  if (forceSmaller) {
    pagesPerPart = Math.floor(pagesPerPart / 2); // Reduce by half for retry
    console.log(`📄 Forcing smaller page limit: ${pagesPerPart} pages per split`);
  }
  
  const partsNeeded = Math.ceil(pageCount / pagesPerPart);
  
  return { partsNeeded, pagesPerPart };
}

// Process a single PDF part with lazy creation
async function processPDFPartLazy(pdfBuffer: Buffer, partIndex: number, strategy: { partsNeeded: number; pagesPerPart: number }): Promise<string> {
  try {
    console.log(`📄 Creating and processing part ${partIndex + 1} (lazy splitting)...`);
    
    // Create only this specific part
    const partBuffer = await createSinglePDFPart(pdfBuffer, partIndex, strategy);
    if (!partBuffer) {
      console.warn(`❌ Failed to create part ${partIndex + 1}`);
      return '';
    }
    
    console.log(`📄 Part ${partIndex + 1} created: ${Math.round(partBuffer.length / 1024 / 1024)}MB`);
    
    // Process this part
    return await processPDFPart(partBuffer, partIndex + 1);
    
  } catch (e) {
    console.warn(`Error processing part ${partIndex + 1}:`, e);
    return '';
  }
}

// Create a single PDF part on demand
async function createSinglePDFPart(pdfBuffer: Buffer, partIndex: number, strategy: { partsNeeded: number; pagesPerPart: number }): Promise<Buffer | null> {
  try {
    // Load the PDF document
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pageCount = pdfDoc.getPageCount();
    
    // Calculate page range for this part
    const startPage = partIndex * strategy.pagesPerPart;
    const endPage = Math.min((partIndex + 1) * strategy.pagesPerPart - 1, pageCount - 1);
    
    console.log(`📄 Creating part ${partIndex + 1}: pages ${startPage + 1}-${endPage + 1}`);
    
    // Create the part with timeout
    const partPromise = createPDFSplit(pdfDoc, startPage, endPage, partIndex + 1);
    const timeoutPromise = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error(`Part ${partIndex + 1} creation timeout`)), 60000)
    );
    
    return await Promise.race([partPromise, timeoutPromise]);
    
  } catch (e) {
    console.warn(`Failed to create part ${partIndex + 1}:`, e);
    return null;
  }
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

    // Persist buffer to a serverless-writable temp file and upload via fs.createReadStream
    const tempDir = os.tmpdir();
    const tempPdfPath = path.join(tempDir, `adobe_extract_${Date.now()}.pdf`);
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
    
    // Cleanup temp file
    try { fs.unlinkSync(tempPdfPath); } catch {}
    
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

    const tempDir = os.tmpdir();
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
    // Cleanup temp file
    try { fs.unlinkSync(tempPdfPath); } catch {}
    return Buffer.concat(chunks);
  } catch (e) {
    console.warn('Adobe OCR error:', e);
    return Buffer.alloc(0);
  }
}

async function tryTextBasedExtraction(pdfBuffer: Buffer): Promise<string> {
  // Try to extract text using regex patterns for common PDF text markers
  try {
    const text = pdfBuffer.toString('utf8', 0, Math.min(pdfBuffer.length, 1000000)); // First 1MB
    
    // Look for text patterns in PDF
    const textMatches = text.match(/\([^)]*\)/g) || [];
    const potentialText = textMatches
      .map(match => match.slice(1, -1)) // Remove parentheses
      .filter(t => t.length > 10 && /[a-zA-Z]/.test(t)) // Filter meaningful text
      .join(' ');
    
    return potentialText || '';
  } catch {
    return '';
  }
}

async function tryExternalPDFService(url: string): Promise<string> {
  // Option 1: Try PDFTron (if you have API key)
  const PDFTRON_API_KEY = process.env.PDFTRON_API_KEY;
  if (PDFTRON_API_KEY) {
    try {
      console.log('📄 Trying PDFTron service...');
      const response = await fetch('https://api.pdftron.com/v2/convert', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PDFTRON_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: url,
          output: 'text',
          options: {
            max_pages: 100, // Higher page limit for large documents
            ocr: true, // Enable OCR for scanned documents
            ocr_language: 'eng', // English OCR
            ocr_quality: 'high' // High quality OCR
          }
        }),
      });
      
      if (response.ok) {
        const result = await response.json();
        return result.text || '';
      }
    } catch (e) {
      console.warn('PDFTron service failed:', e);
    }
  }

  // Option 2: Try PDF.co (if you have API key)
  const PDFCO_API_KEY = process.env.PDFCO_API_KEY;
  if (PDFCO_API_KEY) {
    try {
      console.log('📄 Trying PDF.co service...');
      const response = await fetch('https://api.pdf.co/v1/pdf/convert/to/text', {
        method: 'POST',
        headers: {
          'x-api-key': PDFCO_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: url,
          pages: '1-50', // Process first 50 pages
          ocr: true,
          ocr_language: 'eng'
        }),
      });
      
      if (response.ok) {
        const result = await response.json();
        return result.body || '';
      }
    } catch (e) {
      console.warn('PDF.co service failed:', e);
    }
  }

  // Option 3: Try DocRaptor (if you have API key)
  const DOCRAPTOR_API_KEY = process.env.DOCRAPTOR_API_KEY;
  if (DOCRAPTOR_API_KEY) {
    try {
      console.log('📄 Trying DocRaptor service...');
      const response = await fetch('https://docraptor.com/docs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user_credentials: DOCRAPTOR_API_KEY,
          document_url: url,
          document_type: 'pdf',
          test: false,
          javascript: false,
          prince_options: {
            pdf_profile: 'PDF/A-1a'
          }
        }),
      });
      
      if (response.ok) {
        // DocRaptor returns PDF, we'd need to extract text from it
        console.log('DocRaptor service not fully implemented for text extraction');
      }
    } catch (e) {
      console.warn('DocRaptor service failed:', e);
    }
  }

  // Option 4: Try Google Docs API (if configured)
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  if (GOOGLE_API_KEY) {
    try {
      console.log('📄 Trying Google Docs service...');
      // This would require more complex setup with Google Drive API
      console.log('Google Docs API not fully implemented');
    } catch (e) {
      console.warn('Google Docs service failed:', e);
    }
  }

  // Option 5: Try alternative PDF services
  const ALTERNATIVE_API_KEY = process.env.ALTERNATIVE_PDF_API_KEY;
  if (ALTERNATIVE_API_KEY) {
    try {
      console.log('📄 Trying alternative PDF service...');
      // Add your preferred PDF service here
      // Example: PDF.co, DocRaptor, etc.
    } catch (e) {
      console.warn('Alternative PDF service failed:', e);
    }
  }

  return '';
}

async function tryRawPDFExtraction(pdfBuffer: Buffer): Promise<string> {
  try {
    console.log('📄 Attempting raw PDF text extraction...');
    
    // Convert buffer to string and look for text patterns
    const text = pdfBuffer.toString('utf8', 0, Math.min(pdfBuffer.length, 5000000)); // First 5MB
    
    // Look for various text patterns in PDF
    const patterns = [
      /\([^)]{10,}\)/g, // Text in parentheses (most common)
      /\[[^\]]{10,}\]/g, // Text in brackets
      /<[^>]{10,}>/g,   // Text in angle brackets
      /"[^"]{10,}"/g,   // Text in quotes
    ];
    
    let extractedText = '';
    for (const pattern of patterns) {
      const matches = text.match(pattern) || [];
      const patternText = matches
        .map(match => match.slice(1, -1)) // Remove delimiters
        .filter(t => t.length > 10 && /[a-zA-Z]/.test(t)) // Filter meaningful text
        .join(' ');
      
      if (patternText.length > extractedText.length) {
        extractedText = patternText;
      }
    }
    
    if (extractedText.trim().length > 100) {
      console.log(`📄 Extracted ${extractedText.length} characters from raw PDF`);
      return extractedText;
    }
    
  } catch (e) {
    console.warn('Raw PDF extraction failed:', e);
  }
  
  return '';
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
