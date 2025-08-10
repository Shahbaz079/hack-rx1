export const runtime = 'nodejs';
import { NextRequest,NextResponse } from "next/server";

import OpenAI from "openai";
import { askOpenRouter } from "@/utils/ai";

// No OpenAI usage here; this route only orchestrates extraction

// Validate environment variables
const OPENAI_API_KEY=process.env.OPENAI_API_KEY;


// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

export async function POST(request: NextRequest) {
  try {
    const { documents, questions } = await request.json();

    // Validate URL format and parameters
    if (!documents || !questions || !Array.isArray(questions) || questions.length === 0) {
      return NextResponse.json(
        { error: "Invalid request. Please provide documents URL and questions array." },
        { status: 400 }
      );
    }

    // Validate that documents is a valid URL
    try {
      const url = new URL(documents);
      if (!url.protocol.startsWith('http')) {
        return NextResponse.json(
          { error: "Invalid documents parameter. Must be a valid HTTP/HTTPS URL." },
          { status: 400 }
        );
      }
    } catch (error) {
      return NextResponse.json(
        { error: "Invalid documents parameter. Must be a valid URL." },
        { status: 400 }
      );
    }

    console.log("🚀 Processing documents:", documents);
    console.log("❓ Questions:", questions); 

    // Use extract-text endpoint for PDF text extraction
    let extractedText = "";
    try {
      console.log("📄 Calling extract-text endpoint...");
      
      const response = await fetch(`${request.nextUrl.origin}/api/extract-text`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ pdfUrl: documents }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Extract-text API failed: ${response.status} ${errorData.error || response.statusText}`);
      }

      const extractResult = await response.json();
      extractedText = extractResult.text || extractResult.textContent || "";
      
      if (!extractedText.trim()) {
        console.warn("⚠️ PDF extracted successfully but empty text content");
      }
      
      console.log("✅ PDF extracted successfully via extract-text,", extractedText.length, "characters");

    }catch(error){
      console.error("❌ Error calling extract-text endpoint:", error);
      return NextResponse.json(
        { error: `PDF text extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}` },
        { status: 500 }
      );
    }

// 2. Chunk the document (smaller chunks for faster retrieval)
let chunks: string[] = [];
try {
  if (!extractedText.trim()) {
    throw new Error("Extracted PDF text is empty");
  }
  
  // For very large documents, use smaller chunks
  const chunkSize = extractedText.length > 500000 ? 200 : 300; // 200 words for very large docs
  chunks = chunkText(extractedText, chunkSize);
  console.log("✅ Document chunked:", chunks.length, "chunks (avg size:", Math.round(extractedText.length / chunks.length), "chars)");
  
  // Limit total chunks for very large documents to prevent memory issues
  if (chunks.length > 100) {
    console.warn(`⚠️ Large document detected (${chunks.length} chunks). Limiting to first 100 chunks for performance.`);
    chunks = chunks.slice(0, 100);
  }
} catch (error) {
  console.error("❌ Error during chunking:", error);
  return NextResponse.json(
    { error: "Failed to process the document content." },
    { status: 500 }
  );
}

// 3. Create embeddings for chunks and questions in parallel
let chunkEmbeddings: number[][] = [];
let questionEmbeddings: number[][] = [];
try {
  console.log("🚀 Generating embeddings in parallel...");
  [chunkEmbeddings, questionEmbeddings] = await Promise.all([
    getEmbeddings(chunks),
    getEmbeddings(questions)
  ]);
  console.log("✅ All embeddings created");
} catch (error) {
  console.error("❌ Error generating embeddings:", error);
  return NextResponse.json(
    { error: "Failed to generate embeddings." },
    { status: 500 }
  );
}

// 4. Process all questions in parallel
console.log("🚀 Processing questions in parallel...");
const questionPromises = questions.map(async (question, index) => {
  try {
    if (!question.trim()) {
      return { question, answer: "Error: Empty question provided", index };
    }

    console.log(`🔍 Processing question ${index + 1}:`, question);

    // Find most relevant chunks (reduced from 3 to 2 for speed)
    const relevantChunks = findRelevantChunks(questionEmbeddings[index], chunkEmbeddings, chunks, 2);
    console.log(`✅ Relevant chunks found for Q${index + 1}:`, relevantChunks.length);

    // Ask OpenRouter with improved prompt
    const answer = await askOpenRouter(question, relevantChunks);
    console.log(`✅ Answer received for Q${index + 1}:`, answer.substring(0, 100) + "...");

    return { question, answer, index };
  } catch (error) {
    console.error(`❌ Error processing question ${index + 1}:`, error);
    return { 
      question, 
      answer: `Error: Failed to process the question: ${question}`, 
      index 
    };
  }
});

const questionResults = await Promise.all(questionPromises);
const results = questionResults.sort((a, b) => a.index - b.index).map(r => r.answer);

return NextResponse.json({ answers: results });

  } catch (err: unknown) {
    console.error("🚨 Top-level error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}




// 🧩 Split document into ~300-word chunks (optimized for speed)
function chunkText(text: string, maxWords: number): string[] {
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid input: text must be a non-empty string');
  }
  if (!maxWords || maxWords <= 0) {
    throw new Error('Invalid input: maxWords must be a positive number');
  }

  const words = text.split(/\s+/);
  const chunks = [];

  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords).join(" "));
  }

  return chunks;
}

// 📊 Cosine similarity
function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) {
    throw new Error('Invalid input: vectors must be non-empty arrays');
  }
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));

  if (magA === 0 || magB === 0) {
    throw new Error('Invalid vectors: magnitude cannot be zero');
  }

  return dot / (magA * magB);
}

// 🔍 Get top 2 relevant chunks (optimized for speed)
function findRelevantChunks(
  queryEmbedding: number[],
  docEmbeddings: number[][],
  docChunks: string[],
  topK: number = 2
): string[] {
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    throw new Error('Invalid query embedding');
  }
  if (!Array.isArray(docEmbeddings) || docEmbeddings.length === 0) {
    throw new Error('Invalid document embeddings');
  }
  if (!Array.isArray(docChunks) || docChunks.length === 0) {
    throw new Error('Invalid document chunks');
  }
  if (docEmbeddings.length !== docChunks.length) {
    throw new Error('Number of embeddings must match number of chunks');
  }
  if (topK <= 0 || topK > docChunks.length) {
    topK = Math.min(2, docChunks.length);
  }

  const similarities = docEmbeddings.map((embedding, index) => ({
    index,
    score: cosineSimilarity(queryEmbedding, embedding),
  }));

  const topChunks = similarities
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ index }) => docChunks[index]);

  return topChunks;
}

// 🧠 Get embeddings from OpenAI
async function getEmbeddings(texts: string[]): Promise<number[][]> {
  try {
    if (!texts || !Array.isArray(texts) || texts.length === 0) {
      throw new Error('Invalid input: texts must be a non-empty array of strings');
    }

    // Rate limiting: Process in batches of 10 texts
    const batchSize = 10;
    const embeddings: number[][] = [];
    
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const res = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: batch,
      });
      
      embeddings.push(...res.data.map((d) => d.embedding));
      
      // Add a small delay between batches to avoid rate limits
      if (i + batchSize < texts.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    
    return embeddings;
  } catch (error: any) {
    console.error("❌ OpenAI API Error:", error.message);
    throw new Error("Failed to generate embeddings");
  }
}
