import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import 'dotenv/config';

if (!process.env.GOOGLE_API_KEY) {
  throw new Error('Google API key is not set in environment variables.');
}

const ai = new GoogleGenAI({
  apiKey: process.env.GOOGLE_API_KEY,
});

const translationResultSchema = z.object({
  translatedText: z
    .string()
    .describe('The text translated into the target language.'),
  reTranslatedText: z
    .string()
    .describe(
      'The translated text re-translated back into the original language to verify accuracy.'
    ),
});

type TranslationResult = z.infer<typeof translationResultSchema>;

export async function translateText(text: string): Promise<TranslationResult> {
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: text,
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: z.toJSONSchema(translationResultSchema),
      systemInstruction: '', // TODO: systemを書く
    },
  });
  const result = translationResultSchema.parse(response.text);
  return result;
}
