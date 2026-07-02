import React, { useState, useRef, useEffect } from 'react';
import { Send, Sparkles, User, Bot, Loader2 } from 'lucide-react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatReplProps {
  onCommand: (command: string) => Promise<void>;
}

const ChatRepl: React.FC<ChatReplProps> = ({ onCommand }) => {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: 'Hello! I am your AI Circuit Assistant. I can help you design, debug, and simulate your electronics. What are we building today?' }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setIsLoading(true);

    try {
      const response = await onCommand(userMessage);
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: String(response)
      }]);
    } catch (error: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Sorry, I encountered an error: ${error.message}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const target = e.target;
    setInput(target.value);
    target.style.height = 'auto';
    target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="chat-repl">
      <div className="chat-header">
        <Sparkles size={16} className="sparkle-icon" />
        <span>AI Assistant (REPL)</span>
      </div>
      <div className="chat-messages" ref={scrollRef}>
        {messages.map((msg, idx) => (
          <div key={idx} className={`message ${msg.role}`}>
            <div className="message-icon">
              {msg.role === 'user' ? <User size={14} /> : <Bot size={14} />}
            </div>
            <div className="message-content" style={{ textAlign: 'left', whiteSpace: 'pre-wrap' }}>{msg.content}</div>
          </div>
        ))}
        {isLoading && (
          <div className="message assistant loading">
            <div className="message-icon"><Loader2 size={14} className="animate-spin" /></div>
            <div className="message-content">Thinking...</div>
          </div>
        )}
      </div>
      <form className="chat-input-area" onSubmit={handleSubmit}>
        <textarea 
          ref={textareaRef}
          value={input} 
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Ask AI to 'Add a resistor' or 'Fix the battery divider'..."
          disabled={isLoading}
          rows={1}
          style={{ 
            resize: 'none', 
            overflowY: input.split('\n').length > 5 || (textareaRef.current && textareaRef.current.scrollHeight > 200) ? 'auto' : 'hidden'
          }}
        />
        <button type="submit" disabled={isLoading || !input.trim()}>
          <Send size={16} />
        </button>
      </form>
    </div>
  );
};

export default ChatRepl;
