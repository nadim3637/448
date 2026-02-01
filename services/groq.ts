
import { ClassLevel, Subject, Chapter, LessonContent, Language, Board, Stream, ContentType, MCQItem, SystemSettings } from "../types";
import { STATIC_SYLLABUS } from "../constants";
import { getChapterData, getCustomSyllabus, incrementApiUsage, getApiUsage, rtdb } from "../firebase";
import { ref, get } from "firebase/database";

// GROQ API CALL HELPER
export const callGroqApi = async (messages: any[], model: string = "llama3-8b-8192") => {
    // Validate model (Gemini models are not supported on Groq)
    let safeModel = model;
    if (!safeModel || safeModel.includes("gemini")) {
        console.warn(`Invalid Groq model requested: ${safeModel}. Falling back to llama3-8b-8192.`);
        safeModel = "llama-3.1-8b-instant";
    }

    // Proxy call to server
    const response = await fetch("/api/groq", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: safeModel,
            messages: messages
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Groq API Error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
};

// NEW: Tool Support
export const callGroqApiWithTools = async (messages: any[], tools: any[], model: string = "llama-3.3-70b-versatile") => {
    const response = await fetch("/api/groq", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model,
            messages,
            tools,
            tool_choice: "auto"
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Groq API Error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.choices[0].message; // Returns full message object { content, tool_calls }
};

export const executeWithRotation = async <T>(
    operation: () => Promise<T>,
    usageType: 'PILOT' | 'STUDENT' = 'STUDENT'
): Promise<T> => {
    
    // QUOTA CHECK
    try {
        const usage = await getApiUsage();
        if (usage) {
            const settingsStr = localStorage.getItem('nst_system_settings');
            const settings = settingsStr ? JSON.parse(settingsStr) : {};
            const pilotRatio = settings.aiPilotRatio || 80;
            const dailyLimit = settings.aiDailyLimitPerKey || 1500;
            
            // Assume capacity of 5000 since keys are managed on server
            const totalCapacity = Math.max(10 * dailyLimit, 5000);

            const pilotLimit = Math.floor(totalCapacity * (pilotRatio / 100));
            const studentLimit = totalCapacity - pilotLimit;

            if (usageType === 'PILOT') {
                if ((usage.pilotCount || 0) >= pilotLimit) throw new Error(`AI Pilot Quota Exceeded (${usage.pilotCount}/${pilotLimit})`);
            } else {
                 if ((usage.studentCount || 0) >= studentLimit) throw new Error(`Student AI Quota Exceeded. Try again later.`);
            }
        }
    } catch(e: any) {
        if (e.message && e.message.includes("Quota Exceeded")) throw e;
    }

    // RETRY LOGIC
    const MAX_RETRIES = 2;
    for (let i = 0; i <= MAX_RETRIES; i++) {
        try {
            const result = await operation();

            // TRACK USAGE (Global, using index 0)
            incrementApiUsage(0, usageType);

            return result;
        } catch (error: any) {
            const msg = error?.message || "";
            
            console.warn(`Attempt ${i + 1} failed: ${msg}`);
            
            if (i === MAX_RETRIES) {
                // If 429 or server error, the server might be busy or keys exhausted
                if (msg.includes("429") || msg.includes("500") || msg.includes("503")) {
                     throw new Error("AI services are currently busy. Please try again later.");
                }
                throw error;
            }
            // Wait a bit before retry
            await new Promise(res => setTimeout(res, 1000 * (i + 1)));
        }
    }
    
    throw new Error("Unexpected error in AI service.");
};

// --- PARALLEL BULK EXECUTION ENGINE ---
const executeBulkParallel = async <T>(
    tasks: (() => Promise<T>)[],
    concurrency: number = 20, // Default to 20 parallel requests
    usageType: 'PILOT' | 'STUDENT' = 'STUDENT'
): Promise<T[]> => {

    console.log(`🚀 Starting Bulk Engine (Groq): ${tasks.length} tasks (Parallelism: ${concurrency})`);

    const results: T[] = new Array(tasks.length);
    let taskIndex = 0;
    
    // Worker function: Grabs next task
    const worker = async (workerId: number) => {
        while (taskIndex < tasks.length) {
            const currentTaskIndex = taskIndex++; // Atomic grab
            if (currentTaskIndex >= tasks.length) break;

            const task = tasks[currentTaskIndex];
            
            try {
                // We use executeWithRotation for individual task retry/usage tracking
                // But wait, executeWithRotation does usage tracking.
                // If we wrap task in executeWithRotation, it works.
                // Or we can just call task() if task already includes tracking?
                // The task definition below (in fetchLessonContent) calls callGroqApi directly usually.
                // So we should manually handle usage or just run task.
                
                // Let's assume task() is just the API call wrapper
                const result = await task();
                results[currentTaskIndex] = result;

                // TRACK USAGE
                incrementApiUsage(0, usageType);

            } catch (error) {
                console.error(`Task ${currentTaskIndex} failed:`, error);
            }
        }
    };

    const activeWorkers = Math.min(concurrency, tasks.length); 
    const workers = Array.from({ length: activeWorkers }, (_, i) => worker(i));
    
    await Promise.all(workers);
    return results.filter(r => r !== undefined && r !== null);
};

const chapterCache: Record<string, Chapter[]> = {};
const cleanJson = (text: string) => {
    return text.replace(/```json/g, '').replace(/```/g, '').trim();
};

// NEW TRANSLATION HELPER
export const translateToHindi = async (content: string, isJson: boolean = false, usageType: 'PILOT' | 'STUDENT' = 'STUDENT'): Promise<string> => {
    const prompt = `
    You are an expert translator for Bihar Board students.
    Translate the following ${isJson ? 'JSON Data' : 'Educational Content'} into Hindi (Devanagari).
    
    Style Guide:
    - Use "Hinglish" for technical terms (e.g., "Force" -> "Force (बल)").
    - Keep tone simple and student-friendly.
    - ${isJson ? 'Maintain strict JSON structure. Only translate values (question, options, explanation, etc). Do NOT translate keys.' : 'Keep Markdown formatting intact.'}

    CONTENT:
    ${content}
    `;

    return await executeWithRotation(async () => {
        return await callGroqApi([{ role: "user", content: prompt }]);
    }, usageType);
};

// --- UPDATED CONTENT LOOKUP (ASYNC) ---
const getAdminContent = async (
    board: Board, 
    classLevel: ClassLevel, 
    stream: Stream | null, 
    subject: Subject, 
    chapterId: string,
    type: ContentType,
    syllabusMode: 'SCHOOL' | 'COMPETITION' = 'SCHOOL'
): Promise<LessonContent | null> => {
    // STRICT KEY MATCHING WITH ADMIN
    const streamKey = (classLevel === '11' || classLevel === '12') && stream ? `-${stream}` : '';
    // Key format used in AdminDashboard to save content
    const key = `nst_content_${board}_${classLevel}${streamKey}_${subject.name}_${chapterId}`;
    
    try {
        // FETCH FROM FIREBASE FIRST
        let parsed = await getChapterData(key);
        
        if (!parsed) {
            // Fallback to LocalStorage (for Admin's offline view)
            const stored = localStorage.getItem(key);
            if(stored) parsed = JSON.parse(stored);
        }

        if (parsed) {
            // ... (Logic copied from gemini.ts mostly unchanged as it deals with data retrieval)
            
            // 1. FREE NOTES (PDF_FREE or NOTES_SIMPLE)
            if (type === 'PDF_FREE' || type === 'NOTES_SIMPLE') {
                const linkKey = syllabusMode === 'SCHOOL' ? 'schoolPdfLink' : 'competitionPdfLink';
                const htmlKey = syllabusMode === 'SCHOOL' ? 'schoolFreeNotesHtml' : 'competitionFreeNotesHtml';
                
                const link = parsed[linkKey] || parsed.freeLink;
                const html = parsed[htmlKey] || parsed.freeNotesHtml;

                if (link && type === 'PDF_FREE') {
                    return {
                        id: Date.now().toString(),
                        title: "Free Study Material",
                        subtitle: "Provided by Admin",
                        content: link,
                        type: 'PDF_FREE',
                        dateCreated: new Date().toISOString(),
                        subjectName: subject.name,
                        isComingSoon: false
                    };
                }
                
                if (html && (type === 'NOTES_SIMPLE' || type === 'PDF_FREE')) {
                     return {
                        id: Date.now().toString(),
                        title: "Study Notes",
                        subtitle: "Detailed Notes (Admin)",
                        content: html,
                        type: 'NOTES_SIMPLE',
                        dateCreated: new Date().toISOString(),
                        subjectName: subject.name,
                        isComingSoon: false
                    };
                }
            }

            // 2. PREMIUM NOTES (PDF_PREMIUM or NOTES_PREMIUM)
            if (type === 'PDF_PREMIUM' || type === 'NOTES_PREMIUM') {
                const linkKey = syllabusMode === 'SCHOOL' ? 'schoolPdfPremiumLink' : 'competitionPdfPremiumLink';
                const htmlKey = syllabusMode === 'SCHOOL' ? 'schoolPremiumNotesHtml' : 'competitionPremiumNotesHtml';
                
                const link = parsed[linkKey] || parsed.premiumLink;
                const html = parsed[htmlKey] || parsed.premiumNotesHtml;

                if (link && type === 'PDF_PREMIUM') {
                    return {
                        id: Date.now().toString(),
                        title: "Premium Notes",
                        subtitle: "High Quality Content",
                        content: link,
                        type: 'PDF_PREMIUM',
                        dateCreated: new Date().toISOString(),
                        subjectName: subject.name,
                        isComingSoon: false
                    };
                }

                if (html && (type === 'NOTES_PREMIUM' || type === 'PDF_PREMIUM')) {
                    const htmlKeyHI = syllabusMode === 'SCHOOL' ? 'schoolPremiumNotesHtml_HI' : 'competitionPremiumNotesHtml_HI';
                    const htmlHI = parsed[htmlKeyHI];

                    return {
                        id: Date.now().toString(),
                        title: "Premium Notes",
                        subtitle: "Exclusive Content (Admin)",
                        content: html,
                        type: 'NOTES_PREMIUM',
                        dateCreated: new Date().toISOString(),
                        subjectName: subject.name,
                        isComingSoon: false,
                        schoolPremiumNotesHtml_HI: syllabusMode === 'SCHOOL' ? htmlHI : undefined,
                        competitionPremiumNotesHtml_HI: syllabusMode === 'COMPETITION' ? htmlHI : undefined
                    };
                }
            }

            // Video Lecture
            if (type === 'VIDEO_LECTURE' && (parsed.premiumVideoLink || parsed.freeVideoLink)) {
                return {
                    id: Date.now().toString(),
                    title: "Video Lecture",
                    subtitle: "Watch Class",
                    content: parsed.premiumVideoLink || parsed.freeVideoLink,
                    type: 'PDF_VIEWER',
                    dateCreated: new Date().toISOString(),
                    subjectName: subject.name,
                    isComingSoon: false
                };
            }

            // Legacy Fallback
            if (type === 'PDF_VIEWER' && parsed.link) {
                return {
                    id: Date.now().toString(),
                    title: "Class Notes", 
                    subtitle: "Provided by Teacher",
                    content: parsed.link, 
                    type: 'PDF_VIEWER',
                    dateCreated: new Date().toISOString(),
                    subjectName: subject.name,
                    isComingSoon: false
                };
            }
            
            // Check for Manual MCQs
            if ((type === 'MCQ_SIMPLE' || type === 'MCQ_ANALYSIS') && parsed.manualMcqData) {
                return {
                    id: Date.now().toString(),
                    title: "Class Test (Admin)",
                    subtitle: `${parsed.manualMcqData.length} Questions`,
                    content: '',
                    type: type,
                    dateCreated: new Date().toISOString(),
                    subjectName: subject.name,
                    mcqData: parsed.manualMcqData,
                    manualMcqData_HI: parsed.manualMcqData_HI
                }
            }
        }
    } catch (e) {
        console.error("Content Lookup Error", e);
    }
    return null;
};

const getCustomChapters = (key: string): Chapter[] | null => {
    try {
        const data = localStorage.getItem(`nst_custom_chapters_${key}`);
        return data ? JSON.parse(data) : null;
    } catch(e) { return null; }
};

export const fetchChapters = async (
  board: Board,
  classLevel: ClassLevel, 
  stream: Stream | null,
  subject: Subject,
  language: Language
): Promise<Chapter[]> => {
  const streamKey = (classLevel === '11' || classLevel === '12') && stream ? `-${stream}` : '';
  const cacheKey = `${board}-${classLevel}${streamKey}-${subject.name}-${language}`;
  
  const firebaseChapters = await getCustomSyllabus(cacheKey);
  if (firebaseChapters && firebaseChapters.length > 0) {
      return firebaseChapters;
  }

  const customChapters = getCustomChapters(cacheKey);
  if (customChapters && customChapters.length > 0) return customChapters;

  if (chapterCache[cacheKey]) return chapterCache[cacheKey];

  const staticKey = `${board}-${classLevel}-${subject.name}`; 
  const staticList = STATIC_SYLLABUS[staticKey];
  if (staticList && staticList.length > 0) {
      const chapters: Chapter[] = staticList.map((title, idx) => ({
          id: `static-${idx + 1}`,
          title: title,
          description: `Chapter ${idx + 1}`
      }));
      chapterCache[cacheKey] = chapters;
      return chapters;
  }

  let modelName = "llama3-8b-8192";
  try {
      const s = localStorage.getItem('nst_system_settings');
      if (s) { const p = JSON.parse(s); if(p.aiModel) modelName = p.aiModel; }
  } catch(e){}

  const prompt = `List 15 standard chapters for ${classLevel === 'COMPETITION' ? 'Competitive Exam' : `Class ${classLevel}`} ${stream ? stream : ''} Subject: ${subject.name} (${board}). Return JSON array: [{"title": "...", "description": "..."}].`;
  try {
    const data = await executeWithRotation(async () => {
        const content = await callGroqApi([
             { role: "system", content: "You are a helpful educational assistant. You MUST return strictly valid JSON array. Do not wrap in markdown block." },
             { role: "user", content: prompt }
        ], modelName);
        return JSON.parse(cleanJson(content || '[]'));
    }, 'STUDENT');
    const chapters: Chapter[] = data.map((item: any, index: number) => ({
      id: `ch-${index + 1}`,
      title: item.title,
      description: item.description || ''
    }));
    chapterCache[cacheKey] = chapters;
    return chapters;
  } catch (error) {
    console.error("Chapter Fetch Error:", error);
    const data = [{id:'1', title: 'Chapter 1'}, {id:'2', title: 'Chapter 2'}];
    chapterCache[cacheKey] = data;
    return data;
  }
};

const processTemplate = (template: string, replacements: Record<string, string>) => {
    let result = template;
    for (const [key, value] of Object.entries(replacements)) {
        result = result.replace(new RegExp(`{${key}}`, 'gi'), value);
    }
    return result;
};

// --- MAIN CONTENT FUNCTION (UPDATED FOR GROQ) ---
export const fetchLessonContent = async (
  board: Board,
  classLevel: ClassLevel,
  stream: Stream | null,
  subject: Subject,
  chapter: Chapter,
  language: Language,
  type: ContentType,
  existingMCQCount: number = 0,
  isPremium: boolean = false,
  targetQuestions: number = 15,
  adminPromptOverride: string = "",
  allowAiGeneration: boolean = false,
  syllabusMode: 'SCHOOL' | 'COMPETITION' = 'SCHOOL',
  forceRegenerate: boolean = false,
  dualGeneration: boolean = false,
  usageType: 'PILOT' | 'STUDENT' = 'STUDENT'
): Promise<LessonContent> => {
  
  let customInstruction = "";
  let modelName = "llama3-8b-8192";
  let promptNotes = "";
  let promptNotesPremium = "";
  let promptMCQ = "";

  try {
      const stored = localStorage.getItem('nst_system_settings');
      if (stored) {
          const s = JSON.parse(stored) as SystemSettings;
          if (s.aiInstruction) customInstruction = `IMPORTANT INSTRUCTION: ${s.aiInstruction}`;
          if (s.aiModel) modelName = s.aiModel; // Allow override, but default is Llama3
          
          // ... (Prompt loading logic same as Gemini) ...
           if (syllabusMode === 'COMPETITION') {
              if (board === 'CBSE') {
                  if (s.aiPromptNotesCompetitionCBSE) promptNotes = s.aiPromptNotesCompetitionCBSE;
                  if (s.aiPromptNotesPremiumCompetitionCBSE) promptNotesPremium = s.aiPromptNotesPremiumCompetitionCBSE;
                  if (s.aiPromptMCQCompetitionCBSE) promptMCQ = s.aiPromptMCQCompetitionCBSE;
              }
              if (!promptNotes && s.aiPromptNotesCompetition) promptNotes = s.aiPromptNotesCompetition;
              if (!promptNotesPremium && s.aiPromptNotesPremiumCompetition) promptNotesPremium = s.aiPromptNotesPremiumCompetition;
              if (!promptMCQ && s.aiPromptMCQCompetition) promptMCQ = s.aiPromptMCQCompetition;

          } else {
              if (board === 'CBSE') {
                  if (s.aiPromptNotesCBSE) promptNotes = s.aiPromptNotesCBSE;
                  if (s.aiPromptNotesPremiumCBSE) promptNotesPremium = s.aiPromptNotesPremiumCBSE;
                  if (s.aiPromptMCQCBSE) promptMCQ = s.aiPromptMCQCBSE;
              }
              if (!promptNotes && s.aiPromptNotes) promptNotes = s.aiPromptNotes;
              if (!promptNotesPremium && s.aiPromptNotesPremium) promptNotesPremium = s.aiPromptNotesPremium;
              if (!promptMCQ && s.aiPromptMCQ) promptMCQ = s.aiPromptMCQ;
          }
      }
  } catch(e) {}

  if (!forceRegenerate) {
      const adminContent = await getAdminContent(board, classLevel, stream, subject, chapter.id, type, syllabusMode);
      if (adminContent) {
          return {
              ...adminContent,
              title: chapter.title, 
          };
      }
  }

  if (type === 'PDF_FREE' || type === 'PDF_PREMIUM' || type === 'PDF_VIEWER') {
      return {
          id: Date.now().toString(),
          title: chapter.title,
          subtitle: "Content Unavailable",
          content: "",
          type: type,
          dateCreated: new Date().toISOString(),
          subjectName: subject.name,
          isComingSoon: true 
      };
  }

  if (!allowAiGeneration) {
      return {
          id: Date.now().toString(),
          title: chapter.title,
          subtitle: "Content Unavailable",
          content: "",
          type: type,
          dateCreated: new Date().toISOString(),
          subjectName: subject.name,
          isComingSoon: true
      };
  }
  
  // MCQ Mode
  if (type === 'MCQ_ANALYSIS' || type === 'MCQ_SIMPLE') {
      const effectiveCount = Math.max(targetQuestions, 20); 

      let prompt = "";
      if (promptMCQ) {
           prompt = processTemplate(promptMCQ, {
               board: board || '',
               class: classLevel,
               stream: stream || '',
               subject: subject.name,
               chapter: chapter.title,
               language: language,
               count: effectiveCount.toString(),
               instruction: customInstruction
           });
           if (adminPromptOverride) prompt += `\nINSTRUCTION: ${adminPromptOverride}`;
      } else {
          const competitionConstraints = syllabusMode === 'COMPETITION' 
              ? "STYLE: Fact-Heavy, Direct. HIGHLIGHT PYQs (Previous Year Questions) if relevant." 
              : "STYLE: Strict NCERT Pattern.";

          prompt = `${customInstruction}
          ${adminPromptOverride ? `INSTRUCTION: ${adminPromptOverride}` : ''}
          Create ${effectiveCount} MCQs for ${board} Class ${classLevel} ${subject.name}, Chapter: "${chapter.title}". 
          Language: ${language}.
          ${competitionConstraints}
          
          STRICT FORMAT RULE:
          Return ONLY a valid JSON array. No markdown blocks, no extra text.
          [
            {
              "question": "Question text",
              "options": ["A", "B", "C", "D"],
              "correctAnswer": 0, // Index 0-3
              "explanation": "Logical explanation here",
              "mnemonic": "Short memory trick",
              "concept": "Core concept"
            }
          ]
          
          CRITICAL: You MUST return EXACTLY ${effectiveCount} questions. 
          Provide a very diverse set of questions covering every small detail of the chapter.`;
      }

      let data: any[] = [];

      // SYSTEM PROMPT FOR MCQ
      const mcqSystemPrompt = "You are an exam generator. You MUST return strict valid JSON array only. No introduction, no markdown formatting (like ```json), no ending notes. Just the raw JSON array.";

      if (effectiveCount > 30) {
          const batchSize = 20; 
          const batches = Math.ceil(effectiveCount / batchSize);
          const tasks: (() => Promise<any[]>)[] = [];

          for (let i = 0; i < batches; i++) {
              tasks.push(async () => {
                  const batchPrompt = processTemplate(prompt, {
                      board: board || '',
                      class: classLevel,
                      stream: stream || '',
                      subject: subject.name,
                      chapter: chapter.title,
                      language: language,
                      count: batchSize.toString(),
                      instruction: `${customInstruction}\nBATCH ${i+1}/${batches}. Ensure diversity. Avoid duplicates from previous batches if possible.`
                  });

                  const content = await callGroqApi([
                      { role: "system", content: mcqSystemPrompt },
                      { role: "user", content: batchPrompt }
                  ], modelName);
                  return JSON.parse(cleanJson(content || '[]'));
              });
          }

          const allResults = await executeBulkParallel(tasks, 50, usageType);
          data = allResults.flat();
          
          const seen = new Set();
          data = data.filter(q => {
              const duplicate = seen.has(q.question);
              seen.add(q.question);
              return !duplicate;
          });
          
          if (data.length > effectiveCount) data = data.slice(0, effectiveCount);

      } else {
          data = await executeWithRotation(async () => {
              const content = await callGroqApi([
                  { role: "system", content: mcqSystemPrompt },
                  { role: "user", content: prompt }
              ], modelName);
              return JSON.parse(cleanJson(content || '[]'));
          }, usageType);
      }

      let hindiMcqData = undefined;
      if (language === 'English') {
          try {
             const translatedJson = await translateToHindi(JSON.stringify(data), true, usageType);
             hindiMcqData = JSON.parse(translatedJson);
          } catch(e) { console.error("Translation Failed", e); }
      }

      return {
          id: Date.now().toString(),
          title: `MCQ Test: ${chapter.title}`,
          subtitle: `${data.length} Questions`,
          content: '',
          type: type,
          dateCreated: new Date().toISOString(),
          subjectName: subject.name,
          mcqData: data,
          manualMcqData_HI: hindiMcqData 
      };
  }

  // NOTES Mode
  const generateNotes = async (detailed: boolean): Promise<{text: string, hindiText?: string}> => {
      let prompt = "";
      const template = detailed ? promptNotesPremium : promptNotes;
      
      if (template) {
           prompt = processTemplate(template, {
               board: board || '',
               class: classLevel,
               stream: stream || '',
               subject: subject.name,
               chapter: chapter.title,
               language: language,
               instruction: customInstruction
           });
      } else {
          const competitionConstraints = syllabusMode === 'COMPETITION' 
              ? "STYLE: Fact-Heavy, Direct. HIGHLIGHT PYQs (Previous Year Questions) if relevant." 
              : "STYLE: Strict NCERT Pattern.";

          prompt = `${customInstruction}
          ${adminPromptOverride || ""}
          
          Write ${detailed ? 'PREMIUM DEEP ANALYSIS' : 'SUMMARY'} study notes for ${board} Class ${classLevel} ${subject.name}, Chapter: "${chapter.title}".
          Language: ${language}.
          ${competitionConstraints}
          
          ${!adminPromptOverride ? `STRICT PROFESSIONAL GUIDEBOOK MODE
          
          NEGATIVE CONSTRAINTS:
          - NO Conversational Filler (e.g., "Hello students", "Let's learn").
          - NO Direct Address (e.g., "You").
          
          POSITIVE INSTRUCTIONS:
          - Use Professional Labels: "🔥 MOST IMPORTANT", "🧠 REMEMBER THIS", "⚠️ EXAM ALERT".
          
          STRUCTURAL RULES:
          1. Hook Start: Start with a Thinking Question.
          2. Deep Breakdown: Use Comparison Tables and Flowcharts (Text-based).
          3. Special Sections: 
             - 💡 Concept Chamka? (Insight)
             - ⚠️ Exam Trap (Alert)
             - 🏆 Topper's Trick
          
          Structure:
          1. Introduction (Hook)
          2. Key Concepts (Deep Analysis)
          3. Detailed Explanations (with Tables/Flowcharts)
          4. Important Formulas/Dates
          5. Summary` : ''}

          ${detailed ? 'Include deep insights, memory tips, and exam strategies.' : 'Keep it concise and clear. Focus on quick revision.'}`;
      }

      const text = await executeWithRotation(async () => {
          return await callGroqApi([
              { role: "system", content: "You are an expert teacher. Provide high quality, well-formatted markdown content." },
              { role: "user", content: prompt }
          ], modelName);
      }, usageType);

      let hindiText = undefined;
      if (language === 'English') {
          try {
              hindiText = await translateToHindi(text, false, usageType);
          } catch(e) { console.error("Translation Failed", e); }
      }
      return { text, hindiText };
  };

  if (dualGeneration && (type === 'NOTES_PREMIUM' || type === 'NOTES_SIMPLE')) {
       // ... (Copied logic) ...
       const competitionConstraints = syllabusMode === 'COMPETITION' 
          ? "STYLE: Fact-Heavy, Direct. HIGHLIGHT PYQs (Previous Year Questions) if relevant." 
          : "STYLE: Strict NCERT Pattern.";

       const prompt = `${customInstruction}
       ${adminPromptOverride || ""}
       
       TASK:
       1. Generate Premium Detailed Analysis Notes for ${board} Class ${classLevel} ${subject.name}, Chapter: "${chapter.title}".
       2. Generate a 100-word Summary for Free Notes.
       
       Language: ${language}.
       ${competitionConstraints}
       
       OUTPUT FORMAT STRICTLY:
       <<<PREMIUM>>>
       [Detailed Content Here including Introduction, Key Concepts, Tables, Flowcharts, Formulas, Exam Alerts etc.]
       <<<SUMMARY>>>
       [Short 100-word Summary Here]
       `;
       
       const rawText = await executeWithRotation(async () => {
          return await callGroqApi([{ role: "user", content: prompt }], modelName);
       }, usageType);
       
       let premiumText = "";
       let freeText = "";
       
       if (rawText.includes("<<<PREMIUM>>>")) {
           const parts = rawText.split("<<<PREMIUM>>>");
           if (parts[1]) {
               const subParts = parts[1].split("<<<SUMMARY>>>");
               premiumText = subParts[0].trim();
               if (subParts[1]) freeText = subParts[1].trim();
           }
       } else {
           premiumText = rawText;
           freeText = "Summary not generated.";
       }

       let premiumTextHI = undefined;
       let freeTextHI = undefined;
       
       if (language === 'English') {
          try {
              const [p, f] = await Promise.all([
                  translateToHindi(premiumText, false, usageType),
                  translateToHindi(freeText, false, usageType)
              ]);
              premiumTextHI = p;
              freeTextHI = f;
          } catch(e) { console.error("Translation Failed", e); }
       }

      return {
          id: Date.now().toString(),
          title: chapter.title,
          subtitle: "Premium & Free Notes (Dual)",
          content: premiumText, // Default to Premium
          type: 'NOTES_PREMIUM',
          dateCreated: new Date().toISOString(),
          subjectName: subject.name,
          
          schoolPremiumNotesHtml: syllabusMode === 'SCHOOL' ? premiumText : undefined,
          competitionPremiumNotesHtml: syllabusMode === 'COMPETITION' ? premiumText : undefined,
          schoolPremiumNotesHtml_HI: syllabusMode === 'SCHOOL' ? premiumTextHI : undefined,
          competitionPremiumNotesHtml_HI: syllabusMode === 'COMPETITION' ? premiumTextHI : undefined,

          schoolFreeNotesHtml: syllabusMode === 'SCHOOL' ? freeText : undefined,
          competitionFreeNotesHtml: syllabusMode === 'COMPETITION' ? freeText : undefined,
          
          isComingSoon: false
      };
  }

  const isDetailed = type === 'NOTES_PREMIUM' || type === 'NOTES_HTML_PREMIUM';
  const result = await generateNotes(isDetailed);

  return {
      id: Date.now().toString(),
      title: chapter.title,
      subtitle: isDetailed ? "Premium Study Notes" : "Quick Revision Notes",
      content: result.text,
      type: type,
      dateCreated: new Date().toISOString(),
      subjectName: subject.name,
      schoolPremiumNotesHtml_HI: syllabusMode === 'SCHOOL' && isDetailed ? result.hindiText : undefined,
      competitionPremiumNotesHtml_HI: syllabusMode === 'COMPETITION' && isDetailed ? result.hindiText : undefined,
      isComingSoon: false
  };
};

export const generateTestPaper = async (topics: any, count: number, language: Language): Promise<MCQItem[]> => {
    return []; // Placeholder
};
export const generateDevCode = async (userPrompt: string): Promise<string> => { return "// Dev Console Disabled"; };

export const generateCustomNotes = async (userTopic: string, adminPrompt: string, modelName: string = "llama3-8b-8192"): Promise<string> => {
    const prompt = `${adminPrompt || 'Generate detailed notes for the following topic:'}
    
    TOPIC: ${userTopic}
    
    Ensure the content is well-structured with headings and bullet points.`;

    return await executeWithRotation(async () => {
        return await callGroqApi([{ role: "user", content: prompt }], modelName);
    }, 'STUDENT');
};

export const generateUltraAnalysis = async (
    data: {
        questions: any[], 
        userAnswers: Record<number, number>, 
        score: number, 
        total: number, 
        subject: string, 
        chapter: string, 
        classLevel: string
    },
    settings?: SystemSettings
): Promise<string> => {
    let modelName = "llama3-8b-8192";
    let customInstruction = "";
    
    if (settings) {
        if (settings.aiModel) modelName = settings.aiModel;
        if (settings.aiInstruction) customInstruction = settings.aiInstruction;
    }

    const attemptedQuestions = data.questions.map((q, idx) => {
        const selected = data.userAnswers[idx];
        const isCorrect = selected === q.correctAnswer;
        
        return {
            question: q.question,
            correctAnswer: q.options[q.correctAnswer],
            userSelected: (selected !== undefined && selected !== -1 && q.options[selected]) ? q.options[selected] : "Skipped",
            isCorrect: isCorrect,
            concept: q.concept || q.explanation || "General Concept"
        };
    });

    const prompt = `
    ${customInstruction}
    
    ROLE: Expert Educational Mentor & Analyst.
    
    CONTEXT:
    Student Class: ${data.classLevel}
    Subject: ${data.subject}
    Chapter: ${data.chapter}
    Score: ${data.score}/${data.total}

    TASK:
    Analyze the student's performance and provide a structured JSON analysis grouped by topics.
    
    DATA:
    ${JSON.stringify(attemptedQuestions, null, 2)}

    OUTPUT FORMAT (STRICT JSON ONLY, NO MARKDOWN):
    {
      "topics": [
        {
          "name": "Topic Name",
          "status": "WEAK" | "AVERAGE" | "STRONG",
          "questions": [
            {
              "text": "Question text...",
              "status": "CORRECT" | "WRONG", 
              "correctAnswer": "Option text (if wrong)"
            }
          ],
          "actionPlan": "Specific advice on how to work on this topic...",
          "studyMode": "REVISION" | "DEEP_STUDY"
        }
      ],
      "motivation": "One short punchy motivational line",
      "nextSteps": {
        "duration": "2 Days",
        "focusTopics": ["Topic A", "Topic B"],
        "action": "Brief instructions on what to study immediately."
      },
      "weakToStrongPath": [
        { "step": 1, "action": "Step-by-step action to improve weak areas..." },
        { "step": 2, "action": "..." }
      ]
    }
    
    Ensure the response is valid JSON. Do not wrap in markdown code blocks.
    `;

    return await executeWithRotation(async () => {
        const content = await callGroqApi([
            { role: "system", content: "You are a data analyst. Return only valid JSON." },
            { role: "user", content: prompt }
        ], modelName);
        return cleanJson(content || "{}");
    }, 'STUDENT');
};
