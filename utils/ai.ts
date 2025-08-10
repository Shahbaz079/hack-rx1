// Validate OpenRouter API key
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  throw new Error('OPENROUTER_API_KEY environment variable is not set');
}
{/**
async function askOpenRouter(question: string, contextChunks: string[]): Promise<string> {
  try {
    const context = contextChunks.join('\n\n');
    
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-3.5-turbo", // Faster model for speed
        messages: [
          {
            role: "system",
            content: `You are a helpful assistant that answers questions based on provided document context. 

IMPORTANT GUIDELINES:
- Provide CONCISE answers (2-4 sentences maximum)
- Be ACCURATE and FACTUAL based only on the provided context
- If the context doesn't contain the answer, say "The provided context does not contain information about this."
- Use clear, professional language
- Focus on the most relevant information only
- Do not make assumptions or add information not in the context

EXAMPLE FORMAT:
Q: "What is the grace period for premium payment under the National Parivar Mediclaim Plus Policy?"
A: "A grace period of thirty days is provided for premium payment after the due date to renew or continue the policy without losing continuity benefits."

Q: "What is the waiting period for pre-existing diseases (PED) to be covered?"
A: "There is a waiting period of thirty-six (36) months of continuous coverage from the first policy inception for pre-existing diseases and their direct complications to be covered."

Q: "Does this policy cover maternity expenses, and what are the conditions?"
A: "Yes, the policy covers maternity expenses, including childbirth and lawful medical termination of pregnancy. To be eligible, the female insured person must have been continuously covered for at least 24 months. The benefit is limited to two deliveries or terminations during the policy period."

Q: "What is the waiting period for cataract surgery?"
A: "The policy has a specific waiting period of two (2) years for cataract surgery."

Q: "Are the medical expenses for an organ donor covered under this policy?"
A: "Yes, the policy indemnifies the medical expenses for the organ donor's hospitalization for the purpose of harvesting the organ, provided the organ is for an insured person and the donation complies with the Transplantation of Human Organs Act, 1994."`
          },
          {
            role: "user",
            content: `Context from document:
${context}

Question: ${question}

Please provide a concise answer based only on the context above, following the example format shown.`
          }
        ],
        max_tokens: 150, // Limit response length
        temperature: 0.1, // Lower temperature for more consistent answers
      }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(
        `OpenRouter API error: ${res.status} ${res.statusText}${errorData.error ? ` - ${errorData.error}` : ''}`
      );
    }

    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content?.trim();
    
    if (!answer) {
      throw new Error('No answer received from OpenRouter API');
    }

    return answer;
  } catch (error) {
    console.error('❌ OpenRouter API Error:', error);
    throw error;
  }
}
 */}
// Validate OpenAI API key
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY environment variable is not set');
}

async function askOpenAI(question: string, contextChunks: string[]): Promise<string> {
  try {
    const context = contextChunks.join('\n\n');
    
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo", // Faster model for speed
        messages: [
          {
            role: "system",
            content: `You are a helpful assistant that answers questions based on provided document context. 

IMPORTANT GUIDELINES:
- Provide CONCISE answers (2-4 sentences maximum)
- Be ACCURATE and FACTUAL based on the provided context when available
- If the context doesn't contain the answer, provide a CONCISE answer based on your general knowledge
- Use clear, professional language
- Focus on the most relevant information only
- Do not make assumptions beyond reasonable general knowledge

CONTEXT HANDLING RULES:
- PRIORITY: Use provided document context when available and relevant
- FALLBACK: If context is missing or irrelevant, provide a concise answer from your knowledge
- say "The provided context does not contain information about this" only if you are not able to find answer on your knowledge
- ALWAYS provide a helpful response, even if brief

EXAMPLE FORMAT:
Q: "What is the grace period for premium payment under the National Parivar Mediclaim Plus Policy?"
A: "A grace period of thirty days is provided for premium payment after the due date to renew or continue the policy without losing continuity benefits."

Q: "What is the waiting period for pre-existing diseases (PED) to be covered?"
A: "There is a waiting period of thirty-six (36) months of continuous coverage from the first policy inception for pre-existing diseases and their direct complications to be covered."

Q: "What are Newton's three laws of motion?" (if not in context)
A: "Newton's three laws of motion are: 1) An object remains at rest or in uniform motion unless acted upon by a force, 2) Force equals mass times acceleration (F=ma), and 3) For every action there is an equal and opposite reaction."

Q: "How does photosynthesis work?" (if not in context)
A: "Photosynthesis is the process where plants convert sunlight, carbon dioxide, and water into glucose and oxygen using chlorophyll in their leaves."

Q: "What is quantum computing?" (if not in context)
A: "Quantum computing uses quantum mechanical phenomena like superposition and entanglement to process information, potentially solving complex problems faster than classical computers."`
          },
          {
            role: "user",
            content: `Context from document:
${context}

Question: ${question}

Please provide a concise answer based only on the context above, following the example format shown.`
          }
        ],
        max_tokens: 150, // Limit response length
        temperature: 0.1, // Lower temperature for more consistent answers
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

export { askOpenAI as askOpenRouter };
