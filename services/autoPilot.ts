import { SystemSettings, Board, ClassLevel, Stream, Subject, ContentType, Chapter } from "../types";
import { getSubjectsList } from "../constants";
import { fetchChapters, fetchLessonContent } from "./groq";
import { getChapterData, saveChapterData, saveAiInteraction } from "../firebase";
import pLimit from 'p-limit';

const AUTO_PILOT_PROMPT = `
STRICT PROFESSIONAL GUIDEBOOK MODE

NEGATIVE CONSTRAINTS (What NOT to do):
- NO Conversational Filler: Never use phrases like "Hello students", "Let's learn", "I hope you understood", "Write this down", or "Copy this".
- NO Direct Address: Do not address the student as "You" or "Bachon".
- NO Commands: Do not give instructions like "Note kar lijiye".

POSITIVE INSTRUCTIONS (What TO do):
Instead of sentences, use Professional Labels/Tags:
- Instead of "This is important", use: "🔥 MOST IMPORTANT: [Content]"
- Instead of "Remember this point", use: "🧠 REMEMBER THIS: [Content]"
- Instead of "Beware of mistakes", use: "⚠️ EXAM ALERT: [Content]"

STRUCTURAL RULES (Deep Analysis & Coaching Style):
1. The "Hook" Start:
   - Start every topic with a Thinking Question (e.g., "Why doesn't the stomach digest itself?" instead of just defining digestion).
2. Deep Breakdown (The Analysis):
   - Don't just write paragraphs. Use Comparison Tables whenever possible (e.g., Difference between Arteries vs Veins).
   - Use Flowcharts using text arrows (e.g., Sun -> Plant -> Deer -> Lion).
3. Special Sections (Include these specifically):
   - 💡 Concept Chamka? (Insight): A deep fact or logic behind the concept.
   - ⚠️ Exam Trap (Alert): "Students often make mistakes here..."
   - 🏆 Topper's Trick: A mnemonic or shortcut to remember the topic.
4. Tone:
   - Use a conversational, analytical tone. Use bold text for keywords.
`;

let isAiGenerating = false;

const getRandomItem = <T>(array: T[]): T => {
    return array[Math.floor(Math.random() * array.length)];
};

export const runAutoPilot = async (
    settings: SystemSettings, 
    onLog: (msg: string) => void,
    force: boolean = false,
    concurrency: number = 3,
    apiKeys: string[] = [] 
): Promise<void> => {
    if (isAiGenerating && !force) return;
    
    // Check if enabled (unless forced)
    if (!settings.isAutoPilotEnabled && !force) return;

    isAiGenerating = true;
    const limit = pLimit(concurrency);

    try {
        const config = settings.autoPilotConfig || { targetClasses: [], targetBoards: [], contentTypes: [] };
        
        if (!config.targetClasses?.length) {
             if (force) onLog("⚠️ Auto-Pilot Config Empty (Classes). Please configure in Pilot settings.");
             isAiGenerating = false;
             return;
        }

        onLog("🚀 Auto-Pilot Engaging... Scanning for missing content.");

        // Loop Config
        const boards = config.targetBoards?.length ? config.targetBoards : ['CBSE']; 
        
        let tasks: Promise<void>[] = [];

        for (const board of boards) {
            for (const classLevel of config.targetClasses) {
                // Determine Streams
                const streams: (Stream | null)[] = (classLevel === '11' || classLevel === '12') 
                    ? ['Science', 'Commerce', 'Arts'] 
                    : [null];

                for (const stream of streams) {
                    // Filter subjects based on config
                    const allSubjects = getSubjectsList(classLevel, stream);
                    // If targetSubjects is empty, do ALL
                    const targetSubjects = (config.targetSubjects && config.targetSubjects.length > 0)
                        ? allSubjects.filter(s => config.targetSubjects?.includes(s.name))
                        : allSubjects;

                    for (const subject of targetSubjects) {
                        // Fetch Chapters
                        const chapters = await fetchChapters(board, classLevel, stream, subject, 'English');
                        
                        for (const chapter of chapters) {
                             tasks.push(limit(async () => {
                                 // Check existence
                                 const streamKey = (classLevel === '11' || classLevel === '12') && stream ? `-${stream}` : '';
                                 const contentKey = `nst_content_${board}_${classLevel}${streamKey}_${subject.name}_${chapter.id}`;
                                 const existing = await getChapterData(contentKey);
                                 
                                 const mode = classLevel === 'COMPETITION' ? 'COMPETITION' : 'SCHOOL';
                                 const notesKey = mode === 'SCHOOL' ? 'schoolPremiumNotesHtml' : 'competitionPremiumNotesHtml';
                                 
                                 if (existing && existing[notesKey]) {
                                     // Skip
                                     return;
                                 }

                                 onLog(`⚡ Generating: ${chapter.title} (${subject.name})...`);
                                 
                                 // Generate
                                 const content = await fetchLessonContent(
                                        board,
                                        classLevel,
                                        stream,
                                        subject,
                                        chapter,
                                        'English',
                                        'NOTES_PREMIUM',
                                        0,
                                        true, 
                                        0, 
                                        AUTO_PILOT_PROMPT,
                                        true, 
                                        mode,
                                        false, 
                                        true, 
                                        'PILOT'
                                 );

                                 if (content && content.content) {
                                      let updates: any = {};
                                      
                                      if (mode === 'SCHOOL') {
                                          updates = { 
                                              ...existing, 
                                              schoolPremiumNotesHtml: content.content, 
                                              schoolPremiumNotesHtml_HI: content.schoolPremiumNotesHtml_HI,
                                              schoolFreeNotesHtml: content.schoolFreeNotesHtml, 
                                              is_premium: true,
                                              is_free: true 
                                          };
                                      } else {
                                          updates = { 
                                              ...existing, 
                                              competitionPremiumNotesHtml: content.content, 
                                              competitionPremiumNotesHtml_HI: content.competitionPremiumNotesHtml_HI,
                                              competitionFreeNotesHtml: content.competitionFreeNotesHtml,
                                              is_premium: true,
                                              is_free: true 
                                          };
                                      }
                                      
                                      // @ts-ignore
                                      if (settings.autoPilotConfig?.requireApproval) updates.isDraft = true;
                                      
                                      await saveChapterData(contentKey, updates);
                                      onLog(`✅ Generated: ${chapter.title} (${subject.name})`);
                                 }
                             }));
                        }
                    }
                }
            }
        }
        
        await Promise.all(tasks);
        onLog("🏁 Auto-Pilot Cycle Complete.");

    } catch (e: any) {
        onLog(`❌ Auto-Pilot Error: ${e.message}`);
        console.error("AutoPilot Error", e);
    } finally {
        isAiGenerating = false;
    }
};

// NEW: COMMAND CENTER MODE
export const runCommandMode = async (
    settings: SystemSettings, 
    onLog: (msg: string) => void,
    target: { board: Board, classLevel: ClassLevel, stream: Stream | null, subject: Subject },
    concurrency: number = 5
): Promise<void> => {
     if (isAiGenerating) {
        onLog("⚠️ AI is busy. Please wait...");
        return;
    }
    isAiGenerating = true;

    try {
        // 1. CONFIRMATION
        onLog("Ji Sir, aapke aadeshanusar kaam shuru kar raha hoon.");
        
        // Fetch Chapters
        onLog(`📚 Fetching chapters for ${target.classLevel} ${target.subject.name}...`);
        const chapters = await fetchChapters(target.board, target.classLevel, target.stream, target.subject, 'English');
        
        if (chapters.length === 0) {
             onLog("❌ No chapters found.");
             isAiGenerating = false;
             return;
        }

        onLog(`🚀 Processing ${chapters.length} Chapters for ${target.subject.name}...`);
        const limit = pLimit(concurrency);
        let successCount = 0;

        const tasks = chapters.map(chapter => limit(async () => {
             const streamKey = (target.classLevel === '11' || target.classLevel === '12') && target.stream ? `-${target.stream}` : '';
             const contentKey = `nst_content_${target.board}_${target.classLevel}${streamKey}_${target.subject.name}_${chapter.id}`;
             const existing = await getChapterData(contentKey);
             
             // Check if Premium Notes missing
             const mode = target.classLevel === 'COMPETITION' ? 'COMPETITION' : 'SCHOOL';
             const notesKey = mode === 'SCHOOL' ? 'schoolPremiumNotesHtml' : 'competitionPremiumNotesHtml';
             
             if (existing && existing[notesKey]) {
                 // onLog(`ℹ️ Skipped: ${chapter.title} (Already Exists)`);
                 return;
             }

             onLog(`⚡ Generating: ${chapter.title}...`);
             
             const content = await fetchLessonContent(
                    target.board,
                    target.classLevel,
                    target.stream,
                    target.subject,
                    chapter,
                    'English',
                    'NOTES_PREMIUM', // Target Premium to trigger Dual
                    0,
                    true, 
                    0, 
                    AUTO_PILOT_PROMPT,
                    true, 
                    mode,
                    false, // Don't force if exists
                    true,  // Dual Generation (One Call)
                    'PILOT'
             );

             if (content && content.content) {
                  // Save logic
                  let updates: any = {};
                  if (mode === 'SCHOOL') {
                      updates = { 
                          ...existing, 
                          schoolPremiumNotesHtml: content.content, 
                          schoolPremiumNotesHtml_HI: content.schoolPremiumNotesHtml_HI,
                          schoolFreeNotesHtml: content.schoolFreeNotesHtml, 
                          is_premium: true,
                          is_free: true 
                      };
                  } else {
                      updates = { 
                          ...existing, 
                          competitionPremiumNotesHtml: content.content, 
                          competitionPremiumNotesHtml_HI: content.competitionPremiumNotesHtml_HI,
                          competitionFreeNotesHtml: content.competitionFreeNotesHtml,
                          is_premium: true,
                          is_free: true 
                      };
                  }
                  
                  // @ts-ignore
                  if (settings.autoPilotConfig?.requireApproval) updates.isDraft = true;
                  
                  await saveChapterData(contentKey, updates);
                  onLog(`✅ Generated: ${chapter.title}`);
                  successCount++;
             } else {
                  onLog(`❌ Failed: ${chapter.title}`);
             }
        }));

        await Promise.all(tasks);
        
        if (successCount > 0) {
            // 2. SUCCESS MESSAGE
            onLog("Safalta! Ek hi prayas mein dono version taiyar. Quota surakshit hai.");
        } else {
            onLog("🏁 Command Complete. No new content generated (Already Exists).");
        }

    } catch(e: any) {
        onLog(`❌ Error: ${e.message}`);
        console.error(e);
    } finally {
        isAiGenerating = false;
    }
};
