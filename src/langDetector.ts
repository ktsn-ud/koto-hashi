import { GoogleGenAI, ThinkingLevel } from '@google/genai';
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

const DetectionFailureReasonSchema = z.enum([
  'NOT_A_LANGUAGE_SPECIFICATION',
  'UNRECOGNIZABLE_LANGUAGE',
]);

const DetectionResultSchema = z.discriminatedUnion('failure', [
  z
    .object({
      failure: z
        .literal(false)
        .describe('Indicates that the language was successfully detected.'),
      languageCode: z
        .string()
        .describe('The detected language code in IETF BCP 47 format.'),
    })
    .strict(),
  z
    .object({
      failure: z
        .literal(true)
        .describe('Indicates that the language could not be detected.'),
      failureReason: DetectionFailureReasonSchema.describe(
        'The reason why language detection failed.'
      ),
    })
    .strict(),
]);

type DetectionResult = z.infer<typeof DetectionResultSchema>;

function loadSystemPrompt(): string {
  const candidates = [
    path.resolve(process.cwd(), 'dist', 'prompt', 'langDetector.md'),
    path.resolve(process.cwd(), 'src', 'prompt', 'langDetector.md'),
    path.resolve(process.cwd(), 'prompt', 'langDetector.md'),
    path.join(__dirname, 'prompt', 'langDetector.md'),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  }

  throw new Error(
    `langDetector.md not found. Searched: ${candidates.join(', ')}`
  );
}

const systemPrompt = loadSystemPrompt();

export async function detectTargetLanguage(
  text: string
): Promise<DetectionResult> {
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: text,
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: z.toJSONSchema(DetectionResultSchema),
      temperature: 0.1,
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.MINIMAL,
      },
      systemInstruction: systemPrompt,
    },
  });
  if (!response.text) {
    throw new Error('No response text from Google GenAI');
  }
  const resultObj = JSON.parse(response.text);
  const result = DetectionResultSchema.parse(resultObj);
  return result;
}
