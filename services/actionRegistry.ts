
import { 
    db, 
    rtdb, 
    saveUserToLive, 
    saveSystemSettings, 
    saveChapterData, 
    saveUniversalAnalysis,
    saveAiInteraction,
    savePublicActivity,
    getApiUsage,
    subscribeToUsers,
    bulkSaveLinks
} from '../firebase';
import { 
    ref, 
    set, 
    get, 
    update, 
    remove, 
    push 
} from "firebase/database";
import { 
    doc, 
    deleteDoc, 
    getDocs, 
    collection,
    query,
    where,
    limitToLast,
    orderBy,
    setDoc
} from "firebase/firestore";
import { User, SystemSettings, WeeklyTest, MCQItem, InboxMessage, SubscriptionHistoryEntry, GiftCode } from '../types';
import { DEFAULT_SUBJECTS } from '../constants';
import { runAutoPilot as runAutoPilotService } from './autoPilot';

// --- HELPER: GET ALL USERS (ONCE) ---
const getAllUsers = async (): Promise<User[]> => {
    try {
        const querySnapshot = await getDocs(collection(db, "users"));
        return querySnapshot.docs.map(doc => doc.data() as User);
    } catch (e) {
        console.error("Error fetching users:", e);
        return [];
    }
};

// --- HELPER: GET SETTINGS (ONCE) ---
const getSettings = async (): Promise<SystemSettings | null> => {
    try {
        const snapshot = await get(ref(rtdb, 'system_settings'));
        if (snapshot.exists()) return snapshot.val();
        return null;
    } catch (e) { return null; }
};

// --- ACTION IMPLEMENTATIONS ---

const deleteUser = async (userId: string) => {
    try {
        await deleteDoc(doc(db, "users", userId));
        await remove(ref(rtdb, `users/${userId}`));
        return `User ${userId} deleted successfully from Firestore and RTDB.`;
    } catch (e: any) {
        throw new Error(`Failed to delete user ${userId}: ${e.message}`);
    }
};

const updateUser = async (userId: string, updates: Partial<User>) => {
    try {
        const snapshot = await get(ref(rtdb, `users/${userId}`));
        if (!snapshot.exists()) throw new Error("User not found");
        
        const currentUser = snapshot.val();
        const updatedUser = { ...currentUser, ...updates };
        
        await saveUserToLive(updatedUser);
        return `User ${userId} updated.`;
    } catch (e: any) {
        throw new Error(`Failed to update user: ${e.message}`);
    }
};

const banUser = async (userId: string, reason: string) => {
    return await updateUser(userId, { isLocked: true });
};

const unbanUser = async (userId: string) => {
    return await updateUser(userId, { isLocked: false });
};

const grantSubscription = async (userId: string, plan: 'WEEKLY' | 'MONTHLY' | 'YEARLY' | 'LIFETIME', level: 'BASIC' | 'ULTRA') => {
    const now = new Date();
    let endDate: Date | null = new Date();
    
    if (plan === 'WEEKLY') endDate.setDate(now.getDate() + 7);
    else if (plan === 'MONTHLY') endDate.setDate(now.getDate() + 30);
    else if (plan === 'YEARLY') endDate.setDate(now.getDate() + 365);
    else endDate = null;

    const historyEntry: SubscriptionHistoryEntry = {
        id: `grant-${Date.now()}`,
        tier: plan,
        level: level,
        startDate: now.toISOString(),
        endDate: endDate ? endDate.toISOString() : 'LIFETIME',
        durationHours: 0,
        price: 0,
        originalPrice: 0,
        isFree: true,
        grantSource: 'ADMIN',
        grantedBy: 'AI_AGENT'
    };

    const snapshot = await get(ref(rtdb, `users/${userId}`));
    if (!snapshot.exists()) throw new Error("User not found");
    const user = snapshot.val();
    
    const newHistory = [historyEntry, ...(user.subscriptionHistory || [])];

    return await updateUser(userId, {
        subscriptionTier: plan,
        subscriptionLevel: level,
        subscriptionEndDate: endDate ? endDate.toISOString() : undefined,
        isPremium: true,
        subscriptionHistory: newHistory,
        grantedByAdmin: true
    });
};

const broadcastMessage = async (message: string) => {
    const settings = await getSettings();
    if (settings) {
        const newSettings = { ...settings, noticeText: message };
        await saveSystemSettings(newSettings);
        return "Broadcast banner updated successfully.";
    }
    return "Failed to fetch settings.";
};

const sendInboxMessage = async (userId: string, text: string) => {
    const snapshot = await get(ref(rtdb, `users/${userId}`));
    if (!snapshot.exists()) throw new Error("User not found");
    const user = snapshot.val();
    
    const newMsg: InboxMessage = {
        id: `msg-${Date.now()}`,
        text: text,
        date: new Date().toISOString(),
        read: false,
        type: 'TEXT'
    };
    
    const updatedInbox = [newMsg, ...(user.inbox || [])];
    await updateUser(userId, { inbox: updatedInbox });
    return `Message sent to ${user.name}.`;
};

const createWeeklyTest = async (name: string, subject: string, questionCount: number) => {
    const settings = await getSettings();
    if (!settings) throw new Error("Settings not found");
    
    const newTest: WeeklyTest = {
        id: `test-${Date.now()}`,
        name: name,
        description: `Subject: ${subject}`,
        isActive: true,
        classLevel: '10',
        questions: [],
        totalQuestions: questionCount,
        passingScore: 40,
        createdAt: new Date().toISOString(),
        durationMinutes: 60,
        selectedSubjects: [subject]
    };
    
    const updatedTests = [...(settings.weeklyTests || []), newTest];
    await saveSystemSettings({ ...settings, weeklyTests: updatedTests });
    return `Weekly Test "${name}" created (Empty Questions).`;
};

const scanUsers = async (filter: 'ALL' | 'PREMIUM' | 'FREE' | 'INACTIVE') => {
    const users = await getAllUsers();
    let result = users;
    
    if (filter === 'PREMIUM') result = users.filter(u => u.isPremium);
    if (filter === 'FREE') result = users.filter(u => !u.isPremium);
    if (filter === 'INACTIVE') {
        const monthAgo = new Date();
        monthAgo.setMonth(monthAgo.getMonth() - 1);
        result = users.filter(u => !u.lastActiveTime || new Date(u.lastActiveTime) < monthAgo);
    }
    
    return result.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, credits: u.credits, tier: u.subscriptionTier }));
};

const getRecentLogs = async (limit: number = 20) => {
     try {
        const q = query(collection(db, "ai_interactions"), orderBy("timestamp", "desc"), limitToLast(limit));
        const snapshot = await getDocs(q);
        return snapshot.docs.map(d => d.data());
     } catch (e) { return []; }
};

// --- NEW FUNCTIONS ---

const addSubject = async (name: string) => {
    const id = name.toLowerCase().replace(/\s+/g, '');
    const newSubject = { id, name, icon: 'book', color: 'bg-slate-50 text-slate-600' };
    const customPool = JSON.parse(localStorage.getItem('nst_custom_subjects_pool') || '{}');
    const updatedPool = { ...DEFAULT_SUBJECTS, ...customPool, [id]: newSubject };
    localStorage.setItem('nst_custom_subjects_pool', JSON.stringify(updatedPool));
    // Note: This relies on local storage sync or AdminDashboard reloading. For AI to truly persist, we should probably save to Firebase settings if structure allows, but current implementation uses LS.
    // However, AdminDashboard syncs LS to State.
    return `Subject ${name} added locally.`;
};

const generateGiftCodes = async (amount: number, count: number, type: 'CREDITS'|'SUBSCRIPTION' = 'CREDITS') => {
    const newCodes: GiftCode[] = [];
    const codeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < count; i++) {
        let code = '';
        for (let j = 0; j < 12; j++) code += codeChars.charAt(Math.floor(Math.random() * codeChars.length));
        
        const newGiftCode: GiftCode = {
            id: Date.now().toString() + i,
            code: code.toUpperCase(),
            type,
            amount: type === 'CREDITS' ? amount : 0,
            subTier: type === 'SUBSCRIPTION' ? 'WEEKLY' : undefined, // Default
            subLevel: type === 'SUBSCRIPTION' ? 'BASIC' : undefined,
            createdAt: new Date().toISOString(),
            isRedeemed: false,
            generatedBy: 'AI_ADMIN',
            maxUses: 1,
            usedCount: 0,
            redeemedBy: []
        };
        newCodes.push(newGiftCode);
        await set(ref(rtdb, `redeem_codes/${newGiftCode.code}`), newGiftCode);
    }
    // Sync to LS for Admin visibility
    const existing = JSON.parse(localStorage.getItem('nst_admin_codes') || '[]');
    localStorage.setItem('nst_admin_codes', JSON.stringify([...newCodes, ...existing]));
    
    return `${count} Gift Codes Generated: ${newCodes.map(c => c.code).join(', ')}`;
};

const updateSystemSettings = async (updates: Partial<SystemSettings>) => {
    const settings = await getSettings();
    if (!settings) throw new Error("Settings not found");
    const newSettings = { ...settings, ...updates };
    await saveSystemSettings(newSettings);
    return "Settings updated.";
};

const toggleSetting = async (key: keyof SystemSettings, value: boolean) => {
    return await updateSystemSettings({ [key]: value });
};

const addPackage = async (name: string, price: number, credits: number) => {
    const settings = await getSettings();
    if (!settings) throw new Error("Settings not found");
    const newPkg = { id: `pkg-${Date.now()}`, name, price, credits };
    const packages = [...(settings.packages || []), newPkg];
    await saveSystemSettings({ ...settings, packages });
    return `Package ${name} added.`;
};

const removePackage = async (id: string) => {
    const settings = await getSettings();
    if (!settings) throw new Error("Settings not found");
    const packages = (settings.packages || []).filter(p => p.id !== id);
    await saveSystemSettings({ ...settings, packages });
    return `Package ${id} removed.`;
};

const promoteSubAdmin = async (userId: string) => {
    return await updateUser(userId, { role: 'SUB_ADMIN', isSubAdmin: true, permissions: ['MANAGE_SUBS'] });
};

const demoteSubAdmin = async (userId: string) => {
    return await updateUser(userId, { role: 'STUDENT', isSubAdmin: false, permissions: [] });
};

const approveRecoveryRequest = async (requestId: string) => {
    const reqRef = ref(rtdb, `recovery_requests/${requestId}`);
    await update(reqRef, { status: 'RESOLVED' });
    await updateUser(requestId, { isPasswordless: true });
    return `Request ${requestId} approved.`;
};

const addUniversalVideo = async (title: string, url: string) => {
    const data = await getChapterData('nst_universal_playlist') || { videoPlaylist: [] };
    const playlist = [...(data.videoPlaylist || []), { title, url, price: 0, access: 'FREE' }];
    await saveChapterData('nst_universal_playlist', { videoPlaylist: playlist });
    return `Video "${title}" added to Universal Playlist.`;
};

const saveCustomBloggerPage = async (html: string) => {
    await set(ref(rtdb, 'custom_blogger_page'), html);
    return "Custom Blogger Page saved.";
};

const softDelete = async (type: string, id: string) => {
    // Basic implementation mimicking AdminDashboard logic
    // Just logs it for now as strict recycling logic is complex to port fully without state access
    return "Soft delete not fully supported via AI yet, please use Dashboard.";
};

const runAutoPilot = async () => {
    const settings = await getSettings();
    if (!settings) return "Settings failure.";
    await runAutoPilotService(settings, (msg) => console.log(msg), true, 5, []);
    return "Auto-Pilot cycle triggered.";
};

// --- REGISTRY MAP ---
export const ActionRegistry = {
    deleteUser,
    updateUser,
    banUser,
    unbanUser,
    grantSubscription,
    broadcastMessage,
    sendInboxMessage,
    createWeeklyTest,
    scanUsers,
    getRecentLogs,
    addSubject,
    generateGiftCodes,
    updateSystemSettings,
    toggleSetting,
    addPackage,
    removePackage,
    promoteSubAdmin,
    demoteSubAdmin,
    approveRecoveryRequest,
    addUniversalVideo,
    saveCustomBloggerPage,
    runAutoPilot
};

// --- TOOL DEFINITIONS ---
export const adminTools = [
    {
        type: "function",
        function: {
            name: "deleteUser",
            description: "Delete a user permanently.",
            parameters: {
                type: "object",
                properties: { userId: { type: "string" } },
                required: ["userId"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "updateUser",
            description: "Update user details (credits, etc).",
            parameters: {
                type: "object",
                properties: { userId: { type: "string" }, updates: { type: "object" } },
                required: ["userId", "updates"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "grantSubscription",
            description: "Give a premium subscription.",
            parameters: {
                type: "object",
                properties: { 
                    userId: { type: "string" }, 
                    plan: { type: "string", enum: ["WEEKLY", "MONTHLY", "YEARLY", "LIFETIME"] },
                    level: { type: "string", enum: ["BASIC", "ULTRA"] }
                },
                required: ["userId", "plan", "level"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "banUser",
            description: "Ban a user.",
            parameters: {
                type: "object",
                properties: { userId: { type: "string" }, reason: { type: "string" } },
                required: ["userId"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "unbanUser",
            description: "Unban a user.",
            parameters: {
                type: "object",
                properties: { userId: { type: "string" } },
                required: ["userId"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "broadcastMessage",
            description: "Set a global banner message.",
            parameters: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "sendInboxMessage",
            description: "Send private message.",
            parameters: {
                type: "object",
                properties: { userId: { type: "string" }, text: { type: "string" } },
                required: ["userId", "text"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "scanUsers",
            description: "List users.",
            parameters: {
                type: "object",
                properties: { filter: { type: "string", enum: ["ALL", "PREMIUM", "FREE", "INACTIVE"] } },
                required: ["filter"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "generateGiftCodes",
            description: "Generate redeem codes.",
            parameters: {
                type: "object",
                properties: { amount: { type: "number" }, count: { type: "number" }, type: { type: "string", enum: ["CREDITS", "SUBSCRIPTION"] } },
                required: ["amount", "count"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "toggleSetting",
            description: "Toggle a system boolean setting (maintenance, ai, autopilot).",
            parameters: {
                type: "object",
                properties: { 
                    key: { type: "string", enum: ["maintenanceMode", "isAiEnabled", "isAutoPilotEnabled", "isChatEnabled", "isGameEnabled"] },
                    value: { type: "boolean" }
                },
                required: ["key", "value"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "promoteSubAdmin",
            description: "Make user a Sub-Admin.",
            parameters: {
                type: "object",
                properties: { userId: { type: "string" } },
                required: ["userId"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "demoteSubAdmin",
            description: "Remove Sub-Admin rights.",
            parameters: {
                type: "object",
                properties: { userId: { type: "string" } },
                required: ["userId"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "runAutoPilot",
            description: "Trigger AI Auto-Pilot once.",
            parameters: { type: "object", properties: {} }
        }
    }
];
