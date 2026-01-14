import { GoogleGenerativeAI } from "@google/generative-ai";
import { Review, ReviewInsight } from "../../../shared/types";

const FORMAT_INSTRUCTIONS = `Return an array of JSON objects inside a code block. Each object should include:
 - "reviewId": the ID of the review
 - "sentiment": "positive", "neutral", or "negative"
 - "summary": a short highlight sentence (max 30 words)
 - "highlights": an array with up to 3 short highlight phrases.
Example format: [{"reviewId": "...", "sentiment": "positive", "summary": "...", "highlights": ["..."]}]
`;

function stubInsight(review: Review): ReviewInsight {
  const sentiment = review.rating >= 4 ? "positive" : review.rating === 3 ? "neutral" : "negative";
  return {
    reviewId: review.id,
    sentiment,
    summary: review.text.slice(0, 120) || "Review available from Google",
    highlights: [
      sentiment === "positive" ? "positive tone" : "constructive feedback",
      review.rating ? `rating ${review.rating}/5` : "rating hidden"
    ]
  };
}

export async function summarizeReviews(reviews: Review[], apiKey?: string): Promise<ReviewInsight[]> {
  if (!reviews.length) {
    return [];
  }

  const effectiveKey = apiKey || process.env.GOOGLE_API_KEY;
  if (!effectiveKey) {
    console.warn("No GOOGLE_API_KEY for Gemini, using stub insights.");
    return reviews.map(stubInsight);
  }

  try {
    const genAI = new GoogleGenerativeAI(effectiveKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash-latest",
      generationConfig: { responseMimeType: "application/json" }
    });

    const snippet = reviews
      .map((review) => `Review ID: ${review.id}\nRating: ${review.rating}\nText: ${review.text}`)
      .join("\n\n---\n\n");

    const prompt = `You are an assistant that tóm tắt Google Reviews.
Reviews:
${snippet}

${FORMAT_INSTRUCTIONS}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    let insightChunk;
    try {
      insightChunk = JSON.parse(text);
    } catch {
      // Sometimes it returns with backticks
      const cleanText = text.replace(/```json|```/g, "").trim();
      insightChunk = JSON.parse(cleanText);
    }

    if (Array.isArray(insightChunk)) {
      return insightChunk.map((item) => ({
        reviewId: String(item.reviewId),
        sentiment:
          item.sentiment === "negative" || item.sentiment === "positive" || item.sentiment === "neutral"
            ? item.sentiment
            : "neutral",
        summary: String(item.summary ?? ""),
        highlights: Array.isArray(item.highlights) ? item.highlights.map(String) : []
      }));
    }
  } catch (error) {
    console.error("Gemini summarization failed:", error);
  }

  return reviews.map(stubInsight);
}
