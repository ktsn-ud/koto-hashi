import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
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
  failure: z
    .boolean()
    .describe(
      'Indicates whether the translation could not be performed due to inability to identify the language of the input message.'
    ),
});

type TranslationResult = z.infer<typeof translationResultSchema>;

function loadSystemPrompt(): string {
  const filePath = path.join(__dirname, 'prompt', 'system.md');
  return fs.readFileSync(filePath, 'utf-8');
}

const langCode = process.env.TARGET_LANG_CODE || 'en-US';
const systemPrompt =
  `In the instructions below, replace \`{lang}\` with ${langCode}.` +
  loadSystemPrompt();

export async function translateText(text: string): Promise<TranslationResult> {
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: text,
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: z.toJSONSchema(translationResultSchema),
      temperature: 0.1,
      systemInstruction: systemPrompt,
    },
  });
  const result = translationResultSchema.parse(response.text);
  return result;
}
