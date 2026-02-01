import React, { useState, useEffect, useRef } from 'react';
import { Terminal, Send, Cpu, ShieldCheck, X, Loader2, RefreshCw, Users, CheckCircle, Gift } from 'lucide-react';
import { processAdminCommand, AdminAiResponse } from '../services/adminAi';
import { speakText } from '../utils/textToSpeech';
import { User, SystemSettings } from '../types';

interface Props {
  onClose: () => void;
  users: User[];
  settings: SystemSettings;
  onUpdateSettings: (s: SystemSettings) => void;
}

interface Message {
  role: 'AI' | 'USER';
  text: string;
  type?: AdminAiResponse['type'];
  data?: any;
}

export const AdminAiAssistant: React.FC<Props> = ({ onClose, users, settings, onUpdateSettings }) => {
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasGreeted = useRef(false);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(scrollToBottom, [messages, isLoading]);

  // GREETING ON MOUNT
  useEffect(() => {
      if (!hasGreeted.current) {
          const greeting = "Any work for me Sir? Tell me, I will do it.";
          setMessages([{ role: 'AI', text: greeting, type: 'TEXT' }]);
          speakText(greeting);
          hasGreeted.current = true;
      }
  }, []);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMsg = input;
    setMessages(prev => [...prev, { role: 'USER', text: userMsg }]);
    setInput('');
    setIsLoading(true);

    try {
        const response = await processAdminCommand(userMsg, { 
            users, 
            settings, 
            setSettings: onUpdateSettings 
        });

        setMessages(prev => [...prev, { 
            role: 'AI', 
            text: response.message, 
            type: response.type, 
            data: response.data 
        }]);
        
        speakText(response.message);

    } catch (error: any) {
        setMessages(prev => [...prev, { role: 'AI', text: "Error: " + error.message, type: 'TEXT' }]);
        speakText("I encountered an error.");
    } finally {
        setIsLoading(false);
    }
  };

  const renderContent = (msg: Message) => {
      if (msg.role === 'USER') return <p className="whitespace-pre-wrap font-sans">{msg.text}</p>;

      return (
          <div className="space-y-3 font-sans">
              <p>{msg.text}</p>
              
              {/* LIST USERS */}
              {msg.type === 'LIST_USERS' && msg.data && Array.isArray(msg.data) && (
                  <div className="bg-slate-800 rounded-lg p-2 max-h-40 overflow-y-auto">
                      <table className="w-full text-xs text-left text-slate-300">
                          <thead>
                              <tr className="border-b border-slate-700">
                                  <th className="p-1">Name</th>
                                  <th className="p-1">ID</th>
                                  <th className="p-1">Credits</th>
                              </tr>
                          </thead>
                          <tbody>
                              {msg.data.map((u: User) => (
                                  <tr key={u.id} className="border-b border-slate-700/50">
                                      <td className="p-1">{u.name}</td>
                                      <td className="p-1 font-mono text-slate-500">{u.displayId}</td>
                                      <td className="p-1 text-yellow-400">{u.credits}</td>
                                  </tr>
                              ))}
                          </tbody>
                      </table>
                  </div>
              )}

              {/* LIST MCQ ACTIVITY */}
              {msg.type === 'LIST_MCQ' && msg.data && Array.isArray(msg.data) && (
                  <div className="bg-slate-800 rounded-lg p-2 max-h-40 overflow-y-auto">
                      <p className="text-xs text-slate-400 mb-2">Active Students Today:</p>
                      <div className="flex flex-wrap gap-2">
                          {msg.data.map((u: User) => (
                              <span key={u.id} className="bg-slate-700 px-2 py-1 rounded text-xs text-white">
                                  {u.name}
                              </span>
                          ))}
                      </div>
                  </div>
              )}

              {/* ACTION CONFIRMATION */}
              {msg.type === 'ACTION_CONFIRMATION' && (
                  <div className="flex items-center gap-2 text-green-400 text-sm font-bold bg-green-900/20 p-2 rounded-lg border border-green-800">
                      <CheckCircle size={16} /> Action Completed Successfully
                  </div>
              )}
          </div>
      );
  };

  return (
    <div className="fixed inset-0 z-[200] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="w-full max-w-4xl bg-[#0f172a] rounded-3xl border border-slate-700 shadow-2xl overflow-hidden flex flex-col h-[85vh]">
            {/* Header */}
            <div className="bg-[#1e293b] p-4 border-b border-slate-700 flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg">
                        <Cpu size={20} className="text-white" />
                    </div>
                    <div>
                        <h3 className="font-bold text-white text-lg">Admin Auto-Pilot</h3>
                        <p className="text-xs text-indigo-300 flex items-center gap-1">
                            <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span> Online & Listening
                        </p>
                    </div>
                </div>
                <button onClick={onClose} className="bg-slate-800 p-2 rounded-full text-slate-400 hover:text-white hover:bg-slate-700 transition-all">
                    <X size={20} />
                </button>
            </div>

            {/* Chat Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar bg-slate-900/50">
                {messages.map((msg, idx) => (
                    <div key={idx} className={`flex gap-4 ${msg.role === 'AI' ? 'text-slate-200' : 'text-white flex-row-reverse'}`}>
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 shadow-lg ${msg.role === 'AI' ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-300'}`}>
                            {msg.role === 'AI' ? <Cpu size={20} /> : <ShieldCheck size={20} />}
                        </div>
                        <div className={`max-w-[80%] p-4 rounded-2xl shadow-md ${
                            msg.role === 'AI' 
                            ? 'bg-[#1e293b] border border-slate-700 rounded-tl-none' 
                            : 'bg-indigo-600 rounded-tr-none'
                        }`}>
                           {renderContent(msg)}
                        </div>
                    </div>
                ))}
                
                {isLoading && (
                    <div className="flex gap-4 text-slate-400">
                        <div className="w-10 h-10 rounded-full bg-indigo-900/50 flex items-center justify-center shrink-0">
                            <Loader2 size={20} className="animate-spin text-indigo-400" />
                        </div>
                        <div className="flex items-center gap-2 text-xs font-mono bg-[#1e293b] px-4 py-2 rounded-full border border-slate-700">
                            Processing Command...
                        </div>
                    </div>
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-4 bg-[#1e293b] border-t border-slate-700">
                <div className="relative flex items-center gap-2">
                    <input 
                        type="text" 
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleSend()}
                        disabled={isLoading}
                        className="w-full bg-slate-900 border border-slate-700 rounded-xl py-4 pl-6 pr-14 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all placeholder:text-slate-500 font-medium"
                        placeholder="Type a command (e.g., 'Scan users', 'Create weekly test')..."
                        autoFocus
                    />
                    <button 
                        onClick={handleSend}
                        disabled={isLoading || !input.trim()}
                        className="absolute right-2 p-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-lg"
                    >
                        <Send size={20} />
                    </button>
                </div>
                <div className="flex gap-2 mt-3 overflow-x-auto pb-1 scrollbar-hide">
                    {['Scan Users', 'Create Weekly Test', 'Set Daily Challenge', 'Send Prize'].map(cmd => (
                        <button 
                            key={cmd}
                            onClick={() => { setInput(cmd); }} 
                            className="whitespace-nowrap px-3 py-1.5 bg-slate-800 text-slate-400 text-xs font-bold rounded-lg border border-slate-700 hover:bg-slate-700 hover:text-white transition-colors"
                        >
                            {cmd}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    </div>
  );
};
