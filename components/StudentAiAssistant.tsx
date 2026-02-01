import React, { useState, useEffect, useRef } from 'react';
import { Bot, Send, X, Loader2, Volume2, Sparkles, User as UserIcon, Lock } from 'lucide-react';
import { generateCustomNotes } from '../services/groq';
import { saveAiInteraction, saveUserToLive } from '../firebase';
import { speakText, stopSpeech } from '../utils/textToSpeech';
import { User, SystemSettings } from '../types';
import { SpeakButton } from './SpeakButton';

interface Props {
    user: User;
    settings?: SystemSettings;
    isOpen: boolean;
    onClose: () => void;
}

interface Message {
    role: 'AI' | 'USER';
    text: string;
    timestamp: number;
}

export const StudentAiAssistant: React.FC<Props> = ({ user, settings, isOpen, onClose }) => {
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [messages, setMessages] = useState<Message[]>([]);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(scrollToBottom, [messages, isLoading, isOpen]);

    const handleSend = async () => {
        if (!input.trim() || isLoading) return;

        // 1. CHECK GLOBAL ENABLE
        if (settings?.isAiEnabled === false) {
            setMessages(prev => [...prev, { role: 'AI', text: "AI Tutor is currently disabled by Admin.", timestamp: Date.now() }]);
            return;
        }

        // 2. CHECK LIMITS
        const today = new Date().toISOString().split('T')[0];
        let currentCount = user.dailyAiCount || 0;
        
        // Reset if new day
        if (user.dailyAiDate !== today) {
            currentCount = 0;
        }

        let limit = 5; // Free
        if (user.isPremium) {
            if (user.subscriptionLevel === 'ULTRA') limit = 99999;
            else limit = 50; // Basic
        }

        // Override from Settings if available
        if (settings?.aiLimits) {
            if (!user.isPremium) limit = settings.aiLimits.free || 5;
            else if (user.subscriptionLevel === 'BASIC') limit = settings.aiLimits.basic || 50;
            else limit = settings.aiLimits.ultra || 99999;
        }

        if (currentCount >= limit) {
            setMessages(prev => [...prev, { role: 'AI', text: `⚠️ Daily Limit Reached (${limit}/${limit}).\n\nUpgrade to Premium for more queries!`, timestamp: Date.now() }]);
            return;
        }

        const userMsg = input;
        const newMsg: Message = { role: 'USER', text: userMsg, timestamp: Date.now() };
        
        setMessages(prev => [...prev, newMsg]);
        setInput('');
        setIsLoading(true);

        try {
            // Update Usage Immediately (Optimistic)
            const updatedUser = { 
                ...user, 
                dailyAiDate: today, 
                dailyAiCount: currentCount + 1 
            };
            saveUserToLive(updatedUser); // Fire and forget

            // Use Groq API via generateCustomNotes as a proxy for chat
            const prompt = "You are a helpful AI Tutor. Answer the student's question clearly and concisely. If it's a concept, explain it simply.";
            const responseText = await generateCustomNotes(userMsg, prompt, settings?.aiModel);

            const aiMsg: Message = { role: 'AI', text: responseText, timestamp: Date.now() };
            setMessages(prev => [...prev, aiMsg]);

            // Save Interaction
            saveAiInteraction({
                id: `chat-${Date.now()}`,
                userId: user.id,
                userName: user.name,
                type: 'STUDENT_CHAT',
                query: userMsg,
                response: responseText,
                timestamp: new Date().toISOString()
            });

        } catch (error: any) {
            setMessages(prev => [...prev, { role: 'AI', text: "I'm having trouble connecting right now. Please try again.", timestamp: Date.now() }]);
        } finally {
            setIsLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4">
            <div className="bg-white w-full sm:max-w-md h-[85vh] sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in slide-in-from-right-8">
                {/* Header */}
                <div className="bg-slate-900 text-white p-4 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-indigo-500 rounded-full flex items-center justify-center shadow-lg">
                            <Bot size={24} />
                        </div>
                        <div>
                            <h3 className="font-bold text-lg leading-none">AI Tutor</h3>
                            <p className="text-xs text-indigo-300">
                                {user.isPremium && user.subscriptionLevel === 'ULTRA' ? 'Unlimited Access' : `${(user.dailyAiCount || 0)} used today`}
                            </p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors">
                        <X size={20} />
                    </button>
                </div>

                {/* Chat Area */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50">
                    {messages.length === 0 && (
                        <div className="text-center text-slate-400 mt-20">
                            <Sparkles size={48} className="mx-auto mb-4 opacity-50" />
                            <p>Hello! I am your AI Tutor.</p>
                            <p className="text-xs mt-2">Ask me about any topic, math problem, or definition.</p>
                        </div>
                    )}
                    
                    {messages.map((msg, i) => (
                        <div key={i} className={`flex gap-3 ${msg.role === 'AI' ? '' : 'flex-row-reverse'}`}>
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${msg.role === 'AI' ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-200 text-slate-600'}`}>
                                {msg.role === 'AI' ? <Bot size={16} /> : <UserIcon size={16} />}
                            </div>
                            <div className={`max-w-[80%] p-3 rounded-2xl text-sm shadow-sm relative group ${msg.role === 'AI' ? 'bg-white border border-slate-100 rounded-tl-none' : 'bg-indigo-600 text-white rounded-tr-none'}`}>
                                <p className="whitespace-pre-wrap">{msg.text}</p>
                                {msg.role === 'AI' && (
                                    <div className="absolute -bottom-3 -right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white rounded-full shadow border border-slate-200">
                                        <SpeakButton text={msg.text} iconSize={14} className="p-1.5" />
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}

                    {isLoading && (
                        <div className="flex gap-3">
                            <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600">
                                <Loader2 size={16} className="animate-spin" />
                            </div>
                            <div className="bg-white border border-slate-100 p-3 rounded-2xl rounded-tl-none text-xs text-slate-400">
                                Thinking...
                            </div>
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <div className="p-3 bg-white border-t border-slate-100 flex gap-2">
                    <input 
                        type="text" 
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleSend()}
                        placeholder="Type your question..." 
                        className="flex-1 bg-slate-100 border-none rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                    />
                    <button 
                        onClick={handleSend}
                        disabled={!input.trim() || isLoading}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white p-3 rounded-xl transition-all disabled:opacity-50 disabled:scale-95 shadow-lg"
                    >
                        <Send size={20} />
                    </button>
                </div>
            </div>
        </div>
    );
};
