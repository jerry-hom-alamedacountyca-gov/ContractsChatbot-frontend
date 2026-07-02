import { useCallback, useEffect, useRef, useState } from 'react';
import {
    createApiConversation,
    deleteApiConversation,
    isConversationsEnabled,
    streamChat,
} from '../api/chat';
import {
    createConversation,
    deleteConversation,
    getConversation,
    getConversations,
    saveConversation,
} from '../utils/conversationStorage';
import ChatHistory from './ChatHistory';
import ChatInput from './ChatInput';
import ChatMessage from './ChatMessage';

export default function ChatWindow() {
  const [messages, setMessages] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [apiConvId, setApiConvId] = useState(null);
  const [conversations, setConversations] = useState(() => getConversations());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const abortRef = useRef(null);
  const bottomRef = useRef(null);
  const convIdRef = useRef(null);
  const apiConvIdRef = useRef(null);

  // Keep refs in sync so streaming callbacks see latest values
  useEffect(() => {
    convIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    apiConvIdRef.current = apiConvId;
  }, [apiConvId]);

  const refreshList = useCallback(() => {
    setConversations(getConversations());
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const persistConversation = useCallback(
    (msgs, id, apiId) => {
      if (!id) {
        const conv = createConversation(msgs, apiId);
        saveConversation(conv);
        setConversationId(conv.id);
        convIdRef.current = conv.id;
        refreshList();
        return conv.id;
      }
      const existing = getConversation(id);
      if (existing) {
        existing.messages = msgs;
        existing.updatedAt = new Date().toISOString();
        if (apiId && !existing.apiConversationId) {
          existing.apiConversationId = apiId;
        }
        saveConversation(existing);
        refreshList();
      }
      return id;
    },
    [refreshList],
  );

  const handleSend = useCallback(
    async (text) => {
      const userMsg = { role: 'user', content: text };
      const assistantMsg = { role: 'assistant', content: '' };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      let currentApiId = apiConvId;

      // If Conversations API is enabled, ensure we have a conversation
      if (isConversationsEnabled() && !currentApiId) {
        try {
          const conv = await createApiConversation();
          currentApiId = conv.id;
          setApiConvId(conv.id);
          apiConvIdRef.current = conv.id;
        } catch (err) {
          console.warn('Conversations API failed, falling back to stateless:', err.message);
          currentApiId = null;
        }
      }

      // Determine what to pass to streamChat
      const chatArg = currentApiId ? text : [...messages, userMsg];

      streamChat(chatArg, {
        conversationId: currentApiId || undefined,
        signal: controller.signal,
        onToken: (token) => {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            updated[updated.length - 1] = {
              ...last,
              content: last.content + token,
            };
            return updated;
          });
          scrollToBottom();
        },
        onCitations: (citations) => {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            updated[updated.length - 1] = {
              ...last,
              citations,
            };
            return updated;
          });
        },
        onDone: () => {
          setIsStreaming(false);
          abortRef.current = null;
          scrollToBottom();
          // Persist after assistant finishes
          setMessages((prev) => {
            const id = convIdRef.current;
            const aId = apiConvIdRef.current;
            persistConversation(prev, id, aId);
            return prev;
          });
        },
        onError: (err) => {
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: 'assistant',
              content: `⚠️ Error: ${err.message}`,
            };
            return updated;
          });
          setIsStreaming(false);
          abortRef.current = null;
        },
      });
    },
    [messages, scrollToBottom, persistConversation, apiConvId],
  );

  const handleSelectConversation = useCallback(
    (id) => {
      if (isStreaming) return;
      const conv = getConversation(id);
      if (conv) {
        setMessages(conv.messages);
        setConversationId(id);
        setApiConvId(conv.apiConversationId || null);
      }
      setSidebarOpen(false);
    },
    [isStreaming],
  );

  const handleNewChat = useCallback(() => {
    if (isStreaming) return;
    setMessages([]);
    setConversationId(null);
    setApiConvId(null);
    setSidebarOpen(false);
  }, [isStreaming]);

  const handleDeleteConversation = useCallback(
    (id) => {
      const conv = getConversation(id);
      if (conv?.apiConversationId) {
        deleteApiConversation(conv.apiConversationId).catch(() => {});
      }
      deleteConversation(id);
      if (conversationId === id) {
        setMessages([]);
        setConversationId(null);
        setApiConvId(null);
      }
      refreshList();
    },
    [conversationId, refreshList],
  );

  return (
    <div className="chat-layout">
      {/* Sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`chat-sidebar${sidebarOpen ? ' open' : ''}`}>
        <ChatHistory
          conversations={conversations}
          activeId={conversationId}
          onSelect={handleSelectConversation}
          onNewChat={handleNewChat}
          onDelete={handleDeleteConversation}
        />
      </aside>

      {/* Main chat area */}
      <div className="chat-window">
        <div className="header-frame">
          <div className="header-content">
            <h2 className="header-county">ALAMEDA COUNTY</h2>
            <h3 className="header-department">Procurement Contracts Services</h3>
          </div>
        </div>
        <div className="service-banner">
          <h1 className="service-title">Contracts Assistant</h1>
        </div>
        <div className="chat-toolbar">
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen((o) => !o)}
            title="Toggle chat history"
          >
            ☰
          </button>
        </div>
        <div className="chat-messages">
          {messages.length === 0 && (
            <div className="chat-empty">Send a message to start chatting.</div>
          )}
          {messages.map((msg, i) => (
            <ChatMessage
              key={i}
              role={msg.role}
              content={msg.content}
              citations={msg.citations}
              isLoading={
                isStreaming &&
                i === messages.length - 1 &&
                msg.role === 'assistant' &&
                !msg.content
              }
            />
          ))}
          <div ref={bottomRef} />
        </div>
        <ChatInput onSend={handleSend} disabled={isStreaming} />
      </div>
    </div>
  );
}
