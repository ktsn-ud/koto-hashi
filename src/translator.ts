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
  const candidates = [
    path.resolve(process.cwd(), 'dist', 'prompt', 'system.md'),
    path.resolve(process.cwd(), 'src', 'prompt', 'system.md'),
    path.resolve(process.cwd(), 'prompt', 'system.md'),
    path.join(__dirname, 'prompt', 'system.md'),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  }

  throw new Error(`system.md not found. Searched: ${candidates.join(', ')}`);
}

const systemPrompt = loadSystemPrompt();

export async function translateText(
  text: string,
  targetLanguageCode: string
): Promise<TranslationResult> {
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: text,
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: z.toJSONSchema(translationResultSchema),
      temperature: 0.1,
      systemInstruction: systemPrompt.replaceAll('{lang}', targetLanguageCode),
    },
  });
  if (!response.text) {
    throw new Error('No response text from Google GenAI');
  }
  const resultObj = JSON.parse(response.text);
  const result = translationResultSchema.parse(resultObj);
  return result;
}
