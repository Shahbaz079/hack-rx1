export const runtime = 'nodejs';
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { pineconeService } from "@/lib/pinecone";

// Validate environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;

if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY environment variable is not set');
}

if (!PINECONE_API_KEY) {
  throw new Error('PINECONE_API_KEY environment variable is not set');
}

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

    // 🎯 NEW PINECONE-BASED FLOW
    try {
      // Step 1: Check if PDF exists in Pinecone
      console.log("🔍 Step 1: Checking if PDF exists in Pinecone...");
      const pdfExists = await pineconeService.checkPDFExists(documents);
      
      if (pdfExists) {
        console.log("✅ PDF found in Pinecone! Using cached embeddings...");
        
        // Step 2A: PDF exists - Generate question embeddings and retrieve chunks
        const questionEmbeddings = await getEmbeddingsOptimized(questions, 5);
        
        // Step 3A: Process questions with Pinecone vector search
        const results = await processQuestionsWithPinecone(documents, questions, questionEmbeddings);
        
        return NextResponse.json({ answers: results });
        
      } else {
        console.log("❌ PDF not found in Pinecone. Processing and storing...");
        
        // Step 2B: PDF doesn't exist - Extract, process, and store
        const extractedText = await extractPDFText(documents, request);
        const { chunks, embeddings } = await processAndStorePDF(documents, extractedText);
        
        // Step 3B: Store in Pinecone
        await pineconeService.storePDFChunks(documents, chunks, embeddings);
        
        // Step 4B: Generate question embeddings and process
        const questionEmbeddings = await getEmbeddingsOptimized(questions, 5);
        const results = await processQuestionsWithPinecone(documents, questions, questionEmbeddings);
        
        return NextResponse.json({ answers: results });
      }
      
    } catch (error) {
      console.error("❌ Pinecone operation failed:", error);
      return NextResponse.json(
        { error: `Pinecone operation failed: ${error instanceof Error ? error.message : 'Unknown error'}` },
        { status: 500 }
      );
    }

  } catch (err: unknown) {
    console.error("🚨 Top-level error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// 🎯 Process questions using Pinecone vector search
async function processQuestionsWithPinecone(
  pdfUrl: string, 
  questions: string[], 
  questionEmbeddings: number[][]
): Promise<string[]> {
  console.log("🚀 Processing questions with Pinecone vector search...");
  
  const questionPromises = questions.map(async (question, index) => {
    try {
      if (!question.trim()) {
        return { question, answer: "Error: Empty question provided", index };
      }

      console.log(`🔍 Processing question ${index + 1}:`, question);

      // Get top-k chunks from Pinecone for this question
      const topK = 2; // Adjust based on your needs
      const relevantChunks = await pineconeService.getTopKChunks(
        pdfUrl, 
        questionEmbeddings[index], 
        topK
      );
      
      console.log(`✅ Retrieved ${relevantChunks.length} relevant chunks for Q${index + 1}`);

      // Generate answer using the retrieved chunks
      const answer = await askOpenRouterOptimized(question, relevantChunks);
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
  return questionResults.sort((a, b) => a.index - b.index).map(r => r.answer);
}

// 📄 Extract PDF text using the existing endpoint
async function extractPDFText(pdfUrl: string, request: NextRequest): Promise<string> {
  try {
    console.log("📄 Calling extract-text endpoint...");
    
    const response = await fetch(`${request.nextUrl.origin}/api/extract-text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pdfUrl }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Extract-text API failed: ${response.status} ${errorData.error || response.statusText}`);
    }

    const extractResult = await response.json();
    const extractedText = extractResult.text || extractResult.textContent || "";
    
    if (!extractedText.trim()) {
      console.warn("⚠️ PDF extracted successfully but empty text content");
    }
    
    console.log("✅ PDF extracted successfully via extract-text,", extractedText.length, "characters");
    return extractedText;
  } catch (error) {
    console.error("❌ Error calling extract-text endpoint:", error);
    throw error;
  }
}

// 🔄 Process and prepare PDF for storage
async function processAndStorePDF(pdfUrl: string, extractedText: string): Promise<{ chunks: string[]; embeddings: number[][] }> {
  try {
    console.log("🔄 Processing PDF for Pinecone storage...");
    
    // Chunk the document
    let chunks: string[] = [];
    if (!extractedText.trim()) {
      throw new Error("Extracted PDF text is empty");
    }
    
    // Adaptive chunking based on document size - store ALL chunks for complete coverage
    let chunkSize: number;
    
    if (extractedText.length > 1000000) {
      chunkSize = 150; // Smaller chunks for very large documents
    } else if (extractedText.length > 500000) {
      chunkSize = 200;
    } else {
      chunkSize = 300;
    }
    
    chunks = chunkText(extractedText, chunkSize);
    console.log(`✅ Document chunked: ${chunks.length} chunks (${chunkSize} words each) - storing ALL chunks for complete coverage`);
    
    // Generate embeddings
    const batchSize = chunks.length > 50 ? 20 : 10;
    const embeddings = await getEmbeddingsOptimized(chunks, batchSize);
    
    console.log("✅ PDF processed and ready for Pinecone storage");
    return { chunks, embeddings };
  } catch (error) {
    console.error("❌ Error processing PDF:", error);
    throw error;
  }
}

// 🧩 Split document into optimized chunks
function chunkText(text: string, maxWords: number): string[] {
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid input: text must be a non-empty string');
  }
  if (!maxWords || maxWords <= 0) {
    throw new Error('Invalid input: maxWords must be a positive number');
  }

  const words = text.split(/\s+/).filter(word => word.length > 0);
  const chunks: string[] = [];
  
  for (let i = 0; i < words.length; i += maxWords) {
    const chunk = words.slice(i, i + maxWords).join(' ');
    if (chunk.trim()) {
      chunks.push(chunk);
    }
  }

  console.log(`📊 Created ${chunks.length} chunks from ${words.length} words`);
  return chunks;
}

// 🧠 Get embeddings from OpenAI
async function getEmbeddingsOptimized(texts: string[], batchSize: number = 10): Promise<number[][]> {
  try {
    if (!texts || !Array.isArray(texts) || texts.length === 0) {
      throw new Error('Invalid input: texts must be a non-empty array of strings');
    }

    console.log(`📊 Processing ${texts.length} texts in batches of ${batchSize}...`);
    const embeddings: number[][] = [];
    
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      console.log(`📦 Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)} (${batch.length} texts)`);
      
      const res = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: batch,
      });
      
      embeddings.push(...res.data.map((d) => d.embedding));
      
      if (i + batchSize < texts.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    console.log(`✅ Generated ${embeddings.length} embeddings`);
    return embeddings;
  } catch (error: any) {
    console.error("❌ OpenAI API Error:", error.message);
    throw new Error("Failed to generate embeddings");
  }
}

// 🚀 Optimized AI processing for faster responses
async function askOpenRouterOptimized(question: string, contextChunks: string[]): Promise<string> {
  try {
    const maxContextLength = 2000;
    const context = contextChunks.join('\n\n').substring(0, maxContextLength);
    
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: `You are a helpful assistant. Provide CONCISE answers (1-2 sentences maximum). Be accurate and factual. If context is missing, provide a brief answer from your knowledge.`
          },
          {
            role: "user",
            content: `Context: ${context}\n\nQuestion: ${question}\n\nAnswer:`
          }
        ],
        max_tokens: 100,
        temperature: 0.1,
      }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(
        `OpenAI API error: ${res.status} ${res.statusText}${errorData.error ? ` - ${errorData.error}` : ''}`
      );
    }

    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content?.trim();
    
    if (!answer) {
      throw new Error('No answer received from OpenAI API');
    }

    return answer;
  } catch (error) {
    console.error('❌ OpenAI API Error:', error);
    throw error;
  }
}
