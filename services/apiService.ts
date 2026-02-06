

import { GoogleGenAI } from "@google/genai";
import { Message, Character, AppSettings, DEFAULT_SYSTEM_PROMPT } from '../types';

// Helper to replace placeholders globally
export const replacePlaceholders = (text: any, character: Character, userName: string): string => {
    if (text === null || text === undefined) return "";
    const str = String(text);
    if (!str) return "";
    return str
        .replace(/\{\{char\}\}/gi, character.name || 'Character')
        .replace(/\{\{user\}\}/gi, userName || 'User');
};

// Helper to clean up history for context window
const trimHistory = (history: Message[], systemPrompt: string, maxContext: number, maxOutput: number): Message[] => {
    // Simple approximation: 1 token ~= 4 chars.
    // Reserve space for system prompt + max output + safety buffer
    const reservedChars = (systemPrompt.length) + (maxOutput * 4) + 1000;
    const availableChars = (maxContext * 4) - reservedChars;
    
    // Safety: If history is empty, return empty
    if (history.length === 0) return [];
    
    // If explicit context is exhausted by reserved chars, force return at least the last message
    if (availableChars <= 0) return [history[history.length - 1]];

    let currentChars = 0;
    const trimmed: Message[] = [];
    
    // Iterate backwards
    for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i];
        const len = (msg.content || "").length;
        if (currentChars + len > availableChars) break;
        trimmed.unshift(msg);
        currentChars += len;
    }

    // Safety fallback: If trimmed is empty (e.g., the very last message was bigger than the entire context window),
    // we must return that last message anyway so the model has *something* to work with.
    if (trimmed.length === 0 && history.length > 0) {
        return [history[history.length - 1]];
    }

    return trimmed;
};

const getLorebookContext = (history: Message[], character: Character, settings: AppSettings): string => {
    const activeLorebooks = [
        ...(settings.globalLorebooks || []),
        ...(character.lorebooks || [])
    ].filter(lb => lb.enabled);

    if (activeLorebooks.length === 0) return "";

    // Gather last 7 messages to scan for keywords
    const recentText = history.slice(-7).map(m => m.content).join("\n").toLowerCase();
    
    const triggeredEntries: string[] = [];
    const usedEntryIds = new Set<string>();

    activeLorebooks.forEach(lb => {
        lb.entries.forEach(entry => {
            if (!entry.enabled || usedEntryIds.has(entry.id)) return;
            
            const keys = Array.isArray(entry.keys) ? entry.keys : (entry.keys as string || "").split(',');

            const isTriggered = keys.some(key => {
                const k = key.trim().toLowerCase();
                if (!k) return false;
                return recentText.includes(k);
            });

            if (isTriggered) {
                const processedContent = replacePlaceholders(entry.content, character, settings.userName || 'User');
                triggeredEntries.push(processedContent);
                usedEntryIds.add(entry.id);
            }
        });
    });

    return triggeredEntries.join('\n\n');
};

const buildSystemContext = (character: Character, settings: AppSettings, lorebookContext: string, summary: string): string => {
    const userName = settings.userName || 'User';
    const process = (text: any) => replacePlaceholders(text, character, userName);

    let system = settings.systemPromptOverride || DEFAULT_SYSTEM_PROMPT;
    system = process(system);
    
    const parts = [
        system,
        `[Character Name: ${character.name}]`,
        `[Description: ${process(character.description)}]`,
        `[Personality: ${process(character.personality)}]`,
        `[Appearance: ${process(character.appearance)}]`,
        character.scenario ? `[Scenario: ${process(character.scenario)}]` : "",
        character.style ? `[Writing Style: ${process(character.style)}]` : "",
        character.chatExamples ? `[Dialogue Examples:\n${process(character.chatExamples)}]` : "",
        character.jailbreak ? `[System/Jailbreak: ${process(character.jailbreak)}]` : process(settings.jailbreakOverride),
        lorebookContext ? `### World Info / Lorebook Database (Active Context):\nThe following information regarding the world, items, or characters is active:\n${lorebookContext}` : "",
        summary ? `[PREVIOUS CONVERSATION SUMMARY]:\nThe following is the memory of the events so far. You MUST use this context to maintain continuity:\n"${process(summary)}"` : ""
    ];

    return parts.filter(p => p).join('\n\n');
};

const getCommonHeaders = (settings: AppSettings) => {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (settings.apiKey && settings.apiProvider !== 'puter' && settings.apiProvider !== 'horde') {
        headers['Authorization'] = `Bearer ${settings.apiKey}`;
    }
    if (settings.apiProvider === 'openrouter') {
        headers['HTTP-Referer'] = 'https://erebos.app';
        headers['X-Title'] = 'Erebos AI';
    }
    if (settings.apiProvider === 'horde') {
        headers['apikey'] = settings.apiKey || '0000000000';
    }
    return headers;
};

async function* generateOpenAICompatibleStream(
    history: Message[], 
    character: Character, 
    settings: AppSettings,
    summary: string = "",
    signal?: AbortSignal
): AsyncGenerator<string> {
    let endpoint = settings.customEndpoint || 'https://api.openai.com/v1';
    if (settings.apiProvider === 'openrouter') {
        endpoint = 'https://openrouter.ai/api/v1';
    } else if (settings.apiProvider === 'deepseek') {
        endpoint = 'https://api.deepseek.com';
    } else if (settings.apiProvider === 'routeway') {
        endpoint = 'https://api.routeway.ai/v1';
    } else if (settings.apiProvider === 'vercel') {
        endpoint = settings.customEndpoint || ''; 
    }
    
    const lorebookContext = getLorebookContext(history, character, settings);
    const systemContent = buildSystemContext(character, settings, lorebookContext, summary);
    
    const SAFE_CONTEXT_LIMIT = 8192; 
    const maxOutput = Number(settings.maxOutputTokens) || 1024;
    const trimmedHistory = trimHistory(history, systemContent, SAFE_CONTEXT_LIMIT, maxOutput);

    const messages = [
        { role: 'system', content: systemContent },
        ...trimmedHistory.map(m => ({
            role: m.role === 'model' ? 'assistant' : m.role,
            content: replacePlaceholders(m.content || ".", character, settings.userName || 'User')
        }))
    ];

    let url = endpoint;
    const isVercel = settings.apiProvider === 'vercel';
    
    if (!isVercel && !url.endsWith('/chat/completions') && !url.includes('/chat/completions')) {
        url = url.endsWith('/') ? `${url}chat/completions` : `${url}/chat/completions`;
    } else if (isVercel) {
        if (!url.includes('/api/') && !url.includes('/v1/')) {
             url = url.endsWith('/') ? `${url}api/chat` : `${url}/api/chat`;
        }
    }

    const headers = getCommonHeaders(settings);

    const body: any = {
        model: settings.modelName,
        messages: messages,
        temperature: Number(settings.temperature),
        max_tokens: Number(settings.maxOutputTokens),
        stream: settings.streamResponse,
        top_p: Number(settings.topP),
    };

    if (['custom', 'openrouter', 'routeway', 'puter', 'horde', 'textgen'].includes(settings.apiProvider)) {
        body.repetition_penalty = Number(settings.repetitionPenalty);
        body.top_k = Math.floor(Number(settings.topK));
        body.top_a = Number(settings.topA);
    }
    
    if (settings.apiProvider === 'openai') {
        const rep = Number(settings.repetitionPenalty);
        if (rep > 1.0) {
            body.frequency_penalty = Math.min(2.0, (rep - 1.0) * 2.0);
        }
    }

    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            mode: 'cors',
            credentials: 'omit',
            signal
        });
    } catch (error: any) {
        if (error.name === 'AbortError') throw error;
        throw new Error(`Network Error: ${error.message}`);
    }

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`API Error ${response.status}: ${err}`);
    }

    if (!settings.streamResponse) {
        const data = await response.json();
        if (typeof data === 'string') {
             yield data;
             return;
        }
        yield data.choices?.[0]?.message?.content || "";
        return;
    }

    if (!response.body) throw new Error("No response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (signal?.aborted) throw new Error("Aborted");
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; 

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                
                const vercelMatch = trimmed.match(/^0:"(.*)"$/);
                if (vercelMatch) {
                    try {
                        const content = JSON.parse(`"${vercelMatch[1]}"`); 
                        if (content) yield content;
                    } catch(e) { yield vercelMatch[1]; }
                    continue;
                }

                if (trimmed.startsWith('data: ')) {
                    const dataStr = trimmed.slice(6);
                    if (dataStr === '[DONE]') return;
                    try {
                        const json = JSON.parse(dataStr);
                        const content = json.choices?.[0]?.delta?.content;
                        if (content) yield content;
                        const reasoning = (json.choices?.[0]?.delta as any)?.reasoning_content;
                        if (reasoning) yield `<think>${reasoning}</think>`;
                    } catch (e) {}
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

async function* generateGeminiStream(
    history: Message[], 
    character: Character, 
    settings: AppSettings,
    summary: string = "",
    signal?: AbortSignal
): AsyncGenerator<string> {
    if (!settings.apiKey) throw new Error("API Key required for Gemini");

    const ai = new GoogleGenAI({ apiKey: settings.apiKey });
    
    const lorebookContext = getLorebookContext(history, character, settings);
    const systemContent = buildSystemContext(character, settings, lorebookContext, summary);

    const contents = history.map(m => ({
        role: m.role === 'model' ? 'model' : 'user',
        parts: [{ text: replacePlaceholders(m.content || " ", character, settings.userName || 'User') }] 
    }));

    const modelParams: any = {
        model: settings.modelName,
        contents: contents,
        config: {
            systemInstruction: systemContent,
            temperature: Number(settings.temperature),
            topP: Number(settings.topP),
            topK: Math.floor(Number(settings.topK)), 
            maxOutputTokens: Math.floor(Number(settings.maxOutputTokens)), 
        }
    };
    
    if (settings.enableGoogleSearch) {
        modelParams.config.tools = [{ googleSearch: {} }];
    }

    try {
        const result = await ai.models.generateContentStream(modelParams);
        
        for await (const chunk of result) {
            if (signal?.aborted) throw new Error("Aborted");
            const text = chunk.text;
            if (text) yield text;
        }
    } catch (e: any) {
         if (e.message?.includes("429")) throw new Error("QUOTA_EXCEEDED");
         throw e;
    }
}

export async function* generateResponse(
    history: Message[], 
    character: Character, 
    settings: AppSettings, 
    summary: string = "",
    signal?: AbortSignal
): AsyncGenerator<string> {
    if (settings.apiProvider === 'gemini') {
        yield* generateGeminiStream(history, character, settings, summary, signal);
    } else {
        yield* generateOpenAICompatibleStream(history, character, settings, summary, signal);
    }
}

export async function* generateCharacterStream(
    prompt: string, 
    length: 'short' | 'medium' | 'long',
    settings: AppSettings,
    files: Array<{mimeType: string, data: string}> = [],
    existingContent: string = "",
    includeSequence: boolean = false,
    signal?: AbortSignal,
    detailedSequence: boolean = false
): AsyncGenerator<string> {
    let lengthConstraint = "";
    switch(length) {
        case 'short': lengthConstraint = "Keep the profile concise. Aim for efficient descriptions. Approx 200 words total."; break; 
        case 'medium': lengthConstraint = "Standard roleplay character profile. Balanced detail. Approx 400 words total."; break;
        case 'long': lengthConstraint = "Extensive and detailed. Deep personality analysis. Approx 800+ words total."; break;
    }

    const systemPrompt = `You are an expert character creator. Generate a JSON output for a character based on the user's prompt. 
    Format: JSON matching { name, tagline, description, personality, appearance, firstMessage, chatExamples, scenario, jailbreak, style, eventSequence? }. 
    
    LENGTH INSTRUCTION: ${lengthConstraint}
    Ensure the JSON is valid and content fields match the requested length.`;
    
    const tempChar: Character = { 
        id: 'gen', name: 'Generator', tagline: '', description: '', appearance: '', 
        personality: '', firstMessage: '', chatExamples: '', avatarUrl: '', 
        scenario: '', jailbreak: '', lorebooks: [], style: '', eventSequence: '' 
    };
    
    if (settings.apiProvider === 'gemini') {
         const ai = new GoogleGenAI({ apiKey: settings.apiKey });
         const contents: any[] = [{
             role: 'user',
             parts: [
                 ...files.map(f => ({ inlineData: { mimeType: f.mimeType, data: f.data } })),
                 { text: `${systemPrompt}\n\nPrompt: ${prompt}\n\nExisting JSON (if any): ${existingContent}` }
             ]
         }];

         const resp = await ai.models.generateContentStream({
             model: settings.modelName,
             contents: contents,
             config: { responseMimeType: 'application/json' }
         });

         for await (const chunk of resp) {
             if (signal?.aborted) break;
             if (chunk.text) yield chunk.text;
         }
         return;
    }

    const textPrompt = `Prompt: ${prompt}\n\nExisting: ${existingContent}`;
    const stream = generateOpenAICompatibleStream(
        [{ id: '1', role: 'user', content: textPrompt, timestamp: Date.now() }], 
        tempChar, 
        { ...settings, systemPromptOverride: systemPrompt }, 
        "", 
        signal
    );
    
    for await (const chunk of stream) {
        yield chunk;
    }
}

export const summarizeChat = async (messages: Message[], settings: AppSettings, currentSummary?: string, length: 'short'|'medium'|'detailed' = 'medium'): Promise<string> => {
    let lengthConstraint = "";
    let styleGuide = "";
    let tokenOverride = 1024;

    const customPrompt = settings.summaryPromptOverride?.trim();

    // If custom prompt exists, use it instead of standard style/length guides
    if (customPrompt) {
        styleGuide = `CUSTOM USER INSTRUCTION: ${customPrompt}`;
        lengthConstraint = "Follow the custom user instruction above for length and detail.";
        tokenOverride = 8192; // Give max buffer for custom requests
    } else {
        // Standard Logic
        switch(length) {
            case 'short': 
                lengthConstraint = "Length: Concise (~100 words)."; 
                styleGuide = "Focus strictly on the current status and immediate context. Discard historical fluff.";
                tokenOverride = 512;
                break;
            case 'medium': 
                lengthConstraint = "Length: Moderate (~300 words)."; 
                styleGuide = "Capture the main plot points, key decisions, and emotional shifts. Provide a balanced overview.";
                tokenOverride = 1024;
                break;
            case 'detailed': 
                lengthConstraint = "Length: Comprehensive. Include all available details from the log."; 
                styleGuide = "You are a meticulous archivist. Your goal is preservation of detail. Retell the narrative including specific dialogue quotes, setting changes, and character internal states found in the text. CRITICAL: Do not invent new events to make it longer. Only summarize what is there, but do so with maximum granularity."; 
                tokenOverride = 8192; 
                break;
        }
    }

    const text = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
    
    let prompt = "";

    // Add anti-hallucination header
    const safetyHeader = `IMPORTANT SECURITY PROTOCOL:
    1. Do NOT hallucinate events.
    2. Do NOT invent characters or locations not present in the log.
    3. If the provided log is short, the summary should be short. Do not fluff it up.
    4. Rely EXCLUSIVELY on the provided log.`;
    
    if (currentSummary) {
        // Incremental Mode
        prompt = `Update the existing summary with new events from the logs below.
        
        [EXISTING SUMMARY]:
        ${currentSummary}
        
        [NEW INTERACTION LOG]:
        ${text}
        
        INSTRUCTIONS:
        1. Merge the new events naturally into the narrative.
        2. ${lengthConstraint}
        3. ${styleGuide}
        4. ${safetyHeader}
        
        Output only the updated summary text.`;
    } else {
        // Full Summary Mode
        prompt = `Generate a comprehensive narrative record of the following conversation log.
        
        [FULL CONVERSATION LOG]:
        ${text}
        
        INSTRUCTIONS:
        1. Read the entire log from start to finish.
        2. ${styleGuide}
        3. ${lengthConstraint}
        4. ${safetyHeader}
        
        Output only the summary text.`;
    }
    
    const tempChar: Character = { id: 'sum', name: 'System', tagline:'', description:'', appearance:'', personality:'', firstMessage:'', chatExamples:'', avatarUrl:'', scenario:'', jailbreak:'', lorebooks:[] };
    
    const tempSettings = { 
        ...settings, 
        maxOutputTokens: tokenOverride,
        systemPromptOverride: "You are an objective analytical engine designed to summarize text data with high fidelity. You prioritize accuracy over creativity." 
    };
    
    let summary = "";
    const stream = generateResponse([{ id: '1', role: 'user', content: prompt, timestamp: Date.now() }], tempChar, tempSettings);
    for await (const chunk of stream) {
        summary += chunk;
    }
    return summary;
};

export const googleTranslateFree = async (text: string, target: string): Promise<string> => {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
        const res = await fetch(url);
        const data = await res.json();
        return data[0].map((x: any) => x[0]).join('');
    } catch (e) {
        console.error("Translation failed", e);
        throw new Error("Translation failed");
    }
};

export const testConnection = async (settings: AppSettings): Promise<boolean> => {
    try {
        const tempChar: Character = { id: 'test', name: 'Test', tagline:'', description:'', appearance:'', personality:'', firstMessage:'', chatExamples:'', avatarUrl:'', scenario:'', jailbreak:'', lorebooks:[] };
        const stream = generateResponse([{id:'1', role:'user', content:'hi', timestamp:Date.now()}], tempChar, { ...settings, maxOutputTokens: 10 });
        for await (const chunk of stream) {
            if (chunk) return true;
        }
        return true;
    } catch (e) {
        throw e;
    }
};

export const getPuterModels = async (): Promise<string[]> => {
    return ['gryphe/mythomax-l2-13b'];
};

export const extractJSON = (text: string): any => {
    try {
        return JSON.parse(text);
    } catch (e) {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            try { return JSON.parse(match[0]); } catch (e2) {}
        }
    }
    return null;
};