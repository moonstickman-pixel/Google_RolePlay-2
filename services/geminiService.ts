
// This file is deprecated. Please use services/apiService.ts for all API interactions.
// Re-exporting from apiService for partial backward compatibility during refactor if needed.

import { generateResponse, summarizeChat as apiSummarize } from './apiService';
import { Character, AppSettings, Message } from '../types';

export const generateCharacterResponse = async (
  history: Message[],
  character: Character,
  userSettings: AppSettings,
): Promise<string> => {
  // Consume the async generator to return a full string as expected by the legacy interface
  // Passing undefined for the new summary parameter as this is a legacy wrapper
  const stream = generateResponse(history, character, userSettings, undefined);
  let fullResponse = "";
  for await (const chunk of stream) {
    fullResponse += chunk;
  }
  return fullResponse;
};

export const summarizeChat = async (messages: Message[]): Promise<string> => {
    // Note: This legacy wrapper assumes a default context or might fail if settings aren't passed.
    // Ideally, update the caller to use apiService directly with settings.
    // For now, we return empty to force update in App.tsx
    console.warn("Legacy summarizeChat called without settings.");
    return ""; 
};