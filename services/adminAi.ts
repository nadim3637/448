import { User, SystemSettings } from '../types';
import { callGroqApiWithTools } from './groq';
import { ActionRegistry, adminTools } from './actionRegistry';
import { saveAiInteraction } from '../firebase';

export type AdminAiResponse = {
    type: 'TEXT' | 'LIST_USERS' | 'LIST_MCQ' | 'ACTION_CONFIRMATION';
    message: string;
    data?: any;
    actionType?: string;
};

interface AdminContext {
    users: User[];
    settings: SystemSettings;
    setSettings: (s: SystemSettings) => void;
}

const SYSTEM_PROMPT = `
You are Ainjo, the Super Admin AI of this education platform.
You have FULL control over the system.
You can delete users, grant subscriptions, ban users, create tests, and broadcast messages.

Guidelines:
1. You are the "Second Admin". You have the power to execute actions directly.
2. Use the provided tools to perform actions.
3. If the user's request is ambiguous, ask for clarification.
4. If you perform an action using a tool, respond with a confirmation message summarising what you did.
5. If the user asks for information (like "Show me premium users"), call the relevant tool (e.g., scanUsers) and then summarize the result.

Current Context:
- You are chatting with the Main Admin.
- You have access to real-time database functions.
`;

export const processAdminCommand = async (
    command: string, 
    context: AdminContext
): Promise<AdminAiResponse> => {
    try {
        // 1. Fetch Memory (Last 10 interactions)
        const recentLogs = await ActionRegistry.getRecentLogs(10);
        const memoryContext = recentLogs.map((log: any) => 
            `User: ${log.query}\nAI: ${log.response}`
        ).join('\n---\n');

        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `Recent Activity:\n${memoryContext}\n\nCurrent Command: ${command}` }
        ];

        // 2. Call AI with Tools
        const response = await callGroqApiWithTools(messages, adminTools, "llama-3.3-70b-versatile");

        // 3. Handle Tool Calls
        if (response.tool_calls && response.tool_calls.length > 0) {
            let resultMessage = "";
            let actionData: any = null;
            let responseType: AdminAiResponse['type'] = 'ACTION_CONFIRMATION';

            for (const toolCall of response.tool_calls) {
                const functionName = toolCall.function.name;
                const args = JSON.parse(toolCall.function.arguments);
                
                // Execute Tool
                if (ActionRegistry[functionName as keyof typeof ActionRegistry]) {
                    console.log(`Executing ${functionName} with args:`, args);
                    
                    try {
                        const result = await (ActionRegistry[functionName as keyof typeof ActionRegistry] as any)(...Object.values(args));
                        
                        // Handle specific return types for UI
                        if (functionName === 'scanUsers') {
                            actionData = result;
                            responseType = 'LIST_USERS';
                            resultMessage += `Found ${result.length} users matching criteria.\n`;
                        } else {
                            resultMessage += `Action ${functionName} executed: ${JSON.stringify(result)}\n`;
                        }

                    } catch (err: any) {
                        resultMessage += `Error executing ${functionName}: ${err.message}\n`;
                    }
                } else {
                    resultMessage += `Tool ${functionName} not found.\n`;
                }
            }

            // Log Interaction
            await saveAiInteraction({
                id: `admin-act-${Date.now()}`,
                userId: 'ADMIN',
                userName: 'Admin',
                type: 'ADMIN_ACTION',
                query: command,
                response: resultMessage,
                timestamp: new Date().toISOString()
            });

            return {
                type: responseType,
                message: resultMessage || "Actions completed.",
                data: actionData
            };
        }

        // 4. Handle Text Response (No Tool Used)
        const textResponse = response.content || "I processed your request.";
        
        await saveAiInteraction({
            id: `admin-chat-${Date.now()}`,
            userId: 'ADMIN',
            userName: 'Admin',
            type: 'ADMIN_CHAT',
            query: command,
            response: textResponse,
            timestamp: new Date().toISOString()
        });

        return {
            type: 'TEXT',
            message: textResponse
        };

    } catch (error: any) {
        console.error("Admin AI Error:", error);
        return {
            type: 'TEXT',
            message: `System Error: ${error.message}`
        };
    }
};
