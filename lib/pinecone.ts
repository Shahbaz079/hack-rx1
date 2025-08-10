import { Pinecone } from '@pinecone-database/pinecone';

// Initialize Pinecone client
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!,
});

const INDEX_NAME = process.env.PINECONE_INDEX_NAME || 'pdf-embeddings';

export interface PDFChunk {
  id: string;
  values: number[];
  metadata: {
    text: string;
    pdfUrl: string;
    chunkIndex: number;
    totalChunks: number;
    createdAt: string;
  };
}

export interface PDFDocument {
  pdfUrl: string;
  chunks: string[];
  embeddings: number[][];
  totalChunks: number;
  createdAt: string;
}

export class PineconeService {
  private index;

  constructor() {
    this.index = pinecone.index(INDEX_NAME);
  }

  /**
   * Check if a PDF document exists in Pinecone using URL as filter
   */
  async checkPDFExists(pdfUrl: string): Promise<boolean> {
    try {
      console.log(`🔍 Checking Pinecone for PDF: ${pdfUrl}`);
      
      // Query for documents with this PDF URL
      const queryResponse = await this.index.query({
        vector: new Array(1536).fill(0), // Dummy vector for metadata-only query
        filter: {
          pdfUrl: { $eq: pdfUrl }
        },
        topK: 1,
        includeMetadata: true,
        includeValues: false
      });

      const exists = queryResponse.matches.length > 0;
      console.log(`📊 PDF exists in Pinecone: ${exists}`);
      return exists;
    } catch (error) {
      console.error('❌ Error checking PDF existence:', error);
      return false;
    }
  }

  /**
   * Retrieve top-k chunks for a question from a specific PDF
   */
  async getTopKChunks(pdfUrl: string, questionEmbedding: number[], topK: number = 2): Promise<string[]> {
    try {
      console.log(`🔍 Retrieving top-${topK} chunks for PDF: ${pdfUrl}`);
      
      const queryResponse = await this.index.query({
        vector: questionEmbedding,
        filter: {
          pdfUrl: { $eq: pdfUrl }
        },
        topK: topK,
        includeMetadata: true,
        includeValues: false
      });

      const chunks = queryResponse.matches
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .map(match => {
          const text = match.metadata?.text;
          return typeof text === 'string' ? text : '';
        })
        .filter(text => text.length > 0);

      console.log(`✅ Retrieved ${chunks.length} chunks from Pinecone`);
      return chunks;
    } catch (error) {
      console.error('❌ Error retrieving chunks from Pinecone:', error);
      return [];
    }
  }

  /**
   * Store PDF chunks and embeddings in Pinecone
   */
  async storePDFChunks(pdfUrl: string, chunks: string[], embeddings: number[][]): Promise<void> {
    try {
      console.log(`💾 Storing ${chunks.length} chunks in Pinecone for PDF: ${pdfUrl}`);
      
      // Prepare vectors for Pinecone
      const vectors: PDFChunk[] = chunks.map((chunk, index) => ({
        id: `${pdfUrl}_chunk_${index}`,
        values: embeddings[index],
        metadata: {
          text: chunk,
          pdfUrl: pdfUrl,
          chunkIndex: index,
          totalChunks: chunks.length,
          createdAt: new Date().toISOString()
        }
      }));

      // Upsert in batches (Pinecone has limits)
      const batchSize = 100;
      for (let i = 0; i < vectors.length; i += batchSize) {
        const batch = vectors.slice(i, i + batchSize);
        await this.index.upsert(batch);
        console.log(`📦 Upserted batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(vectors.length / batchSize)}`);
      }

      console.log(`✅ Successfully stored ${chunks.length} chunks in Pinecone`);
    } catch (error) {
      console.error('❌ Error storing chunks in Pinecone:', error);
      throw error;
    }
  }

  /**
   * Delete all chunks for a specific PDF (useful for updates)
   */
  async deletePDFChunks(pdfUrl: string): Promise<void> {
    try {
      console.log(`🗑️ Deleting chunks for PDF: ${pdfUrl}`);
      
      // Get all chunk IDs for this PDF
      const queryResponse = await this.index.query({
        vector: new Array(1536).fill(0),
        filter: {
          pdfUrl: { $eq: pdfUrl }
        },
        topK: 10000, // Large number to get all chunks
        includeMetadata: false,
        includeValues: false
      });

      const chunkIds = queryResponse.matches.map(match => match.id);
      
      if (chunkIds.length > 0) {
        await this.index.deleteMany(chunkIds);
        console.log(`✅ Deleted ${chunkIds.length} chunks for PDF: ${pdfUrl}`);
      } else {
        console.log(`📝 No chunks found to delete for PDF: ${pdfUrl}`);
      }
    } catch (error) {
      console.error('❌ Error deleting chunks from Pinecone:', error);
      throw error;
    }
  }

  /**
   * Get statistics about stored PDFs
   */
  async getPDFStats(pdfUrl: string): Promise<{ totalChunks: number; createdAt: string } | null> {
    try {
      const queryResponse = await this.index.query({
        vector: new Array(1536).fill(0),
        filter: {
          pdfUrl: { $eq: pdfUrl }
        },
        topK: 1,
        includeMetadata: true,
        includeValues: false
      });

      if (queryResponse.matches.length > 0) {
        const metadata = queryResponse.matches[0].metadata;
        const totalChunks = metadata?.totalChunks;
        const createdAt = metadata?.createdAt;
        
        return {
          totalChunks: typeof totalChunks === 'number' ? totalChunks : 0,
          createdAt: typeof createdAt === 'string' ? createdAt : new Date().toISOString()
        };
      }
      
      return null;
    } catch (error) {
      console.error('❌ Error getting PDF stats:', error);
      return null;
    }
  }
}

// Export singleton instance
export const pineconeService = new PineconeService();
